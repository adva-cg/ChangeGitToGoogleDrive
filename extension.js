const vscode = require('vscode');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { google } = require('googleapis');
const url = require('url');
const http = require('http');
const crypto = require('crypto');
const { minimatch } = require('minimatch');
const os = require('os');

const REDIRECT_URI = 'http://localhost:8080/oauth2callback';

// Ключи для хранения
const GOOGLE_DRIVE_CREDENTIALS_KEY = 'googleDriveCredentials';
const GOOGLE_DRIVE_TOKENS_KEY = 'googleDriveTokens';
const LAST_PUSHED_HASH_KEY_PREFIX = 'lastPushedHash_'; // Prefix + branch name
const PROCESSED_TOMBSTONES_KEY = 'processedBranchTombstones';
const AI_HISTORY_ENABLED_KEY = 'aiHistoryEnabled'; // Stores true/false/undefined for the current project
const AI_HISTORY_IDS_KEY = 'aiHistoryConversationIds'; // Array of IDs for the current project
const AI_HISTORY_LOCAL_PATH = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
const CLIPBOARD_SYNC_FILE_NAME = 'clipboard_sync.json';
const LAST_CLIPBOARD_HASH_KEY = 'lastClipboardHash';

function escapeGdriveQueryParam(param) {
    if (!param) return "";
    return param.replace(/\\/g, '/').replace(/'/g, "'\'");
}

function activate(context) {
    // --- ГЕНЕРАЦИЯ MACHINE ID ---
    // Используем встроенный в VS Code ID машины напрямую, чтобы он не синхронизировался
    const machineId = vscode.env.machineId;

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
        vscode.commands.registerCommand('changegittogoogledrive-extension.syncUntrackedFiles', () => syncUntrackedFiles(context, false)),
        vscode.commands.registerCommand('changegittogoogledrive-extension.deleteUntrackedFile', () => deleteUntrackedFile(context)),
        vscode.commands.registerCommand('changegittogoogledrive-extension.clearTombstones', () => clearTombstones(context)),
        vscode.commands.registerCommand('changegittogoogledrive-extension.syncAIHistory', () => syncAIHistory(context, false)),
        vscode.commands.registerCommand('changegittogoogledrive-extension.configureAIHistorySync', () => configureAIHistorySync(context)),
        vscode.commands.registerCommand('changegittogoogledrive-extension.toggleClipboardSync', () => toggleClipboardSync(context))
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
    const aiConfig = vscode.workspace.getConfiguration('changegittogoogledrive-extension.aiHistory');
    if (aiConfig.get('autoSync')) {
        syncAIHistory(context, true);
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

    // --- ТРЕКИНГ ТЕКУЩЕЙ БЕСЕДЫ ---
    trackCurrentConversation(context);

    // --- АВТОМАТИЧЕСКАЯ СИНХРОНИЗАЦИЯ ИСТОРИИ AI ПРИ ИЗМЕНЕНИИ ---
    let aiHistorySyncTimeout;
    const aiWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(AI_HISTORY_LOCAL_PATH), '**/*'));

    const debouncedAIHistorySync = () => {
        clearTimeout(aiHistorySyncTimeout);
        aiHistorySyncTimeout = setTimeout(() => {
            const aiHistoryConfig = vscode.workspace.getConfiguration('changegittogoogledrive-extension.aiHistory');
            const isEnabled = context.workspaceState.get(AI_HISTORY_ENABLED_KEY);
            // Синхронизируем, если включено и не в режиме 'never'
            if (isEnabled !== false && aiHistoryConfig.get('syncMode') !== 'never') {
                console.log('Auto-syncing AI history after changes...');
                syncAIHistory(context, true);
            }
        }, 60000); // 60 секунд тишины перед синхронизацией
    };

    aiWatcher.onDidChange(debouncedAIHistorySync);
    aiWatcher.onDidCreate(debouncedAIHistorySync);
    aiWatcher.onDidDelete(debouncedAIHistorySync);
    context.subscriptions.push(aiWatcher);
    
    // --- МОНИТОРИНГ GIT-ХУКОВ ЧЕРЕЗ ФАЙЛ-ТРИГГЕР ---
    if (workspaceRoot) {
        const syncTriggerPath = path.join(workspaceRoot, '.git', 'SYNC_REQUEST');
        const syncWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.dirname(syncTriggerPath), path.basename(syncTriggerPath)));
        
        const handleSyncTrigger = async () => {
            console.log('Git hook trigger detected via SYNC_REQUEST file...');
            try {
                if (fsSync.existsSync(syncTriggerPath)) {
                    await fs.unlink(syncTriggerPath);
                }
                await sync(context);
            } catch (error) {
                vscode.window.showErrorMessage(`Sync from hook trigger failed: ${error.message}`);
            }
        };

        syncWatcher.onDidCreate(handleSyncTrigger);
        syncWatcher.onDidChange(handleSyncTrigger);
        context.subscriptions.push(syncWatcher);
    }

    // --- МОНИТОРИНГ ВЕТОК ГИТА ---
    setupBranchMonitoring(context);

    // --- ОБЛАЧНЫЙ БУФЕР ОБМЕНА ---
    setupCloudClipboard(context);
}

let clipboardInterval;

async function toggleClipboardSync(context) {
    const config = vscode.workspace.getConfiguration('changegittogoogledrive-extension.clipboard');
    const currentState = config.get('syncEnabled');
    await config.update('syncEnabled', !currentState, vscode.ConfigurationTarget.Global);
    
    if (!currentState) {
        vscode.window.showInformationMessage('Cloud Clipboard: Синхронизация включена');
        setupCloudClipboard(context);
    } else {
        vscode.window.showInformationMessage('Cloud Clipboard: Синхронизация выключена');
        if (clipboardInterval) {
            clearInterval(clipboardInterval);
            clipboardInterval = null;
        }
    }
}

async function setupCloudClipboard(context) {
    if (clipboardInterval) {
        clearInterval(clipboardInterval);
    }

    const config = vscode.workspace.getConfiguration('changegittogoogledrive-extension.clipboard');
    if (!config.get('syncEnabled')) return;

    const intervalTime = Math.max(config.get('syncInterval') || 5000, 1000);
    
    // Пытаемся синхронизироваться сразу при запуске
    syncCloudClipboard(context).catch(e => console.error('Initial clipboard sync failed:', e));

    clipboardInterval = setInterval(() => {
        syncCloudClipboard(context).catch(e => console.error('Periodic clipboard sync failed:', e));
    }, intervalTime);
    
    context.subscriptions.push({ dispose: () => clearInterval(clipboardInterval) });
}

