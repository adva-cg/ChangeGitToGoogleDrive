const vscode = require('vscode');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { google } = require('googleapis');
const url = require('url');
const http = require('http');
const crypto = require('crypto');

const REDIRECT_URI = 'http://localhost:8080/oauth2callback';

// Ключи для хранения
const GOOGLE_DRIVE_CREDENTIALS_KEY = 'googleDriveCredentials';
const GOOGLE_DRIVE_TOKENS_KEY = 'googleDriveTokens';
const LAST_PUSHED_HASH_KEY_PREFIX = 'lastPushedHash_'; // Prefix + branch name
const MACHINE_ID_KEY = 'machineId';

function escapeGdriveQueryParam(param) {
    if (!param) return "";
    return param.replace(/\\/g, '/').replace(/'/g, "\\'");
}

function activate(context) {
    // --- ГЕНЕРАЦИЯ MACHINE ID ---
    let machineId = context.globalState.get(MACHINE_ID_KEY);
    if (!machineId) {
        machineId = vscode.env.machineId;
        context.globalState.update(MACHINE_ID_KEY, machineId);
    }

    // --- РЕГИСТРАЦИЯ КОМАНД ---
    context.subscriptions.push(
        vscode.commands.registerCommand('changegittogoogledrive-extension.setupGoogleCredentials', () => setupGoogleCredentials(context)),
        vscode.commands.registerCommand('changegittogoogledrive-extension.authenticateWithGoogle', () => authenticateWithGoogle(context)),
        vscode.commands.registerCommand('changegittogoogledrive-extension.initialUpload', () => initialUpload(context)),
        vscode.commands.registerCommand('changegittogoogledrive-extension.sync', () => sync(context)),
        vscode.commands.registerCommand('changegittogoogledrive-extension.installGitHooks', () => installGitHooks(context)),
        vscode.commands.registerCommand('changegittogoogledrive-extension.cloneFromGoogleDrive', () => cloneFromGoogleDrive(context)),
        vscode.commands.registerCommand('changegittogoogledrive-extension.manageSyncHash', () => manageSyncHash(context)),
        vscode.commands.registerCommand('changegittogoogledrive-extension.uploadUntrackedFiles', () => uploadUntrackedFiles(context, false)),
        vscode.commands.registerCommand('changegittogoogledrive-extension.syncUntrackedFiles', () => syncUntrackedFiles(context, false))
    );

    // --- РЕГИСТРАЦИЯ ОБРАБОТЧИКА URI ДЛЯ GIT HOOKS ---
    context.subscriptions.push(vscode.window.registerUriHandler({
        async handleUri(uri) {
            if (uri.path === '/sync') {
                vscode.window.showInformationMessage('Git hook triggered sync...');
                try {
                    await sync(context);
                } catch (error) {
                    vscode.window.showErrorMessage(`Sync from hook failed: ${error.message}`);
                }
            }
        }
    }));

    // --- АВТОМАТИЧЕСКАЯ СИНХРОНИЗАЦИЯ ПРИ ЗАПУСКЕ ---
    const config = vscode.workspace.getConfiguration('changegittogoogledrive-extension.untrackedFiles');
    if (config.get('syncOnStartup')) {
        syncUntrackedFiles(context, true);
    }

    // --- АВТОМАТИЧЕСКАЯ ВЫГРУЗКА НЕОТСЛЕЖИВАЕМЫХ ФАЙЛОВ ---
    let uploadTimeout;
    const workspaceRoot = getWorkspaceRoot();
    if (workspaceRoot) {
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspaceRoot, '**/*'));

        const debouncedUpload = () => {
            clearTimeout(uploadTimeout);
            uploadTimeout = setTimeout(() => {
                const uploadConfig = vscode.workspace.getConfiguration('changegittogoogledrive-extension.untrackedFiles');
                if (uploadConfig.get('autoUpload')) {
                    console.log('Auto-uploading untracked files...');
                    uploadUntrackedFiles(context, true);
                }
            }, 60000);
        };

        watcher.onDidChange(debouncedUpload);
        watcher.onDidCreate(debouncedUpload);
        context.subscriptions.push(watcher);
    }
}

// --- КОМАНДЫ СИНХРОНИЗАЦИИ НЕОТСЛЕЖИВАЕМЫХ ФАЙЛОВ ---

