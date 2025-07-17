const vscode = require('vscode');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { google } = require('googleapis');
const url = require('url');
const http = require('http');

const REDIRECT_URI = 'http://localhost:8080/oauth2callback';

// Ключи для хранения в SecretStorage и workspaceState
const GOOGLE_DRIVE_CREDENTIALS_KEY = 'googleDriveCredentials';
const GOOGLE_DRIVE_TOKENS_KEY = 'googleDriveTokens';

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
    // Новая функция pushCommits обрабатывает начальный случай корректно.
    vscode.window.showInformationMessage('Starting initial upload. This may take a while for large repositories...');
    await pushCommits(context);
}

// --- Подпрограмма: "Синхронизация" ---
async function sync(context) {
    vscode.window.showInformationMessage('Starting sync...');
    await pullCommits(context);
    await pushCommits(context);
    vscode.window.showInformationMessage('Sync finished.');
}

// --- Подпрограмма: "Выгрузка изменений (Push)" ---
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
    const bundleName = `${currentBranch}.bundle`;
    // Сохраняем бандл в .git, чтобы избежать рекурсии и случайного добавления в коммиты
    const bundlePath = path.join(workspaceRoot, '.git', bundleName);

    try {
        // 1. Находим или создаем папку проекта на Google Drive
        let { data: { files: projectFolders } } = await drive.files.list({
            q: `name='${gdriveGitDir}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
            fields: 'files(id)',
        });

        let projectFolderId;
        if (projectFolders.length === 0) {
            vscode.window.showInformationMessage(`Project folder not found on Google Drive. Creating '${gdriveGitDir}'...`);
            const { data: projectFolder } = await drive.files.create({
                resource: {
                    name: gdriveGitDir,
                    mimeType: 'application/vnd.google-apps.folder',
                },
                fields: 'id',
            });
            projectFolderId = projectFolder.id;
        } else {
            projectFolderId = projectFolders[0].id;
        }

        // 2. Создаем git bundle
        vscode.window.showInformationMessage(`Creating bundle for branch '${currentBranch}'...`);
        await runCommand(`git bundle create "${bundlePath}" HEAD`, workspaceRoot);

        // 3. Проверяем, существует ли уже файл бандла на диске
        const { data: { files: existingBundles } } = await drive.files.list({
            q: `name='${bundleName}' and '${projectFolderId}' in parents and trashed=false`,
            fields: 'files(id)',
        });

        // 4. Загружаем бандл
        const media = {
            mimeType: 'application/octet-stream',
            body: fsSync.createReadStream(bundlePath),
        };
        const fileMetadata = {
            name: bundleName,
        };

        if (existingBundles.length > 0) {
            vscode.window.showInformationMessage(`Updating existing bundle on Google Drive...`);
            await drive.files.update({
                fileId: existingBundles[0].id,
                media: media,
            });
        } else {
            vscode.window.showInformationMessage(`Uploading new bundle to Google Drive...`);
            fileMetadata.parents = [projectFolderId];
            await drive.files.create({
                resource: fileMetadata,
                media: media,
                fields: 'id',
            });
        }

        vscode.window.showInformationMessage(`Successfully pushed branch '${currentBranch}' to Google Drive.`);

    } catch (error) {
        vscode.window.showErrorMessage(`Push failed: ${error.message}`);
    } finally {
        // 5. Очищаем локальный файл бандла
        if (fsSync.existsSync(bundlePath)) {
            await fs.unlink(bundlePath);
        }
    }
}

// --- Подпрограмма: "Загрузка изменений (Pull)" ---
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
    const bundleName = `${currentBranch}.bundle`;
    const tempBundlePath = path.join(workspaceRoot, '.git', `gdrive-${currentBranch}.bundle`);

    try {
        // 1. Находим папку проекта
        const { data: { files: projectFolders } } = await drive.files.list({
            q: `name='${gdriveGitDir}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
            fields: 'files(id)',
        });

        if (projectFolders.length === 0) {
            vscode.window.showInformationMessage(`No remote found for project '${projectName}'. Nothing to pull.`);
            return;
        }
        const projectFolderId = projectFolders[0].id;

        // 2. Находим файл бандла
        const { data: { files: bundleFiles } } = await drive.files.list({
            q: `name='${bundleName}' and '${projectFolderId}' in parents and trashed=false`,
            fields: 'files(id)',
        });

        if (bundleFiles.length === 0) {
            vscode.window.showInformationMessage(`No remote bundle found for branch '${currentBranch}'. Nothing to pull.`);
            return;
        }
        const bundleFileId = bundleFiles[0].id;

        // 3. Скачиваем бандл
        vscode.window.showInformationMessage(`Downloading bundle for branch '${currentBranch}'...`);
        const dest = fsSync.createWriteStream(tempBundlePath);
        const { data: fileStream } = await drive.files.get({ fileId: bundleFileId, alt: 'media' }, { responseType: 'stream' });
        await new Promise((resolve, reject) => {
            fileStream.on('end', resolve);
            fileStream.on('error', reject);
            fileStream.pipe(dest);
        });

        // 4. Выполняем pull из бандла
        vscode.window.showInformationMessage('Applying changes from bundle...');
        try {
            const commandPath = tempBundlePath.replace(/\\/g, '/');
            await runCommand(`git pull "${commandPath}"`, workspaceRoot);
            vscode.window.showInformationMessage(`Successfully pulled and merged changes for branch '${currentBranch}'.`);
        } catch (error) {
            if (error.message.includes('conflict')) {
                vscode.window.showWarningMessage('Merge conflict detected. Please resolve conflicts and commit.');
            } else if (error.message.includes('Already up to date')) {
                vscode.window.showInformationMessage('Already up-to-date.');
            } else {
                throw error;
            }
        }

    } catch (error) {
        vscode.window.showErrorMessage(`Pull failed: ${error.message}`);
    } finally {
        // 5. Очищаем временный файл
        if (fsSync.existsSync(tempBundlePath)) {
            await fs.unlink(tempBundlePath);
        }
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

async function installGitHooks(context) {
    vscode.window.showInformationMessage('Git hook installation is not implemented in this version.');
}

function runCommand(command, cwd, options = {}) {
    const execOptions = { encoding: 'utf8', cwd };
    Object.assign(execOptions, options);
    return new Promise((resolve, reject) => {
        exec(command, execOptions, (error, stdout, stderr) => {
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
};