let isSyncingClipboard = false;
async function syncCloudClipboard(context) {
    if (isSyncingClipboard) return;
    isSyncingClipboard = true;

    try {
        const drive = await getAuthenticatedClient(context);
        if (!drive) {
            isSyncingClipboard = false;
            return;
        }

        const machineId = vscode.env.machineId;
        const gdriveGitDirId = await findOrCreateBaseGdriveDir(drive);
        if (!gdriveGitDirId) throw new Error("Could not find/create base GDrive folder");

        const syncFile = await findClipboardSyncFile(drive, gdriveGitDirId);
        
        // 1. Проверяем локальный буфер
        const local = await getLocalClipboard();
        const lastLocalHash = context.globalState.get(LAST_CLIPBOARD_HASH_KEY);

        if (local && local.hash !== lastLocalHash) {
            // Буфер изменился локально - выгружаем
            console.log('Clipboard changed locally, uploading...');
            const content = {
                type: local.type,
                data: local.data,
                timestamp: new Date().toISOString(),
                machineId: machineId
            };

            if (syncFile) {
                await drive.files.update({
                    fileId: syncFile.id,
                    resource: { appProperties: { machineId: machineId, hash: local.hash } },
                    media: { mimeType: 'application/json', body: JSON.stringify(content) }
                });
            } else {
                await drive.files.create({
                    resource: { 
                        name: CLIPBOARD_SYNC_FILE_NAME, 
                        parents: [gdriveGitDirId], 
                        appProperties: { machineId: machineId, hash: local.hash } 
                    },
                    media: { mimeType: 'application/json', body: JSON.stringify(content) }
                });
            }
            await context.globalState.update(LAST_CLIPBOARD_HASH_KEY, local.hash);
        }

        // 2. Проверяем облако
        if (syncFile) {
            const remoteMachineId = syncFile.appProperties ? syncFile.appProperties.machineId : null;
            const remoteHash = syncFile.appProperties ? syncFile.appProperties.hash : null;

            if (remoteMachineId && remoteMachineId !== machineId && remoteHash !== lastLocalHash) {
                // В облаке данные от другого устройства и у нас их еще нет
                console.log('Cloud clipboard has new data from another device, downloading...');
                const { data: content } = await drive.files.get({ fileId: syncFile.id, alt: 'media' });
                
                if (content && content.type && content.data) {
                    await setLocalClipboard(content.type, content.data);
                    await context.globalState.update(LAST_CLIPBOARD_HASH_KEY, remoteHash);
                    vscode.window.showStatusBarMessage(`📋 Буфер обновлен из облака (${content.type === 'image' ? 'Картинка' : 'Текст'})`, 3000);
                }
            }
        }
    } catch (error) {
        console.error('Clipboard sync error:', error);
    } finally {
        isSyncingClipboard = false;
    }
}

async function findClipboardSyncFile(drive, parentId) {
    const q = `name='${CLIPBOARD_SYNC_FILE_NAME}' and '${parentId}' in parents and trashed=false`;
    const { data: { files } } = await drive.files.list({ q, fields: 'files(id, name, appProperties, modifiedTime)' });
    return files.length > 0 ? files[0] : null;
}

async function findOrCreateBaseGdriveDir(drive) {
    const gdriveGitDir = `.gdrive-git`;
    let { data: { files: rootFolders } } = await drive.files.list({
        q: `name='${gdriveGitDir}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: 'files(id)'
    });

    if (rootFolders.length === 0) {
        const { data } = await drive.files.create({
            resource: { name: gdriveGitDir, mimeType: 'application/vnd.google-apps.folder' },
            fields: 'id'
        });
        return data.id;
    }
    return rootFolders[0].id;
}

async function getLocalClipboard() {
    // 1. Проверяем на картинку через PowerShell
    try {
        const isImage = (await runCommand('powershell -noprofile -command "Add-Type -AssemblyName System.Windows.Forms; [Windows.Forms.Clipboard]::ContainsImage()"')).stdout.trim() === 'True';
        if (isImage) {
            const base64 = (await runCommand('powershell -noprofile -command "Add-Type -AssemblyName System.Windows.Forms; $img = [Windows.Forms.Clipboard]::GetImage(); if ($img) { $ms = New-Object System.IO.MemoryStream; $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); [Convert]::ToBase64String($ms.ToArray()) }"')).stdout.trim();
            if (base64) {
                const hash = crypto.createHash('md5').update(base64).digest('hex');
                return { type: 'image', data: base64, hash: hash };
            }
        }
    } catch (e) {
        console.error('Failed to check for image in clipboard:', e);
    }

    // 2. Если не картинка, проверяем текст
    const text = await vscode.env.clipboard.readText();
    if (text) {
        const hash = crypto.createHash('md5').update(text).digest('hex');
        return { type: 'text', data: text, hash: hash };
    }

    return null;
}

async function setLocalClipboard(type, data) {
    if (type === 'text') {
        await vscode.env.clipboard.writeText(data);
    } else if (type === 'image') {
        try {
            // Используем временный файл для записи картинки, чтобы не превысить лимит длины команды PowerShell
            const tempFile = path.join(os.tmpdir(), `cv_temp_${Date.now()}.b64`);
            await fs.writeFile(tempFile, data);
            
            const psCommand = `powershell -noprofile -command "Add-Type -AssemblyName System.Windows.Forms; $b64 = Get-Content '${tempFile}' -Raw; [Windows.Forms.Clipboard]::SetImage([System.Drawing.Image]::FromStream((New-Object System.IO.MemoryStream([Convert]::FromBase64String($b64)))))"`;
            await runCommand(psCommand);
            
            await fs.unlink(tempFile);
        } catch (e) {
            console.error('Failed to set image to clipboard:', e);
        }
    }
}

let lastKnownBranches = new Set();

async function setupBranchMonitoring(context) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    // Инициализация начального списка веток
    try {
        const branches = await getLocalBranches(workspaceRoot);
        lastKnownBranches = new Set(branches);
    } catch (e) {
        console.error('Failed to initialize branch list:', e);
    }

    // Используем расширение Git для отслеживания изменений
    const gitExtension = vscode.extensions.getExtension('vscode.git');
    if (gitExtension) {
        const api = gitExtension.exports.getAPI(1);
        api.onDidOpenRepository(repo => subscribeToRepo(repo, context));
        api.repositories.forEach(repo => subscribeToRepo(repo, context));
    } else {
        // Fallback: периодическая проверка, если расширение Git не найдено (маловероятно в VS Code)
        setInterval(() => checkForBranchChanges(context), 30000);
    }
}

function subscribeToRepo(repo, context) {
    repo.state.onDidChange(() => checkForBranchChanges(context));
}

async function checkForBranchChanges(context) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    try {
        const currentBranches = await getLocalBranches(workspaceRoot);
        const currentBranchesSet = new Set(currentBranches);

        // Поиск удаленных веток
        for (const branch of lastKnownBranches) {
            if (!currentBranchesSet.has(branch)) {
                // Ветка была удалена!
                offerToDeleteBranchFromDrive(context, branch);
            }
        }

        lastKnownBranches = currentBranchesSet;
    } catch (e) {
        console.error('Error checking for branch changes:', e);
    }
}

async function getLocalBranches(workspaceRoot) {
    const { stdout } = await runCommand('git branch --list --no-color', workspaceRoot);
    return stdout.split('\n')
        .map(b => b.trim().replace('* ', ''))
        .filter(b => b && !b.startsWith('(')); // Игнорируем "(HEAD detached at...)"
}

async function offerToDeleteBranchFromDrive(context, branchName) {
    const choice = await vscode.window.showInformationMessage(
        `Ветка '${branchName}' была удалена локально. Удалить её бандлы из Google Drive и уведомить другие компьютеры?`,
        'Да', 'Нет'
    );

    if (choice === 'Да') {
        await deleteBranchFromDrive(context, branchName);
    }
}

async function deleteBranchFromDrive(context, branchName) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const drive = await getAuthenticatedClient(context);
    if (!drive) return;

    vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Удаление ветки '${branchName}' из Google Drive...`,
        cancellable: false
    }, async (progress) => {
        try {
            const bundleFolderId = await findOrCreateProjectFolders(drive, workspaceRoot);
            const sanitizedName = sanitizeBranchNameForDrive(branchName);

            // 1. Поиск и удаление бандлов
            const q = `'${bundleFolderId}' in parents and name contains '${sanitizedName}--' and trashed=false`;
            const { data: { files } } = await drive.files.list({ q, fields: 'files(id, name)' });

            for (const file of files) {
                // Дополнительная проверка, чтобы точно совпало начало имени (префикс ветки)
                if (file.name.startsWith(`${sanitizedName}--`)) {
                    await drive.files.update({ fileId: file.id, resource: { trashed: true } });
                }
            }

            // 2. Создание надгробия (tombstone) для ветки
            const tombstonesFolderId = await findOrCreateTombstonesFolder(drive, workspaceRoot);
            const branchTombstonesFolderId = await findOrCreateSubFolder(drive, tombstonesFolderId, 'branches');

            await drive.files.create({
                resource: {
                    name: sanitizedName,
                    parents: [branchTombstonesFolderId],
                    mimeType: 'text/plain'
                },
                media: {
                    mimeType: 'text/plain',
                    body: `Deleted at ${new Date().toISOString()}`
                }
            });

            // 3. Очистка локального состояния
            await context.workspaceState.update(`${LAST_PUSHED_HASH_KEY_PREFIX}${branchName}`, undefined);

            vscode.window.showInformationMessage(`Ветка '${branchName}' успешно удалена из Google Drive.`);
        } catch (error) {
            vscode.window.showErrorMessage(`Ошибка при удалении ветки '${branchName}' из Google Drive: ${error.message}`);
        }
    });
}

