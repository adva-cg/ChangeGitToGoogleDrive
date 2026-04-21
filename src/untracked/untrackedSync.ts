import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
import * as fsSync from 'fs';
import { minimatch } from 'minimatch';
import { CONFLICT_DECISIONS_KEY, LAST_KNOWN_UNTRACKED_FILES_KEY } from '../constants';
import { 
    getGitRepositories,
    GitRepository,
    runCommand, 
    getFileMd5, 
    getFilesRecursively 
} from '../utils/common';
import { getAuthenticatedClient } from '../googleDrive/auth';
import { 
    findOrCreateBaseProjectFolder, 
    findOrCreateUntrackedFilesFolder,
    getAllRemoteFiles,
    downloadFile,
    uploadFile,
    updateFile,
    findRemoteFile,
    ensureSingleFolder
} from '../googleDrive/operations';
import { LockManager } from '../googleDrive/lockManager';
import { 
    getConflictDecisions, 
    setConflictDecision, 
    getEffectiveConfig, 
    updateCloudConfig 
} from './decisions';

export async function syncUntrackedFiles(context: vscode.ExtensionContext, silent: boolean = false, repo?: GitRepository) {
    if (!repo) {
        const repos = await getGitRepositories();
        for (const r of repos) {
            await syncUntrackedFiles(context, silent, r);
        }
        return;
    }

    const { root: repoRoot, name: repoName } = repo;
    const drive = await getAuthenticatedClient(context);
    if (!drive) return;

    const projectFolderId = await findOrCreateBaseProjectFolder(drive, repoRoot, context);
    if (!projectFolderId) throw new Error(`Could not find or create project folder for ${repoName} on Google Drive.`);

    // Acquire Lock
    const lockAcquired = await LockManager.acquireLock(drive, projectFolderId, 'untracked', `Untracked Sync: ${repoName}`, silent, repoRoot);
    if (!lockAcquired) return;

    if (!silent) vscode.window.showInformationMessage(`[${repoName}] Синхронизация неотслеживаемых файлов...`);
    try {
        const untrackedFolderId = await findOrCreateUntrackedFilesFolder(drive, repoRoot, context);
        const deletedFolderId = await ensureSingleFolder(drive, untrackedFolderId, '.deleted', context);
        const tombstones = await getAllRemoteFiles(drive, deletedFolderId, true);
        const tombstoneSet = new Set(tombstones.map(f => f.name));
        const decisions = getConflictDecisions(context);
        let config = await getEffectiveConfig(drive, projectFolderId);
        const localFiles = await getUntrackedAndIgnoredFiles(repoRoot);
        const remoteFiles = await getAllRemoteFiles(drive, untrackedFolderId);
        const machineId = vscode.env.machineId;

        // Detect manual local deletions
        const lastKnownFiles: string[] = context.workspaceState.get(`${LAST_KNOWN_UNTRACKED_FILES_KEY}_${repoName}`, []);
        const lastKnownFilesSet = new Set(lastKnownFiles);
        const currentFilesSet = new Set(localFiles);
        const remoteFilesMap = new Map(remoteFiles.map(f => [f.name, f]));
        
        const disappearedFiles = remoteFiles.filter(f => {
            const isMissingLocally = !currentFilesSet.has(f.name);
            const wasKnownLocally = lastKnownFilesSet.has(f.name);
            const isSameMachine = f.appProperties?.machineId === machineId;
            const isNotTombstone = !tombstoneSet.has(f.name);
            
            return isMissingLocally && isNotTombstone && (wasKnownLocally || isSameMachine);
        }).map(f => f.name);

        if (disappearedFiles.length > 0) {
            const choice = await vscode.window.showWarningMessage(
                `[${repoName}] Detected ${disappearedFiles.length} locally deleted files. Mark them as deleted on Google Drive too?`,
                'Yes', 'No'
            );
            if (choice === 'Yes') {
                for (const relPath of disappearedFiles) {
                    const remote = remoteFilesMap.get(relPath);
                    if (remote && remote.id) {
                        const { data: { parents } } = await drive.files.get({ fileId: remote.id, fields: 'parents' });
                        if (parents?.length && parents[0]) {
                            await drive.files.update({ fileId: remote.id, addParents: deletedFolderId, removeParents: parents[0] });
                        }
                    }
                }
                // Refresh remote files
                const updatedRemoteFiles = await getAllRemoteFiles(drive, untrackedFolderId);
                remoteFiles.splice(0, remoteFiles.length, ...updatedRemoteFiles);
            }
        }

        for (const remoteFile of remoteFiles) {
            const localPath = path.join(repoRoot, remoteFile.name);
            if (!fsSync.existsSync(localPath) && !isFileIncluded(remoteFile.name, config.include, config.exclude)) {
                const decisionKey = `suggest_track_${repoName}_${remoteFile.name}`;
                if (decisions[decisionKey]) continue;
                const choice = await vscode.window.showInformationMessage(`[${repoName}] Found new file on Drive: "${remoteFile.name}". Track it?`, 'Yes', 'No', 'Never');
                if (choice === 'Yes') {
                    config.include.push(remoteFile.name);
                    await updateCloudConfig(drive, projectFolderId, config);
                } else if (choice === 'Never') {
                    await setConflictDecision(context, { key: decisionKey, data: { decision: 'ignore_suggestion' } });
                }
            }
        }

        for (const tombstonePath of tombstoneSet) {
            const localPath = path.join(repoRoot, tombstonePath);
            if (fsSync.existsSync(localPath)) {
                const choice = await vscode.window.showWarningMessage(`[${repoName}] File "${tombstonePath}" was deleted elsewhere. Delete local?`, 'Yes', 'No');
                if (choice === 'Yes') await fs.unlink(localPath);
            }
        }

        for (const remoteFile of remoteFiles) {
            if (tombstoneSet.has(remoteFile.name) || !isFileIncluded(remoteFile.name, config.include, config.exclude)) continue;
            const localPath = path.join(repoRoot, remoteFile.name);
            if (fsSync.existsSync(localPath)) {
                const localMd5 = await getFileMd5(localPath);
                if (localMd5 !== remoteFile.md5Checksum) {
                    if (remoteFile.appProperties?.machineId === machineId) continue;
                    const choice = await vscode.window.showQuickPick(['Download', 'Upload', 'Skip'], { placeHolder: `Conflict [${repoName}]: ${remoteFile.name}` });
                    if (choice === 'Download' && remoteFile.id) await downloadFile(drive, remoteFile.id, localPath);
                    else if (choice === 'Upload' && remoteFile.id) await updateFile(drive, remoteFile.id, localPath, machineId);
                }
            } else {
                if (remoteFile.id) await downloadFile(drive, remoteFile.id, localPath);
            }
        }

        const remoteFileNames = new Set(remoteFiles.map(f => f.name));
        for (const relPath of localFiles) {
            if (remoteFileNames.has(relPath) || tombstoneSet.has(relPath) || !isFileIncluded(relPath, config.include, config.exclude)) continue;
            await uploadFile(drive, untrackedFolderId, path.join(repoRoot, relPath), relPath, machineId);
        }

        // Update last known state
        await context.workspaceState.update(`${LAST_KNOWN_UNTRACKED_FILES_KEY}_${repoName}`, localFiles);
    } catch (e: any) {
        vscode.window.showErrorMessage(`[${repoName}] Sync failed: ${e.message}`);
    } finally {
        await LockManager.releaseLock(drive, 'untracked', repoRoot);
    }
}