async function syncUntrackedFiles(context, silent = false) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const drive = await getAuthenticatedClient(context);
    if (!drive) return;

    if (!silent) {
        vscode.window.showInformationMessage('Syncing untracked files with Google Drive...');
    }

    try {
        const untrackedFolderId = await findOrCreateUntrackedFilesFolder(drive, workspaceRoot);
        if (!untrackedFolderId) return;

        const remoteFiles = await getAllRemoteFiles(drive, untrackedFolderId);
        const machineId = context.globalState.get(MACHINE_ID_KEY);

        for (const remoteFile of remoteFiles) {
            const localPath = path.join(workspaceRoot, remoteFile.name);
            try {
                const fileExistsLocally = fsSync.existsSync(localPath);

                if (fileExistsLocally) {
                    const localMd5 = await getFileMd5(localPath);
                    if (localMd5 !== remoteFile.md5Checksum) {
                        const remoteMachineId = (remoteFile.appProperties && remoteFile.appProperties.machineId) ? remoteFile.appProperties.machineId : null;
                        
                        if (remoteMachineId !== machineId) {
                            const choice = await vscode.window.showQuickPick(
                                [
                                    { label: "Download from Google Drive", description: `Overwrite local file: ${remoteFile.name}`, action: "download" },
                                    { label: "Keep Local Version", description: "Ignore remote changes", action: "keep" },
                                ],
                                { placeHolder: `Conflict detected for ${remoteFile.name}. The remote file was modified by another machine. What would you like to do?`, ignoreFocusOut: true }
                            );

                            if (choice && choice.action === 'download') {
                                await downloadFile(drive, remoteFile.id, localPath);
                                if (!silent) vscode.window.showInformationMessage(`Downloaded: ${remoteFile.name}`);
                            }
                        }
                    }
                } else {
                    await downloadFile(drive, remoteFile.id, localPath);
                    if (!silent) vscode.window.showInformationMessage(`Downloaded new file: ${remoteFile.name}`);
                }
            } catch (error) {
                vscode.window.showErrorMessage(`Error processing file ${remoteFile.name}: ${error.message}`);
            }
        }

        if (!silent) {
            vscode.window.showInformationMessage('Finished syncing untracked files.');
        }

    } catch (error) {
        vscode.window.showErrorMessage(`Failed to sync untracked files: ${error.message}`);
    }
}

async function uploadUntrackedFiles(context, silent = false) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const drive = await getAuthenticatedClient(context);
    if (!drive) return;

    if (!silent) {
        vscode.window.showInformationMessage('Uploading untracked files to Google Drive...');
    }

    try {
        const untrackedFolderId = await findOrCreateUntrackedFilesFolder(drive, workspaceRoot);
        if (!untrackedFolderId) return;

        const { stdout: untrackedFilesStr } = await runCommand('git ls-files --others --exclude-standard', workspaceRoot);
        let untrackedFiles = untrackedFilesStr.trim().split(/\r\n|\n/).filter(f => f);

        const config = vscode.workspace.getConfiguration('changegittogoogledrive-extension.untrackedFiles');
        const excludePatterns = config.get('exclude', []);
        if (excludePatterns.length > 0) {
            const minimatch = require('minimatch');
            untrackedFiles = untrackedFiles.filter(file =>
                !excludePatterns.some(pattern => minimatch(file, pattern, { matchBase: true }))
            );
        }

        if (untrackedFiles.length === 0) {
            if (!silent) vscode.window.showInformationMessage('No untracked files to upload.');
            return;
        }

        const machineId = context.globalState.get(MACHINE_ID_KEY);

        for (const relativePath of untrackedFiles) {
            const absolutePath = path.join(workspaceRoot, relativePath);
            try {
                const remoteFile = await findRemoteFile(drive, untrackedFolderId, relativePath);
                const localMd5 = await getFileMd5(absolutePath);

                if (remoteFile) {
                    if (localMd5 !== remoteFile.md5Checksum) {
                        const remoteMachineId = (remoteFile.appProperties && remoteFile.appProperties.machineId) ? remoteFile.appProperties.machineId : null;

                        if (remoteMachineId === machineId) {
                            await updateFile(drive, remoteFile.id, absolutePath, machineId);
                            if (!silent) vscode.window.showInformationMessage(`Updated: ${relativePath}`);
                        } else {
                            const choice = await vscode.window.showQuickPick(
                                [
                                    { label: "Upload & Overwrite", description: `Replace remote file: ${relativePath}`, action: "upload" },
                                    { label: "Skip", description: "Do not upload this file", action: "skip" },
                                ],
                                { placeHolder: `Conflict detected for ${relativePath}. The remote file was modified by another machine. What would you like to do?`, ignoreFocusOut: true }
                            );

                            if (choice && choice.action === 'upload') {
                                await updateFile(drive, remoteFile.id, absolutePath, machineId);
                                if (!silent) vscode.window.showInformationMessage(`Uploaded & Overwrote: ${relativePath}`);
                            }
                        }
                    }
                } else {
                    await createFile(drive, untrackedFolderId, absolutePath, relativePath, machineId);
                    if (!silent) vscode.window.showInformationMessage(`Uploaded new file: ${relativePath}`);
                }
            } catch (error) {
                vscode.window.showErrorMessage(`Error processing file ${relativePath}: ${error.message}`);
            }
        }

        if (!silent) {
            vscode.window.showInformationMessage('Finished uploading untracked files.');
        }

    } catch (error) {
        vscode.window.showErrorMessage(`Failed to upload untracked files: ${error.message}`);
    }
}