// --- КОМАНДЫ УПРАВЛЕНИЯ НЕОТСЛЕЖИВАЕМЫМИ ФАЙЛАМИ ---

async function deleteUntrackedFile(context) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const drive = await getAuthenticatedClient(context);
    if (!drive) return;

    try {
        const config = vscode.workspace.getConfiguration('changegittogoogledrive-extension.untrackedFiles');
        const includePatterns = config.get('include', []);
        const excludePatterns = config.get('exclude', []);
        if (includePatterns.length === 0) {
            vscode.window.showInformationMessage('Нет настроенных шаблонов для неотслеживаемых файлов.');
            return;
        }

        const { stdout: allIgnoredFilesStr } = await runCommand('git -c core.quotePath=false ls-files --others --ignored --exclude-standard', workspaceRoot);
        const allIgnoredFiles = allIgnoredFilesStr.trim().split(/\r\n|\n/).filter(f => f);
        const filesToList = allIgnoredFiles.filter(file => {
            if (!file) return false;
            const isIncluded = includePatterns.some(p => minimatch(file, p, { matchBase: true }));
            if (!isIncluded) return false;
            const isExcluded = excludePatterns.some(p => minimatch(file, p, { matchBase: true }));
            return !isExcluded;
        }).sort();

        if (filesToList.length === 0) {
            vscode.window.showInformationMessage('Не найдено неотслеживаемых файлов, соответствующих шаблонам.');
            return;
        }

        const selectedFiles = await vscode.window.showQuickPick(filesToList, {
            placeHolder: 'Выберите неотслеживаемые файлы для удаления',
            canPickMany: true
        });

        if (!selectedFiles || selectedFiles.length === 0) {
            vscode.window.showInformationMessage('Файлы не выбраны.');
            return;
        }

        const confirmation = await vscode.window.showWarningMessage(
            `Вы уверены, что хотите удалить ${selectedFiles.length} файл(ов)? Файлы будут удалены локально, а их версии на Google Drive будут перемещены в корзину.`,
            { modal: true },
            'Да, удалить'
        );

        if (confirmation !== 'Да, удалить') {
            vscode.window.showInformationMessage('Операция удаления отменена.');
            return;
        }

        const untrackedFolderId = await findOrCreateUntrackedFilesFolder(drive, workspaceRoot);
        const deletedFolderId = await findOrCreateDeletedFolder(drive, untrackedFolderId);
        let deletedCount = 0;
        let errorCount = 0;

        for (const selectedFile of selectedFiles) {
            try {
                const remoteFile = await findRemoteFile(drive, untrackedFolderId, selectedFile);

                if (!remoteFile) {
                    vscode.window.showWarningMessage(`Файл "${selectedFile}" не найден на Google Drive. Удаление только локально.`);
                } else {
                    await moveFileToDeleted(drive, remoteFile, untrackedFolderId, deletedFolderId);
                }

                const localPath = path.join(workspaceRoot, selectedFile);
                if (fsSync.existsSync(localPath)) {
                    await fs.unlink(localPath);
                }
                deletedCount++;
            } catch (fileError) {
                errorCount++;
                vscode.window.showErrorMessage(`Ошибка при удалении файла "${selectedFile}": ${fileError.message}`);
            }
        }

        vscode.window.showInformationMessage(`Удалено ${deletedCount} из ${selectedFiles.length} файлов. Ошибок: ${errorCount}.`);

    } catch (error) {
        vscode.window.showErrorMessage(`Ошибка при удалении файла: ${error.message}`);
    }
}

async function clearTombstones(context) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const drive = await getAuthenticatedClient(context);
    if (!drive) return;

    try {
        const untrackedFolderId = await findOrCreateUntrackedFilesFolder(drive, workspaceRoot);
        if (!untrackedFolderId) {
            vscode.window.showInformationMessage('Не найдена папка неотслеживаемых файлов.');
            return;
        }
        const deletedFolderId = await findOrCreateDeletedFolder(drive, untrackedFolderId);

        const tombstones = await getAllRemoteFiles(drive, deletedFolderId, true);

        if (tombstones.length === 0) {
            vscode.window.showInformationMessage('Корзина неотслеживаемых файлов пуста.');
            return;
        }

        const confirmation = await vscode.window.showWarningMessage(
            `Найдено ${tombstones.length} файлов в корзине. Вы уверены, что хотите их все удалить навсегда? Это действие необратимо.`,
            { modal: true },
            'Да, очистить корзину'
        );

        if (confirmation !== 'Да, очистить корзину') {
            vscode.window.showInformationMessage('Операция очистки отменена.');
            return;
        }

        for (const tombstone of tombstones) {
            await drive.files.delete({ fileId: tombstone.id });
        }

        const decisions = getConflictDecisions(context);
        let changed = false;
        for (const key in decisions) {
            if (decisions[key].decision === 'ignore_tombstone') {
                delete decisions[key];
                changed = true;
            }
        }
        if (changed) {
            await context.workspaceState.update(CONFLICT_DECISIONS_KEY, decisions);
        }

        vscode.window.showInformationMessage(`Корзина из ${tombstones.length} файлов успешно очищена.`);

    } catch (error) {
        vscode.window.showErrorMessage(`Ошибка при очистке корзины: ${error.message}`);
    }
}

// --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ДЛЯ КОНФЛИКТОВ И НАДГРОБИЙ ---

function getConflictDecisions(context) {
    return context.workspaceState.get(CONFLICT_DECISIONS_KEY, {});
}

async function setConflictDecision(context, decision) {
    const decisions = getConflictDecisions(context);
    decisions[decision.key] = decision.data;
    await context.workspaceState.update(CONFLICT_DECISIONS_KEY, decisions);
}

async function clearConflictDecision(context, key) {
    const decisions = getConflictDecisions(context);
    delete decisions[key];
    await context.workspaceState.update(CONFLICT_DECISIONS_KEY, decisions);
}

async function findOrCreateDeletedFolder(drive, untrackedFolderId) {
    const folderName = '.deleted';
    const q = `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and '${untrackedFolderId}' in parents and trashed=false`;
    let { data: { files } } = await drive.files.list({ q, fields: 'files(id)' });

    if (files.length > 0) {
        return files[0].id;
    } else {
        const { data } = await drive.files.create({
            resource: { name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [untrackedFolderId] },
            fields: 'id'
        });
        return data.id;
    }
}

async function moveFileToDeleted(drive, fileToMove, untrackedFolderId, deletedFolderId) {
    // Найдем оригинальный ID родительской папки, чтобы можно было его удалить
    const { data: { parents } } = await drive.files.get({
        fileId: fileToMove.id,
        fields: 'parents'
    });
    const originalParentId = parents[0];

    // Перемещаем файл
    await drive.files.update({
        fileId: fileToMove.id,
        addParents: deletedFolderId,
        removeParents: originalParentId,
        fields: 'id, parents'
    });
}

