const vscode = require('vscode');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const archiver = require('archiver');
const moment = require('moment');
const { exec } = require('child_process');
const unzipper = require('unzipper');
const { google } = require('googleapis');
const url = require('url');
const http = require('http');

const REDIRECT_URI = 'http://localhost:8080/oauth2callback';

// Ключи для хранения в SecretStorage и workspaceState
const GOOGLE_DRIVE_CREDENTIALS_KEY = 'googleDriveCredentials';
const GOOGLE_DRIVE_TOKENS_KEY = 'googleDriveTokens';
const LAST_UPLOAD_HASH_KEY = 'lastUploadCommitHash';

function activate(context) {
    // Команда для установки учетных данных
    let setupCredentialsDisposable = vscode.commands.registerCommand('changegittogoogledrive-extension.setupGoogleCredentials', async () => {
        try {
            await setupGoogleCredentials(context);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to set up Google credentials: ${error.message}`);
        }
    });

    // Команда аутентификации
    let authDisposable = vscode.commands.registerCommand('changegittogoogledrive-extension.authenticateWithGoogle', async () => {
        try {
            await authenticateWithGoogle(context);
        } catch (error) {
            vscode.window.showErrorMessage(`Authentication failed: ${error.message}`);
        }
    });

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

    context.subscriptions.push(setupCredentialsDisposable, authDisposable, initialUploadDisposable, incrementalUploadDisposable, downloadDisposable);
}

// --- Подпрограмма: "Установка учетных данных" ---
async function setupGoogleCredentials(context) {
    const options = {
        canSelectMany: false,
        openLabel: 'Select client_secret.json',
        filters: {
            'JSON files': ['json']
        }
    };

    const fileUri = await vscode.window.showOpenDialog(options);

    if (fileUri && fileUri[0]) {
        try {
            const filePath = fileUri[0].fsPath;
            const fileContent = await fs.readFile(filePath, 'utf8');
            // Проверяем, что это действительно файл учетных данных
            const credentials = JSON.parse(fileContent);
            if (credentials.installed || credentials.web) {
                await context.secrets.store(GOOGLE_DRIVE_CREDENTIALS_KEY, fileContent);
                vscode.window.showInformationMessage('Google credentials have been set up successfully.');
            } else {
                vscode.window.showErrorMessage('Invalid credentials file. Please select the correct client_secret.json file.');
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Error reading or parsing credentials file: ${error.message}`);
        }
    } else {
        vscode.window.showInformationMessage('Credential setup cancelled.');
    }
}

