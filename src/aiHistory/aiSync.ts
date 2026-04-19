import * as vscode from 'vscode';
import { drive_v3 } from 'googleapis';
import * as path from 'path';
import { promises as fs } from 'fs';
import * as fsSync from 'fs';
import { 
    ANTIGRAVITY_ENABLED_KEY, 
    ANTIGRAVITY_IDS_KEY, 
    ANTIGRAVITY_BRAIN_PATH, 
    ANTIGRAVITY_CONVERSATIONS_PATH, 
    ANTIGRAVITY_ANNOTATIONS_PATH,
    ANTIGRAVITY_IMPLICIT_PATH,
    ANTIGRAVITY_KNOWLEDGE_PATH 
} from '../constants';
import { getWorkspaceRoot, getFileMd5 } from '../utils/common';
import { getAuthenticatedClient } from '../googleDrive/auth';
import { 
    findOrCreateBaseProjectFolder, 
    ensureSingleFolder,
    findOrCreateSubFolder,
    getAllRemoteFiles,
    downloadFile,
    updateFile,
    uploadFile
} from '../googleDrive/operations';
import { LockManager } from '../googleDrive/lockManager';

export async function trackCurrentConversation(context: vscode.ExtensionContext) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;
    try {
        const conversationId = await getCurrentConversationId();
        if (!conversationId) return;
        let projectConversationIds = context.workspaceState.get<string[]>(ANTIGRAVITY_IDS_KEY, []);
        if (!projectConversationIds.includes(conversationId)) {
            const updatedIds = [...projectConversationIds, conversationId];
            await context.workspaceState.update(ANTIGRAVITY_IDS_KEY, updatedIds);
            // Если мы только что добавили беседу, возможно стоит сразу обновить манифест в облаке,
            // но мы дождемся плановой или ручной синхронизации для экономии запросов.
        }
    } catch (e) {
        console.error('Error tracking current conversation:', e);
    }
}

async function getCurrentConversationId() {
    try {
        const folders = await fs.readdir(ANTIGRAVITY_BRAIN_PATH);
        if (folders.length === 0) return null;
        const folderDetails = await Promise.all(folders.map(async name => {
            const stats = await fs.stat(path.join(ANTIGRAVITY_BRAIN_PATH, name));
            return { name, mtime: stats.mtime };
        }));
        // Игнорируем временные папки
        const validFolders = folderDetails.filter(f => f.name.length > 20); 
        validFolders.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
        return validFolders.length > 0 ? validFolders[0].name : null;
    } catch (e) { return null; }
}

export async function configureAntigravitySync(context: vscode.ExtensionContext) {
    const choice = await vscode.window.showQuickPick([
        { label: "Включить", action: "enable" },
        { label: "Отключить", action: "disable" },
        { label: "Сбросить выбор", action: "reset" }
    ], { placeHolder: "Настроить Antigravity Sync" });
    if (!choice) return;
    switch (choice.action) {
        case "enable":
            await context.workspaceState.update(ANTIGRAVITY_ENABLED_KEY, true);
            vscode.window.showInformationMessage('Antigravity Sync включена.');
            await syncAntigravity(context, false);
            break;
        case "disable":
            await context.workspaceState.update(ANTIGRAVITY_ENABLED_KEY, false);
            vscode.window.showInformationMessage('Antigravity Sync отключена.');
            break;
        case "reset":
            await context.workspaceState.update(ANTIGRAVITY_ENABLED_KEY, undefined);
            vscode.window.showInformationMessage('Выбор сброшен.');
            break;
    }
}

