import * as vscode from 'vscode';
import * as path from 'path';
import { drive_v3 } from 'googleapis';
import { getAuthenticatedClient } from '../googleDrive/auth';
import { findOrCreateBaseProjectFolder } from '../googleDrive/operations';
import { getGitRepositories } from '../utils/common';
import { getCloudConfig, updateCloudConfig } from '../untracked/decisions';

const CONFIG_SECTION = 'changegittogoogledrive-extension.untrackedFiles';
const INCLUDE_KEY = `${CONFIG_SECTION}.include`;
const EXCLUDE_KEY = `${CONFIG_SECTION}.exclude`;

let isApplyingRemoteConfig = false;
let pushDebounceTimer: NodeJS.Timeout | undefined;

function getConfigUri(repoRoot: string): vscode.Uri {
    const normalizedRoot = path.normalize(repoRoot);
    const folder = vscode.workspace.workspaceFolders?.find(f => {
        const folderPath = path.normalize(f.uri.fsPath);
        return normalizedRoot === folderPath || normalizedRoot.startsWith(folderPath + path.sep);
    });
    return folder?.uri ?? vscode.Uri.file(repoRoot);
}

export async function applyUntrackedConfigToWorkspace(
    repoRoot: string,
    config: { include: string[]; exclude: string[] }
): Promise<void> {
    isApplyingRemoteConfig = true;
    try {
        const uri = getConfigUri(repoRoot);
        const workspaceConfig = vscode.workspace.getConfiguration(CONFIG_SECTION, uri);
        await workspaceConfig.update('include', config.include, vscode.ConfigurationTarget.WorkspaceFolder);
        await workspaceConfig.update('exclude', config.exclude, vscode.ConfigurationTarget.WorkspaceFolder);
    } finally {
        setTimeout(() => { isApplyingRemoteConfig = false; }, 100);
    }
}

export async function pullUntrackedConfigFromDrive(
    context: vscode.ExtensionContext,
    repoRoot: string,
    drive?: drive_v3.Drive,
    projectFolderId?: string
): Promise<boolean> {
    const client = drive ?? await getAuthenticatedClient(context);
    if (!client) return false;

    const folderId = projectFolderId ?? await findOrCreateBaseProjectFolder(client, repoRoot, context);
    if (!folderId) return false;

    const cloud = await getCloudConfig(client, folderId);
    if (!cloud) {
        const uri = getConfigUri(repoRoot);
        const local = vscode.workspace.getConfiguration(CONFIG_SECTION, uri);
        const include = local.get<string[]>('include', []);
        const exclude = local.get<string[]>('exclude', []);
        if (include.length || exclude.length) {
            await updateCloudConfig(client, folderId, { include, exclude });
        }
        return false;
    }

    await applyUntrackedConfigToWorkspace(repoRoot, {
        include: (cloud.include ?? []) as string[],
        exclude: (cloud.exclude ?? []) as string[]
    });
    return true;
}

export async function pullUntrackedConfigForAllRepos(context: vscode.ExtensionContext): Promise<void> {
    const repos = await getGitRepositories();
    for (const repo of repos) {
        try {
            await pullUntrackedConfigFromDrive(context, repo.root);
        } catch (e) {
            console.error(`Failed to pull untracked config for ${repo.name}:`, e);
        }
    }
}

export async function pushUntrackedConfigToDrive(
    context: vscode.ExtensionContext,
    repoRoot: string
): Promise<void> {
    const drive = await getAuthenticatedClient(context);
    if (!drive) return;

    const projectFolderId = await findOrCreateBaseProjectFolder(drive, repoRoot, context);
    if (!projectFolderId) return;

    const uri = getConfigUri(repoRoot);
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION, uri);
    await updateCloudConfig(drive, projectFolderId, {
        include: config.get<string[]>('include', []),
        exclude: config.get<string[]>('exclude', [])
    });
}

async function pushUntrackedConfigForAllRepos(context: vscode.ExtensionContext): Promise<void> {
    const repos = await getGitRepositories();
    for (const repo of repos) {
        try {
            await pushUntrackedConfigToDrive(context, repo.root);
        } catch (e) {
            console.error(`Failed to push untracked config for ${repo.name}:`, e);
        }
    }
}

export function setupUntrackedConfigSync(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (isApplyingRemoteConfig) return;
            if (!e.affectsConfiguration(INCLUDE_KEY) && !e.affectsConfiguration(EXCLUDE_KEY)) return;

            if (pushDebounceTimer) clearTimeout(pushDebounceTimer);
            pushDebounceTimer = setTimeout(() => {
                pushUntrackedConfigForAllRepos(context).catch(err =>
                    console.error('Failed to push untracked config to Drive:', err)
                );
            }, 500);
        })
    );
}

export function openExtensionSettings(): void {
    vscode.commands.executeCommand('workbench.action.openSettings', '@ext:VitalyAdadurov.changegittogoogledrive-extension');
}
