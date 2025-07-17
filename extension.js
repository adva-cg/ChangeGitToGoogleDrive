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
const LAST_UPLOAD_HASHES_BY_BRANCH_KEY = 'lastUploadHashesByBranch';

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

    // Команда синхронизации
    let syncDisposable = vscode.commands.registerCommand('changegittogoogledrive-extension.sync', async () => {
        try {
            await sync(context);
        } catch (error) {
            vscode.window.showErrorMessage(`Sync failed: ${error.message}`);
        }
    });

    let installHooksDisposable = vscode.commands.registerCommand('changegittogoogledrive-extension.installGitHooks', async () => {
        try {
            await installGitHooks(context);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to install git hooks: ${error.message}`);
        }
    });

    context.subscriptions.push(setupCredentialsDisposable, authDisposable, initialUploadDisposable, syncDisposable, installHooksDisposable);
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
    const currentBranch = await getCurrentBranch(workspaceRoot);

    const drive = await getAuthenticatedClient(context);
    if (!drive) {
        vscode.window.showErrorMessage('Authentication with Google Drive is required.');
        return;
    }

    const projectName = path.basename(workspaceRoot);
    const gdriveGitDir = `.gdrive-git/${projectName}`;

    try {
        // Создаем корневую папку проекта на Google Drive
        const { data: projectFolder } = await drive.files.create({
            resource: {
                name: gdriveGitDir,
                mimeType: 'application/vnd.google-apps.folder',
            },
            fields: 'id',
        });

        // Создаем папку refs/heads
        const { data: refsFolder } = await drive.files.create({
            resource: {
                name: 'refs',
                mimeType: 'application/vnd.google-apps.folder',
                parents: [projectFolder.id],
            },
            fields: 'id',
        });
        const { data: headsFolder } = await drive.files.create({
            resource: {
                name: 'heads',
                mimeType: 'application/vnd.google-apps.folder',
                parents: [refsFolder.id],
            },
            fields: 'id',
        });

        // Создаем папку objects
        await drive.files.create({
            resource: {
                name: 'objects',
                mimeType: 'application/vnd.google-apps.folder',
                parents: [projectFolder.id],
            },
            fields: 'id',
        });

        // Загружаем текущий хеш ветки
        const { stdout: headHash } = await runCommand('git rev-parse HEAD', workspaceRoot);
        await drive.files.create({
            resource: {
                name: currentBranch,
                parents: [headsFolder.id],
            },
            media: {
                mimeType: 'text/plain',
                body: headHash.trim(),
            },
        });

        // Сохраняем локально, что мы синхронизированы с этим хешем
        const hashes = context.workspaceState.get(LAST_UPLOAD_HASHES_BY_BRANCH_KEY, {});
        hashes[currentBranch] = headHash.trim();
        await context.workspaceState.update(LAST_UPLOAD_HASHES_BY_BRANCH_KEY, hashes);

        vscode.window.showInformationMessage(`Successfully initialized Google Drive remote for project \'${projectName}\' and branch \'${currentBranch}\'.`);

    } catch (error) {
        vscode.window.showErrorMessage(`Failed to initialize Google Drive remote: ${error.message}`);
    }
}

// --- Подпрограмма: "Синхронизация" ---
async function sync(context) {
    await pushCommits(context);
}

// --- Подпрограмма: "Инкрементальная выгрузка" ---
async function pushCommits(context) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        vscode.window.showErrorMessage('No workspace folder is open.');
        return;
    }
    const workspaceRoot = workspaceFolders[0].uri.fsPath;
    const currentBranch = await getCurrentBranch(workspaceRoot);

    const drive = await getAuthenticatedClient(context);
    if (!drive) {
        vscode.window.showErrorMessage('Authentication with Google Drive is required.');
        return;
    }

    const projectName = path.basename(workspaceRoot);
    const gdriveGitDir = `.gdrive-git/${projectName}`;

    try {
        // Получаем ID папки проекта
        const { data: { files: projectFolders } } = await drive.files.list({
            q: `name=\'${gdriveGitDir}\' and mimeType=\'application/vnd.google-apps.folder\' and trashed=false`,
            fields: 'files(id)',
        });

        if (projectFolders.length === 0) {
            vscode.window.showErrorMessage(`Google Drive remote for project \'${projectName}\' not found. Please run initial upload first.`);
            return;
        }
        const projectFolderId = projectFolders[0].id;

        // Получаем ID папки refs
        const { data: { files: refsFolders } } = await drive.files.list({
            q: `name=\'refs\' and mimeType=\'application/vnd.google-apps.folder\' and \'${projectFolderId}\' in parents and trashed=false`,
            fields: 'files(id)',
        });
        const { data: { files: headsFolders } } = await drive.files.list({
            q: `name=\'heads\' and mimeType=\'application/vnd.google-apps.folder\' and \'${refsFolders[0].id}\' in parents and trashed=false`,
            fields: 'files(id)',
        });
        const headsFolderId = headsFolders[0].id;

        // Получаем ID папки objects
        const { data: { files: objectsFolders } } = await drive.files.list({
            q: `name=\'objects\' and mimeType=\'application/vnd.google-apps.folder\' and \'${projectFolderId}\' in parents and trashed=false`,
            fields: 'files(id)',
        });
        const objectsFolderId = objectsFolders[0].id;

        // Получаем последний хеш с Google Drive
        const { data: { files: branchFiles } } = await drive.files.list({
            q: `name=\'${currentBranch}\' and \'${headsFolderId}\' in parents and trashed=false`,
            fields: 'files(id, name)',
        });

        let lastRemoteHash = null;
        if (branchFiles.length > 0) {
            const { data: fileContent } = await drive.files.get({ fileId: branchFiles[0].id, alt: 'media' });
            lastRemoteHash = fileContent.trim();
        }

        const lastLocalHash = context.workspaceState.get(LAST_UPLOAD_HASHES_BY_BRANCH_KEY, {})[currentBranch];

        if (lastRemoteHash && lastRemoteHash !== lastLocalHash) {
            vscode.window.showErrorMessage('Remote history has diverged. Please pull changes first.');
            return;
        }

        const command = `git -c core.quotepath=false log ${lastLocalHash || '--all'} --pretty=format:"%H %aI %s" --reverse`;
        const { stdout } = await runCommand(command, workspaceRoot);
        if (!stdout) {
            vscode.window.showInformationMessage('No new commits to push.');
            return;
        }
        const commits = stdout.trim().split('\n').filter(Boolean).map(line => {
            const [hash, date, ...messageParts] = line.split(' ');
            const message = messageParts.join(' ');
            return { hash, date, message };
        });

        for (const commit of commits) {
            const tempDir = path.join(workspaceRoot, '.upload-temp');
            await fs.mkdir(tempDir, { recursive: true });
            const archivePath = path.join(tempDir, `${commit.hash}.zip`);

            const { stdout: files } = await runCommand(`git -c core.quotepath=false show --name-status --pretty="" ${commit.hash}`, workspaceRoot);
            const changedFilesWithStatus = files.trim().split('\n').filter(Boolean);

            const output = fsSync.createWriteStream(archivePath);
            const archive = archiver('zip', { zlib: { level: 9 } });
            archive.pipe(output);

            for (const line of changedFilesWithStatus) {
                const parts = line.split('\t');
                const status = parts[0];
                const file = parts[1];

                if (status.startsWith('A') || status.startsWith('M')) {
                    archive.file(path.join(workspaceRoot, file), { name: file });
                } else if (status.startsWith('D')) {
                    // Флаг удаления можно хранить в архиве, если потребуется
                } else if (status.startsWith('R')) {
                    // Обработка переименований
                }
            }
            await archive.finalize();

            await uploadToGoogleDrive(context, archivePath, objectsFolderId, `${commit.hash}.zip`);
            await fs.rm(tempDir, { recursive: true, force: true });
        }

        const { stdout: newHeadHash } = await runCommand('git rev-parse HEAD', workspaceRoot);

        if (branchFiles.length > 0) {
            await drive.files.update({
                fileId: branchFiles[0].id,
                media: {
                    mimeType: 'text/plain',
                    body: newHeadHash.trim(),
                },
            });
        } else {
            await drive.files.create({
                resource: {
                    name: currentBranch,
                    parents: [headsFolderId],
                },
                media: {
                    mimeType: 'text/plain',
                    body: newHeadHash.trim(),
                },
            });
        }

        const allHashes = context.workspaceState.get(LAST_UPLOAD_HASHES_BY_BRANCH_KEY, {});
        allHashes[currentBranch] = newHeadHash.trim();
        await context.workspaceState.update(LAST_UPLOAD_HASHES_BY_BRANCH_KEY, allHashes);

        vscode.window.showInformationMessage(`Successfully pushed ${commits.length} commits to branch \'${currentBranch}\'.`);

    } catch (error) {
        vscode.window.showErrorMessage(`Push failed: ${error.message}`);
    }
}

