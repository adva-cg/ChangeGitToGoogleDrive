const vscode = require('vscode');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const archiver = require('archiver');
const moment = require('moment');
const { exec } = require('child_process');
const unzipper = require('unzipper');

// Ключ для хранения хеша последнего выгруженного коммита
const LAST_UPLOAD_HASH_KEY = 'lastUploadCommitHash';

function activate(context) {
    // Команда выгрузки
    let uploadDisposable = vscode.commands.registerCommand('changegittogoogledrive-extension.uploadChanges', async () => {
        try {
            await uploadChanges(context);
        } catch (error) {
            vscode.window.showErrorMessage(`Upload failed: ${error.message}`);
        }
    });

    // Команда загрузки
    let downloadDisposable = vscode.commands.registerCommand('changegittogoogledrive-extension.downloadChanges', async () => {
        try {
            await downloadChanges(context);
        } catch (error) {
            vscode.window.showErrorMessage(`Download failed: ${error.message}`);
        }
    });

    context.subscriptions.push(uploadDisposable, downloadDisposable);
}

// --- Подпрограмма: "Выгрузка изменений" ---
async function uploadChanges(context) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        vscode.window.showErrorMessage('No workspace folder is open.');
        return;
    }
    const workspaceRoot = workspaceFolders[0].uri.fsPath;

    const lastUploadHash = context.workspaceState.get(LAST_UPLOAD_HASH_KEY);
    let commits = [];

    if (lastUploadHash) {
        const command = `git log ${lastUploadHash}..HEAD --pretty=format:"%H %s"`;
        const { stdout } = await runCommand(command, workspaceRoot);
        if (!stdout) {
            vscode.window.showInformationMessage('No new commits to upload.');
            return;
        }
        commits = stdout.trim().split('\n').map(line => {
            const [hash, ...message] = line.split(' ');
            return { hash, message: message.join(' ') };
        });
    } else {
        const { stdout } = await runCommand('git ls-files', workspaceRoot);
        if (!stdout) {
            vscode.window.showInformationMessage('No files to upload in the repository.');
            return;
        }
        const allFiles = stdout.trim().split('\n');
        await createAndUploadFullArchive(workspaceRoot, allFiles);
        const { stdout: headHash } = await runCommand('git rev-parse HEAD', workspaceRoot);
        await context.workspaceState.update(LAST_UPLOAD_HASH_KEY, headHash.trim());
        return;
    }

    const tempDir = path.join(workspaceRoot, '.upload-temp');
    await fs.mkdir(tempDir, { recursive: true });

    const logFilePath = path.join(tempDir, 'commits.log');
    let logContent = '';

    for (const commit of commits) {
        const commitDir = path.join(tempDir, commit.hash);
        await fs.mkdir(commitDir, { recursive: true });

        const { stdout: files } = await runCommand(`git diff-tree --no-commit-id --name-only -r ${commit.hash}`, workspaceRoot);
        const changedFiles = files.trim().split('\n').filter(Boolean);

        for (const file of changedFiles) {
            const sourcePath = path.join(workspaceRoot, file);
            const destPath = path.join(commitDir, file);
            await fs.mkdir(path.dirname(destPath), { recursive: true });
            await fs.copyFile(sourcePath, destPath);
        }
        logContent += `${commit.hash} ${commit.message}\n`;
    }

    await fs.writeFile(logFilePath, logContent);

    const archiveName = `${path.basename(workspaceRoot)}_${moment().format('YYYYMMDDHHmmss')}.zip`;
    const archivePath = path.join(workspaceRoot, archiveName);

    await createArchiveFromFolder(tempDir, archivePath);

    const { stdout: newHeadHash } = await runCommand('git rev-parse HEAD', workspaceRoot);
    await context.workspaceState.update(LAST_UPLOAD_HASH_KEY, newHeadHash.trim());
    await fs.rm(tempDir, { recursive: true, force: true });

    vscode.window.showInformationMessage(`Successfully created incremental archive at ${archivePath}. Now, upload it using the Google Drive extension.`);
}