export async function syncAntigravity(context: vscode.ExtensionContext, silent: boolean = false) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;
    let isEnabled = context.workspaceState.get(ANTIGRAVITY_ENABLED_KEY);
    if (isEnabled === false) return;
    if (isEnabled === undefined) {
        const choice = await vscode.window.showInformationMessage('Включить Antigravity Sync?', 'Да', 'Нет');
        if (choice === 'Да') { isEnabled = true; await context.workspaceState.update(ANTIGRAVITY_ENABLED_KEY, true); }
        else { isEnabled = false; await context.workspaceState.update(ANTIGRAVITY_ENABLED_KEY, false); return; }
    }
    const drive = await getAuthenticatedClient(context);
    if (!drive) return;

    const projectFolderId = await findOrCreateBaseProjectFolder(drive, workspaceRoot, context);
    if (!projectFolderId) throw new Error('Could not find or create project folder on Google Drive.');

    // Acquire Lock
    const lockAcquired = await LockManager.acquireLock(drive, projectFolderId, 'antigravity', 'Antigravity Sync', silent);
    if (!lockAcquired) return;

    if (!silent) vscode.window.showInformationMessage('Синхронизация Antigravity...');
    try {
        const historyFolderId = await findOrCreateAntigravityFolder(drive, workspaceRoot, context);
        const manifestId = await findOrCreateAntigravityManifest(drive, historyFolderId);
        if (!manifestId) return;
        const { data: manifestContent }: any = await drive.files.get({ fileId: manifestId, alt: 'media' });
        let remoteManifest: any = typeof manifestContent === 'object' ? manifestContent : JSON.parse(manifestContent || '{}');
        const projectConversationIds = context.workspaceState.get<string[]>(ANTIGRAVITY_IDS_KEY, []);
        const allRelevantIds = new Set([...projectConversationIds, ...(remoteManifest.ids || [])]);
        const machineId = vscode.env.machineId;

        for (const convId of allRelevantIds) {
            const localBrainPath = path.join(ANTIGRAVITY_BRAIN_PATH, convId);
            const localPbPath = path.join(ANTIGRAVITY_CONVERSATIONS_PATH, `${convId}.pb`);
            const localAnnotPath = path.join(ANTIGRAVITY_ANNOTATIONS_PATH, `${convId}.pbtxt`);
            const localImplicitPath = path.join(ANTIGRAVITY_IMPLICIT_PATH, `${convId}.pb`);

            const remoteConvFolderId = await findOrCreateSubFolder(drive, historyFolderId, convId, context);
            
            // 1. Синхронизируем папку brain (артефакты, логи)
            if (fsSync.existsSync(localBrainPath)) await syncFolder(drive, localBrainPath, remoteConvFolderId, machineId, silent);
            else await downloadFolder(drive, remoteConvFolderId, localBrainPath);

            const remoteFiles = await getAllRemoteFiles(drive, remoteConvFolderId);
            
            // 2. Синхронизируем основной .pb файл беседы
            const remotePbFile = remoteFiles.find(f => f.name === `${convId}.pb`);
            if (fsSync.existsSync(localPbPath)) {
                if (remotePbFile) await syncFileWithConflictResolution(drive, localPbPath, remotePbFile, machineId, silent);
                else await uploadFile(drive, remoteConvFolderId, localPbPath, `${convId}.pb`, machineId);
            } else if (remotePbFile) await downloadFile(drive, remotePbFile.id, localPbPath);

            // 3. Синхронизируем аннотацию (.pbtxt) - критично для отображения в списке
            const remoteAnnotFile = remoteFiles.find(f => f.name === `${convId}.pbtxt`);
            if (fsSync.existsSync(localAnnotPath)) {
                if (remoteAnnotFile) await syncFileWithConflictResolution(drive, localAnnotPath, remoteAnnotFile, machineId, silent);
                else await uploadFile(drive, remoteConvFolderId, localAnnotPath, `${convId}.pbtxt`, machineId);
            } else if (remoteAnnotFile) await downloadFile(drive, remoteAnnotFile.id, localAnnotPath);

            // 4. Синхронизируем implicit данные (.pb)
            const remoteImplicitFile = remoteFiles.find(f => f.name === `${convId}.implicit.pb`);
            if (fsSync.existsSync(localImplicitPath)) {
                if (remoteImplicitFile) await syncFileWithConflictResolution(drive, localImplicitPath, remoteImplicitFile, machineId, silent);
                else await uploadFile(drive, remoteConvFolderId, localImplicitPath, `${convId}.implicit.pb`, machineId);
            } else if (remoteImplicitFile) await downloadFile(drive, remoteImplicitFile.id, localImplicitPath);
        }

        const knowledgeFolderId = await findOrCreateAntigravityKnowledgeFolder(drive, workspaceRoot, context);
        await syncFolder(drive, ANTIGRAVITY_KNOWLEDGE_PATH, knowledgeFolderId, machineId, silent);

        const mergedIds = Array.from(allRelevantIds);
        await context.workspaceState.update(ANTIGRAVITY_IDS_KEY, mergedIds);
        await drive.files.update({ fileId: manifestId, media: { mimeType: 'application/json', body: JSON.stringify({ ids: mergedIds }) } });
        
        // В конце синхронизации пробуем подхватить текущую беседу, если она сменилась
        await trackCurrentConversation(context);

        if (!silent) vscode.window.showInformationMessage('Синхронизация Antigravity завершена.');
    } catch (error: any) {
        vscode.window.showErrorMessage(`Ошибка синхронизации Antigravity: ${error.message}`);
    } finally {
        await LockManager.releaseLock(drive, 'antigravity');
    }
}