// --- ОСНОВНЫЕ КОМАНДЫ GIT -- -

async function initialUpload(context) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    try {
        const currentBranch = await getCurrentBranch(workspaceRoot);
        if (!currentBranch) return;

        await context.workspaceState.update(`${LAST_PUSHED_HASH_KEY_PREFIX}${currentBranch}`, undefined);
        vscode.window.showInformationMessage(`Статус синхронизации для ветки '${currentBranch}' сброшен. Начинаю новую выгрузку...`);

        await pushCommits(context);
    } catch (error) {
        vscode.window.showErrorMessage(`Первоначальная выгрузка не удалась: ${error.message}`);
    }
}

async function sync(context) {
    vscode.window.showInformationMessage('Syncing with Google Drive...');
    await pullCommits(context);
    await pushCommits(context);
    vscode.window.showInformationMessage('Sync finished.');
}

async function pushCommits(context) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const drive = await getAuthenticatedClient(context);
    if (!drive) return;

    const currentBranch = await getCurrentBranch(workspaceRoot);
    const lastPushedHash = context.workspaceState.get(`${LAST_PUSHED_HASH_KEY_PREFIX}${currentBranch}`);
    const currentHead = (await runCommand('git rev-parse HEAD', workspaceRoot)).stdout.trim();

    if (lastPushedHash === currentHead) {
        vscode.window.showInformationMessage('Already up-to-date. Nothing to push.');
        return;
    }

    if (lastPushedHash) {
        try {
            await runCommand(`git merge-base --is-ancestor ${lastPushedHash} HEAD`, workspaceRoot);
        } catch (error) {
            vscode.window.showErrorMessage(
                `Push aborted: History has been rewritten (e.g., via rebase or amend) after the last sync. ` +
                `Pushing is blocked to prevent corrupting the shared history. ` +
                `Recommendation: Use 'git revert' to undo changes that are already synced.`
            );
            return;
        }
    }

    const bundleFolderId = await findOrCreateProjectFolders(drive, workspaceRoot);
    if (!bundleFolderId) return;

    const revisionRange = lastPushedHash ? `${lastPushedHash}..HEAD` : 'HEAD';
    const { stdout: commitsToPush } = await runCommand(`git rev-list ${revisionRange}`, workspaceRoot);

    if (!commitsToPush.trim()) {
        vscode.window.showInformationMessage('No new commits to push.');
        return;
    }

    const bundleFileName = `${currentBranch}--${currentHead}.bundle`;
    const bundlePath = path.join(workspaceRoot, '.git', bundleFileName);

    try {
        vscode.window.showInformationMessage(`Creating bundle for range: ${revisionRange}`);
        const bundleCommand = `git bundle create \"${bundlePath}\" ${revisionRange}`;
        await runCommand(bundleCommand, workspaceRoot);

        await uploadBundleFile(drive, bundlePath, bundleFolderId);

        await context.workspaceState.update(`${LAST_PUSHED_HASH_KEY_PREFIX}${currentBranch}`, currentHead);
        vscode.window.showInformationMessage(`Successfully pushed commits up to ${currentHead.substring(0, 7)}.`);

    } catch (error) {
        vscode.window.showErrorMessage(`Push failed: ${error.message}`);
    } finally {
        if (fsSync.existsSync(bundlePath)) {
            await fs.unlink(bundlePath);
        }
    }
}

