import * as vscode from 'vscode';
import * as path from 'path';
import * as fsSync from 'fs';
import { promises as fs } from 'fs';
import { drive_v3 } from 'googleapis';
import { BACKUPS_DIR_NAME } from '../constants';
import { getWorkspaceRoot, escapeGdriveQueryParam } from '../utils/common';

export async function downloadFile(drive: drive_v3.Drive, fileId: string, destPath: string) {
    const destDir = path.dirname(destPath);
    await fs.mkdir(destDir, { recursive: true });
    const dest = fsSync.createWriteStream(destPath);
    const { data: fileStream } = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
    await new Promise((resolve, reject) => {
        (fileStream as any).pipe(dest)
            .on('finish', resolve)
            .on('error', (error: any) => {
                if (error.code === 'EBUSY' || error.code === 'EPERM') {
                    vscode.window.showInformationMessage(`File is locked, skipping for now: ${path.basename(destPath)}`);
                    try { fsSync.unlinkSync(destPath); } catch (e) { }
                    resolve(undefined);
                } else {
                    reject(error);
                }
            });
    });
}

export async function uploadFile(drive: drive_v3.Drive, folderId: string, filePath: string, relativePath: string, machineId: string) {
    const fileName = relativePath.replace(/\\/g, '/');
    const media = { mimeType: 'application/octet-stream', body: fsSync.createReadStream(filePath) };
    await drive.files.create({
        requestBody: { name: fileName, parents: [folderId], appProperties: { machineId } },
        media: media,
        fields: 'id',
    });
}

export async function updateFile(drive: drive_v3.Drive, fileId: string, filePath: string, machineId: string) {
    const media = { mimeType: 'application/octet-stream', body: fsSync.createReadStream(filePath) };
    await drive.files.update({
        fileId: fileId,
        requestBody: { appProperties: { machineId } },
        media: media,
        fields: 'id',
    });
}

export async function findRemoteFile(drive: drive_v3.Drive, folderId: string, fileName: string) {
    const escapedFileName = escapeGdriveQueryParam(fileName);
    const q = `'${folderId}' in parents and name = '${escapedFileName}' and trashed=false`;
    const res = await drive.files.list({ q, fields: 'files(id, name, md5Checksum, appProperties)' });
    const files = res.data.files || [];
    return files[0];
}

export async function getAllRemoteFiles(drive: drive_v3.Drive, folderId: string, recursive: boolean = false, prefix: string = '') {
    let files: any[] = [];
    let pageToken: string | undefined = undefined;
    do {
        const res: any = await drive.files.list({
            q: `'${folderId}' in parents and trashed=false and name != '.deleted'`,
            fields: 'nextPageToken, files(id, name, md5Checksum, appProperties, mimeType, modifiedTime)',
            pageToken: pageToken,
        });
        
        const currentFiles = res.data.files || [];
        for (const file of currentFiles) {
            const fullName = prefix ? `${prefix}/${file.name}` : file.name;
            if (recursive && file.mimeType === 'application/vnd.google-apps.folder' && file.id) {
                const subFiles = await getAllRemoteFiles(drive, file.id, true, fullName);
                files = files.concat(subFiles);
            } else {
                files.push({ ...file, name: fullName });
            }
        }
        pageToken = res.data.nextPageToken || undefined;
    } while (pageToken);
    return files;
}

export async function ensureSingleFolder(drive: drive_v3.Drive, parentId: string | null | undefined, folderName: string, context?: vscode.ExtensionContext) {
    const q = `name='${escapeGdriveQueryParam(folderName)}' and mimeType='application/vnd.google-apps.folder' and ${parentId ? `'${parentId}' in parents` : "'root' in parents"} and trashed=false`;
    const res = await drive.files.list({ q, fields: 'files(id, name, createdTime)' });
    const files = res.data.files || [];
    if (files.length === 0) {
        const requestBody: any = { name: folderName, mimeType: 'application/vnd.google-apps.folder' };
        if (parentId) requestBody.parents = [parentId];
        const { data } = await drive.files.create({ requestBody, fields: 'id' });
        return data.id;
    } else if (files.length === 1) {
        return files[0].id;
    } else {
        return await reconcileFolderDuplicates(drive, files, folderName, parentId, context as vscode.ExtensionContext);
    }
}