async function getAllTombstones(drive, deletedFolderId) {
    const files = await getAllRemoteFiles(drive, deletedFolderId, true); // true to get full hierarchy
    return new Set(files.map(f => f.name));
}


// --- КОМАНДЫ СИНХРОНИЗАЦИИ НЕОТСЛЕЖИВАЕМЫХ ФАЙЛОВ ---

async function syncUntrackedFiles(context, silent = false) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const drive = await getAuthenticatedClient(context);
    if (!drive) return;

    if (!silent) {
        vscode.window.showInformationMessage('Синхронизация неотслеживаемых файлов...');
    }

    try {
        const untrackedFolderId = await findOrCreateUntrackedFilesFolder(drive, workspaceRoot);
        if (!untrackedFolderId) return;

        const deletedFolderId = await findOrCreateDeletedFolder(drive, untrackedFolderId);
        const tombstoneSet = await getAllTombstones(drive, deletedFolderId);
        const decisions = getConflictDecisions(context);
        const config = vscode.workspace.getConfiguration('changegittogoogledrive-extension.untrackedFiles');
        let includePatterns = config.get('include', []);
        const excludePatterns = config.get('exclude', []);

        const remoteFiles = await getAllRemoteFiles(drive, untrackedFolderId);

        // 1. Предложить добавить правила для новых файлов с диска
        for (const remoteFile of remoteFiles) {
            const localPath = path.join(workspaceRoot, remoteFile.name);
            const isIncluded = includePatterns.some(p => minimatch(remoteFile.name, p));
            const isExcluded = excludePatterns.some(p => minimatch(remoteFile.name, p));

            if (!fsSync.existsSync(localPath) && !isIncluded && !isExcluded) {
                const decisionKey = `suggest_track_${remoteFile.name}`;
                if (decisions[decisionKey]) continue;

                const choice = await vscode.window.showInformationMessage(
                    `Найден новый неотслеживаемый файл на Google Drive: "${remoteFile.name}". Добавить правило для его синхронизации?`,
                    { modal: true },
                    'Да, добавить', 'Нет', 'Нет и не спрашивать снова'
                );

                if (choice === 'Да, добавить') {
                    const newPattern = await vscode.window.showInputBox({
                        prompt: 'Введите glob-шаблон для добавления в настройки',
                        value: remoteFile.name
                    });
                    if (newPattern) {
                        const newPatterns = [...includePatterns, newPattern];
                        await config.update('include', newPatterns, vscode.ConfigurationTarget.Workspace);
                        includePatterns = newPatterns; // Обновляем локальную копию
                        vscode.window.showInformationMessage(`Правило "${newPattern}" добавлено. Файл будет загружен при следующей синхронизации.`);
                    }
                } else if (choice === 'Нет и не спрашивать снова') {
                    await setConflictDecision(context, { key: decisionKey, data: { decision: 'ignore_suggestion' } });
                }
            }
        }

        // 2. Обработать удаления по надгробиям
        for (const tombstonePath of tombstoneSet) {
            const localPath = path.join(workspaceRoot, tombstonePath);
            if (fsSync.existsSync(localPath)) {
                const localMd5 = await getFileMd5(localPath);
                const decisionKey = `tombstone_${tombstonePath}`;
                const savedDecision = decisions[decisionKey];

                if (savedDecision && savedDecision.decision === 'ignore_tombstone' && savedDecision.localMd5 === localMd5) {
                    continue;
                }

                const choice = await vscode.window.showWarningMessage(
                    `Файл "${tombstonePath}" был удален на другом рабочем месте. Удалить его локально?`,
                    { modal: true },
                    'Да, удалить', 'Нет, оставить'
                );

                if (choice === 'Да, удалить') {
                    await fs.unlink(localPath);
                    await clearConflictDecision(context, decisionKey);
                    if (!silent) vscode.window.showInformationMessage(`Файл ${tombstonePath} удален локально.`);
                } else {
                    await setConflictDecision(context, { key: decisionKey, data: { decision: 'ignore_tombstone', localMd5 } });
                }
            }
        }

        // 3. Обработать остальные файлы
        const machineId = vscode.env.machineId;
        for (const remoteFile of remoteFiles) {
            const isIncluded = includePatterns.some(p => minimatch(remoteFile.name, p));
            const isExcluded = excludePatterns.some(p => minimatch(remoteFile.name, p));

            if (tombstoneSet.has(remoteFile.name) || !isIncluded || isExcluded) {
                continue;
            }

            const localPath = path.join(workspaceRoot, remoteFile.name);
            try {
                if (fsSync.existsSync(localPath)) {
                    const localMd5 = await getFileMd5(localPath);
                    if (localMd5 !== remoteFile.md5Checksum) {
                        const remoteMachineId = (remoteFile.appProperties && remoteFile.appProperties.machineId) ? remoteFile.appProperties.machineId : null;
                        if (remoteMachineId === machineId) continue;

                        const decisionKey = `conflict_${remoteFile.name}`;
                        const savedDecision = decisions[decisionKey];
                        if (savedDecision && savedDecision.localMd5 === localMd5 && savedDecision.remoteMd5 === remoteFile.md5Checksum) {
                            continue;
                        }

                        let choice;
                        while (true) {
                            const options = [
                                { label: "Загрузить с Google Drive (Перезаписать локальный)", action: "download" },
                                { label: "Оставить локальную версию (Пропустить)", action: "keep" },
                                { label: "Выгрузить мою версию (Перезаписать удаленный)", action: "upload" },
                                { label: "Сравнить изменения", action: "compare" }
                            ];
                            choice = await vscode.window.showQuickPick(options, { placeHolder: `Конфликт для ${remoteFile.name}. Что сделать?`, ignoreFocusOut: true });

                            if (choice && choice.action === 'compare') {
                                const tempRemotePath = path.join(os.tmpdir(), `gdrive-remote-${Date.now()}-${path.basename(remoteFile.name)}`);
                                try {
                                    await downloadFile(drive, remoteFile.id, tempRemotePath);
                                    await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(tempRemotePath), vscode.Uri.file(localPath), `${remoteFile.name} (Google Drive) ↔ (Локальный)`);
                                } finally {
                                    if (fsSync.existsSync(tempRemotePath)) await fs.unlink(tempRemotePath);
                                }
                            } else {
                                break;
                            }
                        }

                        if (!choice) continue;

                        if (choice.action === 'keep') {
                            await setConflictDecision(context, { key: decisionKey, data: { decision: 'keep', localMd5, remoteMd5: remoteFile.md5Checksum } });
                        } else {
                            await clearConflictDecision(context, decisionKey);
                            if (choice.action === 'download') {
                                await downloadFile(drive, remoteFile.id, localPath);
                                if (!silent) vscode.window.showInformationMessage(`Загружен: ${remoteFile.name}`);
                            } else if (choice.action === 'upload') {
                                await updateFile(drive, remoteFile.id, localPath, machineId);
                                if (!silent) vscode.window.showInformationMessage(`Выгружен: ${remoteFile.name}`);
                            }
                        }
                    }
                } else {
                    await downloadFile(drive, remoteFile.id, localPath);
                    if (!silent) vscode.window.showInformationMessage(`Загружен новый файл: ${remoteFile.name}`);
                }
            } catch (error) {
                vscode.window.showErrorMessage(`Ошибка обработки файла ${remoteFile.name}: ${error.message}`);
            }
        }

        if (!silent) {
            vscode.window.showInformationMessage('Синхронизация неотслеживаемых файлов завершена.');
        }

    } catch (error) {
        vscode.window.showErrorMessage(`Ошибка синхронизации: ${error.message}`);
    }
}

