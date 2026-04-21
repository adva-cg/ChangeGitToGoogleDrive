import * as vscode from 'vscode';
import { drive_v3 } from 'googleapis';
import * as path from 'path';
import { promises as fs } from 'fs';
import * as fsSync from 'fs';
import { 
    LAST_PUSHED_HASH_KEY_PREFIX, 
    PROCESSED_TOMBSTONES_KEY 
} from '../constants';
import { 
    getWorkspaceRoot,
    getGitRepositories,
    GitRepository,
    runCommand, 
    sanitizeBranchNameForDrive, 
    restoreBranchNameFromDrive 
} from '../utils/common';
import { getAuthenticatedClient } from '../googleDrive/auth';
import { LockManager } from '../googleDrive/lockManager';
import { 
    findOrCreateProjectFolders, 
    findOrCreateTombstonesFolder, 
    findOrCreateSubFolder,
    ensureSingleFolder,
    downloadFile,
    findOrCreateBaseProjectFolder
} from '../googleDrive/operations';
import { 
    getCurrentBranch, 
    getLocalBranches, 
    getRemoteRefs, 
    updateRemoteRefs 
} from './gitUtils';

export async function initialUpload(context: vscode.ExtensionContext, repo?: GitRepository) {
    if (!repo) {
        const repos = await getGitRepositories();
        for (const r of repos) {
            await initialUpload(context, r);
        }
        return;
    }

    const { root: repoRoot, name: repoName } = repo;
    try {
        const currentBranch = await getCurrentBranch(repoRoot);
        if (!currentBranch) return;
        
        const drive = await getAuthenticatedClient(context);
        if (!drive) return;

        const projectFolderId = await findOrCreateBaseProjectFolder(drive, repoRoot, context);
        if (!projectFolderId) throw new Error(`Could not find or create project folder for ${repoName} on Google Drive.`);

        // Acquire Remote Lock
        const lockAcquired = await LockManager.acquireLock(drive, projectFolderId, 'git', `Git Initial Push: ${repoName}`, false, repoRoot);
        if (!lockAcquired) return;

        try {
            await context.workspaceState.update(`${LAST_PUSHED_HASH_KEY_PREFIX}${currentBranch}`, undefined);
            vscode.window.showInformationMessage(`[${repoName}] Статус синхронизации для ветки '${currentBranch}' сброшен. Начинаю новую выгрузку...`);
            
            const bundleFolderId = await ensureSingleFolder(drive, projectFolderId, 'bundles', context);
            if (!bundleFolderId) throw new Error(`Could not find or create bundles folder for ${repoName}.`);
            
            const remoteRefs = await getRemoteRefs(drive, bundleFolderId);
            await pushCommits(context, drive, bundleFolderId, remoteRefs, repoRoot, false);
        } finally {
            await LockManager.releaseLock(drive, 'git', repoRoot);
        }
    } catch (error: any) {
        vscode.window.showErrorMessage(`[${repoName}] Первоначальная выгрузка не удалась: ${error.message}`);
    }
}