export async function reconcileFolderDuplicates(drive: drive_v3.Drive, folders: any[], folderName: string, parentId: string | null | undefined, context: vscode.ExtensionContext) {
    vscode.window.showInformationMessage(`Обнаружены дубликаты папки "${folderName}". Начинаю автоматическое объединение...`);
    folders.sort((a, b) => new Date(a.createdTime).getTime() - new Date(b.createdTime).getTime());
    const primaryFolder = folders[0];
    const duplicates = folders.slice(1);
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return undefined;

    const backupBaseId = await findOrCreateBackupsFolder(drive, workspaceRoot, context);
    if (!backupBaseId) throw new Error('Could not find or create backups folder');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupSessionId = await ensureSingleFolder(drive, (backupBaseId as string | null), `merge_${folderName}_${timestamp}`, context) as string;

    for (const dup of duplicates) {
        if (primaryFolder.id && dup.id && backupSessionId) {
            await mergeFoldersRecursive(drive, primaryFolder.id, dup.id, backupSessionId);
            await drive.files.update({
                fileId: dup.id,
                addParents: backupSessionId,
                removeParents: (parentId as string) || 'root',
                requestBody: {}
            });
        }
    }
    return primaryFolder.id;
}

export async function mergeFoldersRecursive(drive: drive_v3.Drive, targetFolderId: string, sourceFolderId: string, backupFolderId: string) {
    const sourceItems = await getAllRemoteFiles(drive, sourceFolderId);
    const targetItems = await getAllRemoteFiles(drive, targetFolderId);
    const targetMap = new Map(targetItems.map(i => [i.name, i]));
    for (const item of sourceItems) {
        const targetItem = targetMap.get(item.name);
        if (item.mimeType === 'application/vnd.google-apps.folder') {
            if (targetItem && targetItem.mimeType === 'application/vnd.google-apps.folder') {
                const subBackupId = await ensureSingleFolder(drive, backupFolderId, item.name);
                await mergeFoldersRecursive(drive, targetItem.id, item.id, subBackupId);
            } else {
                if (targetItem) await drive.files.update({ fileId: targetItem.id, addParents: backupFolderId, removeParents: targetFolderId });
                await drive.files.update({ fileId: item.id, addParents: targetFolderId, removeParents: sourceFolderId });
            }
        } else {
            if (targetItem) {
                const sourceTime = new Date(item.modifiedTime).getTime();
                const targetTime = new Date(targetItem.modifiedTime).getTime();
                if (sourceTime > targetTime) {
                    await drive.files.update({ fileId: targetItem.id, addParents: backupFolderId, removeParents: targetFolderId });
                    await drive.files.update({ fileId: item.id, addParents: targetFolderId, removeParents: sourceFolderId });
                } else {
                    await drive.files.update({ fileId: item.id, addParents: backupFolderId, removeParents: sourceFolderId });
                }
            } else {
                await drive.files.update({ fileId: item.id, addParents: targetFolderId, removeParents: sourceFolderId });
            }
        }
    }
}

export async function cleanupOldBackups(drive: drive_v3.Drive, workspaceRoot: string) {
    try {
        const backupsFolderId = await findOrCreateBackupsFolder(drive, workspaceRoot);
        if (!backupsFolderId) return;
        const res = await drive.files.list({ q: `'${backupsFolderId}' in parents and trashed=false`, fields: 'files(id, name, createdTime)' });
        const sessions = res.data.files || [];
        const now = new Date();
        const thirtyDaysInMs = 30 * 24 * 60 * 60 * 1000;
        for (const session of sessions) {
            if (!session.createdTime || !session.id) continue;
            const createdTime = new Date(session.createdTime).getTime();
            if (now.getTime() - createdTime > thirtyDaysInMs) {
                console.log(`Cleaning up old backup session: ${session.name}`);
                await drive.files.delete({ fileId: session.id });
            }
        }
    } catch (e) {
        console.error('Error during backups cleanup:', e);
    }
}

