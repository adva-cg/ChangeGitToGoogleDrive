import { drive_v3 } from 'googleapis';
import { runCommand } from '../utils/common';
import { REFS_FILE_NAME } from '../constants';

export async function getCurrentBranch(cwd: string): Promise<string> {
    try {
        const { stdout } = await runCommand('git branch --show-current', cwd);
        const branch = stdout.trim();
        if (branch) return branch;
        const { stdout: fallback } = await runCommand('git rev-parse --abbrev-ref HEAD', cwd);
        return fallback.trim();
    } catch (error) {
        throw new Error('Не удалось определить текущую ветку. Если репозиторий новый, сделайте первый коммит.');
    }
}

export async function getLocalBranches(workspaceRoot: string): Promise<string[]> {
    const { stdout } = await runCommand('git branch --list --no-color', workspaceRoot);
    return stdout.split('\n')
        .map(b => b.trim().replace('* ', ''))
        .filter(b => b && !b.startsWith('(')); 
}

export async function getRemoteRefs(drive: drive_v3.Drive, bundleFolderId: string): Promise<Record<string, string>> {
    const q = `name='${REFS_FILE_NAME}' and '${bundleFolderId}' in parents and trashed=false`;
    const res = await drive.files.list({ q, fields: 'files(id, name)' });
    const files = res.data.files || [];
    if (files.length === 0) return {};
    try {
        if (!files[0].id) return {};
        const response = await drive.files.get({ fileId: files[0].id, alt: 'media' });
        return response.data as Record<string, string>;
    } catch (error) {
        console.error('Error reading remote refs:', error);
        return {};
    }
}

export async function updateRemoteRefs(drive: drive_v3.Drive, bundleFolderId: string, refs: Record<string, string>) {
    const q = `name='${REFS_FILE_NAME}' and '${bundleFolderId}' in parents and trashed=false`;
    const res = await drive.files.list({ q, fields: 'files(id, name)' });
    const files = res.data.files || [];
    const content = JSON.stringify(refs, null, 2);
    const media = { mimeType: 'application/json', body: content };
    if (files.length > 0 && files[0].id) {
        await drive.files.update({ fileId: files[0].id, media: media });
    } else {
        await drive.files.create({
            requestBody: { name: REFS_FILE_NAME, parents: [bundleFolderId] },
            media: media,
        });
    }
}