// --- Подпрограмма: "Аутентификация" ---
async function authenticateWithGoogle(context) {
    try {
        const credentialsStr = await context.secrets.get(GOOGLE_DRIVE_CREDENTIALS_KEY);
        if (!credentialsStr) {
            vscode.window.showErrorMessage('Google credentials are not set up. Please run the "Setup Google Credentials" command first.');
            return;
        }

        const credentials = JSON.parse(credentialsStr);
        const credsType = credentials.web ? 'web' : 'installed';
        const { client_id, client_secret, redirect_uris } = credentials[credsType];
        const redirect_uri = redirect_uris[0];

        if (!redirect_uri.includes('localhost')) {
            vscode.window.showErrorMessage('Only localhost redirect URIs are supported for this extension.');
            return;
        }

        const port = new url.URL(redirect_uri).port;

        const oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uri);

        return new Promise((resolve, reject) => {
            const server = http.createServer(async (req, res) => {
                const qs = new url.URL(req.url, `http://localhost:${port}`).searchParams;
                const code = qs.get('code');
                const error = qs.get('error');

                if (error) {
                    res.writeHead(500);
                    res.end(`Authentication failed: ${error}`);
                    server.close();
                    return reject(new Error(`Authentication error from Google: ${error}`));
                }

                if (!code) {
                    res.writeHead(400);
                    res.end('Authentication failed: Authorization code not found in callback.');
                    server.close();
                    return reject(new Error('Authorization code not found in callback.'));
                }

                try {
                    const { tokens } = await oauth2Client.getToken(code);
                    await context.secrets.store(GOOGLE_DRIVE_TOKENS_KEY, JSON.stringify(tokens));
                    
                    const storedTokens = await context.secrets.get(GOOGLE_DRIVE_TOKENS_KEY);
                    if (storedTokens) {
                        vscode.window.showInformationMessage('Successfully authenticated with Google Drive and tokens are stored!');
                        res.end('Authentication successful! You can close this browser tab.');
                    } else {
                        vscode.window.showErrorMessage('Authentication succeeded, but failed to store tokens. Please check your system keychain access.');
                        res.writeHead(500);
                        res.end('Authentication failed on server: Could not store tokens.');
                    }
                    resolve();
                } catch (e) {
                    vscode.window.showErrorMessage(`Failed to get or store tokens: ${e.message}`);
                    res.writeHead(500);
                    res.end('Authentication failed on server. Please check the extension logs.');
                    reject(new Error(`Failed to get tokens: ${e.message}`));
                } finally {
                    server.close();
                }
            }).listen(port, () => {
                const authUrl = oauth2Client.generateAuthUrl({
                    access_type: 'offline',
                    scope: ['https://www.googleapis.com/auth/drive.file'],
                    prompt: 'consent'
                });
                vscode.env.openExternal(vscode.Uri.parse(authUrl));
            });

            server.on('error', (e) => {
                reject(new Error(`Authentication server could not be started: ${e.message}`));
            });
        });
    } catch (error) {
        vscode.window.showErrorMessage(`Authentication failed: ${error.message}`);
    }
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
    const archivePath = await createAndUploadFullArchive(workspaceRoot, allFiles);
    if (archivePath) {
        await uploadToGoogleDrive(context, archivePath);
        const { stdout: headHash } = await runCommand('git rev-parse HEAD', workspaceRoot);
        await context.workspaceState.update(LAST_UPLOAD_HASH_KEY, headHash.trim());
    }
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

    const command = `git -c core.quotepath=false log ${lastUploadHash}..HEAD --pretty=format:"%H %aI %s" --reverse`;
    const { stdout } = await runCommand(command, workspaceRoot);
    if (!stdout) {
        vscode.window.showInformationMessage('No new commits to upload.');
        return;
    }
    const commits = stdout.trim().split('\n').filter(Boolean).map(line => {
        const [hash, date, ...messageParts] = line.split(' ');
        const message = messageParts.join(' ');
        return { hash, date, message };
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
        logContent += `${commit.hash} ${commit.date} ${commit.message}\n`;
    }

    await fs.writeFile(logFilePath, logContent);

    const archiveName = `${path.basename(workspaceRoot)}_${moment().format('YYYYMMDDHHmmss')}.zip`;
    const archivePath = path.join(workspaceRoot, archiveName);

    await createArchiveFromFolder(tempDir, archivePath);
    await uploadToGoogleDrive(context, archivePath);

    const { stdout: newHeadHash } = await runCommand('git rev-parse HEAD', workspaceRoot);
    await context.workspaceState.update(LAST_UPLOAD_HASH_KEY, newHeadHash.trim());
    await fs.rm(tempDir, { recursive: true, force: true });

    vscode.window.showInformationMessage(`Successfully created and uploaded incremental archive.`);
}

async function createAndUploadFullArchive(workspaceRoot, files) {
    const archiveName = `${path.basename(workspaceRoot)}_${moment().format('YYYYMMDDHHmmss')}.zip`;
    const archivePath = path.join(workspaceRoot, archiveName);
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.show();

    try {
        const output = fsSync.createWriteStream(archivePath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        const totalFiles = files.length;
        let processedFiles = 0;
        statusBarItem.text = `Archiving: 0/${totalFiles} files`;

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
                processedFiles++;
                statusBarItem.text = `Archiving: ${processedFiles}/${totalFiles} files`;
            } else {
                vscode.window.showWarningMessage(`File not found and will be skipped: ${file}`);
            }
        }

        await archive.finalize();
        await closePromise;

        return archivePath;

    } catch (error) {
        vscode.window.showErrorMessage(`Failed to create archive: ${error.message}`);
        // Попытаемся удалить частично созданный архив в случае ошибки
        if (fsSync.existsSync(archivePath)) {
            await fs.unlink(archivePath);
        }
        return null;
    } finally {
        statusBarItem.hide();
        statusBarItem.dispose();
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

    const drive = await getAuthenticatedClient(context);
    if (!drive) {
        vscode.window.showErrorMessage('Authentication with Google Drive is required.');
        return;
    }

    const { data } = await drive.files.list({
        q: "mimeType='application/zip' and trashed = false",
        fields: 'files(id, name)',
        orderBy: 'createdTime desc'
    });

    const files = data.files;
    if (files.length === 0) {
        vscode.window.showInformationMessage('No archives found on Google Drive.');
        return;
    }

    const selectedFile = await vscode.window.showQuickPick(files.map(f => ({ label: f.name, description: f.id })), {
        placeHolder: 'Select an archive to download'
    });

    if (!selectedFile) {
        return;
    }

    const fileId = selectedFile.description;
    const archivePath = path.join(workspaceRoot, selectedFile.label);

    const dest = fsSync.createWriteStream(archivePath);
    const { data: fileStream } = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });

    await new Promise((resolve, reject) => {
        fileStream.on('end', resolve);
        fileStream.on('error', reject);
        fileStream.pipe(dest);
    });

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
                const [hash, date, ...messageParts] = line.split(' ');
                const message = messageParts.join(' ');
                return { hash, date, message };
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
                const escapedMessage = commit.message.replace(/`/g, '`').replace(/"\//g, '"')
                // Коммитим, разрешая пустые коммиты (например, если были только удаления)
                await runCommand(`git commit --allow-empty -m "${escapedMessage}" --date="${commit.date}"`, workspaceRoot);
            }
			
			if (commitsToApply.length > 0) {
                const lastAppliedCommitHash = commitsToApply[commitsToApply.length - 1].hash;
                await context.workspaceState.update(LAST_UPLOAD_HASH_KEY, lastAppliedCommitHash);
                vscode.window.showInformationMessage(`${commitsToApply.length} commits have been successfully applied. Last commit hash updated to ${lastAppliedCommitHash.substring(0, 7)}.`);
            } else {
                vscode.window.showInformationMessage('No new commits were applied.');
            }

        } else {
            // Полное восстановление
            await copyRecursive(tempDir, workspaceRoot);
            vscode.window.showInformationMessage('Project has been fully restored from the archive. Please review and commit the changes.');
        }

    } finally {
        // Очистка
        await fs.rm(tempDir, { recursive: true, force: true });
        await fs.unlink(archivePath);
    }
}