async function uploadUntrackedFiles(context, silent = false) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const drive = await getAuthenticatedClient(context);
    if (!drive) return;

    if (!silent) {
        vscode.window.showInformationMessage('Выгрузка неотслеживаемых файлов...');
    }

    try {
        const untrackedFolderId = await findOrCreateUntrackedFilesFolder(drive, workspaceRoot);
        if (!untrackedFolderId) return;

        const deletedFolderId = await findOrCreateDeletedFolder(drive, untrackedFolderId);
        const tombstoneSet = await getAllTombstones(drive, deletedFolderId);
        const decisions = getConflictDecisions(context);

        const config = vscode.workspace.getConfiguration('changegittogoogledrive-extension.untrackedFiles');
        const includePatterns = config.get('include', []);
        const excludePatterns = config.get('exclude', []);
        if (includePatterns.length === 0) {
            if (!silent) vscode.window.showInformationMessage('Нет настроенных шаблонов для выгрузки.');
            return;
        }

        const { stdout: allIgnoredFilesStr } = await runCommand('git -c core.quotePath=false ls-files --others --ignored --exclude-standard', workspaceRoot);
        const filesToUpload = allIgnoredFilesStr.trim().split(/\r\n|\n/).filter(f => {
            if (!f) return false;
            const isIncluded = includePatterns.some(p => minimatch(f, p, { matchBase: true }));
            if (!isIncluded) return false;
            const isExcluded = excludePatterns.some(p => minimatch(f, p, { matchBase: true }));
            return !isExcluded;
        });

        if (filesToUpload.length === 0 && !silent) {
            vscode.window.showInformationMessage('Не найдено файлов для выгрузки, соответствующих шаблонам.');
            return;
        }

        const machineId = vscode.env.machineId;

        for (const relativePath of filesToUpload) {
            const absolutePath = path.join(workspaceRoot, relativePath);
            try {
                // 1. Проверка на надгробие
                if (tombstoneSet.has(relativePath)) {
                    const localMd5 = await getFileMd5(absolutePath);
                    const decisionKey = `tombstone_${relativePath}`;
                    const savedDecision = decisions[decisionKey];

                    if (savedDecision && savedDecision.decision === 'ignore_tombstone' && savedDecision.localMd5 === localMd5) {
                        continue;
                    }

                    const choice = await vscode.window.showWarningMessage(
                        `Файл \"${relativePath}\" помечен как удаленный. Удалить его локально, чтобы завершить синхронизацию?`,
                        { modal: true },
                        'Да, удалить', 'Нет, оставить'
                    );

                    if (choice === 'Да, удалить') {
                        await fs.unlink(absolutePath);
                        await clearConflictDecision(context, decisionKey);
                        if (!silent) vscode.window.showInformationMessage(`Локальный файл ${relativePath} удален.`);
                    } else {
                        await setConflictDecision(context, { key: decisionKey, data: { decision: 'ignore_tombstone', localMd5 } });
                    }
                    continue; // В любом случае не выгружаем файл, для которого есть надгробие
                }

                // 2. Логика создания/обновления/конфликта
                const remoteFile = await findRemoteFile(drive, untrackedFolderId, relativePath);
                const localMd5 = await getFileMd5(absolutePath);

                if (remoteFile) {
                    if (localMd5 !== remoteFile.md5Checksum) {
                        const remoteMachineId = (remoteFile.appProperties && remoteFile.appProperties.machineId) ? remoteFile.appProperties.machineId : null;
                        if (remoteMachineId === machineId) {
                            await updateFile(drive, remoteFile.id, absolutePath, machineId);
                            if (!silent) vscode.window.showInformationMessage(`Обновлен: ${relativePath}`);
                            continue;
                        }

                        const decisionKey = `conflict_${relativePath}`;
                        const savedDecision = decisions[decisionKey];
                        if (savedDecision && savedDecision.localMd5 === localMd5 && savedDecision.remoteMd5 === remoteFile.md5Checksum) {
                            continue;
                        }

                        let choice;
                        while (true) {
                            const options = [
                                { label: "Выгрузить мою версию (Перезаписать удаленный)", action: "upload" },
                                { label: "Пропустить выгрузку", action: "skip" },
                                { label: "Загрузить удаленную версию (Перезаписать локальный)", action: "download" },
                                { label: "Сравнить изменения", action: "compare" }
                            ];
                            choice = await vscode.window.showQuickPick(options, { placeHolder: `Конфликт для ${relativePath}. Что сделать?`, ignoreFocusOut: true });

                            if (choice && choice.action === 'compare') {
                                const tempRemotePath = path.join(os.tmpdir(), `gdrive-remote-${Date.now()}-${path.basename(relativePath)}`);
                                try {
                                    await downloadFile(drive, remoteFile.id, tempRemotePath);
                                    await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(tempRemotePath), vscode.Uri.file(absolutePath), `${relativePath} (Google Drive) ↔ (Локальный)`);
                                } finally {
                                    if (fsSync.existsSync(tempRemotePath)) await fs.unlink(tempRemotePath);
                                }
                            } else {
                                break;
                            }
                        }

                        if (!choice) continue;

                        if (choice.action === 'skip') {
                            await setConflictDecision(context, { key: decisionKey, data: { decision: 'skip', localMd5, remoteMd5: remoteFile.md5Checksum } });
                        } else {
                            await clearConflictDecision(context, decisionKey);
                            if (choice.action === 'upload') {
                                await updateFile(drive, remoteFile.id, absolutePath, machineId);
                                if (!silent) vscode.window.showInformationMessage(`Выгружен: ${relativePath}`);
                            } else if (choice.action === 'download') {
                                await downloadFile(drive, remoteFile.id, absolutePath);
                                if (!silent) vscode.window.showInformationMessage(`Загружен: ${relativePath}`);
                            }
                        }
                    }
                } else {
                    await createFile(drive, untrackedFolderId, absolutePath, relativePath, machineId);
                    if (!silent) vscode.window.showInformationMessage(`Создан: ${relativePath}`);
                }
            } catch (error) {
                vscode.window.showErrorMessage(`Ошибка обработки файла ${relativePath}: ${error.message}`);
            }
        }

        if (!silent) {
            vscode.window.showInformationMessage('Выгрузка неотслеживаемых файлов завершена.');
        }

    } catch (error) {
        vscode.window.showErrorMessage(`Ошибка выгрузки: ${error.message}`);
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
    try {
        await checkRemoteBranchTombstones(context);
        await pullCommits(context);
        await pushCommits(context);
        vscode.window.showInformationMessage('Sync finished.');
    } catch (error) {
        vscode.window.showErrorMessage(`Sync failed: ${error.message}`, { modal: true });
    }
}