async function pullCommits(context) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const drive = await getAuthenticatedClient(context);
    if (!drive) return;

    const bundleFolderId = await findOrCreateProjectFolders(drive, workspaceRoot);
    if (!bundleFolderId) return;

    const currentBranch = await getCurrentBranch(workspaceRoot);
    if (!currentBranch) {
        vscode.window.showInformationMessage('Not on a branch, skipping pull.');
        return;
    }

    const q = `'${bundleFolderId}' in parents and trashed=false and fileExtension='bundle' and name contains '${escapeGdriveQueryParam(currentBranch)}--'`;
    const { data: { files: remoteBundles } } = await drive.files.list({
        q: q,
        fields: 'files(id, name, createdTime)',
        orderBy: 'createdTime',
    });

    if (!remoteBundles || remoteBundles.length === 0) {
        vscode.window.showInformationMessage('No remote commits found to pull.');
        return;
    }

    const { stdout: localCommitsResult } = await runCommand('git rev-list --all --pretty=format:%H', workspaceRoot);
    const localCommitSet = new Set(localCommitsResult.trim().split(/\s+/));

    const bundlesToDownload = remoteBundles.filter(bundle => {
        const commitHash = bundle.name.split('--')[1]?.replace('.bundle', '');
        return commitHash && !localCommitSet.has(commitHash);
    });

    if (bundlesToDownload.length === 0) {
        vscode.window.showInformationMessage('Local repository is up-to-date.');
        return;
    }

    vscode.window.showInformationMessage(`Found ${bundlesToDownload.length} new commit(s) to download.`);

    const tempDir = path.join(workspaceRoot, '.git', 'gdrive-temp-bundles');
    await fs.mkdir(tempDir, { recursive: true });

    try {
        for (const bundle of bundlesToDownload) {
            const tempBundlePath = path.join(tempDir, bundle.name);
            await downloadFile(drive, bundle.id, tempBundlePath);
            await runCommand(`git fetch \"${tempBundlePath}\"`, workspaceRoot);
            vscode.window.showInformationMessage(`Fetched commit ${bundle.name.split('--')[1]?.substring(0, 7)}.`);
        }

        await runCommand(`git merge --ff-only FETCH_HEAD`, workspaceRoot);
        vscode.window.showInformationMessage('Successfully merged remote changes.');

    } catch (error) {
        vscode.window.showInformationMessage('New commits have been fetched. Please merge or rebase your branch as needed.');
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
}