// --- Вспомогательные функции ---

async function getAuthenticatedClient(context) {
    const credentialsStr = await context.secrets.get(GOOGLE_DRIVE_CREDENTIALS_KEY);
    if (!credentialsStr) {
        return null;
    }

    const credentials = JSON.parse(credentialsStr);
    const credsType = credentials.web ? 'web' : 'installed';
    const { client_id, client_secret, redirect_uris } = credentials[credsType];
    const redirect_uri = redirect_uris[0];

    const oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uri);

    const tokensStr = await context.secrets.get(GOOGLE_DRIVE_TOKENS_KEY);
    if (!tokensStr) {
        return null;
    }

    const tokens = JSON.parse(tokensStr);
    oauth2Client.setCredentials(tokens);

    // Проверяем, не истек ли токен, и обновляем его при необходимости
    if (oauth2Client.isTokenExpiring()) {
        try {
            const { credentials: newCredentials } = await oauth2Client.refreshAccessToken();
            await context.secrets.store(GOOGLE_DRIVE_TOKENS_KEY, JSON.stringify(newCredentials));
            oauth2Client.setCredentials(newCredentials);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to refresh access token: ${error.message}`);
            // Запускаем процесс аутентификации заново, если токен не удалось обновить
            await authenticateWithGoogle(context);
            return null; // Возвращаем null, так как аутентификация еще не завершена
        }
    }

    return google.drive({ version: 'v3', auth: oauth2Client });
}

async function uploadToGoogleDrive(context, archivePath) {
    const drive = await getAuthenticatedClient(context);
    if (!drive) {
        vscode.window.showErrorMessage('Authentication with Google Drive is required.');
        return;
    }

    const archiveName = path.basename(archivePath);

    const media = {
        mimeType: 'application/zip',
        body: fsSync.createReadStream(archivePath),
    };

    const fileMetadata = {
        name: archiveName,
    };

    try {
        const file = await drive.files.create({
            resource: fileMetadata,
            media: media,
            fields: 'id',
        });
        vscode.window.showInformationMessage(`Successfully uploaded archive to Google Drive with ID: ${file.data.id}`);
    } catch (error) {
        vscode.window.showErrorMessage(`Google Drive upload failed: ${error.message}`);
    } finally {
        // Удаляем локальный архив после выгрузки
        await fs.unlink(archivePath);
    }
}

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

async function countFilesInDirectory(dir) {
    let count = 0;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.isDirectory()) {
            count += await countFilesInDirectory(path.join(dir, entry.name));
        } else {
            count++;
        }
    }
    return count;
}

async function createArchiveFromFolder(folderPath, outputPath) {
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.show();

    try {
        const totalFiles = await countFilesInDirectory(folderPath);
        let processedFiles = 0;
        statusBarItem.text = `Archiving: ${processedFiles}/${totalFiles} files`;

        const output = fsSync.createWriteStream(outputPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        archive.on('entry', () => {
            processedFiles++;
            statusBarItem.text = `Archiving: ${processedFiles}/${totalFiles} files`;
        });

        const closePromise = new Promise((resolve, reject) => {
            output.on('close', resolve);
            archive.on('error', reject);
        });

        archive.pipe(output);
        archive.directory(folderPath, false);
        await archive.finalize();
        await closePromise;

    } finally {
        statusBarItem.hide();
        statusBarItem.dispose();
    }
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