async function checkRemoteBranchTombstones(context) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const drive = await getAuthenticatedClient(context);
    if (!drive) return;

    try {
        const tombstonesFolderId = await findOrCreateTombstonesFolder(drive, workspaceRoot);
        const branchTombstonesFolderId = await findOrCreateSubFolder(drive, tombstonesFolderId, 'branches');

        const { data: { files: tombstones } } = await drive.files.list({
            q: `'${branchTombstonesFolderId}' in parents and trashed=false`,
            fields: 'files(id, name)'
        });

        if (!tombstones || tombstones.length === 0) return;

        const localBranches = await getLocalBranches(workspaceRoot);
        const processedTombstones = context.workspaceState.get(PROCESSED_TOMBSTONES_KEY, {});

        for (const tombstone of tombstones) {
            const branchName = restoreBranchNameFromDrive(tombstone.name);

            // Если ветка есть локально и мы еще не обрабатывали это надгробие
            if (localBranches.includes(branchName) && !processedTombstones[tombstone.id]) {
                const choice = await vscode.window.showWarningMessage(
                    `Ветка '${branchName}' была удалена на другом компьютере. Удалить её локально?`,
                    'Да', 'Нет'
                );

                if (choice === 'Да') {
                    try {
                        await runCommand(`git branch -D ${branchName}`, workspaceRoot);
                        vscode.window.showInformationMessage(`Ветка '${branchName}' удалена локально.`);

                        // Если удалили текущую ветку, переключаемся на main/master
                        const current = await getCurrentBranch(workspaceRoot);
                        if (current === branchName) {
                            const defaultBranch = localBranches.includes('main') ? 'main' : (localBranches.includes('master') ? 'master' : null);
                            if (defaultBranch) {
                                await runCommand(`git checkout ${defaultBranch}`, workspaceRoot);
                                vscode.window.showInformationMessage(`Переключено на '${defaultBranch}'.`);
                            }
                        }
                    } catch (e) {
                        vscode.window.showErrorMessage(`Не удалось удалить ветку '${branchName}': ${e.message}`);
                    }
                }

                // Запоминаем, что обработали это надгробие (даже если пользователь выбрал "Нет")
                processedTombstones[tombstone.id] = true;
            }
        }

        await context.workspaceState.update(PROCESSED_TOMBSTONES_KEY, processedTombstones);
    } catch (error) {
        console.error('Error checking remote branch tombstones:', error);
    }
}

async function pushCommits(context) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const drive = await getAuthenticatedClient(context);
    if (!drive) return;

    const currentBranch = await getCurrentBranch(workspaceRoot);
    const lastPushedHash = context.workspaceState.get(`${LAST_PUSHED_HASH_KEY_PREFIX}${currentBranch}`);
    let currentHead;
    try {
        const headRes = await runCommand('git rev-parse HEAD', workspaceRoot);
        currentHead = headRes.stdout.trim();
    } catch (e) {
        vscode.window.showWarningMessage('Репозиторий пуст. Для синхронизации истории необходимо сделать хотя бы один коммит.', { modal: true });
        return;
    }

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

    const sanitizedBranchName = sanitizeBranchNameForDrive(currentBranch);
    const bundleFileName = `${sanitizedBranchName}--${currentHead}.bundle`;
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

    vscode.window.showInformationMessage('Checking for remote changes...');

    // 1. Get all remote bundles
    const q = `'${bundleFolderId}' in parents and trashed=false and fileExtension='bundle'`;
    const { data: { files: allRemoteBundles } } = await drive.files.list({
        q: q,
        fields: 'files(id, name, createdTime)',
        orderBy: 'createdTime',
    });

    if (!allRemoteBundles || allRemoteBundles.length === 0) {
        vscode.window.showInformationMessage('No remote bundles found.');
        return;
    }

    // 2. Get local branches
    const { stdout: localBranchStr } = await runCommand('git branch --list --no-color', workspaceRoot);
    const localBranches = new Set(localBranchStr.split('\n').map(b => b.trim().replace('* ', '')).filter(b => b));
    const currentBranch = await getCurrentBranch(workspaceRoot);

    // 3. Group all remote bundles by branch name
    const remoteBundlesByBranch = new Map();
    for (const bundle of allRemoteBundles) {
        const parts = bundle.name.split('--');
        if (parts.length < 2) continue;
        const driveBranchName = parts[0];
        const branchName = restoreBranchNameFromDrive(driveBranchName);

        if (!remoteBundlesByBranch.has(branchName)) {
            remoteBundlesByBranch.set(branchName, []);
        }
        remoteBundlesByBranch.get(branchName).push(bundle);
    }

    const tempDir = path.join(workspaceRoot, '.git', 'gdrive-temp-bundles');
    await fs.mkdir(tempDir, { recursive: true });
    let changesMade = false;
    let newCommitsFound = false;

    try {
        for (const [branchName, bundles] of remoteBundlesByBranch.entries()) {
            if (localBranches.has(branchName)) {
                // --- Logic for EXISTING branches (only the current one for now) ---
                if (branchName !== currentBranch) continue;

                // Get commits for the current branch to find what's new
                const { stdout: currentBranchCommitsResult } = await runCommand(`git rev-list ${branchName}`, workspaceRoot);
                const currentBranchCommitSet = new Set(currentBranchCommitsResult.trim().split(/\s+/));

                const newBundles = bundles.filter(bundle => {
                    const commitHash = bundle.name.split('--')[1]?.replace('.bundle', '');
                    return commitHash && !currentBranchCommitSet.has(commitHash);
                });

                if (newBundles.length === 0) {
                    continue; // No new commits for this branch
                }
                newCommitsFound = true;

                vscode.window.showInformationMessage(`Found ${newBundles.length} new commit(s) for current branch '${branchName}'. Fetching...`);
                for (const bundle of newBundles) {
                    const tempBundlePath = path.join(tempDir, bundle.name);
                    await downloadFile(drive, bundle.id, tempBundlePath);
                    await runCommand(`git fetch "${tempBundlePath}"`, workspaceRoot);
                }
                changesMade = true;
                try {
                    await runCommand(`git merge --ff-only FETCH_HEAD`, workspaceRoot);
                    vscode.window.showInformationMessage(`Successfully merged remote changes into '${branchName}'.`);
                } catch (error) {
                    vscode.window.showInformationMessage(`New commits for '${branchName}' have been fetched. Please merge or rebase manually.`);
                }

            } else {
                // --- Logic for NEW branches ---
                newCommitsFound = true;
                const choice = await vscode.window.showInformationMessage(
                    `Found new remote branch '${branchName}' with ${bundles.length} new commit(s). Create local branch?`,
                    { modal: true },
                    'Yes'
                );

                if (choice === 'Yes') {
                    vscode.window.showInformationMessage(`Fetching bundles for new branch '${branchName}'...`);
                    let lastHash = '';
                    for (const bundle of bundles) { // Already sorted by createdTime
                        const tempBundlePath = path.join(tempDir, bundle.name);
                        await downloadFile(drive, bundle.id, tempBundlePath);
                        await runCommand(`git fetch "${tempBundlePath}"`, workspaceRoot);
                        lastHash = bundle.name.split('--')[1]?.replace('.bundle', '');
                    }

                    if (lastHash) {
                        try {
                            await runCommand(`git checkout -b ${branchName} ${lastHash}`, workspaceRoot);
                            await context.workspaceState.update(`${LAST_PUSHED_HASH_KEY_PREFIX}${branchName}`, lastHash);
                            vscode.window.showInformationMessage(`Successfully created and checked out branch '${branchName}'.`);
                            changesMade = true;
                        } catch (error) {
                            vscode.window.showErrorMessage(`Failed to create branch '${branchName}': ${error.message}`);
                        }
                    }
                }
            }
        }
    } finally {
        if (fsSync.existsSync(tempDir)) {
            await fs.rm(tempDir, { recursive: true, force: true });
        }
    }

    if (changesMade) {
        vscode.window.showInformationMessage('Pull from Google Drive finished.');
    } else if (newCommitsFound) {
        vscode.window.showInformationMessage('No new changes to pull for current branch or any new branches.');
    } else {
        vscode.window.showInformationMessage('Local repository is up-to-date.');
    }
}