async function installGitHooks(context) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const hooksDir = path.join(workspaceRoot, '.git', 'hooks');
    const postCommitHookPath = path.join(hooksDir, 'post-commit');
    const extensionId = 'user.changegittogoogledrive-extension'; 

    const postCommitScript = `#!/bin/sh\n# Hook to trigger VS Code sync after commit\nif command -v code >/dev/null 2>&1; then\n  code --open-url "vscode://${extensionId}/sync"\nelse\n  echo "VS Code command 'code' not found in PATH. Cannot trigger sync."\nfi\n`;

    try {
        await fs.mkdir(hooksDir, { recursive: true });
        await fs.writeFile(postCommitHookPath, postCommitScript);
        await fs.chmod(postCommitHookPath, '755');
        vscode.window.showInformationMessage('Successfully installed post-commit hook!');
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to install git hooks: ${error.message}`);
    }
}

async function cloneFromGoogleDrive(context) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const files = await fs.readdir(workspaceRoot);
    if (files.length > 0) {
        vscode.window.showErrorMessage('Clone can only be done into an empty folder.');
        return;
    }

    const drive = await getAuthenticatedClient(context);
    if (!drive) return;

    try {
        const { data: { files: rootFolders } } = await drive.files.list({
            q: `name='.gdrive-git' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
            fields: 'files(id, name)'
        });
        if (rootFolders.length === 0) {
            vscode.window.showErrorMessage('No projects found on Google Drive. Please perform an initial upload from a source repository first.');
            return;
        }
        const rootFolderId = rootFolders[0].id;

        const { data: { files: projectFolders } } = await drive.files.list({
            q: `mimeType='application/vnd.google-apps.folder' and '${rootFolderId}' in parents and trashed=false`,
            fields: 'files(id, name)'
        });
        if (projectFolders.length === 0) {
            vscode.window.showErrorMessage('No projects found in the .gdrive-git folder.');
            return;
        }

        const selectedProject = await vscode.window.showQuickPick(
            projectFolders.map(f => ({ label: f.name, description: `(ID: ${f.id})`, id: f.id })),
            { placeHolder: 'Select the project to clone' }
        );
        if (!selectedProject) return;

        const { data: { files: bundlesFolders } } = await drive.files.list({
            q: `name='bundles' and mimeType='application/vnd.google-apps.folder' and '${selectedProject.id}' in parents and trashed=false`,
            fields: 'files(id)'
        });
        if (bundlesFolders.length === 0) {
            vscode.window.showErrorMessage(`No 'bundles' folder found for project ${selectedProject.label}.`);
            return;
        }
        const bundleFolderId = bundlesFolders[0].id;

        const { data: { files: remoteBundles } } = await drive.files.list({
            q: `'${bundleFolderId}' in parents and trashed=false and fileExtension='bundle'`,
            fields: 'files(id, name)',
            orderBy: 'createdTime desc'
        });
        if (!remoteBundles || remoteBundles.length === 0) {
            vscode.window.showErrorMessage('No bundles found to clone from.');
            return;
        }

        const selectedBundle = await vscode.window.showQuickPick(
            remoteBundles.map(b => ({ label: b.name, description: `(ID: ${b.id})`, id: b.id })),
            { placeHolder: 'Select the bundle to clone from (latest is recommended)' }
        );
        if (!selectedBundle) return;

        const tempDir = path.join(workspaceRoot, '.gdrive-temp-clone');
        await fs.mkdir(tempDir, { recursive: true });
        const tempBundlePath = path.join(tempDir, selectedBundle.label);

        vscode.window.showInformationMessage(`Downloading ${selectedBundle.label}...`);
        await downloadFile(drive, selectedBundle.id, tempBundlePath);

        vscode.window.showInformationMessage(`Cloning repository from ${selectedBundle.label}...`);
        const cloneTempDir = path.join(tempDir, 'cloned');
        await runCommand(`git clone \"${tempBundlePath}\" \"${cloneTempDir}\"`, tempDir);

        const [branchToCheckout, clonedHead] = selectedBundle.label.replace('.bundle', '').split('--');

        const clonedFiles = await fs.readdir(cloneTempDir);
        for (const file of clonedFiles) {
            await fs.rename(path.join(cloneTempDir, file), path.join(workspaceRoot, file));
        }

        await fs.rm(tempDir, { recursive: true, force: true });

        if (branchToCheckout) {
            try {
                await runCommand(`git checkout -b ${branchToCheckout}`, workspaceRoot);
                vscode.window.showInformationMessage(`Switched to branch '${branchToCheckout}'.`);
                await context.workspaceState.update(`${LAST_PUSHED_HASH_KEY_PREFIX}${branchToCheckout}`, clonedHead);
                vscode.window.showInformationMessage(`Set initial hash for branch '${branchToCheckout}' to ${clonedHead.substring(0, 7)}.`);
            } catch (error) {
                vscode.window.showWarningMessage(`Could not create and checkout branch '${branchToCheckout}'. Please do it manually.`);
            }
        } else {
            vscode.window.showWarningMessage(`Could not automatically determine the main branch from bundle name. Please checkout a branch manually.`);
        }

        vscode.window.showInformationMessage('Repository cloned successfully!');

        const installHooks = await vscode.window.showInformationMessage(
            'Do you want to install Git hooks to automatically sync on commit?',
            { modal: true },
            'Yes'
        );

        if (installHooks === 'Yes') {
            await installGitHooks(context);
        }

        vscode.window.showInformationMessage('Reloading window to apply changes...');
        vscode.commands.executeCommand('workbench.action.reloadWindow');

    } catch (error) {
        vscode.window.showErrorMessage(`Clone failed: ${error.message}`);
        const tempDir = path.join(workspaceRoot, '.gdrive-temp-clone');
        if (fsSync.existsSync(tempDir)) {
            await fs.rm(tempDir, { recursive: true, force: true });
        }
    }
}