export async function uploadUntrackedFiles(context: vscode.ExtensionContext, silent: boolean = false, repo?: GitRepository) {
    if (!repo) {
        const repos = await getGitRepositories();
        for (const r of repos) {
            await uploadUntrackedFiles(context, silent, r);
        }
        return;
    }

    const { root: repoRoot, name: repoName } = repo;
    const drive = await getAuthenticatedClient(context);
    if (!drive) return;
    const projectFolderId = await findOrCreateBaseProjectFolder(drive, repoRoot, context);
    if (!projectFolderId) return;

    // Acquire Lock (silent background sync)
    const lockAcquired = await LockManager.acquireLock(drive, projectFolderId, 'untracked', `Untracked Background Sync: ${repoName}`, true, repoRoot);
    if (!lockAcquired) return;

    try {
        const untrackedFolderId = await findOrCreateUntrackedFilesFolder(drive, repoRoot, context);
        const config = await getEffectiveConfig(drive, projectFolderId);
        const allFiles = await getUntrackedAndIgnoredFiles(repoRoot);
        const toUpload = allFiles.filter(f => isFileIncluded(f, config.include, config.exclude));
        const machineId = vscode.env.machineId;
        for (const relPath of toUpload) {
            const absPath = path.join(repoRoot, relPath);
            const remoteFile = await findRemoteFile(drive, untrackedFolderId, relPath);
            if (remoteFile) {
                const localMd5 = await getFileMd5(absPath);
                if (localMd5 !== remoteFile.md5Checksum && remoteFile.appProperties?.machineId === machineId && remoteFile.id) {
                    await updateFile(drive, remoteFile.id, absPath, machineId);
                }
            } else {
                await uploadFile(drive, untrackedFolderId, absPath, relPath, machineId);
            }
        }
    } catch (e: any) {
    } finally {
        await LockManager.releaseLock(drive, 'untracked', repoRoot);
    }
}