async function installGitHooks(context) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const hooksDir = path.join(workspaceRoot, '.git', 'hooks');
    const postCommitHookPath = path.join(hooksDir, 'post-commit');
    const extensionId = 'user.changegittogoogledrive-extension';

    const postCommitScript = `#!/bin/sh\n# Hook to trigger VS Code sync after commit\ntouch .git/SYNC_REQUEST\n`;

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

        const [driveBranchName, clonedHead] = selectedBundle.label.replace('.bundle', '').split('--');
        const branchToCheckout = restoreBranchNameFromDrive(driveBranchName);

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
        vscode.window.showErrorMessage(`Clone failed: ${error.message}`, { modal: true });
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

// --- КОМАНДЫ ДЛЯ СИНХРОНИЗАЦИИ ИСТОРИИ AI (Antigravity) ---

async function trackCurrentConversation(context) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    try {
        const conversationId = await getCurrentConversationId();
        if (!conversationId) return;

        let projectConversationIds = context.workspaceState.get(AI_HISTORY_IDS_KEY, []);
        if (!projectConversationIds.includes(conversationId)) {
            projectConversationIds.push(conversationId);
            await context.workspaceState.update(AI_HISTORY_IDS_KEY, projectConversationIds);
            console.log(`Associated conversation ${conversationId} with this project.`);
        }
    } catch (e) {
        console.error('Error tracking current conversation:', e);
    }
}

async function getCurrentConversationId() {
    // В идеале мы берем ID из окружения Antigravity, 
    // но как fallback - находим самую свежую папку в brain
    try {
        const folders = await fs.readdir(AI_HISTORY_LOCAL_PATH);
        if (folders.length === 0) return null;

        const folderDetails = await Promise.all(folders.map(async name => {
            const stats = await fs.stat(path.join(AI_HISTORY_LOCAL_PATH, name));
            return { name, mtime: stats.mtime };
        }));

        folderDetails.sort((a, b) => b.mtime - a.mtime);
        return folderDetails[0].name; // Самая свежая беседа
    } catch (e) {
        return null;
    }
}

async function configureAIHistorySync(context) {
    const choice = await vscode.window.showQuickPick([
        { label: "Включить", description: "Синхронизировать историю для этого проекта", action: "enable" },
        { label: "Отключить", description: "Никогда не синхронизировать для этого проекта", action: "disable" },
        { label: "Сбросить выбор", description: "Спрашивать при следующей синхронизации", action: "reset" }
    ], { placeHolder: "Настроить синхронизацию истории AI (Antigravity)" });

    if (!choice) return;

    switch (choice.action) {
        case "enable":
            await context.workspaceState.update(AI_HISTORY_ENABLED_KEY, true);
            vscode.window.showInformationMessage('Синхронизация истории AI включена для этого проекта.');
            await syncAIHistory(context, false);
            break;
        case "disable":
            await context.workspaceState.update(AI_HISTORY_ENABLED_KEY, false);
            vscode.window.showInformationMessage('Синхронизация истории AI отключена для этого проекта.');
            break;
        case "reset":
            await context.workspaceState.update(AI_HISTORY_ENABLED_KEY, undefined);
            vscode.window.showInformationMessage('Выбор сброшен. Antigravity спросит вас при следующей попытке синхронизации.');
            break;
    }
}

async function syncAIHistory(context, silent = false) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    let isEnabled = context.workspaceState.get(AI_HISTORY_ENABLED_KEY);

    if (isEnabled === false) {
        if (!silent) vscode.window.showInformationMessage('Синхронизация истории AI отключена для этого проекта в настройках рабочей области.');
        return;
    }

    if (isEnabled === undefined) {
        const choice = await vscode.window.showInformationMessage(
            'Включить синхронизацию истории AI (Antigravity) для этого проекта?',
            { modal: true },
            'Да', 'Нет'
        );
        if (choice === 'Да') {
            isEnabled = true;
            await context.workspaceState.update(AI_HISTORY_ENABLED_KEY, true);
        } else {
            isEnabled = false;
            await context.workspaceState.update(AI_HISTORY_ENABLED_KEY, false);
            return;
        }
    }

    const drive = await getAuthenticatedClient(context);
    if (!drive) return;

    if (!silent) vscode.window.showInformationMessage('Синхронизация истории AI с Google Drive...');

    try {
        const historyFolderId = await findOrCreateAIHistoryFolder(drive, workspaceRoot);
        const manifestFileId = await findOrCreateAIHistoryManifest(drive, historyFolderId);

        // 1. Загружаем манифест с диска (чтобы узнать о чатах с других машин)
        const { data: manifestContent } = await drive.files.get({ fileId: manifestFileId, alt: 'media' });
        let remoteManifest = {};
        try {
            // Обработка потока данных, если он пришел как объект
            if (typeof manifestContent === 'object') {
                remoteManifest = manifestContent;
            } else if (typeof manifestContent === 'string') {
                remoteManifest = JSON.parse(manifestContent);
            }
        } catch (e) { }

        const projectConversationIds = context.workspaceState.get(AI_HISTORY_IDS_KEY, []);
        const allRelevantIds = new Set([...projectConversationIds, ...(remoteManifest.ids || [])]);

        const machineId = vscode.env.machineId;

        for (const convId of allRelevantIds) {
            const localPath = path.join(AI_HISTORY_LOCAL_PATH, convId);
            const remoteConvFolderId = await findOrCreateSubFolder(drive, historyFolderId, convId);

            if (fsSync.existsSync(localPath)) {
                // Синхронизируем файлы внутри папки чата
                await syncFolder(drive, localPath, remoteConvFolderId, machineId, silent);
            } else {
                // Если чата нет локально - скачиваем его
                if (!silent) vscode.window.showInformationMessage(`Загрузка нового чата: ${convId}`);
                await downloadFolder(drive, remoteConvFolderId, localPath, silent);
            }
        }

        // 2. Обновляем манифест на диске, если добавились новые ID
        const mergedIds = Array.from(allRelevantIds);
        if (mergedIds.length > (remoteManifest.ids || []).length) {
            await drive.files.update({
                fileId: manifestFileId,
                media: { mimeType: 'application/json', body: JSON.stringify({ ids: mergedIds }) }
            });
        }

        if (!silent) vscode.window.showInformationMessage('Синхронизация истории AI завершена успешно.');
    } catch (error) {
        vscode.window.showErrorMessage(`Ошибка синхронизации истории AI: ${error.message}`);
    }
}

async function syncFolder(drive, localPath, remoteFolderId, machineId, silent) {
    const localFiles = await fs.readdir(localPath);
    const remoteFiles = await getAllRemoteFiles(drive, remoteFolderId);

    for (const file of localFiles) {
        const localFilePath = path.join(localPath, file);
        const stats = await fs.stat(localFilePath);
        if (stats.isDirectory()) continue;

        const localMd5 = await getFileMd5(localFilePath);
        const remoteFile = remoteFiles.find(f => f.name === file);

        if (remoteFile) {
            if (localMd5 !== remoteFile.md5Checksum) {
                const remoteMachineId = (remoteFile.appProperties && remoteFile.appProperties.machineId) ? remoteFile.appProperties.machineId : null;
                if (remoteMachineId !== machineId) {
                    await updateFile(drive, remoteFile.id, localFilePath, machineId);
                }
            }
        } else {
            await createFile(drive, remoteFolderId, localFilePath, file, machineId);
        }
    }
}

async function downloadFolder(drive, remoteFolderId, localPath, silent) {
    const remoteFiles = await getAllRemoteFiles(drive, remoteFolderId);
    for (const file of remoteFiles) {
        const destPath = path.join(localPath, file.name);
        await downloadFile(drive, file.id, destPath);
    }
}

async function findOrCreateAIHistoryFolder(drive, workspaceRoot) {
    const projectFolderId = await findOrCreateBaseProjectFolder(drive, workspaceRoot);
    return await findOrCreateSubFolder(drive, projectFolderId, 'ai-history');
}