async function manageSyncHash(context) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const currentBranch = await getCurrentBranch(workspaceRoot);
    if (!currentBranch) return;

    const hashKey = `${LAST_PUSHED_HASH_KEY_PREFIX}${currentBranch}`;
    const lastPushedHash = context.workspaceState.get(hashKey);

    const currentHashMessage = lastPushedHash
        ? `Текущий хеш синхронизации для ветки '${currentBranch}': ${lastPushedHash.substring(0, 7)}`
        : `Для ветки '${currentBranch}' не задан хеш синхронизации. Следующая отправка будет полной.`;

    vscode.window.showInformationMessage(currentHashMessage);

    const choice = await vscode.window.showQuickPick([
        { label: "Установить из последних коммитов", description: "Выбрать из 10 последних коммитов", action: "select" },
        { label: "Ввести хеш вручную", description: "Указать конкретный хеш коммита", action: "manual" },
        { label: "Сбросить хеш синхронизации", description: "Вызвать полную повторную выгрузку для этой ветки", action: "reset" },
        { label: "Отмена", isCloseAffordance: true, action: "cancel" }
    ], {
        placeHolder: "Как вы хотите изменить хеш синхронизации?"
    });

    if (!choice || choice.action === "cancel") {
        vscode.window.showInformationMessage("Операция отменена.");
        return;
    }

    let newHash = null;

    switch (choice.action) {
        case "select":
            newHash = await selectCommitHash(workspaceRoot);
            break;
        case "manual":
            newHash = await inputCommitHash();
            break;
        case "reset":
            newHash = undefined;
            break;
    }

    if (newHash === null) {
        vscode.window.showInformationMessage("Операция отменена.");
        return;
    }

    await context.workspaceState.update(hashKey, newHash);

    if (newHash === undefined) {
        vscode.window.showInformationMessage(`Хеш синхронизации для ветки '${currentBranch}' был сброшен.`);
    } else {
        vscode.window.showInformationMessage(`Хеш синхронизации для ветки '${currentBranch}' обновлен на: ${newHash.substring(0, 7)}`);
    }
}

async function selectCommitHash(workspaceRoot) {
    try {
        const { stdout } = await runCommand('git log -10 --pretty=format:"%H|%s"', workspaceRoot);
        if (!stdout.trim()) {
            vscode.window.showErrorMessage("В этом репозитории еще нет коммитов.");
            return null;
        }
        const commits = stdout.trim().split('\n').map(line => {
            const [hash, subject] = line.slice(1, -1).split('|');
            return { label: subject, description: hash.substring(0, 7), hash: hash };
        });

        const selectedCommit = await vscode.window.showQuickPick(commits, {
            placeHolder: "Выберите коммит, который будет новой точкой синхронизации"
        });

        return selectedCommit ? selectedCommit.hash : null;
    } catch (error) {
        vscode.window.showErrorMessage(`Не удалось получить последние коммиты: ${error.message}`);
        return null;
    }
}

async function inputCommitHash() {
    const newHash = await vscode.window.showInputBox({
        prompt: "Введите полный хеш коммита",
        placeHolder: "например, a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
        validateInput: value => /^[a-f0-9]{40}$/.test(value) ? null : "Неверный формат хеша. Укажите полный 40-символьный SHA-1 хеш."
    });
    return newHash === undefined ? null : newHash;
}

// --- АУТЕНТИФИКАЦИЯ И УТИЛИТЫ GOOGLE DRIVE ---