async function syncFolder(drive: drive_v3.Drive, localPath: string, remoteFolderId: string, machineId: string, silent: boolean) {
    try {
        const localEntries = await fs.readdir(localPath);
        const remoteFiles = await getAllRemoteFiles(drive, remoteFolderId);
        for (const entry of localEntries) {
            if (entry === 'knowledge.lock') continue;
            const entryPath = path.join(localPath, entry);
            const stats = await fs.stat(entryPath);
            if (stats.isDirectory()) {
                const subId = await findOrCreateSubFolder(drive, remoteFolderId, entry);
                await syncFolder(drive, entryPath, subId, machineId, silent);
            } else {
                const remoteFile = remoteFiles.find(f => f.name === entry);
                if (remoteFile) await syncFileWithConflictResolution(drive, entryPath, remoteFile, machineId, silent);
                else await uploadFile(drive, remoteFolderId, entryPath, entry, machineId);
            }
        }
    } catch (e) {}
}

async function syncFileWithConflictResolution(drive: drive_v3.Drive, localPath: string, remoteFile: any, machineId: string, silent: boolean) {
    if (!fsSync.existsSync(localPath)) return; // Prevents errors if file was deleted during sync
    const localMd5 = await getFileMd5(localPath);
    if (localMd5 === remoteFile.md5Checksum) return;
    const stats = await fs.stat(localPath);
    const localTime = stats.mtime.getTime();
    const remoteTime = remoteFile.modifiedTime ? new Date(remoteFile.modifiedTime).getTime() : 0;
    if (remoteTime > localTime + 2000 && remoteFile.id) await downloadFile(drive, remoteFile.id, localPath);
    else if (localTime > remoteTime + 2000 && remoteFile.id) await updateFile(drive, remoteFile.id, localPath, machineId);
    else if (silent) await downloadFile(drive, remoteFile.id, localPath);
    else {
        const choice = await vscode.window.showQuickPick(['Download', 'Upload', 'Compare'], { placeHolder: `Conflict in Antigravity file: ${path.basename(localPath)}` });
        if (choice === 'Download') await downloadFile(drive, remoteFile.id, localPath);
        else if (choice === 'Upload') await updateFile(drive, remoteFile.id, localPath, machineId);
    }
}

async function downloadFolder(drive: drive_v3.Drive, remoteFolderId: string, localPath: string) {
    const remoteFiles = await getAllRemoteFiles(drive, remoteFolderId, true);
    for (const file of remoteFiles) await downloadFile(drive, file.id, path.join(localPath, file.name));
}

async function findOrCreateAntigravityFolder(drive: drive_v3.Drive, workspaceRoot: string, context: vscode.ExtensionContext) {
    const projectFolderId = await findOrCreateBaseProjectFolder(drive, workspaceRoot, context);
    return await ensureSingleFolder(drive, projectFolderId, 'antigravity-history', context);
}

async function findOrCreateAntigravityManifest(drive: drive_v3.Drive, historyFolderId: string) {
    const fileName = 'antigravity_manifest.json';
    const q = `name='${fileName}' and '${historyFolderId}' in parents and trashed=false`;
    const res = await drive.files.list({ q, fields: 'files(id)' });
    if (res.data.files?.length) return res.data.files[0].id;
    const { data } = await drive.files.create({ requestBody: { name: fileName, parents: [historyFolderId] }, media: { mimeType: 'application/json', body: JSON.stringify({ ids: [] }) }, fields: 'id' });
    return data.id;
}

async function findOrCreateAntigravityKnowledgeFolder(drive: drive_v3.Drive, workspaceRoot: string, context: vscode.ExtensionContext) {
    const projectFolderId = await findOrCreateBaseProjectFolder(drive, workspaceRoot, context);
    return await ensureSingleFolder(drive, projectFolderId, 'antigravity-knowledge', context);
}