async function findOrCreateAIHistoryManifest(drive, historyFolderId) {
    const fileName = 'history_manifest.json';
    const q = `name='${fileName}' and '${historyFolderId}' in parents and trashed=false`;
    const { data: { files } } = await drive.files.list({ q, fields: 'files(id)' });

    if (files.length > 0) {
        return files[0].id;
    } else {
        const { data } = await drive.files.create({
            resource: { name: fileName, parents: [historyFolderId], mimeType: 'application/json' },
            media: { mimeType: 'application/json', body: JSON.stringify({ ids: [] }) },
            fields: 'id'
        });
        return data.id;
    }
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

            if (!tokens.refresh_token) {
                console.warn('Refresh token was not returned by Google. This might happen if you did not provide full consent OR if you have already authenticated before. If you experience frequent logouts, try revoking access in Google Account settings and re-authenticating.');
                vscode.window.showWarningMessage('Google не прислал "refresh_token". Это может привести к частым запросам авторизации. Если сессии будут слетать, попробуйте сначала "Выйти" в настройках аккаунта Google для приложения "VSCode Git Sync".');
            }

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
        console.log(`Attempting to open authentication URL: ${authUrl}`);
        vscode.window.showInformationMessage('Attempting to open the authentication URL in your browser. If it fails, please check for the URL in the developer tools console (Help > Toggle Developer Tools).');
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
            // refreshAccessToken возвращает новые токены в поле 'credentials'
            const { credentials } = await oauth2Client.refreshAccessToken();
            const oldTokens = JSON.parse(tokensStr || '{}');

            if (credentials && credentials.access_token) {
                // Если Google не прислал refresh_token при обновлении (это стандартное поведение), сохраняем старый
                if (oldTokens.refresh_token && !credentials.refresh_token) {
                    credentials.refresh_token = oldTokens.refresh_token;
                }
                await context.secrets.store(GOOGLE_DRIVE_TOKENS_KEY, JSON.stringify(credentials));
                oauth2Client.setCredentials(credentials);
            } else {
                throw new Error("Google API returned an invalid response during refresh.");
            }
        } catch (error) {
            console.error("ChangeGitToGoogleDrive: Failed to refresh token", error);
            const detailedMessage = error.message.includes('invalid_grant') 
                ? "Сессия Google отозвана или недействительна (invalid_grant). Возможно, из-за смены пароля или входа с другого устройства."
                : error.message;
            
            vscode.window.showErrorMessage(
                `Failed to refresh token: ${detailedMessage}. Please run the 'Authenticate with Google' command again. (Check 'Toggle Developer Tools' for details)`,
                { modal: true }
            );
            return null;
        }
    }
    return google.drive({ version: 'v3', auth: oauth2Client });
}

// --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ---

async function findOrCreateProjectFolders(drive, workspaceRoot) {
    const projectFolderId = await findOrCreateBaseProjectFolder(drive, workspaceRoot);
    return await findOrCreateSubFolder(drive, projectFolderId, 'bundles');
}

async function findOrCreateUntrackedFilesFolder(drive, workspaceRoot) {
    const projectFolderId = await findOrCreateBaseProjectFolder(drive, workspaceRoot);
    return await findOrCreateSubFolder(drive, projectFolderId, 'untracked');
}

async function findOrCreateTombstonesFolder(drive, workspaceRoot) {
    const projectFolderId = await findOrCreateBaseProjectFolder(drive, workspaceRoot);
    return await findOrCreateSubFolder(drive, projectFolderId, 'tombstones');
}

async function findOrCreateBaseProjectFolder(drive, workspaceRoot) {
    const projectName = path.basename(workspaceRoot);
    const gdriveGitDir = `.gdrive-git`;

    let { data: { files: rootFolders } } = await drive.files.list({
        q: `name='${gdriveGitDir}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: 'files(id)'
    });

    let rootFolderId;
    if (rootFolders.length === 0) {
        const { data } = await drive.files.create({
            resource: { name: gdriveGitDir, mimeType: 'application/vnd.google-apps.folder' },
            fields: 'id'
        });
        rootFolderId = data.id;
    } else {
        rootFolderId = rootFolders[0].id;
    }

    const q = `name='${escapeGdriveQueryParam(projectName)}' and mimeType='application/vnd.google-apps.folder' and '${rootFolderId}' in parents and trashed=false`;
    let { data: { files: projectFolders } } = await drive.files.list({ q: q, fields: 'files(id)' });

    if (projectFolders.length === 0) {
        const { data } = await drive.files.create({
            resource: { name: projectName, mimeType: 'application/vnd.google-apps.folder', parents: [rootFolderId] },
            fields: 'id'
        });
        return data.id;
    } else {
        return projectFolders[0].id;
    }
}

async function findOrCreateSubFolder(drive, parentId, folderName) {
    const q = `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`;
    let { data: { files: folders } } = await drive.files.list({ q, fields: 'files(id)' });

    if (folders.length === 0) {
        const { data } = await drive.files.create({
            resource: { name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
            fields: 'id'
        });
        return data.id;
    } else {
        return folders[0].id;
    }
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
            q: `'${folderId}' in parents and trashed=false and name != '.deleted'`,
            fields: 'nextPageToken, files(id, name, md5Checksum, appProperties)',
            pageToken: pageToken,
        });
        files = files.concat(res.data.files);
        pageToken = res.data.nextPageToken;
    } while (pageToken);
    return files;
}

async function downloadFile(drive, fileId, destPath) {
    const destDir = path.dirname(destPath);
    await fs.mkdir(destDir, { recursive: true });
    const dest = fsSync.createWriteStream(destPath);
    const { data: fileStream } = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
    await new Promise((resolve, reject) => {
        fileStream.pipe(dest)
            .on('finish', resolve)
            .on('error', (error) => {
                // If the file is busy/locked, we'll show a message and skip it.
                if (error.code === 'EBUSY' || error.code === 'EPERM') {
                    vscode.window.showInformationMessage(`File is locked, skipping for now: ${path.basename(destPath)}`);
                    // Attempt to clean up the partial file.
                    // We use the sync version here because we are in a callback and don't want to complicate with async/await.
                    // The stream is already closed on error.
                    try {
                        fsSync.unlinkSync(destPath);
                    } catch (e) {
                        // Ignore errors during cleanup
                    }
                    resolve(); // Resolve to not stop the entire sync process.
                } else {
                    reject(error); // For other errors, fail as usual.
                }
            });
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

// Функция для преобразования имени ветки при сохранении на Google Drive
// Заменяет слеши на подчеркивания
function sanitizeBranchNameForDrive(branchName) {
    if (!branchName) return "";
    return branchName.replace(/\//g, '_');
}

// Функция для обратного преобразования имени ветки при загрузке с Google Drive
// Заменяет подчеркивания на слеши
function restoreBranchNameFromDrive(driveBranchName) {
    if (!driveBranchName) return "";
    return driveBranchName.replace(/_/g, '/');
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
        // Пытаемся получить текущую ветку методом, который работает даже в пустых репозиториях (Git 2.22+)
        const { stdout } = await runCommand('git branch --show-current', cwd);
        const branch = stdout.trim();
        if (branch) {
            return branch;
        }

        // Если команда не вернула имя (старый Git?), пробуем запасной вариант
        const { stdout: fallback } = await runCommand('git rev-parse --abbrev-ref HEAD', cwd);
        return fallback.trim();
    } catch (error) {
        console.error('Error in getCurrentBranch:', error);
        throw new Error('Не удалось определить текущую ветку. Если репозиторий новый, сделайте первый коммит.');
    }
}

function deactivate() { } module.exports = { activate, deactivate };