async function setupGoogleCredentials(context) {
    const fileUri = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: 'Select client_secret.json',
        filters: { 'JSON files': ['json'] }
    });

    if (fileUri && fileUri[0]) {
        try {
            const fileContent = await fs.readFile(fileUri[0].fsPath, 'utf8');
            const credentials = JSON.parse(fileContent);
            if (credentials.installed || credentials.web) {
                await context.secrets.store(GOOGLE_DRIVE_CREDENTIALS_KEY, fileContent);
                vscode.window.showInformationMessage('Google credentials stored successfully.');
            } else {
                throw new Error('Invalid credentials file format.');
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Error processing credentials file: ${error.message}`);
        }
    }
}

async function authenticateWithGoogle(context) {
    const credentialsStr = await context.secrets.get(GOOGLE_DRIVE_CREDENTIALS_KEY);
    if (!credentialsStr) {
        vscode.window.showErrorMessage('Set up Google Credentials first.');
        return;
    }

    const credentials = JSON.parse(credentialsStr);
    const credsType = credentials.web ? 'web' : 'installed';
    const { client_id, client_secret, redirect_uris } = credentials[credsType];
    const redirect_uri = redirect_uris[0];
    const port = new url.URL(redirect_uri).port;

    const oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uri);

    const server = http.createServer(async (req, res) => {
        try {
            const code = new url.URL(req.url, `http://localhost:${port}`).searchParams.get('code');
            res.end('Authentication successful! You can close this tab.');
            server.close();
            const { tokens } = await oauth2Client.getToken(code);
            await context.secrets.store(GOOGLE_DRIVE_TOKENS_KEY, JSON.stringify(tokens));
            vscode.window.showInformationMessage('Successfully authenticated with Google.');
        } catch (e) {
            vscode.window.showErrorMessage(`Authentication failed: ${e.message}`);
            res.end('Authentication failed. Check logs.');
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
}

async function getAuthenticatedClient(context) {
    const credentialsStr = await context.secrets.get(GOOGLE_DRIVE_CREDENTIALS_KEY);
    const tokensStr = await context.secrets.get(GOOGLE_DRIVE_TOKENS_KEY);

    if (!credentialsStr || !tokensStr) {
        vscode.window.showErrorMessage('Authentication required. Please run authentication command.');
        return null;
    }

    const credentials = JSON.parse(credentialsStr);
    const credsType = credentials.web ? 'web' : 'installed';
    const { client_id, client_secret, redirect_uris } = credentials[credsType];
    const oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

    oauth2Client.setCredentials(JSON.parse(tokensStr));

    if (oauth2Client.isTokenExpiring()) {
        try {
            const { credentials: newTokens } = await oauth2Client.refreshAccessToken();
            await context.secrets.store(GOOGLE_DRIVE_TOKENS_KEY, JSON.stringify(newTokens));
            oauth2Client.setCredentials(newTokens);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to refresh token: ${error.message}. Please re-authenticate.`);
            await authenticateWithGoogle(context);
            return null;
        }
    }
    return google.drive({ version: 'v3', auth: oauth2Client });
}

// --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ---

async function findOrCreateProjectFolders(drive, workspaceRoot) {
    const projectName = path.basename(workspaceRoot);
    const gdriveGitDir = `.gdrive-git`;

    let { data: { files: rootFolders } } = await drive.files.list({ q: `name='${gdriveGitDir}' and mimeType='application/vnd.google-apps.folder' and trashed=false`, fields: 'files(id)' });
    let rootFolderId;
    if (rootFolders.length === 0) {
        const { data } = await drive.files.create({ resource: { name: gdriveGitDir, mimeType: 'application/vnd.google-apps.folder' }, fields: 'id' });
        rootFolderId = data.id;
    } else {
        rootFolderId = rootFolders[0].id;
    }

    const q = `name='${escapeGdriveQueryParam(projectName)}' and mimeType='application/vnd.google-apps.folder' and '${rootFolderId}' in parents and trashed=false`;
    let { data: { files: projectFolders } } = await drive.files.list({ q: q, fields: 'files(id)' });
    let projectFolderId;
    if (projectFolders.length === 0) {
        const { data } = await drive.files.create({ resource: { name: projectName, mimeType: 'application/vnd.google-apps.folder', parents: [rootFolderId] }, fields: 'id' });
        projectFolderId = data.id;
    } else {
        projectFolderId = projectFolders[0].id;
    }

    const bundlesDir = `bundles`;
    let { data: { files: bundlesFolders } } = await drive.files.list({ q: `name='${bundlesDir}' and mimeType='application/vnd.google-apps.folder' and '${projectFolderId}' in parents and trashed=false`, fields: 'files(id)' });
    let bundlesFolderId;
    if (bundlesFolders.length === 0) {
        const { data } = await drive.files.create({ resource: { name: bundlesDir, mimeType: 'application/vnd.google-apps.folder', parents: [projectFolderId] }, fields: 'id' });
        bundlesFolderId = data.id;
    } else {
        bundlesFolderId = bundlesFolders[0].id;
    }

    return bundlesFolderId;
}

async function findOrCreateUntrackedFilesFolder(drive, workspaceRoot) {
    const projectName = path.basename(workspaceRoot);
    const gdriveGitDir = `.gdrive-git`;

    let { data: { files: rootFolders } } = await drive.files.list({ q: `name='${gdriveGitDir}' and mimeType='application/vnd.google-apps.folder' and trashed=false`, fields: 'files(id)' });
    let rootFolderId;
    if (rootFolders.length === 0) {
        const { data } = await drive.files.create({ resource: { name: gdriveGitDir, mimeType: 'application/vnd.google-apps.folder' }, fields: 'id' });
        rootFolderId = data.id;
    } else {
        rootFolderId = rootFolders[0].id;
    }

    const q = `name='${escapeGdriveQueryParam(projectName)}' and mimeType='application/vnd.google-apps.folder' and '${rootFolderId}' in parents and trashed=false`;
    let { data: { files: projectFolders } } = await drive.files.list({ q: q, fields: 'files(id)' });
    let projectFolderId;
    if (projectFolders.length === 0) {
        const { data } = await drive.files.create({ resource: { name: projectName, mimeType: 'application/vnd.google-apps.folder', parents: [rootFolderId] }, fields: 'id' });
        projectFolderId = data.id;
    } else {
        projectFolderId = projectFolders[0].id;
    }
    
    const untrackedDir = `untracked`;
    let { data: { files: untrackedFolders } } = await drive.files.list({ q: `name='${untrackedDir}' and mimeType='application/vnd.google-apps.folder' and '${projectFolderId}' in parents and trashed=false`, fields: 'files(id)' });
    let untrackedFolderId;
    if (untrackedFolders.length === 0) {
        const { data } = await drive.files.create({ resource: { name: untrackedDir, mimeType: 'application/vnd.google-apps.folder', parents: [projectFolderId] }, fields: 'id' });
        untrackedFolderId = data.id;
    } else {
        untrackedFolderId = untrackedFolders[0].id;
    }

    return untrackedFolderId;
}

async function uploadBundleFile(drive, filePath, parentFolderId) {
    const fileName = path.basename(filePath);
    const media = {
        mimeType: 'application/octet-stream',
        body: fsSync.createReadStream(filePath),
    };
    await drive.files.create({
        resource: { name: fileName, parents: [parentFolderId] },
        media: media,
        fields: 'id',
    });
}

async function getAllRemoteFiles(drive, folderId) {
    let files = [];
    let pageToken = null;
    do {
        const res = await drive.files.list({
            q: `'${folderId}' in parents and trashed=false`,
            fields: 'nextPageToken, files(id, name, md5Checksum, appProperties)',
            pageToken: pageToken,
        });
        files = files.concat(res.data.files);
        pageToken = res.data.nextPageToken;
    } while (pageToken);
    return files;
}

async function downloadFile(drive, fileId, destPath) {
    const dest = fsSync.createWriteStream(destPath);
    const { data: fileStream } = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
    await new Promise((resolve, reject) => {
        fileStream.pipe(dest).on('finish', resolve).on('error', reject);
    });
}

function getFileMd5(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('md5');
        const stream = fsSync.createReadStream(filePath);
        stream.on('data', (data) => hash.update(data));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}

async function findRemoteFile(drive, folderId, fileName) {
    const escapedFileName = escapeGdriveQueryParam(fileName);
    const q = `'${folderId}' in parents and name = '${escapedFileName}' and trashed=false`;
    const res = await drive.files.list({
        q: q,
        fields: 'files(id, name, md5Checksum, appProperties)',
    });
    return res.data.files[0];
}

async function createFile(drive, folderId, filePath, relativePath, machineId) {
    const fileName = relativePath.replace(/\\/g, '/');
    const media = { mimeType: 'application/octet-stream', body: fsSync.createReadStream(filePath) };
    await drive.files.create({
        resource: { name: fileName, parents: [folderId], appProperties: { machineId } },
        media: media,
        fields: 'id',
    });
}

async function updateFile(drive, fileId, filePath, machineId) {
    const media = { mimeType: 'application/octet-stream', body: fsSync.createReadStream(filePath) };
    await drive.files.update({
        fileId: fileId,
        resource: { appProperties: { machineId } },
        media: media,
        fields: 'id',
    });
}

function getWorkspaceRoot() {
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        return vscode.workspace.workspaceFolders[0].uri.fsPath;
    }
    vscode.window.showErrorMessage('No workspace folder is open.');
    return null;
}

function runCommand(command, cwd) {
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

async function getCurrentBranch(cwd) {
    try {
        const { stdout } = await runCommand('git rev-parse --abbrev-ref HEAD', cwd);
        return stdout.trim();
    } catch (error) {
        vscode.window.showErrorMessage('Could not determine the current git branch.');
        throw error;
    }
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
};