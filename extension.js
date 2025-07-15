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
    // Команда начальной выгрузки
    let initialUploadDisposable = vscode.commands.registerCommand('changegittogoogledrive-extension.initialUpload', async () => {
        try {
            await initialUpload(context);
        } catch (error) {
            vscode.window.showErrorMessage(`Initial upload failed: ${error.message}`);
        }
    });

    // Команда инкрементальной выгрузки
    let incrementalUploadDisposable = vscode.commands.registerCommand('changegittogoogledrive-extension.incrementalUpload', async () => {
        try {
            await incrementalUpload(context);
        } catch (error) {
            vscode.window.showErrorMessage(`Incremental upload failed: ${error.message}`);
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

    context.subscriptions.push(initialUploadDisposable, incrementalUploadDisposable, downloadDisposable);
}

// --- Подпрограмма: "Начальная выгрузка" ---
async function initialUpload(context) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        vscode.window.showErrorMessage('No workspace folder is open.');
        return;
    }
    const workspaceRoot = workspaceFolders[0].uri.fsPath;

    const { stdout } = await runCommand('git -c core.quotepath=false ls-files', workspaceRoot, { maxBuffer: 1024 * 1024 * 50 });
    if (!stdout) {
        vscode.window.showInformationMessage('No files to upload in the repository.');
        return;
    }
    const allFiles = stdout.trim().split('\n');
    await createAndUploadFullArchive(workspaceRoot, allFiles);
    const { stdout: headHash } = await runCommand('git rev-parse HEAD', workspaceRoot);
    await context.workspaceState.update(LAST_UPLOAD_HASH_KEY, headHash.trim());
}