export async function findOrCreateBaseProjectFolder(drive: drive_v3.Drive, workspaceRoot: string, context?: vscode.ExtensionContext) {
    const projectName = path.basename(workspaceRoot);
    const rootFolderId = await ensureSingleFolder(drive, null, '.gdrive-git', context);
    return await ensureSingleFolder(drive, rootFolderId, projectName, context);
}

export async function findOrCreateSubFolder(drive: drive_v3.Drive, parentId: string | null | undefined, folderName: string, context?: vscode.ExtensionContext) {
    return await ensureSingleFolder(drive, parentId, folderName, context);
}

export async function findOrCreateProjectFolders(drive: drive_v3.Drive, workspaceRoot: string, context: vscode.ExtensionContext) {
    const projectFolderId = await findOrCreateBaseProjectFolder(drive, workspaceRoot, context);
    return await ensureSingleFolder(drive, projectFolderId, 'bundles', context);
}

export async function findOrCreateUntrackedFilesFolder(drive: drive_v3.Drive, workspaceRoot: string, context: vscode.ExtensionContext) {
    const projectFolderId = await findOrCreateBaseProjectFolder(drive, workspaceRoot, context);
    return await ensureSingleFolder(drive, projectFolderId, 'untracked', context);
}

export async function findOrCreateTombstonesFolder(drive: drive_v3.Drive, workspaceRoot: string, context: vscode.ExtensionContext) {
    const projectFolderId = await findOrCreateBaseProjectFolder(drive, workspaceRoot, context);
    return await ensureSingleFolder(drive, projectFolderId, 'tombstones', context);
}

export async function findOrCreateBackupsFolder(drive: drive_v3.Drive, workspaceRoot: string, context?: vscode.ExtensionContext) {
    const projectFolderId = await findOrCreateBaseProjectFolder(drive, workspaceRoot, context);
    const q = `name='${BACKUPS_DIR_NAME}' and mimeType='application/vnd.google-apps.folder' and '${projectFolderId}' in parents and trashed=false`;
    const res = await drive.files.list({ q, fields: 'files(id)' });
    const files = res.data.files || [];
    if (files.length > 0 && files[0].id) return files[0].id;
    const { data } = await drive.files.create({ requestBody: { name: BACKUPS_DIR_NAME, mimeType: 'application/vnd.google-apps.folder', parents: [projectFolderId] }, fields: 'id' });
    return data.id;
}

export async function getRemoteLock(drive: drive_v3.Drive, projectFolderId: string) {
    const q = `name='.sync.lock' and '${projectFolderId}' in parents and trashed=false`;
    const res = await drive.files.list({ q, fields: 'files(id, name, description, modifiedTime, appProperties)' });
    return res.data.files?.[0];
}

export async function createRemoteLock(drive: drive_v3.Drive, projectFolderId: string, lockData: any) {
    await drive.files.create({
        requestBody: {
            name: '.sync.lock',
            parents: [projectFolderId],
            description: JSON.stringify(lockData),
            appProperties: {
                machineId: lockData.machineId,
                timestamp: lockData.timestamp
            }
        }
    });
}

export async function updateRemoteLock(drive: drive_v3.Drive, fileId: string, lockData: any) {
    await drive.files.update({
        fileId: fileId,
        requestBody: {
            description: JSON.stringify(lockData),
            appProperties: {
                machineId: lockData.machineId,
                timestamp: lockData.timestamp
            }
        }
    });
}

export async function deleteRemoteLock(drive: drive_v3.Drive, fileId: string) {
    await drive.files.delete({ fileId });
}
