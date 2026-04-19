import * as vscode from 'vscode';
import { drive_v3 } from 'googleapis';
import { CONFLICT_DECISIONS_KEY, CLOUD_CONFIG_FILE_NAME } from '../constants';

export function getConflictDecisions(context: vscode.ExtensionContext): Record<string, any> {
    return context.workspaceState.get<Record<string, any>>(CONFLICT_DECISIONS_KEY, {});
}

export async function setConflictDecision(context: vscode.ExtensionContext, decision: { key: string, data: any }) {
    const decisions = getConflictDecisions(context);
    decisions[decision.key] = decision.data;
    await context.workspaceState.update(CONFLICT_DECISIONS_KEY, decisions);
}

export async function clearConflictDecision(context: vscode.ExtensionContext, key: string) {
    const decisions = getConflictDecisions(context);
    delete decisions[key];
    await context.workspaceState.update(CONFLICT_DECISIONS_KEY, decisions);
}

export async function getCloudConfig(drive: drive_v3.Drive, projectFolderId: string) {
    const q = `name='${CLOUD_CONFIG_FILE_NAME}' and '${projectFolderId}' in parents and trashed=false`;
    const res = await drive.files.list({ q, fields: 'files(id)' });
    const files = res.data.files || [];
    if (files.length === 0) return null;
    try {
        if (!files[0].id) return null;
        const { data } = await drive.files.get({ fileId: files[0].id, alt: 'media' });
        if (typeof data === 'string') return JSON.parse(data);
        return data as any;
    } catch (e) {
        console.error('Error reading cloud config:', e);
        return null;
    }
}

export async function updateCloudConfig(drive: drive_v3.Drive, projectFolderId: string, config: any) {
    const q = `name='${CLOUD_CONFIG_FILE_NAME}' and '${projectFolderId}' in parents and trashed=false`;
    const { data: { files } } = await drive.files.list({ q, fields: 'files(id)' });
    const media = {
        mimeType: 'application/json',
        body: JSON.stringify(config, null, 2)
    };
    const targetFiles = files || [];
    if (targetFiles.length > 0 && targetFiles[0].id) {
        await drive.files.update({ fileId: targetFiles[0].id, media });
    } else {
        await drive.files.create({
            requestBody: { name: CLOUD_CONFIG_FILE_NAME, parents: [projectFolderId] },
            media
        });
    }
}

export async function getEffectiveConfig(drive: drive_v3.Drive, projectFolderId: string) {
    const cloudConfig = await getCloudConfig(drive, projectFolderId);
    const localConfig = vscode.workspace.getConfiguration('changegittogoogledrive-extension.untrackedFiles');
    return {
        include: (cloudConfig?.include || localConfig.get('include', [])) as string[],
        exclude: (cloudConfig?.exclude || localConfig.get('exclude', [])) as string[]
    };
}
