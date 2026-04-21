import * as vscode from 'vscode';
import * as path from 'path';
import { getGitRepositories } from './common';
import { ANTIGRAVITY_BRAIN_PATH, ANTIGRAVITY_ENABLED_KEY } from '../constants';
import { getAuthenticatedClient } from '../googleDrive/auth';

export async function showDiagnostics(context: vscode.ExtensionContext) {
    const outputChannel = vscode.window.createOutputChannel('GitToGoogleDrive Diagnostics');
    outputChannel.show();

    outputChannel.appendLine('=== ChangeGitToGoogleDrive Diagnostics ===');
    outputChannel.appendLine(`Timestamp: ${new Date().toISOString()}`);
    outputChannel.appendLine(`Extension Version: ${vscode.extensions.getExtension('VitalyAdadurov.changegittogoogledrive-extension')?.packageJSON.version}`);
    outputChannel.appendLine('');

    // 1. Repositories
    outputChannel.appendLine('--- Detected Repositories ---');
    try {
        const repos = await getGitRepositories();
        if (repos.length === 0) {
            outputChannel.appendLine('No Git repositories detected.');
        } else {
            repos.forEach(repo => {
                outputChannel.appendLine(`- Name: ${repo.name}`);
                outputChannel.appendLine(`  Path: ${repo.root}`);
            });
        }
    } catch (e: any) {
        outputChannel.appendLine(`Error detecting repositories: ${e.message}`);
    }
    outputChannel.appendLine('');

    // 2. Antigravity status
    outputChannel.appendLine('--- Antigravity (AI History) Status ---');
    const agEnabled = context.globalState.get<boolean>(ANTIGRAVITY_ENABLED_KEY, false);
    outputChannel.appendLine(`Global Enabled: ${agEnabled}`);
    outputChannel.appendLine(`Brain Path: ${ANTIGRAVITY_BRAIN_PATH}`);
    
    const fs = require('fs');
    if (fs.existsSync(ANTIGRAVITY_BRAIN_PATH)) {
        outputChannel.appendLine('Brain folder exists: Yes');
        const historyPath = path.join(ANTIGRAVITY_BRAIN_PATH, '.system_generated', 'logs');
        if (fs.existsSync(historyPath)) {
             outputChannel.appendLine('History logs folder exists: Yes');
        } else {
             outputChannel.appendLine('History logs folder missing (Expected if no AG history exists yet)');
        }
    } else {
        outputChannel.appendLine('Brain folder exists: No (Antigravity might not be configured or path is different)');
    }
    outputChannel.appendLine('');

    // 3. Google Drive
    outputChannel.appendLine('--- Google Drive Status ---');
    try {
        const drive = await getAuthenticatedClient(context);
        if (drive) {
            outputChannel.appendLine('Authentication: OK');
            // Try a simple list to verify token
            await drive.files.list({ pageSize: 1 });
            outputChannel.appendLine('API Access: Verified');
        } else {
            outputChannel.appendLine('Authentication: Not authenticated');
        }
    } catch (e: any) {
        outputChannel.appendLine(`Authentication/API Error: ${e.message}`);
    }

    outputChannel.appendLine('');
    outputChannel.appendLine('=== End of Diagnostics ===');
}
