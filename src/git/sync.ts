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
    runCommand, 
    sanitizeBranchNameForDrive, 
    restoreBranchNameFromDrive 
} from '../utils/common';
import { getAuthenticatedClient } from '../googleDrive/auth';
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

let lastKnownBranches = new Set<string>();

export async function initialUpload(context: vscode.ExtensionContext) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;
    try {
        const currentBranch = await getCurrentBranch(workspaceRoot);
        if (!currentBranch) return;
        await context.workspaceState.update(`${LAST_PUSHED_HASH_KEY_PREFIX}${currentBranch}`, undefined);
        vscode.window.showInformationMessage(`Статус синхронизации для ветки '${currentBranch}' сброшен. Начинаю новую выгрузку...`);
        const drive = await getAuthenticatedClient(context);
        if (!drive) return;
        const bundleFolderId = await findOrCreateProjectFolders(drive, workspaceRoot, context);
        if (!bundleFolderId) throw new Error('Could not find or create project folder on Google Drive.');
        const remoteRefs = await getRemoteRefs(drive, bundleFolderId);
        await pushCommits(context, drive, bundleFolderId, remoteRefs, false);
    } catch (error: any) {
        vscode.window.showErrorMessage(`Первоначальная выгрузка не удалась: ${error.message}`);
    }
}

export async function sync(context: vscode.ExtensionContext, silent: boolean = false) {
    if (!silent) vscode.window.showInformationMessage('Syncing with Google Drive...');
    try {
        const drive = await getAuthenticatedClient(context);
        if (!drive) return;
        const workspaceRoot = getWorkspaceRoot();
        if (!workspaceRoot) return;
        const bundleFolderId = await findOrCreateProjectFolders(drive, workspaceRoot, context);
        if (!bundleFolderId) throw new Error('Could not find or create project folder on Google Drive.');
        const remoteRefs = await getRemoteRefs(drive, bundleFolderId);
        await checkRemoteBranchTombstones(context, drive, silent);
        await pullCommits(context, drive, bundleFolderId, remoteRefs, silent);
        await pushCommits(context, drive, bundleFolderId, remoteRefs, silent);
        if (!silent) vscode.window.showInformationMessage('Sync finished.');
    } catch (error: any) {
        if (silent) {
            console.error(`Sync failed: ${error.message}`);
            vscode.window.showErrorMessage(`Background sync failed: ${error.message}.`);
        } else {
            vscode.window.showErrorMessage(`Sync failed: ${error.message}`, { modal: true });
        }
    }
}