// --- Подпрограмма: "Инкрементальная выгрузка" ---
async function incrementalUpload(context) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        vscode.window.showErrorMessage('No workspace folder is open.');
        return;
    }
    const workspaceRoot = workspaceFolders[0].uri.fsPath;

    const lastUploadHash = context.workspaceState.get(LAST_UPLOAD_HASH_KEY);
    if (!lastUploadHash) {
        vscode.window.showErrorMessage('No previous upload found. Please run the initial upload first.');
        return;
    }

    const command = `git -c core.quotepath=false log ${lastUploadHash}..HEAD --pretty=format:"%H %s"`;
    const { stdout } = await runCommand(command, workspaceRoot);
    if (!stdout) {
        vscode.window.showInformationMessage('No new commits to upload.');
        return;
    }
    const commits = stdout.trim().split('\n').map(line => {
        const [hash, ...message] = line.split(' ');
        return { hash, message: message.join(' ') };
    });

    const tempDir = path.join(workspaceRoot, '.upload-temp');
    await fs.mkdir(tempDir, { recursive: true });

    const logFilePath = path.join(tempDir, 'commits.log');
    let logContent = '';

    for (const commit of commits) {
        const commitDir = path.join(tempDir, commit.hash);
        await fs.mkdir(commitDir, { recursive: true });

        const { stdout: files } = await runCommand(`git -c core.quotepath=false show --name-status --pretty="" ${commit.hash}`, workspaceRoot);
        const changedFilesWithStatus = files.trim().split('\n').filter(Boolean);
        const deletedFiles = [];

        for (const line of changedFilesWithStatus) {
            const parts = line.split('\t');
            const status = parts[0];

            if (status.startsWith('D')) {
                deletedFiles.push(parts[1]);
            } else if (status.startsWith('R')) {
                deletedFiles.push(parts[1]); // old path
                const newFile = parts[2]; // new path
                const sourcePath = path.join(workspaceRoot, newFile);
                const destPath = path.join(commitDir, newFile);
                await fs.mkdir(path.dirname(destPath), { recursive: true });
                await fs.copyFile(sourcePath, destPath);
            } else { // A, M, C
                const file = parts[1];
                const sourcePath = path.join(workspaceRoot, file);
                const destPath = path.join(commitDir, file);
                await fs.mkdir(path.dirname(destPath), { recursive: true });
                await fs.copyFile(sourcePath, destPath);
            }
        }

        if (deletedFiles.length > 0) {
            const deletedFilePath = path.join(commitDir, 'deleted.txt');
            await fs.writeFile(deletedFilePath, deletedFiles.join('\n'));
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

    try {
        const output = fsSync.createWriteStream(archivePath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        const closePromise = new Promise((resolve, reject) => {
            output.on('close', resolve);
            archive.on('error', reject);
        });

        archive.pipe(output);

        for (const file of files) {
            const filePath = path.join(workspaceRoot, file);
            // Убедимся, что файл существует, прежде чем его добавлять
            if (fsSync.existsSync(filePath)) {
                archive.file(filePath, { name: file });
            } else {
                vscode.window.showWarningMessage(`File not found and will be skipped: ${file}`);
            }
        }

        await archive.finalize();
        await closePromise;

        vscode.window.showInformationMessage(`Successfully created full archive at ${archivePath}. Now, upload it using the Google Drive extension.`);

    } catch (error) {
        vscode.window.showErrorMessage(`Failed to create archive: ${error.message}`);
        // Попытаемся удалить частично созданный архив в случае ошибки
        if (fsSync.existsSync(archivePath)) {
            await fs.unlink(archivePath);
        }
    }
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
            vscode.window.showInformationMessage('Found commits.log, starting incremental download.');
            const logContent = await fs.readFile(logPath, 'utf-8');
            const commitsToApply = logContent.trim().split('\n').filter(Boolean).map(line => {
                const [hash, ...message] = line.split(' ');
                return { hash, message: message.join(' ') };
            });

            for (const commit of commitsToApply) {
                const commitDir = path.join(tempDir, commit.hash);
                const deletedFilePath = path.join(commitDir, 'deleted.txt');

                if (fsSync.existsSync(deletedFilePath)) {
                    const deletedFilesContent = await fs.readFile(deletedFilePath, 'utf-8');
                    const deletedFiles = deletedFilesContent.trim().split('\n').filter(Boolean);
                    if (deletedFiles.length > 0) {
                        const filesToRemove = [];
                        for (const file of deletedFiles) {
                            if (fsSync.existsSync(path.join(workspaceRoot, file))) {
                                filesToRemove.push(`"${file.replace(/\\//g, '/')}"`);
                            } else {
                                vscode.window.showWarningMessage(`File scheduled for deletion not found, skipping: ${file}`);
                            }
                        }
                        if (filesToRemove.length > 0) {
                            await runCommand(`git rm -- ${filesToRemove.join(' ')}`, workspaceRoot);
                        }
                    }
                }

                // Копируем файлы из папки коммита в рабочую директорию, исключая deleted.txt
                await copyRecursive(commitDir, workspaceRoot, ['deleted.txt']);

                // Получаем список всех файлов, которые были в этом коммите (кроме deleted.txt)
                const filesToCommit = (await getAllFilesRecursive(commitDir)).filter(f => f !== 'deleted.txt');

                // Добавляем в индекс только измененные/новые файлы
                if (filesToCommit.length > 0) {
                    const filesToAdd = filesToCommit.map(f => `"${f.replace(/\\//g, '/')}"`).join(' ');
                    await runCommand(`git add -- ${filesToAdd}`, workspaceRoot);
                }

                // Экранируем кавычки в сообщении коммита
                const escapedMessage = commit.message.replace(/"/g, '\"');
                // Коммитим, разрешая пустые коммиты (например, если были только удаления)
                await runCommand(`git commit --allow-empty -m "${escapedMessage}"`, workspaceRoot);
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

function runCommand(command, cwd, options = {}) {
    return new Promise((resolve, reject) => {
        exec(command, { encoding: 'utf8', cwd, ...options }, (error, stdout, stderr) => {
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

async function copyRecursive(src, dest, exclude = []) {
    const entries = await fs.readdir(src, { withFileTypes: true });
    for (let entry of entries) {
        if (exclude.includes(entry.name)) {
            continue;
        }
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            await fs.mkdir(destPath, { recursive: true });
            await copyRecursive(srcPath, destPath, exclude);
        } else {
            await fs.mkdir(path.dirname(destPath), { recursive: true });
            await fs.copyFile(srcPath, destPath);
        }
    }
}

// Рекурсивно получает все пути к файлам в директории, возвращая относительные пути
async function getAllFilesRecursive(baseDir) {
    const result = [];
    async function recurse(currentDir, relativePath) {
        const entries = await fs.readdir(currentDir, { withFileTypes: true });
        for (const entry of entries) {
            const newRelativePath = path.join(relativePath, entry.name);
            if (entry.isDirectory()) {
                await recurse(path.join(currentDir, entry.name), newRelativePath);
            } else {
                result.push(newRelativePath);
            }
        }
    }
    await recurse(baseDir, '');
    return result;
}



function deactivate() {}

module.exports = {
    activate,
    deactivate
}