export async function sync(context: vscode.ExtensionContext, silent: boolean = false, repo?: GitRepository) {
    if (!repo) {
        const repos = await getGitRepositories();
        for (const r of repos) {
            await sync(context, silent, r);
        }
        return;
    }

    const { root: repoRoot, name: repoName } = repo;
    try {
        const drive = await getAuthenticatedClient(context);
        if (!drive) return;

        const projectFolderId = await findOrCreateBaseProjectFolder(drive, repoRoot, context);
        if (!projectFolderId) throw new Error(`Could not find or create project folder for ${repoName} on Google Drive.`);

        // Acquire Lock
        const lockAcquired = await LockManager.acquireLock(drive, projectFolderId, 'git', `Git Sync: ${repoName}`, silent, repoRoot);
        if (!lockAcquired) return;

        try {
            const bundleFolderId = await ensureSingleFolder(drive, projectFolderId, 'bundles', context);
            if (!bundleFolderId) throw new Error(`Could not find or create bundles folder for ${repoName}.`);
            
            const remoteRefs = await getRemoteRefs(drive, bundleFolderId);
            await checkRemoteBranchTombstones(context, drive, repoRoot, silent);
            await pullCommits(context, drive, bundleFolderId, remoteRefs, repoRoot, silent);
            await pushCommits(context, drive, bundleFolderId, remoteRefs, repoRoot, silent);

            // Cleanup SYNC_REQUEST if it exists
            const syncRequestPath = path.join(repoRoot, '.git', 'SYNC_REQUEST');
            if (fsSync.existsSync(syncRequestPath)) {
                await fs.unlink(syncRequestPath).catch(() => {});
            }

            if (!silent) vscode.window.showInformationMessage(`[${repoName}] Sync finished.`);
        } finally {
            await LockManager.releaseLock(drive, 'git', repoRoot);
        }
    } catch (error: any) {
        const errorMsg = `[${repoName}] Sync failed: ${error.message}`;
        if (silent) {
            console.error(errorMsg);
            vscode.window.showErrorMessage(`Background sync failed for ${repoName}: ${error.message}.`);
        } else {
            vscode.window.showErrorMessage(errorMsg, { modal: true });
        }
    }
}

async function checkRemoteBranchTombstones(context: vscode.ExtensionContext, drive: drive_v3.Drive, repoRoot: string, silent: boolean = false) {
    try {
        const tombstonesFolderId = await findOrCreateTombstonesFolder(drive, repoRoot, context);
        const branchTombstonesFolderId = await findOrCreateSubFolder(drive, tombstonesFolderId, 'branches', context);
        const { data: { files: tombstones } } = await drive.files.list({
            q: `'${branchTombstonesFolderId}' in parents and trashed=false`,
            fields: 'files(id, name)'
        });
        if (!tombstones || tombstones.length === 0) return;
        const localBranches = await getLocalBranches(repoRoot);
        const processedTombstones = context.workspaceState.get<Record<string, boolean>>(PROCESSED_TOMBSTONES_KEY, {});
        for (const tombstone of tombstones) {
            const branchName = restoreBranchNameFromDrive(tombstone.name || '');
            const repoName = path.basename(repoRoot);
            if (localBranches.includes(branchName) && tombstone.id && !processedTombstones[tombstone.id]) {
                const choice = await vscode.window.showWarningMessage(
                    `[${repoName}] Ветка '${branchName}' была удалена на другом компьютере. Удалить её локально?`,
                    'Да', 'Нет'
                );
                if (choice === 'Да') {
                    try {
                        await runCommand(`git branch -D ${branchName}`, repoRoot);
                        if (!silent) vscode.window.showInformationMessage(`[${repoName}] Ветка '${branchName}' удалена локально.`);
                        const current = await getCurrentBranch(repoRoot);
                        if (current === branchName) {
                            const defaultBranch = localBranches.includes('main') ? 'main' : (localBranches.includes('master') ? 'master' : null);
                            if (defaultBranch) await runCommand(`git checkout ${defaultBranch}`, repoRoot);
                        }
                    } catch (e: any) {
                        vscode.window.showErrorMessage(`[${repoName}] Не удалось удалить ветку '${branchName}': ${e.message}`);
                    }
                }
                if (tombstone.id) processedTombstones[tombstone.id] = true;
            }
        }
        await context.workspaceState.update(PROCESSED_TOMBSTONES_KEY, processedTombstones);
    } catch (error: any) {
        console.error('Error checking remote branch tombstones:', error.message);
    }
}

