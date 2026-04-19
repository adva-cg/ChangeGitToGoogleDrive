import * as vscode from 'vscode';
import { setupGoogleCredentials, authenticateWithGoogle } from './googleDrive/auth';
import { initialUpload, sync, installGitHooks, cloneFromGoogleDrive, manageSyncHash, setupBranchMonitoring } from './git/sync';
import { uploadUntrackedFiles, syncUntrackedFiles, deleteUntrackedFile, clearTombstones } from './untracked/untrackedSync';
import { syncAntigravity, configureAntigravitySync, trackCurrentConversation } from './aiHistory/aiSync';
import { toggleClipboardSync, setupCloudClipboard } from './clipboard/clipboardSync';
import { ANTIGRAVITY_BRAIN_PATH, ANTIGRAVITY_ENABLED_KEY } from './constants';
import { getWorkspaceRoot } from './utils/common';

export function activate(context: vscode.ExtensionContext) {
    console.log('Congratulations, your extension "ChangeGitToGoogleDrive" is now active!');

    // Регистрация команд
    context.subscriptions.push(
        vscode.commands.registerCommand('changegittogoogledrive-extension.setupGoogleCredentials', () => setupGoogleCredentials(context)),
        vscode.commands.registerCommand('changegittogoogledrive-extension.authenticateWithGoogle', () => authenticateWithGoogle(context)),
        vscode.commands.registerCommand('changegittogoogledrive-extension.initialUpload', () => initialUpload(context)),
        vscode.commands.registerCommand('changegittogoogledrive-extension.sync', () => sync(context)),
        vscode.commands.registerCommand('changegittogoogledrive-extension.installGitHooks', () => installGitHooks(context)),
        vscode.commands.registerCommand('changegittogoogledrive-extension.cloneFromGoogleDrive', () => cloneFromGoogleDrive(context)),
        vscode.commands.registerCommand('changegittogoogledrive-extension.syncUntrackedFiles', () => syncUntrackedFiles(context)),
        vscode.commands.registerCommand('changegittogoogledrive-extension.deleteUntrackedFile', () => deleteUntrackedFile(context)),
        vscode.commands.registerCommand('changegittogoogledrive-extension.clearTombstones', () => clearTombstones(context)),
        vscode.commands.registerCommand('changegittogoogledrive-extension.manageSyncHash', () => manageSyncHash(context)),
        vscode.commands.registerCommand('changegittogoogledrive-extension.configureAIHistorySync', () => configureAntigravitySync(context)),
        vscode.commands.registerCommand('changegittogoogledrive-extension.syncAIHistory', () => syncAntigravity(context)),
        vscode.commands.registerCommand('changegittogoogledrive-extension.toggleClipboardSync', () => toggleClipboardSync(context))
    );

    // Фоновая синхронизация Git при изменениях
    const gitWatcher = vscode.workspace.createFileSystemWatcher('**/.git/SYNC_REQUEST');
    gitWatcher.onDidChange(() => sync(context, true));
    context.subscriptions.push(gitWatcher);

    // Мониторинг веток
    setupBranchMonitoring(context);

    // Мониторинг Antigravity истории
    const aiWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(ANTIGRAVITY_BRAIN_PATH, '**/*'));
    aiWatcher.onDidChange(() => {
        if (context.workspaceState.get(ANTIGRAVITY_ENABLED_KEY) === true) {
            trackCurrentConversation(context);
        }
    });
    aiWatcher.onDidCreate(() => {
        if (context.workspaceState.get(ANTIGRAVITY_ENABLED_KEY) === true) {
            trackCurrentConversation(context);
        }
    });
    context.subscriptions.push(aiWatcher);

    // Авто-синхронизация при открытии
    const workspaceRoot = getWorkspaceRoot();
    if (workspaceRoot) {
        sync(context, true).catch(e => console.error('Initial git sync failed:', e));
        syncUntrackedFiles(context, true).catch(e => console.error('Initial untracked sync failed:', e));
        syncAntigravity(context, true).catch(e => console.error('Initial Antigravity sync failed:', e));
    }

    // Настройка облачного буфера обмена
    setupCloudClipboard(context);

    // Периодическая выгрузка новых файлов (на всякий случай)
    const uploadInterval = setInterval(() => {
        uploadUntrackedFiles(context, true);
    }, 120000); // каждые 2 минуты
    context.subscriptions.push({ dispose: () => clearInterval(uploadInterval) });
}

export function deactivate() {}
