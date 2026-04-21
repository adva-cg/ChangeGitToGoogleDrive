import * as vscode from 'vscode';
import { drive_v3 } from 'googleapis';
import * as path from 'path';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import { CLIPBOARD_SYNC_FILE_NAME, LAST_CLIPBOARD_HASH_KEY } from '../constants';
import { runCommand } from '../utils/common';
import { getAuthenticatedClient } from '../googleDrive/auth';
import { ensureSingleFolder } from '../googleDrive/operations';

let clipboardInterval: NodeJS.Timeout | undefined;
let isSyncingClipboard = false;

export async function toggleClipboardSync(context: vscode.ExtensionContext) {
    const config = vscode.workspace.getConfiguration('changegittogoogledrive-extension.clipboard');
    const currentState = config.get('syncEnabled');
    await config.update('syncEnabled', !currentState, vscode.ConfigurationTarget.Global);
    if (!currentState) {
        vscode.window.showInformationMessage('Cloud Clipboard: Синхронизация включена');
        setupCloudClipboard(context);
    } else {
        vscode.window.showInformationMessage('Cloud Clipboard: Синхронизация выключена');
        if (clipboardInterval) { clearInterval(clipboardInterval); clipboardInterval = undefined; }
    }
}

export async function setupCloudClipboard(context: vscode.ExtensionContext) {
    if (clipboardInterval) clearInterval(clipboardInterval);
    const config = vscode.workspace.getConfiguration('changegittogoogledrive-extension.clipboard');
    if (!config.get('syncEnabled')) return;
    const intervalTime = Math.max(config.get<number>('syncInterval') || 5000, 1000);
    syncCloudClipboard(context).catch(e => console.error('Initial clipboard sync failed:', e));
    clipboardInterval = setInterval(() => {
        syncCloudClipboard(context).catch(e => console.error('Periodic clipboard sync failed:', e));
    }, intervalTime);
    context.subscriptions.push({ dispose: () => { if (clipboardInterval) clearInterval(clipboardInterval); } });
}

async function syncCloudClipboard(context: vscode.ExtensionContext) {
    if (isSyncingClipboard) return;
    isSyncingClipboard = true;
    try {
        const drive = await getAuthenticatedClient(context);
        if (!drive) { isSyncingClipboard = false; return; }
        const machineId = vscode.env.machineId;
        const gdriveGitDirId = await ensureSingleFolder(drive, null, '.gdrive-git', context);
        if (!gdriveGitDirId) throw new Error("Could not find/create base GDrive folder");
        const syncFile = await findClipboardSyncFile(drive, gdriveGitDirId);
        const local = await getLocalClipboard();
        const lastLocalHash = context.globalState.get(LAST_CLIPBOARD_HASH_KEY);

        if (local && local.hash !== lastLocalHash) {
            const content = { type: local.type, data: local.data, timestamp: new Date().toISOString(), machineId: machineId };
            if (syncFile?.id) {
                await drive.files.update({ fileId: syncFile.id, requestBody: { appProperties: { machineId, hash: local.hash } }, media: { mimeType: 'application/json', body: JSON.stringify(content) } });
            } else {
                await drive.files.create({ requestBody: { name: CLIPBOARD_SYNC_FILE_NAME, parents: [gdriveGitDirId], appProperties: { machineId, hash: local.hash } }, media: { mimeType: 'application/json', body: JSON.stringify(content) } });
            }
            await context.globalState.update(LAST_CLIPBOARD_HASH_KEY, local.hash);
        }

        if (syncFile) {
            const remoteMachineId = syncFile.appProperties?.machineId;
            const remoteHash = syncFile.appProperties?.hash;
            if (remoteMachineId && remoteMachineId !== machineId && remoteHash !== lastLocalHash) {
                const response: any = await drive.files.get({ fileId: syncFile.id as string, alt: 'media' });
                const content = response.data;
                if (content?.type && content?.data) {
                    await setLocalClipboard(content.type, content.data);
                    await context.globalState.update(LAST_CLIPBOARD_HASH_KEY, remoteHash);
                    vscode.window.setStatusBarMessage(`📋 Буфер обновлен из облака`, 3000);
                }
            }
        }
    } catch (error) { console.error('Clipboard sync error:', error); }
    finally { isSyncingClipboard = false; }
}

async function findClipboardSyncFile(drive: drive_v3.Drive, parentId: string) {
    const q = `name='${CLIPBOARD_SYNC_FILE_NAME}' and '${parentId}' in parents and trashed=false`;
    const res = await drive.files.list({ q, fields: 'files(id, name, appProperties, modifiedTime)' });
    return res.data.files?.length ? res.data.files[0] : null;
}

async function getLocalClipboard() {
    const cwd = os.tmpdir();
    try {
        const isImage = (await runCommand('powershell -noprofile -command "Add-Type -AssemblyName System.Windows.Forms; [Windows.Forms.Clipboard]::ContainsImage()"', cwd)).stdout.trim() === 'True';
        if (isImage) {
            const base64 = (await runCommand('powershell -noprofile -command "Add-Type -AssemblyName System.Windows.Forms; $img = [Windows.Forms.Clipboard]::GetImage(); if ($img) { $ms = New-Object System.IO.MemoryStream; $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); [Convert]::ToBase64String($ms.ToArray()) }"', cwd)).stdout.trim();
            if (base64) return { type: 'image', data: base64, hash: crypto.createHash('md5').update(base64).digest('hex') };
        }
    } catch (e) {}
    const text = await vscode.env.clipboard.readText();
    if (text) return { type: 'text', data: text, hash: crypto.createHash('md5').update(text).digest('hex') };
    return null;
}

async function setLocalClipboard(type: string, data: string) {
    if (type === 'text') await vscode.env.clipboard.writeText(data);
    else if (type === 'image') {
        try {
            const tempFile = path.join(os.tmpdir(), `cv_temp_${Date.now()}.b64`);
            await fs.writeFile(tempFile, data);
            const psCommand = `powershell -noprofile -command "Add-Type -AssemblyName System.Windows.Forms; $b64 = Get-Content '${tempFile}' -Raw; [Windows.Forms.Clipboard]::SetImage([System.Drawing.Image]::FromStream((New-Object System.IO.MemoryStream([Convert]::FromBase64String($b64)))))"`;
            await runCommand(psCommand, os.tmpdir());
            await fs.unlink(tempFile);
        } catch (e) {}
    }
}