async function pushCommits(context: vscode.ExtensionContext, drive: drive_v3.Drive, bundleFolderId: string, remoteRefs: any, repoRoot: string, silent: boolean = false) {
    const currentBranch = await getCurrentBranch(repoRoot);
    const remoteBranchHead = remoteRefs[currentBranch];
    const lastPushedHash = remoteBranchHead || context.workspaceState.get(`${LAST_PUSHED_HASH_KEY_PREFIX}${currentBranch}`);
    let currentHead;
    try {
        const headRes = await runCommand('git rev-parse HEAD', repoRoot);
        currentHead = headRes.stdout.trim();
    } catch (e) {
        if (!silent) vscode.window.showWarningMessage(`Репозиторий ${path.basename(repoRoot)} пуст. Сделайте хотя бы один коммит.`, { modal: true });
        return;
    }
    if (lastPushedHash === currentHead) {
        if (!silent) vscode.window.showInformationMessage(`[${path.basename(repoRoot)}] Already up-to-date.`);
        return;
    }
    if (lastPushedHash) {
        try {
            await runCommand(`git merge-base --is-ancestor ${lastPushedHash} HEAD`, repoRoot);
        } catch (error) {
            vscode.window.showErrorMessage(`[${path.basename(repoRoot)}] Push aborted: History has been rewritten.`);
            return;
        }
    }
    const revisionRange = lastPushedHash ? `${lastPushedHash}..HEAD` : 'HEAD';
    const { stdout: commitsToPush } = await runCommand(`git rev-list ${revisionRange}`, repoRoot);
    if (!commitsToPush.trim()) return;
    const sanitizedBranchName = sanitizeBranchNameForDrive(currentBranch);
    const bundleFileName = `${sanitizedBranchName}--${currentHead}.bundle`;
    const bundlePath = path.join(repoRoot, '.git', bundleFileName);
    try {
        await runCommand(`git bundle create \"${bundlePath}\" ${revisionRange}`, repoRoot);
        const media = { mimeType: 'application/octet-stream', body: fsSync.createReadStream(bundlePath) };
        await drive.files.create({ requestBody: { name: bundleFileName, parents: [bundleFolderId] }, media: media });
        remoteRefs[currentBranch] = currentHead;
        await updateRemoteRefs(drive, bundleFolderId, remoteRefs);
        await context.workspaceState.update(`${LAST_PUSHED_HASH_KEY_PREFIX}${currentBranch}`, currentHead);
    } catch (error: any) {
        vscode.window.showErrorMessage(`[${path.basename(repoRoot)}] Push failed: ${error.message}`);
    } finally {
        if (fsSync.existsSync(bundlePath)) await fs.unlink(bundlePath);
    }
}

async function pullCommits(context: vscode.ExtensionContext, drive: drive_v3.Drive, bundleFolderId: string, remoteRefs: any, repoRoot: string, silent: boolean = false) {
    const q = `'${bundleFolderId}' in parents and trashed=false and fileExtension='bundle'`;
    const { data: { files: allRemoteBundles } } = await drive.files.list({ q, fields: 'files(id, name, createdTime)', orderBy: 'createdTime' });
    if (!allRemoteBundles || allRemoteBundles.length === 0) return;
    const localBranches = new Set(await getLocalBranches(repoRoot));
    const currentBranch = await getCurrentBranch(repoRoot);
    const repoName = path.basename(repoRoot);
    const remoteBundlesByBranch = new Map<string, any[]>();
    for (const bundle of allRemoteBundles) {
        const parts = (bundle.name || '').split('--');
        if (parts.length < 2) continue;
        const branchName = restoreBranchNameFromDrive(parts[0]);
        if (!remoteBundlesByBranch.has(branchName)) remoteBundlesByBranch.set(branchName, []);
        remoteBundlesByBranch.get(branchName)!.push(bundle);
    }
    const tempDir = path.join(repoRoot, '.git', 'gdrive-temp-bundles');
    await fs.mkdir(tempDir, { recursive: true });
    try {
        for (const [branchName, bundles] of remoteBundlesByBranch.entries()) {
            if (localBranches.has(branchName)) {
                if (branchName !== currentBranch) continue;
                const { stdout: currentCommits } = await runCommand(`git rev-list ${branchName}`, repoRoot);
                const commitSet = new Set(currentCommits.trim().split(/\s+/));
                const newBundles = bundles.filter(b => {
                    const hash = (b.name || '').split('--')[1]?.replace('.bundle', '');
                    return hash && !commitSet.has(hash);
                });
                if (newBundles.length === 0) continue;
                let lastHash = '';
                for (const bundle of newBundles) {
                    const bPath = path.join(tempDir, bundle.name);
                    await downloadFile(drive, bundle.id, bPath);
                    await runCommand(`git fetch \"${bPath}\"`, repoRoot);
                    lastHash = bundle.name.split('--')[1]?.replace('.bundle', '');
                }
                try {
                    await runCommand(`git merge --ff-only FETCH_HEAD`, repoRoot);
                } catch (e) {
                    try {
                        await runCommand(`git merge --no-edit FETCH_HEAD`, repoRoot);
                    } catch (mError) {
                        if (silent) await runCommand(`git merge --abort`, repoRoot).catch(() => {});
                        throw mError;
                    }
                }
                const remoteHead = remoteRefs[branchName] || lastHash;
                if (remoteHead) await context.workspaceState.update(`${LAST_PUSHED_HASH_KEY_PREFIX}${branchName}`, remoteHead);
            } else {
                const choice = await vscode.window.showInformationMessage(`[${repoName}] Found new branch '${branchName}'. Create local?`, 'Yes');
                if (choice === 'Yes') {
                    let lastHash = '';
                    for (const bundle of bundles) {
                        const bPath = path.join(tempDir, bundle.name);
                        await downloadFile(drive, bundle.id, bPath);
                        await runCommand(`git fetch \"${bPath}\"`, repoRoot);
                        lastHash = bundle.name.split('--')[1]?.replace('.bundle', '');
                    }
                    if (lastHash) {
                        await runCommand(`git checkout -b ${branchName} ${lastHash}`, repoRoot);
                        await context.workspaceState.update(`${LAST_PUSHED_HASH_KEY_PREFIX}${branchName}`, lastHash);
                    }
                }
            }
        }
    } finally {
        if (fsSync.existsSync(tempDir)) await fs.rm(tempDir, { recursive: true, force: true });
    }
}