async function checkRemoteBranchTombstones(context: vscode.ExtensionContext, drive: drive_v3.Drive, silent: boolean = false) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;
    try {
        const tombstonesFolderId = await findOrCreateTombstonesFolder(drive, workspaceRoot, context);
        const branchTombstonesFolderId = await findOrCreateSubFolder(drive, tombstonesFolderId, 'branches', context);
        const { data: { files: tombstones } } = await drive.files.list({
            q: `'${branchTombstonesFolderId}' in parents and trashed=false`,
            fields: 'files(id, name)'
        });
        if (!tombstones || tombstones.length === 0) return;
        const localBranches = await getLocalBranches(workspaceRoot);
        const processedTombstones = context.workspaceState.get<Record<string, boolean>>(PROCESSED_TOMBSTONES_KEY, {});
        for (const tombstone of tombstones) {
            const branchName = restoreBranchNameFromDrive(tombstone.name || '');
            if (localBranches.includes(branchName) && tombstone.id && !processedTombstones[tombstone.id]) {
                const choice = await vscode.window.showWarningMessage(
                    `Ветка '${branchName}' была удалена на другом компьютере. Удалить её локально?`,
                    'Да', 'Нет'
                );
                if (choice === 'Да') {
                    try {
                        await runCommand(`git branch -D ${branchName}`, workspaceRoot);
                        if (!silent) vscode.window.showInformationMessage(`Ветка '${branchName}' удалена локально.`);
                        const current = await getCurrentBranch(workspaceRoot);
                        if (current === branchName) {
                            const defaultBranch = localBranches.includes('main') ? 'main' : (localBranches.includes('master') ? 'master' : null);
                            if (defaultBranch) await runCommand(`git checkout ${defaultBranch}`, workspaceRoot);
                        }
                    } catch (e: any) {
                        vscode.window.showErrorMessage(`Не удалось удалить ветку '${branchName}': ${e.message}`);
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

async function pushCommits(context: vscode.ExtensionContext, drive: drive_v3.Drive, bundleFolderId: string, remoteRefs: any, silent: boolean = false) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;
    const currentBranch = await getCurrentBranch(workspaceRoot);
    const remoteBranchHead = remoteRefs[currentBranch];
    const lastPushedHash = remoteBranchHead || context.workspaceState.get(`${LAST_PUSHED_HASH_KEY_PREFIX}${currentBranch}`);
    let currentHead;
    try {
        const headRes = await runCommand('git rev-parse HEAD', workspaceRoot);
        currentHead = headRes.stdout.trim();
    } catch (e) {
        vscode.window.showWarningMessage('Репозиторий пуст. Сделайте хотя бы один коммит.', { modal: true });
        return;
    }
    if (lastPushedHash === currentHead) {
        if (!silent) vscode.window.showInformationMessage('Already up-to-date.');
        return;
    }
    if (lastPushedHash) {
        try {
            await runCommand(`git merge-base --is-ancestor ${lastPushedHash} HEAD`, workspaceRoot);
        } catch (error) {
            vscode.window.showErrorMessage('Push aborted: History has been rewritten.');
            return;
        }
    }
    const revisionRange = lastPushedHash ? `${lastPushedHash}..HEAD` : 'HEAD';
    const { stdout: commitsToPush } = await runCommand(`git rev-list ${revisionRange}`, workspaceRoot);
    if (!commitsToPush.trim()) return;
    const sanitizedBranchName = sanitizeBranchNameForDrive(currentBranch);
    const bundleFileName = `${sanitizedBranchName}--${currentHead}.bundle`;
    const bundlePath = path.join(workspaceRoot, '.git', bundleFileName);
    try {
        await runCommand(`git bundle create \"${bundlePath}\" ${revisionRange}`, workspaceRoot);
        const media = { mimeType: 'application/octet-stream', body: fsSync.createReadStream(bundlePath) };
        await drive.files.create({ requestBody: { name: bundleFileName, parents: [bundleFolderId] }, media: media });
        remoteRefs[currentBranch] = currentHead;
        await updateRemoteRefs(drive, bundleFolderId, remoteRefs);
        await context.workspaceState.update(`${LAST_PUSHED_HASH_KEY_PREFIX}${currentBranch}`, currentHead);
    } catch (error: any) {
        vscode.window.showErrorMessage(`Push failed: ${error.message}`);
    } finally {
        if (fsSync.existsSync(bundlePath)) await fs.unlink(bundlePath);
    }
}

async function pullCommits(context: vscode.ExtensionContext, drive: drive_v3.Drive, bundleFolderId: string, remoteRefs: any, silent: boolean = false) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;
    const q = `'${bundleFolderId}' in parents and trashed=false and fileExtension='bundle'`;
    const { data: { files: allRemoteBundles } } = await drive.files.list({ q, fields: 'files(id, name, createdTime)', orderBy: 'createdTime' });
    if (!allRemoteBundles || allRemoteBundles.length === 0) return;
    const localBranches = new Set(await getLocalBranches(workspaceRoot));
    const currentBranch = await getCurrentBranch(workspaceRoot);
    const remoteBundlesByBranch = new Map<string, any[]>();
    for (const bundle of allRemoteBundles) {
        const parts = (bundle.name || '').split('--');
        if (parts.length < 2) continue;
        const branchName = restoreBranchNameFromDrive(parts[0]);
        if (!remoteBundlesByBranch.has(branchName)) remoteBundlesByBranch.set(branchName, []);
        remoteBundlesByBranch.get(branchName)!.push(bundle);
    }
    const tempDir = path.join(workspaceRoot, '.git', 'gdrive-temp-bundles');
    await fs.mkdir(tempDir, { recursive: true });
    try {
        for (const [branchName, bundles] of remoteBundlesByBranch.entries()) {
            if (localBranches.has(branchName)) {
                if (branchName !== currentBranch) continue;
                const { stdout: currentCommits } = await runCommand(`git rev-list ${branchName}`, workspaceRoot);
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
                    await runCommand(`git fetch \"${bPath}\"`, workspaceRoot);
                    lastHash = bundle.name.split('--')[1]?.replace('.bundle', '');
                }
                try {
                    await runCommand(`git merge --ff-only FETCH_HEAD`, workspaceRoot);
                } catch (e) {
                    try {
                        await runCommand(`git merge --no-edit FETCH_HEAD`, workspaceRoot);
                    } catch (mError) {
                        if (silent) await runCommand(`git merge --abort`, workspaceRoot).catch(() => {});
                        throw mError;
                    }
                }
                const remoteHead = remoteRefs[branchName] || lastHash;
                if (remoteHead) await context.workspaceState.update(`${LAST_PUSHED_HASH_KEY_PREFIX}${branchName}`, remoteHead);
            } else {
                const choice = await vscode.window.showInformationMessage(`Found new branch '${branchName}'. Create local?`, 'Yes');
                if (choice === 'Yes') {
                    let lastHash = '';
                    for (const bundle of bundles) {
                        const bPath = path.join(tempDir, bundle.name);
                        await downloadFile(drive, bundle.id, bPath);
                        await runCommand(`git fetch \"${bPath}\"`, workspaceRoot);
                        lastHash = bundle.name.split('--')[1]?.replace('.bundle', '');
                    }
                    if (lastHash) {
                        await runCommand(`git checkout -b ${branchName} ${lastHash}`, workspaceRoot);
                        await context.workspaceState.update(`${LAST_PUSHED_HASH_KEY_PREFIX}${branchName}`, lastHash);
                    }
                }
            }
        }
    } finally {
        if (fsSync.existsSync(tempDir)) await fs.rm(tempDir, { recursive: true, force: true });
    }
}

export async function installGitHooks(_context: vscode.ExtensionContext) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;
    const hooksDir = path.join(workspaceRoot, '.git', 'hooks');
    const postCommitHookPath = path.join(hooksDir, 'post-commit');
    const postCommitScript = `#!/bin/sh\n# Hook to trigger VS Code sync after commit\ntouch .git/SYNC_REQUEST\n`;
    try {
        await fs.mkdir(hooksDir, { recursive: true });
        await fs.writeFile(postCommitHookPath, postCommitScript);
        await fs.chmod(postCommitHookPath, '755');
        vscode.window.showInformationMessage('Successfully installed post-commit hook!');
    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to install git hooks: ${error.message}`);
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
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;
    const currentBranch = await getCurrentBranch(workspaceRoot);
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
        const { stdout } = await runCommand('git log -10 --pretty=format:"%H|%s"', workspaceRoot);
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
        const bundleFolderId = await findOrCreateProjectFolders(drive, workspaceRoot, context);
        if (bundleFolderId) {
            const remoteRefs = await getRemoteRefs(drive, bundleFolderId);
            if (newHash === undefined) delete remoteRefs[currentBranch]; else remoteRefs[currentBranch] = newHash;
            await updateRemoteRefs(drive, bundleFolderId, remoteRefs);
        }
    }
}

export async function setupBranchMonitoring(context: vscode.ExtensionContext) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;
    try {
        const branches = await getLocalBranches(workspaceRoot);
        lastKnownBranches = new Set(branches);
    } catch (e) {}
    const gitExtension = vscode.extensions.getExtension('vscode.git');
    if (gitExtension) {
        const api = gitExtension.exports.getAPI(1);
        api.onDidOpenRepository((repo: any) => repo.state.onDidChange(() => checkForBranchChanges(context)));
        api.repositories.forEach((repo: any) => repo.state.onDidChange(() => checkForBranchChanges(context)));
    } else {
        setInterval(() => checkForBranchChanges(context), 30000);
    }
}

async function checkForBranchChanges(context: vscode.ExtensionContext) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;
    try {
        const currentBranches = await getLocalBranches(workspaceRoot);
        const currentBranchesSet = new Set(currentBranches);
        for (const branch of Array.from(lastKnownBranches)) {
            if (!currentBranchesSet.has(branch)) await offerToDeleteBranchFromDrive(context, branch);
        }
        lastKnownBranches = currentBranchesSet;
    } catch (e) {}
}

async function offerToDeleteBranchFromDrive(context: vscode.ExtensionContext, branchName: string) {
    const choice = await vscode.window.showInformationMessage(`Ветка '${branchName}' была удалена. Удалить её из Drive?`, 'Да', 'Нет');
    if (choice === 'Да') await deleteBranchFromDrive(context, branchName);
}

async function deleteBranchFromDrive(context: vscode.ExtensionContext, branchName: string) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;
    const drive = await getAuthenticatedClient(context);
    if (!drive) return;
    try {
        const projectFolderId = await findOrCreateBaseProjectFolder(drive, workspaceRoot, context);
        const bundleFolderId = await ensureSingleFolder(drive, projectFolderId, 'bundles', context);
        const sanitizedName = sanitizeBranchNameForDrive(branchName);
        const q = `'${bundleFolderId}' in parents and name contains '${sanitizedName}--' and trashed=false`;
        const res = await drive.files.list({ q, fields: 'files(id, name)' });
        for (const file of res.data.files || []) {
            if (file.id && file.name?.startsWith(`${sanitizedName}--`)) await drive.files.update({ fileId: file.id, requestBody: { trashed: true } });
        }
        const tombstonesFolderId = await ensureSingleFolder(drive, projectFolderId, 'tombstones', context);
        const branchTombstonesFolderId = await ensureSingleFolder(drive, tombstonesFolderId, 'branches', context);
        await drive.files.create({ requestBody: { name: sanitizedName, parents: [branchTombstonesFolderId], mimeType: 'text/plain' }, media: { mimeType: 'text/plain', body: `Deleted at ${new Date().toISOString()}` } });
        await context.workspaceState.update(`${LAST_PUSHED_HASH_KEY_PREFIX}${branchName}`, undefined);
    } catch (error: any) {}
}
