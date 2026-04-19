import * as vscode from 'vscode';
import { exec } from 'child_process';
import * as crypto from 'crypto';
import * as fsSync from 'fs';
import { promises as fs } from 'fs';
import * as path from 'path';

export function getWorkspaceRoot(): string | null {
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        return vscode.workspace.workspaceFolders[0].uri.fsPath;
    }
    vscode.window.showErrorMessage('No workspace folder is open.');
    return null;
}

export function runCommand(command: string, cwd: string): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        exec(command, { cwd, encoding: 'utf8' }, (error, stdout, stderr) => {
            if (error) {
                return reject(error);
            }
            if (stderr) {
                console.warn(`stderr: ${stderr}`);
            }
            resolve({ stdout, stderr });
        });
    });
}

export function getFileMd5(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('md5');
        const stream = fsSync.createReadStream(filePath);
        stream.on('data', (data) => hash.update(data));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}

export async function getFilesRecursively(dir: string, baseDir: string): Promise<string[]> {
    let results: string[] = [];
    const list = await fs.readdir(dir, { withFileTypes: true });
    for (const file of list) {
        const res = path.resolve(dir, file.name);
        if (file.isDirectory()) {
            results = results.concat(await getFilesRecursively(res, baseDir));
        } else {
            const relative = path.relative(baseDir, res).replace(/\\/g, '/');
            results.push(relative);
        }
    }
    return results;
}

export function sanitizeBranchNameForDrive(branchName: string): string {
    if (!branchName) return "";
    return branchName.replace(/\//g, '_');
}

export function restoreBranchNameFromDrive(driveBranchName: string): string {
    if (!driveBranchName) return "";
    return driveBranchName.replace(/_/g, '/');
}

export function escapeGdriveQueryParam(param: string): string {
    if (!param) return "";
    return param.replace(/\\/g, '/').replace(/'/g, "\\'");
}