export async function installGitHooks(_context: vscode.ExtensionContext, repo?: GitRepository) {
    if (!repo) {
        const repos = await getGitRepositories();
        for (const r of repos) {
            await installGitHooks(_context, r);
        }
        return;
    }
    const { root: repoRoot, name: repoName } = repo;
    const hooksDir = path.join(repoRoot, '.git', 'hooks');
    const postCommitHookPath = path.join(hooksDir, 'post-commit');
    const postCommitScript = `#!/bin/sh\n# Hook to trigger VS Code sync after commit\ntouch .git/SYNC_REQUEST\n`;
    try {
        await fs.mkdir(hooksDir, { recursive: true });
        await fs.writeFile(postCommitHookPath, postCommitScript);
        await fs.chmod(postCommitHookPath, '755');
        vscode.window.showInformationMessage(`[${repoName}] Successfully installed post-commit hook!`);
    } catch (error: any) {
        vscode.window.showErrorMessage(`[${repoName}] Failed to install git hooks: ${error.message}`);
    }
}

export async function cloneFromGoogleDrive(context: vscode.ExtensionContext) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;
    const files = await fs.readdir(workspaceRoot);
    if (files.length > 0) {
        vscode.window.showErrorMessage('Clone can only be done into an empty folder.');
        return;
    }
    const drive = await getAuthenticatedClient(context);
    if (!drive) return;
    try {
        const rootFolderId = await ensureSingleFolder(drive, null, '.gdrive-git', context);
        const resProjects = await drive.files.list({ q: `'${rootFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`, fields: 'files(id, name)' });
        const projects = resProjects.data.files || [];
        if (projects.length === 0) return;
        const selectedProject = await vscode.window.showQuickPick(projects.map(f => ({ label: f.name!, id: f.id! })), { placeHolder: 'Select the project' });
        if (!selectedProject) return;
        const resBundles = await drive.files.list({ q: `name='bundles' and mimeType='application/vnd.google-apps.folder' and '${selectedProject.id}' in parents and trashed=false`, fields: 'files(id)' });
        if (!resBundles.data.files?.length) return;
        const bundleFolderId = resBundles.data.files[0].id!;
        const resRemote = await drive.files.list({ q: `'${bundleFolderId}' in parents and trashed=false and fileExtension='bundle'`, fields: 'files(id, name)', orderBy: 'createdTime desc' });
        if (!resRemote.data.files?.length) return;
        const selectedBundle = await vscode.window.showQuickPick(resRemote.data.files.map(b => ({ label: b.name!, id: b.id! })), { placeHolder: 'Select the bundle' });
        if (!selectedBundle) return;
        const tempDir = path.join(workspaceRoot, '.gdrive-temp-clone');
        await fs.mkdir(tempDir, { recursive: true });
        const tempBundlePath = path.join(tempDir, selectedBundle.label);
        await downloadFile(drive, selectedBundle.id, tempBundlePath);
        await runCommand(`git clone \"${tempBundlePath}\" \"${path.join(tempDir, 'cloned')}\"`, tempDir);
        const [driveBranchName, clonedHead] = selectedBundle.label.replace('.bundle', '').split('--');
        const branchToCheckout = restoreBranchNameFromDrive(driveBranchName);
        const clonedFiles = await fs.readdir(path.join(tempDir, 'cloned'));
        for (const file of clonedFiles) await fs.rename(path.join(tempDir, 'cloned', file), path.join(workspaceRoot, file));
        await fs.rm(tempDir, { recursive: true, force: true });
        if (branchToCheckout) {
            await runCommand(`git checkout -b ${branchToCheckout}`, workspaceRoot);
            await context.workspaceState.update(`${LAST_PUSHED_HASH_KEY_PREFIX}${branchToCheckout}`, clonedHead);
        }
        vscode.window.showInformationMessage('Repository cloned successfully!');
        vscode.commands.executeCommand('workbench.action.reloadWindow');
    } catch (error: any) {
        vscode.window.showErrorMessage(`Clone failed: ${error.message}`);
    }
}