async function createAndUploadFullArchive(workspaceRoot, files, currentBranch) {
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

        // Добавляем информацию о ветке в архив
        if (currentBranch) {
            archive.append(`branch: ${currentBranch}`, { name: 'branch.info' });
        }

        // Добавляем папку .git в архив
        archive.directory(path.join(workspaceRoot, '.git'), '.git');

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
async function pullCommits(context) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        vscode.window.showErrorMessage('No workspace folder is open.');
        return;
    }
    const workspaceRoot = workspaceFolders[0].uri.fsPath;
    const currentBranch = await getCurrentBranch(workspaceRoot);

    const drive = await getAuthenticatedClient(context);
    if (!drive) {
        vscode.window.showErrorMessage('Authentication with Google Drive is required.');
        return;
    }

    const projectName = path.basename(workspaceRoot);
    const gdriveGitDir = `.gdrive-git/${projectName}`;

    try {
        // Получаем ID папки проекта
        const { data: { files: projectFolders } } = await drive.files.list({
            q: `name=\'${gdriveGitDir}\' and mimeType=\'application/vnd.google-apps.folder\' and trashed=false`,
            fields: 'files(id)',
        });

        if (projectFolders.length === 0) {
            vscode.window.showErrorMessage(`Google Drive remote for project \'${projectName}\' not found. Please run initial upload first.`);
            return;
        }
        const projectFolderId = projectFolders[0].id;

        // Получаем ID папки heads
        const { data: { files: refsFolders } } = await drive.files.list({
            q: `name=\'refs\' and mimeType=\'application/vnd.google-apps.folder\' and \'${projectFolderId}\' in parents and trashed=false`,
            fields: 'files(id)',
        });
        const { data: { files: headsFolders } } = await drive.files.list({
            q: `name=\'heads\' and mimeType=\'application/vnd.google-apps.folder\' and \'${refsFolders[0].id}\' in parents and trashed=false`,
            fields: 'files(id)',
        });
        const headsFolderId = headsFolders[0].id;

        // Получаем ID папки objects
        const { data: { files: objectsFolders } } = await drive.files.list({
            q: `name=\'objects\' and mimeType=\'application/vnd.google-apps.folder\' and \'${projectFolderId}\' in parents and trashed=false`,
            fields: 'files(id)',
        });
        const objectsFolderId = objectsFolders[0].id;

        // Получаем последний хеш с Google Drive
        const { data: { files: branchFiles } } = await drive.files.list({
            q: `name=\'${currentBranch}\' and \'${headsFolderId}\' in parents and trashed=false`,
            fields: 'files(id, name)',
        });

        if (branchFiles.length === 0) {
            vscode.window.showInformationMessage('No remote commits to pull.');
            return;
        }

        const { data: fileContent } = await drive.files.get({ fileId: branchFiles[0].id, alt: 'media' });
        const lastRemoteHash = fileContent.trim();
        const lastLocalHash = context.workspaceState.get(LAST_UPLOAD_HASHES_BY_BRANCH_KEY, {})[currentBranch];

        if (lastRemoteHash === lastLocalHash) {
            vscode.window.showInformationMessage('Already up-to-date.');
            return;
        }

        // Скачиваем недостающие коммиты
        const { stdout: missingCommits } = await runCommand(`git -c core.quotepath=false log ${lastRemoteHash}..${lastLocalHash} --pretty=format:"%H"`, workspaceRoot);
        const missingCommitHashes = missingCommits.trim().split('\n').filter(Boolean);

        const tempDir = path.join(workspaceRoot, '.download-temp');
        await fs.mkdir(tempDir, { recursive: true });

        for (const commitHash of missingCommitHashes) {
            const { data: { files } } = await drive.files.list({
                q: `name=\'${commitHash}.zip\' and \'${objectsFolderId}\' in parents and trashed=false`,
                fields: 'files(id)',
            });

            if (files.length > 0) {
                const fileId = files[0].id;
                const archivePath = path.join(tempDir, `${commitHash}.zip`);
                const dest = fsSync.createWriteStream(archivePath);
                const { data: fileStream } = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });

                await new Promise((resolve, reject) => {
                    fileStream.on('end', resolve);
                    fileStream.on('error', reject);
                    fileStream.pipe(dest);
                });

                await fsSync.createReadStream(archivePath).pipe(unzipper.Extract({ path: workspaceRoot })).promise();
                await fs.unlink(archivePath);
            }
        }

        await fs.rm(tempDir, { recursive: true, force: true });

        // Мержим изменения
        try {
            await runCommand(`git merge ${lastRemoteHash}`, workspaceRoot);
            vscode.window.showInformationMessage('Successfully pulled and merged changes.');
        } catch (error) {
            if (error.message.includes('conflict')) {
                vscode.window.showWarningMessage('Merge conflict detected. Please resolve conflicts and commit.');
            } else {
                throw error;
            }
        }

        const { stdout: newHeadHash } = await runCommand('git rev-parse HEAD', workspaceRoot);
        const allHashes = context.workspaceState.get(LAST_UPLOAD_HASHES_BY_BRANCH_KEY, {});
        allHashes[currentBranch] = newHeadHash.trim();
        await context.workspaceState.update(LAST_UPLOAD_HASHES_BY_BRANCH_KEY, allHashes);

    } catch (error) {
        vscode.window.showErrorMessage(`Pull failed: ${error.message}`);
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

async function uploadToGoogleDrive(context, archivePath, parentFolderId, fileName) {
    const drive = await getAuthenticatedClient(context);
    if (!drive) {
        vscode.window.showErrorMessage('Authentication with Google Drive is required.');
        return;
    }

    const media = {
        mimeType: 'application/zip',
        body: fsSync.createReadStream(archivePath),
    };

    const fileMetadata = {
        name: fileName,
        parents: [parentFolderId]
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

async function getCurrentBranch(cwd) {
    try {
        const { stdout } = await runCommand('git rev-parse --abbrev-ref HEAD', cwd);
        return stdout.trim();
    } catch (error) {
        vscode.window.showErrorMessage('Could not determine the current git branch.');
        throw new Error('Failed to get current branch');
    }
}



function deactivate() {}

module.exports = {
    activate,
    deactivate
}