export async function deleteUntrackedFile(context: vscode.ExtensionContext) {
    const repos = await getGitRepositories();
    if (repos.length === 0) return;
    
    let repo = repos[0];
    if (repos.length > 1) {
        const selected = await vscode.window.showQuickPick(repos.map(r => ({ label: r.name, repo: r })), { placeHolder: 'Выберите репозиторий' });
        if (!selected) return;
        repo = selected.repo;
    }

    const { root: repoRoot, name: repoName } = repo;
    const drive = await getAuthenticatedClient(context);
    if (!drive) return;
    try {
        const projectFolderId = await findOrCreateBaseProjectFolder(drive, repoRoot, context);
        const untrackedFolderId = await findOrCreateUntrackedFilesFolder(drive, repoRoot, context);
        const config = await getEffectiveConfig(drive, projectFolderId);
        const localFiles = await getUntrackedAndIgnoredFiles(repoRoot);
        const filesToList = localFiles.filter(f => isFileIncluded(f, config.include, config.exclude));
        const selected = await vscode.window.showQuickPick(filesToList, { canPickMany: true });
        if (!selected?.length) return;
        const choices = await vscode.window.showWarningMessage(`[${repoName}] Delete ${selected.length} files?`, 'Yes');
        if (choices !== 'Yes') return;
        const deletedFolderId = await ensureSingleFolder(drive, untrackedFolderId, '.deleted', context);
        if (!deletedFolderId) return;
        for (const file of selected) {
            const remote = await findRemoteFile(drive, untrackedFolderId, file);
            if (remote && remote.id) {
                const { data: { parents } } = await drive.files.get({ fileId: remote.id, fields: 'parents' });
                if (parents?.length && parents[0]) await drive.files.update({ fileId: remote.id, addParents: deletedFolderId, removeParents: parents[0] });
            }
            await fs.unlink(path.join(repoRoot, file));
        }
    } catch (e: any) {}
}

export async function clearTombstones(context: vscode.ExtensionContext) {
    const repos = await getGitRepositories();
    if (repos.length === 0) return;
    
    let repo = repos[0];
    if (repos.length > 1) {
        const selected = await vscode.window.showQuickPick(repos.map(r => ({ label: r.name, repo: r })), { placeHolder: 'Выберите репозиторий для очистки корзины' });
        if (!selected) return;
        repo = selected.repo;
    }

    const { root: repoRoot, name: repoName } = repo;
    const drive = await getAuthenticatedClient(context);
    if (!drive) return;
    try {
        const untrackedFolderId = await findOrCreateUntrackedFilesFolder(drive, repoRoot, context);
        const deletedFolderId = await ensureSingleFolder(drive, untrackedFolderId, '.deleted', context);
        const tombstones = await getAllRemoteFiles(drive, deletedFolderId, true);
        if (!tombstones.length) return;
        const choice = await vscode.window.showWarningMessage(`[${repoName}] Clear ${tombstones.length} files from trash?`, 'Yes');
        if (choice === 'Yes') {
            for (const t of tombstones) if (t.id) await drive.files.delete({ fileId: t.id });
            await context.workspaceState.update(CONFLICT_DECISIONS_KEY, {});
        }
    } catch (e: any) {}
}

export async function getUntrackedAndIgnoredFiles(workspaceRoot: string) {
    try {
        const { stdout: filesStr } = await runCommand('git -c core.quotePath=false ls-files --others --ignored --exclude-standard', workspaceRoot);
        const files = filesStr.trim().split(/\r\n|\n/).filter(f => f);
        const { stdout: dirsStr } = await runCommand('git -c core.quotePath=false ls-files --others --ignored --exclude-standard --directory', workspaceRoot);
        const { stdout: utDirsStr } = await runCommand('git -c core.quotePath=false ls-files --others --exclude-standard --directory', workspaceRoot);
        const dirs = [...new Set([...dirsStr.split(/\r\n|\n/).filter(d => d), ...utDirsStr.split(/\r\n|\n/).filter(d => d)])];
        let all = new Set(files);
        for (const dir of dirs) {
            const sanitized = dir.replace(/\\/g, '/').replace(/\/$/, '');
            const full = path.join(workspaceRoot, sanitized);
            try {
                if ((await fs.stat(full)).isDirectory()) {
                    const subFiles = await getFilesRecursively(full, workspaceRoot);
                    subFiles.forEach(f => all.add(f));
                } else all.add(sanitized);
            } catch (e) {}
        }
        return Array.from(all).sort();
    } catch (e) { return []; }
}

export function isFileIncluded(filePath: string, includePatterns: string[], excludePatterns: string[]) {
    if (!includePatterns?.length) return false;
    const sanitize = (p: string) => p.replace(/\\/g, '/').replace(/\/$/, '');
    const incs = includePatterns.map(sanitize);
    const excs = (excludePatterns || []).map(sanitize);
    const check = (f: string, p: string) => minimatch(f, p, { matchBase: true }) || f.startsWith(p + '/') || f === p;
    if (!incs.some(p => check(filePath, p))) return false;
    return !excs.some(p => check(filePath, p));
}