export async function manageSyncHash(context: vscode.ExtensionContext) {
    const repos = await getGitRepositories();
    if (repos.length === 0) return;
    
    let repo = repos[0];
    if (repos.length > 1) {
        const selected = await vscode.window.showQuickPick(repos.map(r => ({ label: r.name, repo: r })), { placeHolder: 'Выберите репозиторий для управления хешем' });
        if (!selected) return;
        repo = selected.repo;
    }

    const { root: repoRoot, name: repoName } = repo;
    const currentBranch = await getCurrentBranch(repoRoot);
    if (!currentBranch) return;
    const hashKey = `${LAST_PUSHED_HASH_KEY_PREFIX}${currentBranch}`;
    const choice = await vscode.window.showQuickPick([
        { label: "Установить из последних коммитов", action: "select" },
        { label: "Ввести хеш вручную", action: "manual" },
        { label: "Сбросить хеш синхронизации", action: "reset" }
    ]);
    if (!choice) return;
    let newHash: string | null | undefined = null;
    if (choice.action === "select") {
        const { stdout } = await runCommand('git log -10 --pretty=format:"%H|%s"', repoRoot);
        const commits = stdout.trim().split('\n').map(line => ({ label: line.split('|')[1], description: line.split('|')[0].substring(0, 7), hash: line.split('|')[0] }));
        newHash = (await vscode.window.showQuickPick(commits))?.hash;
    } else if (choice.action === "manual") {
        newHash = await vscode.window.showInputBox({ prompt: "Введите хеш" });
    } else if (choice.action === "reset") {
        newHash = undefined;
    }
    if (newHash === null) return;
    await context.workspaceState.update(hashKey, newHash);
    const drive = await getAuthenticatedClient(context);
    if (drive) {
        const bundleFolderId = await findOrCreateProjectFolders(drive, repoRoot, context);
        if (bundleFolderId) {
            const remoteRefs = await getRemoteRefs(drive, bundleFolderId);
            if (newHash === undefined) delete remoteRefs[currentBranch]; else remoteRefs[currentBranch] = newHash;
            await updateRemoteRefs(drive, bundleFolderId, remoteRefs);
            vscode.window.showInformationMessage(`[${repoName}] Хеш синхронизации обновлен.`);
        }
    }
}

export async function setupBranchMonitoring(_context: vscode.ExtensionContext) {
    // Branch monitoring is temporarily disabled for multi-repo refactoring
}