async function createAndUploadFullArchive(workspaceRoot, files) {
    const archiveName = `${path.basename(workspaceRoot)}_${moment().format('YYYYMMDDHHmmss')}.zip`;
    const archivePath = path.join(workspaceRoot, archiveName);
    
    await new Promise((resolve, reject) => {
        const output = fsSync.createWriteStream(archivePath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', resolve);
        archive.on('error', reject);
        archive.pipe(output);

        for (const file of files) {
            archive.file(path.join(workspaceRoot, file), { name: file });
        }
        archive.finalize();
    });

    vscode.window.showInformationMessage(`Successfully created full archive at ${archivePath}. Now, upload it using the Google Drive extension.`);
}


// --- Подпрограмма: "Загрузка изменений" ---
async function downloadChanges(context) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        vscode.window.showErrorMessage('No workspace folder is open.');
        return;
    }
    const workspaceRoot = workspaceFolders[0].uri.fsPath;

    const archiveUri = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: 'Select Archive to Download',
        filters: { 'Zip archives': ['zip'] }
    });

    if (!archiveUri || archiveUri.length === 0) {
        vscode.window.showInformationMessage('No archive selected.');
        return;
    }
    const archivePath = archiveUri[0].fsPath;

    const { stdout: status } = await runCommand('git status --porcelain', workspaceRoot);
    if (status.trim()) {
        vscode.window.showErrorMessage('Your working directory is not clean. Please commit or stash your changes before downloading.');
        return;
    }
    
    const tempDir = path.join(workspaceRoot, '.download-temp');
    await fs.mkdir(tempDir, { recursive: true });

    try {
        // Распаковываем архив
        await fsSync.createReadStream(archivePath).pipe(unzipper.Extract({ path: tempDir })).promise();

        const logPath = path.join(tempDir, 'commits.log');
        
        // Проверяем, есть ли commits.log для инкрементного обновления
        if (fsSync.existsSync(logPath)) {
            const logContent = await fs.readFile(logPath, 'utf-8');
            const commitsToApply = logContent.trim().split('\n').filter(Boolean).map(line => {
                const [hash, ...message] = line.split(' ');
                return { hash, message: message.join(' ') };
            });

            for (const commit of commitsToApply) {
                const commitDir = path.join(tempDir, commit.hash);
                // Копируем файлы из папки коммита в рабочую директорию
                await copyRecursive(commitDir, workspaceRoot);
                
                // Коммитим изменения
                await runCommand('git add .', workspaceRoot);
                // Экранируем кавычки в сообщении коммита
                const escapedMessage = commit.message.replace(/"/g, '\"');
                await runCommand(`git commit -m "${escapedMessage}"`, workspaceRoot);
            }
            vscode.window.showInformationMessage(`${commitsToApply.length} commits have been successfully applied.`);

        } else {
            // Полное восстановление
            await copyRecursive(tempDir, workspaceRoot);
            vscode.window.showInformationMessage('Project has been fully restored from the archive. Please review and commit the changes.');
        }

    } finally {
        // Очистка
        await fs.rm(tempDir, { recursive: true, force: true });
    }
}


// --- Вспомогательные функции ---

function runCommand(command, cwd) {
    return new Promise((resolve, reject) => {
        exec(command, { cwd }, (error, stdout, stderr) => {
            if (error) {
                console.error(`exec error: ${error}`);
                return reject(error);
            }
            if (stderr) {
                console.warn(`stderr: ${stderr}`);
            }
            resolve({ stdout, stderr });
        });
    });
}

function createArchiveFromFolder(folderPath, outputPath) {
    return new Promise((resolve, reject) => {
        const output = fsSync.createWriteStream(outputPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', resolve);
        archive.on('error', reject);
        archive.pipe(output);
        archive.directory(folderPath, false);
        archive.finalize();
    });
}

async function copyRecursive(src, dest) {
    const entries = await fs.readdir(src, { withFileTypes: true });
    for (let entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            await fs.mkdir(destPath, { recursive: true });
            await copyRecursive(srcPath, destPath);
        } else {
            await fs.copyFile(srcPath, destPath);
        }
    }
}


function deactivate() {}

module.exports = {
    activate,
    deactivate
}