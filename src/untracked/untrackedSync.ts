import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
import * as fsSync from 'fs';
import { minimatch } from 'minimatch';
import { CONFLICT_DECISIONS_KEY } from '../constants';
import { 
    getWorkspaceRoot, 
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
import { 
    getConflictDecisions, 
    setConflictDecision, 
    getEffectiveConfig, 
    updateCloudConfig 
} from './decisions';

export async function syncUntrackedFiles(context: vscode.ExtensionContext, silent: boolean = false) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;
    const drive = await getAuthenticatedClient(context);
    if (!drive) return;
    if (!silent) vscode.window.showInformationMessage('Синхронизация неотслеживаемых файлов...');
    try {
        const projectFolderId = await findOrCreateBaseProjectFolder(drive, workspaceRoot, context);
        const untrackedFolderId = await findOrCreateUntrackedFilesFolder(drive, workspaceRoot, context);
        const deletedFolderId = await ensureSingleFolder(drive, untrackedFolderId, '.deleted', context);
        const tombstones = await getAllRemoteFiles(drive, deletedFolderId, true);
        const tombstoneSet = new Set(tombstones.map(f => f.name));
        const decisions = getConflictDecisions(context);
        let config = await getEffectiveConfig(drive, projectFolderId);
        const localFiles = await getUntrackedAndIgnoredFiles(workspaceRoot);
        const remoteFiles = await getAllRemoteFiles(drive, untrackedFolderId);
        const machineId = vscode.env.machineId;

        for (const remoteFile of remoteFiles) {
            const localPath = path.join(workspaceRoot, remoteFile.name);
            if (!fsSync.existsSync(localPath) && !isFileIncluded(remoteFile.name, config.include, config.exclude)) {
                const decisionKey = `suggest_track_${remoteFile.name}`;
                if (decisions[decisionKey]) continue;
                const choice = await vscode.window.showInformationMessage(`Found new file on Drive: "${remoteFile.name}". Track it?`, 'Yes', 'No', 'Never');
                if (choice === 'Yes') {
                    config.include.push(remoteFile.name);
                    await updateCloudConfig(drive, projectFolderId, config);
                } else if (choice === 'Never') {
                    await setConflictDecision(context, { key: decisionKey, data: { decision: 'ignore_suggestion' } });
                }
            }
        }

        for (const tombstonePath of tombstoneSet) {
            const localPath = path.join(workspaceRoot, tombstonePath);
            if (fsSync.existsSync(localPath)) {
                const choice = await vscode.window.showWarningMessage(`File "${tombstonePath}" was deleted elsewhere. Delete local?`, 'Yes', 'No');
                if (choice === 'Yes') await fs.unlink(localPath);
            }
        }

        for (const remoteFile of remoteFiles) {
            if (tombstoneSet.has(remoteFile.name) || !isFileIncluded(remoteFile.name, config.include, config.exclude)) continue;
            const localPath = path.join(workspaceRoot, remoteFile.name);
            if (fsSync.existsSync(localPath)) {
                const localMd5 = await getFileMd5(localPath);
                if (localMd5 !== remoteFile.md5Checksum) {
                    if (remoteFile.appProperties?.machineId === machineId) continue;
                    const choice = await vscode.window.showQuickPick(['Download', 'Upload', 'Skip'], { placeHolder: `Conflict: ${remoteFile.name}` });
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
            await uploadFile(drive, untrackedFolderId, path.join(workspaceRoot, relPath), relPath, machineId);
        }
    } catch (e: any) {
        vscode.window.showErrorMessage(`Sync failed: ${e.message}`);
    }
}

export async function uploadUntrackedFiles(context: vscode.ExtensionContext, _silent: boolean = false) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;
    const drive = await getAuthenticatedClient(context);
    if (!drive) return;
    try {
        const projectFolderId = await findOrCreateBaseProjectFolder(drive, workspaceRoot, context);
        const untrackedFolderId = await findOrCreateUntrackedFilesFolder(drive, workspaceRoot, context);
        const config = await getEffectiveConfig(drive, projectFolderId);
        const allFiles = await getUntrackedAndIgnoredFiles(workspaceRoot);
        const toUpload = allFiles.filter(f => isFileIncluded(f, config.include, config.exclude));
        const machineId = vscode.env.machineId;
        for (const relPath of toUpload) {
            const absPath = path.join(workspaceRoot, relPath);
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
    } catch (e: any) {}
}

export async function deleteUntrackedFile(context: vscode.ExtensionContext) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;
    const drive = await getAuthenticatedClient(context);
    if (!drive) return;
    try {
        const projectFolderId = await findOrCreateBaseProjectFolder(drive, workspaceRoot, context);
        const untrackedFolderId = await findOrCreateUntrackedFilesFolder(drive, workspaceRoot, context);
        const config = await getEffectiveConfig(drive, projectFolderId);
        const localFiles = await getUntrackedAndIgnoredFiles(workspaceRoot);
        const filesToList = localFiles.filter(f => isFileIncluded(f, config.include, config.exclude));
        const selected = await vscode.window.showQuickPick(filesToList, { canPickMany: true });
        if (!selected?.length) return;
        const choices = await vscode.window.showWarningMessage(`Delete ${selected.length} files?`, 'Yes');
        if (choices !== 'Yes') return;
        const deletedFolderId = await ensureSingleFolder(drive, untrackedFolderId, '.deleted', context);
        if (!deletedFolderId) return;
        for (const file of selected) {
            const remote = await findRemoteFile(drive, untrackedFolderId, file);
            if (remote && remote.id) {
                const { data: { parents } } = await drive.files.get({ fileId: remote.id, fields: 'parents' });
                if (parents?.length && parents[0]) await drive.files.update({ fileId: remote.id, addParents: deletedFolderId, removeParents: parents[0] });
            }
            await fs.unlink(path.join(workspaceRoot, file));
        }
    } catch (e: any) {}
}

export async function clearTombstones(context: vscode.ExtensionContext) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;
    const drive = await getAuthenticatedClient(context);
    if (!drive) return;
    try {
        const untrackedFolderId = await findOrCreateUntrackedFilesFolder(drive, workspaceRoot, context);
        const deletedFolderId = await ensureSingleFolder(drive, untrackedFolderId, '.deleted', context);
        const tombstones = await getAllRemoteFiles(drive, deletedFolderId, true);
        if (!tombstones.length) return;
        const choice = await vscode.window.showWarningMessage(`Clear ${tombstones.length} files from trash?`, 'Yes');
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
