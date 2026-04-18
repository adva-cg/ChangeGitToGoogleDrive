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
const AI_HISTORY_CONVERSATIONS_PATH = path.join(os.homedir(), '.gemini', 'antigravity', 'conversations');
const AI_KNOWLEDGE_LOCAL_PATH = path.join(os.homedir(), '.gemini', 'antigravity', 'knowledge');
const CLIPBOARD_SYNC_FILE_NAME = 'clipboard_sync.json';
const LAST_CLIPBOARD_HASH_KEY = 'lastClipboardHash';
const REFS_FILE_NAME = 'refs.json';
const CLOUD_CONFIG_FILE_NAME = 'config.json';
const BACKUPS_DIR_NAME = 'backups';
const CONFLICT_DECISIONS_KEY = 'untrackedConflictDecisions';

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
        aiHistorySyncTimeout = setTimeout(async () => {
            const aiHistoryConfig = vscode.workspace.getConfiguration('changegittogoogledrive-extension.aiHistory');
            const isEnabled = context.workspaceState.get(AI_HISTORY_ENABLED_KEY);
            // Синхронизируем, если включено и не в режиме 'never'
            if (isEnabled !== false && aiHistoryConfig.get('syncMode') !== 'never') {
                console.log('Auto-syncing AI history after changes...');
                await trackCurrentConversation(context); // Обновляем текущую беседу перед синхронизацией
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
                await sync(context, true);
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

    // --- ПЕРИОДИЧЕСКАЯ ОЧИСТКА СТАРЫХ БЭКАПОВ (через 2 мин) ---
    setTimeout(() => {
        getAuthenticatedClient(context).then(async (drive) => {
            if (drive && workspaceRoot) {
                await cleanupOldBackups(drive, workspaceRoot);
            }
        }).catch(e => console.error('Backup cleanup error:', e));
    }, 120000);
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
        const gdriveGitDirId = await ensureSingleFolder(drive, null, '.gdrive-git', context);
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
            const projectFolderId = await findOrCreateBaseProjectFolder(drive, workspaceRoot, context);
            const bundleFolderId = await ensureSingleFolder(drive, projectFolderId, 'bundles', context);
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
            const tombstonesFolderId = await ensureSingleFolder(drive, projectFolderId, 'tombstones', context);
            const branchTombstonesFolderId = await ensureSingleFolder(drive, tombstonesFolderId, 'branches', context);

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
        const projectFolderId = await findOrCreateBaseProjectFolder(drive, workspaceRoot, context);
        const effectiveConfig = await getEffectiveConfig(drive, projectFolderId);
        const includePatterns = effectiveConfig.include;
        const excludePatterns = effectiveConfig.exclude;
        
        if (includePatterns.length === 0) {
            vscode.window.showInformationMessage('Нет настроенных шаблонов (ни в облаке, ни локально) для неотслеживаемых файлов.');
            return;
        }

        const allUntrackedFiles = await getUntrackedAndIgnoredFiles(workspaceRoot);
        const filesToList = allUntrackedFiles.filter(file => isFileIncluded(file, includePatterns, excludePatterns)).sort();

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

        const untrackedFolderId = await findOrCreateUntrackedFilesFolder(drive, workspaceRoot, context);
        const deletedFolderId = await findOrCreateDeletedFolder(drive, untrackedFolderId, context);
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
        const untrackedFolderId = await findOrCreateUntrackedFilesFolder(drive, workspaceRoot, context);
        if (!untrackedFolderId) {
            vscode.window.showInformationMessage('Не найдена папка неотслеживаемых файлов.');
            return;
        }
        const deletedFolderId = await findOrCreateDeletedFolder(drive, untrackedFolderId, context);

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

async function findOrCreateDeletedFolder(drive, untrackedFolderId, context) {
    return await ensureSingleFolder(drive, untrackedFolderId, '.deleted', context);
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
        const projectFolderId = await findOrCreateBaseProjectFolder(drive, workspaceRoot, context);
        const untrackedFolderId = await findOrCreateUntrackedFilesFolder(drive, workspaceRoot, context);
        const deletedFolderId = await findOrCreateDeletedFolder(drive, untrackedFolderId, context);
        
        const tombstoneSet = await getAllTombstones(drive, deletedFolderId);
        const decisions = getConflictDecisions(context);
        
        const effectiveConfig = await getEffectiveConfig(drive, projectFolderId);
        let includePatterns = effectiveConfig.include;
        const excludePatterns = effectiveConfig.exclude;
        
        const localUntrackedFiles = await getUntrackedAndIgnoredFiles(workspaceRoot);
        const remoteFiles = await getAllRemoteFiles(drive, untrackedFolderId);

        // 1. Предложить добавить правила для новых файлов с диска
        for (const remoteFile of remoteFiles) {
            const localPath = path.join(workspaceRoot, remoteFile.name);
            const isIncluded = isFileIncluded(remoteFile.name, includePatterns, excludePatterns);
            const isExcluded = false; // isFileIncluded уже учитывает исключения

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
                        prompt: 'Введите glob-шаблон для добавления в ОБЛАЧНЫЙ конфиг',
                        value: remoteFile.name
                    });
                    if (newPattern) {
                        includePatterns = [...includePatterns, newPattern];
                        await updateCloudConfig(drive, projectFolderId, { include: includePatterns, exclude: excludePatterns });
                        vscode.window.showInformationMessage(`Правило "${newPattern}" добавлено в облачный конфиг проекта.`);
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
            const isIncluded = isFileIncluded(remoteFile.name, includePatterns, excludePatterns);

            if (tombstoneSet.has(remoteFile.name) || !isIncluded) {
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

        // 4. Загрузить новые локальные файлы, которых нет на Google Drive
        const remoteFileNames = new Set(remoteFiles.map(f => f.name));
        for (const relativePath of localUntrackedFiles) {
            if (remoteFileNames.has(relativePath)) continue;
            if (tombstoneSet.has(relativePath)) continue;
            if (!isFileIncluded(relativePath, includePatterns, excludePatterns)) continue;

            const absolutePath = path.join(workspaceRoot, relativePath);
            try {
                await uploadFile(drive, untrackedFolderId, absolutePath, relativePath, machineId);
                if (!silent) vscode.window.showInformationMessage(`Новый файл выгружен: ${relativePath}`);
            } catch (error) {
                vscode.window.showErrorMessage(`Ошибка выгрузки ${relativePath}: ${error.message}`);
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
        const projectFolderId = await findOrCreateBaseProjectFolder(drive, workspaceRoot, context);
        const untrackedFolderId = await findOrCreateUntrackedFilesFolder(drive, workspaceRoot, context);
        if (!untrackedFolderId) return;

        const deletedFolderId = await findOrCreateDeletedFolder(drive, untrackedFolderId, context);
        const tombstoneSet = await getAllTombstones(drive, deletedFolderId);
        const decisions = getConflictDecisions(context);

        const effectiveConfig = await getEffectiveConfig(drive, projectFolderId);
        const includePatterns = effectiveConfig.include;
        const excludePatterns = effectiveConfig.exclude;
        
        if (includePatterns.length === 0) {
            if (!silent) vscode.window.showInformationMessage('Нет настроенных шаблонов (ни в облаке, ни локально) для выгрузки.');
            return;
        }

        const allUntrackedFiles = await getUntrackedAndIgnoredFiles(workspaceRoot);
        const filesToUpload = allUntrackedFiles.filter(f => isFileIncluded(f, includePatterns, excludePatterns));

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
                    await uploadFile(drive, untrackedFolderId, absolutePath, relativePath, machineId);
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


async function getRemoteRefs(drive, bundleFolderId) {
    const q = `name='${REFS_FILE_NAME}' and '${bundleFolderId}' in parents and trashed=false`;
    const { data: { files } } = await drive.files.list({ q, fields: 'files(id, name)' });
    
    if (files.length === 0) return {};

    try {
        const response = await drive.files.get({ fileId: files[0].id, alt: 'media' });
        return response.data;
    } catch (error) {
        console.error('Error reading remote refs:', error);
        return {};
    }
}

async function updateRemoteRefs(drive, bundleFolderId, refs) {
    const q = `name='${REFS_FILE_NAME}' and '${bundleFolderId}' in parents and trashed=false`;
    const { data: { files } } = await drive.files.list({ q, fields: 'files(id, name)' });

    const content = JSON.stringify(refs, null, 2);
    const media = {
        mimeType: 'application/json',
        body: content,
    };

    if (files.length > 0) {
        await drive.files.update({
            fileId: files[0].id,
            media: media,
        });
    } else {
        await drive.files.create({
            requestBody: {
                name: REFS_FILE_NAME,
                parents: [bundleFolderId],
            },
            media: media,
        });
    }
}

async function sync(context, silent = false) {
    if (!silent) vscode.window.showInformationMessage('Syncing with Google Drive...');
    try {
        const drive = await getAuthenticatedClient(context);
        const workspaceRoot = getWorkspaceRoot();
        if (!workspaceRoot) return;

        const bundleFolderId = await findOrCreateProjectFolders(drive, workspaceRoot, context);
        if (!bundleFolderId) {
            throw new Error('Could not find or create project folder on Google Drive.');
        }

        const remoteRefs = await getRemoteRefs(drive, bundleFolderId);

        await checkRemoteBranchTombstones(context, drive, bundleFolderId, silent);
        await pullCommits(context, drive, bundleFolderId, remoteRefs, silent);
        await pushCommits(context, drive, bundleFolderId, remoteRefs, silent);

        if (!silent) vscode.window.showInformationMessage('Sync finished.');
    } catch (error) {
        if (silent) {
            console.error(`Sync failed: ${error.message}`);
            vscode.window.showErrorMessage(`Background sync failed: ${error.message}. Check output logs for details.`);
        } else {
            vscode.window.showErrorMessage(`Sync failed: ${error.message}`, { modal: true });
        }
    }
}

async function checkRemoteBranchTombstones(context, drive, bundleFolderId, silent = false) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    try {
        const tombstonesFolderId = await findOrCreateTombstonesFolder(drive, workspaceRoot, context);
        const branchTombstonesFolderId = await findOrCreateSubFolder(drive, tombstonesFolderId, 'branches', context);

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
                        if (!silent) vscode.window.showInformationMessage(`Ветка '${branchName}' удалена локально.`);

                        // Если удалили текущую ветку, переключаемся на main/master
                        const current = await getCurrentBranch(workspaceRoot);
                        if (current === branchName) {
                            const defaultBranch = localBranches.includes('main') ? 'main' : (localBranches.includes('master') ? 'master' : null);
                            if (defaultBranch) {
                                await runCommand(`git checkout ${defaultBranch}`, workspaceRoot);
                                if (!silent) vscode.window.showInformationMessage(`Переключено на '${defaultBranch}'.`);
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

async function pushCommits(context, drive, bundleFolderId, remoteRefs, silent = false) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    const currentBranch = await getCurrentBranch(workspaceRoot);
    const remoteBranchHead = remoteRefs[currentBranch];
    const lastPushedHash = remoteBranchHead || context.workspaceState.get(`${LAST_PUSHED_HASH_KEY_PREFIX}${currentBranch}`);

    let currentHead;
    try {
        const headRes = await runCommand('git rev-parse HEAD', workspaceRoot);
        currentHead = headRes.stdout.trim();
    } catch (e) {
        vscode.window.showWarningMessage('Репозиторий пуст. Для синхронизации истории необходимо сделать хотя бы один коммит.', { modal: true });
        return;
    }

    if (lastPushedHash === currentHead) {
        if (!silent) vscode.window.showInformationMessage('Already up-to-date. Nothing to push.');
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

    const revisionRange = lastPushedHash ? `${lastPushedHash}..HEAD` : 'HEAD';
    const { stdout: commitsToPush } = await runCommand(`git rev-list ${revisionRange}`, workspaceRoot);

    if (!commitsToPush.trim()) {
        if (!silent) vscode.window.showInformationMessage('No new commits to push.');
        return;
    }

    const sanitizedBranchName = sanitizeBranchNameForDrive(currentBranch);
    const bundleFileName = `${sanitizedBranchName}--${currentHead}.bundle`;
    const bundlePath = path.join(workspaceRoot, '.git', bundleFileName);

    try {
        if (!silent) vscode.window.showInformationMessage(`Creating bundle for range: ${revisionRange}`);
        const bundleCommand = `git bundle create \"${bundlePath}\" ${revisionRange}`;
        await runCommand(bundleCommand, workspaceRoot);

        await uploadBundleFile(drive, bundlePath, bundleFolderId);

        // Update remote refs locally and then on drive
        remoteRefs[currentBranch] = currentHead;
        await updateRemoteRefs(drive, bundleFolderId, remoteRefs);

        await context.workspaceState.update(`${LAST_PUSHED_HASH_KEY_PREFIX}${currentBranch}`, currentHead);
        if (!silent) vscode.window.showInformationMessage(`Successfully pushed commits up to ${currentHead.substring(0, 7)}.`);

    } catch (error) {
        vscode.window.showErrorMessage(`Push failed: ${error.message}`);
    } finally {
        if (fsSync.existsSync(bundlePath)) {
            await fs.unlink(bundlePath);
        }
    }
}

async function pullCommits(context, drive, bundleFolderId, remoteRefs, silent = false) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    if (!silent) vscode.window.showInformationMessage('Checking for remote changes...');

    // 1. Get all remote bundles
    const q = `'${bundleFolderId}' in parents and trashed=false and fileExtension='bundle'`;
    const { data: { files: allRemoteBundles } } = await drive.files.list({
        q: q,
        fields: 'files(id, name, createdTime)',
        orderBy: 'createdTime',
    });

    if (!allRemoteBundles || allRemoteBundles.length === 0) {
        if (!silent) vscode.window.showInformationMessage('No remote bundles found.');
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

                if (!silent) vscode.window.showInformationMessage(`Found ${newBundles.length} new commit(s) for current branch '${branchName}'. Fetching...`);
                let lastFetchedHash = '';
                for (const bundle of newBundles) {
                    const tempBundlePath = path.join(tempDir, bundle.name);
                    await downloadFile(drive, bundle.id, tempBundlePath);
                    await runCommand(`git fetch "${tempBundlePath}"`, workspaceRoot);
                    lastFetchedHash = bundle.name.split('--')[1]?.replace('.bundle', '');
                }
                changesMade = true;

                try {
                    // Try fast-forward first
                    await runCommand(`git merge --ff-only FETCH_HEAD`, workspaceRoot);
                    if (!silent) vscode.window.showInformationMessage(`Successfully fast-forwarded '${branchName}' to latest remote changes.`);
                } catch (ffError) {
                    // If FF fails, try regular merge
                    try {
                        await runCommand(`git merge --no-edit FETCH_HEAD`, workspaceRoot);
                        vscode.window.showInformationMessage(`History for '${branchName}' has been merged automatically. Please review changes before proceeding.`, 'OK');
                    } catch (mergeError) {
                        // If merge fails (conflicts), abort in silent mode to keep workspace clean.
                        // In manual mode, leave it in merging state so the user can resolve it immediately.
                        if (silent) {
                            await runCommand(`git merge --abort`, workspaceRoot).catch(() => {});
                        }

                        vscode.window.showErrorMessage(
                            `Merge conflict encountered for '${branchName}'. ${silent ? 'Automatic sync aborted.' : 'Please resolve conflicts in the editor.'}`,
                            { modal: true }
                        );
                        throw mergeError;
                    }
                }

                // Update local knowledge of what is pushed
                const remoteHead = remoteRefs[branchName] || lastFetchedHash;
                if (remoteHead) {
                    await context.workspaceState.update(`${LAST_PUSHED_HASH_KEY_PREFIX}${branchName}`, remoteHead);
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
                    if (!silent) vscode.window.showInformationMessage(`Fetching bundles for new branch '${branchName}'...`);
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
        const rootFolderId = await ensureSingleFolder(drive, null, '.gdrive-git', context);
        const { data: { files: projects } } = await drive.files.list({
            q: `'${rootFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
            fields: 'files(id, name)'
        });
        if (projects.length === 0) {
            vscode.window.showErrorMessage('No projects found on Google Drive. Please perform an initial upload from a source repository first.');
            return;
        }

        const selectedProject = await vscode.window.showQuickPick(
            projects.map(f => ({ label: f.name, description: `(ID: ${f.id})`, id: f.id })),
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

    // --- Sync with Drive ---
    try {
        const drive = await getAuthenticatedClient(context);
        const bundleFolderId = await findOrCreateProjectFolders(drive, workspaceRoot, context);
        if (bundleFolderId) {
            const remoteRefs = await getRemoteRefs(drive, bundleFolderId);
            if (newHash === undefined) {
                delete remoteRefs[currentBranch];
            } else {
                remoteRefs[currentBranch] = newHash;
            }
            await updateRemoteRefs(drive, bundleFolderId, remoteRefs);
        }
    } catch (e) {
        console.error('Failed to sync hash update to Drive:', e);
        vscode.window.showWarningMessage('Локальный хеш обновлен, но не удалось синхронизировать его с Google Drive.');
    }

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
        const historyFolderId = await findOrCreateAIHistoryFolder(drive, workspaceRoot, context);
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

        // 1. Синхронизируем основную папку (brain)
        for (const convId of allRelevantIds) {
            const localPath = path.join(AI_HISTORY_LOCAL_PATH, convId);
            const localPbPath = path.join(AI_HISTORY_CONVERSATIONS_PATH, `${convId}.pb`);
            // Для подпапок бесед используем простой поиск/создание, чтобы не спамить уведомлениями о слиянии (если их несколько)
            const remoteConvFolderId = await findOrCreateSubFolder(drive, historyFolderId, convId, context);

            if (fsSync.existsSync(localPath)) {
                await syncFolder(drive, localPath, remoteConvFolderId, machineId, silent);
            } else {
                if (!silent) vscode.window.showInformationMessage(`Загрузка нового чата: ${convId}`);
                await downloadFolder(drive, remoteConvFolderId, localPath, silent);
            }

            // 2. Синхронизируем .pb файл (conversations)
            const remoteFiles = await getAllRemoteFiles(drive, remoteConvFolderId);
            const pbFileNameOnDrive = `${convId}.pb`;
            const remotePbFile = remoteFiles.find(f => f.name === pbFileNameOnDrive);

            if (fsSync.existsSync(localPbPath)) {
                if (remotePbFile) {
                    await syncFileWithConflictResolution(drive, localPbPath, remotePbFile, machineId, silent);
                } else {
                    await uploadFile(drive, remoteConvFolderId, localPbPath, pbFileNameOnDrive, machineId);
                }
            } else if (remotePbFile) {
                await downloadFile(drive, remotePbFile.id, localPbPath);
            }
        }

        // 2. Синхронизируем Базу Знаний (Knowledge Items) целиком
        const knowledgeFolderId = await findOrCreateAIKnowledgeFolder(drive, workspaceRoot, context);
        await syncFolder(drive, AI_KNOWLEDGE_LOCAL_PATH, knowledgeFolderId, machineId, silent);

        // 3. Обновляем манифест на диске и локально
        const mergedIds = Array.from(allRelevantIds);
        await context.workspaceState.update(AI_HISTORY_IDS_KEY, mergedIds);
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
    try {
        const localEntries = await fs.readdir(localPath);
        const remoteFiles = await getAllRemoteFiles(drive, remoteFolderId);

        for (const entry of localEntries) {
            if (entry === 'knowledge.lock') continue; // Пропускаем файл блокировки

            const localEntryPath = path.join(localPath, entry);
            const stats = await fs.stat(localEntryPath);

            if (stats.isDirectory()) {
                const remoteSubFolderId = await findOrCreateSubFolder(drive, remoteFolderId, entry);
                await syncFolder(drive, localEntryPath, remoteSubFolderId, machineId, silent);
            } else {
                const remoteFile = remoteFiles.find(f => f.name === entry);
                if (remoteFile) {
                    await syncFileWithConflictResolution(drive, localEntryPath, remoteFile, machineId, silent);
                } else {
                    await uploadFile(drive, remoteFolderId, localEntryPath, entry, machineId);
                }
            }
        }
    } catch (e) {
        console.error(`Error syncing folder ${localPath}:`, e);
    }
}

async function syncFileWithConflictResolution(drive, localPath, remoteFile, machineId, silent) {
    const localMd5 = await getFileMd5(localPath);
    if (localMd5 === remoteFile.md5Checksum) return;

    const stats = await fs.stat(localPath);
    const localTime = stats.mtime.getTime();
    const remoteTime = new Date(remoteFile.modifiedTime).getTime();
    const fileName = path.basename(localPath);

    // Добавляем буфер 2 сек для учета разницы в точности файловых систем
    if (remoteTime > localTime + 2000) {
        // Удаленная версия новее - скачиваем
        await downloadFile(drive, remoteFile.id, localPath);
    } else if (localTime > remoteTime + 2000) {
        // Локальная версия новее - выгружаем
        await updateFile(drive, remoteFile.id, localPath, machineId);
    } else {
        // Конфликт (время почти совпадает или MD5 разный при равном времени)
        if (silent) {
            // В тихом режиме отдаем приоритет облаку во избежание потери данных с другого ПК
            await downloadFile(drive, remoteFile.id, localPath);
        } else {
            const options = [
                { label: "Загрузить из Google Drive (Перезаписать мою)", action: "download" },
                { label: "Оставить мою версию (Перезаписать в облаке)", action: "upload" },
                { label: "Сравнить изменения", action: "compare" }
            ];
            const choice = await vscode.window.showQuickPick(options, { 
                placeHolder: `Конфликт в файле AI: ${fileName}. Время почти совпадает. Что сделать?`,
                ignoreFocusOut: true 
            });

            if (choice && choice.action === 'compare') {
                const tempRemotePath = path.join(os.tmpdir(), `gdrive-remote-${Date.now()}-${path.basename(localPath)}`);
                try {
                    await downloadFile(drive, remoteFile.id, tempRemotePath);
                    await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(tempRemotePath), vscode.Uri.file(localPath), `${fileName} (Cloud) ↔ (Local)`);
                    // После сравнения снова вызываем решение конфликта
                    return await syncFileWithConflictResolution(drive, localPath, remoteFile, machineId, silent);
                } finally {
                    if (fsSync.existsSync(tempRemotePath)) await fs.unlink(tempRemotePath).catch(() => {});
                }
            }

            if (choice && choice.action === 'download') {
                await downloadFile(drive, remoteFile.id, localPath);
            } else if (choice && choice.action === 'upload') {
                await updateFile(drive, remoteFile.id, localPath, machineId);
            }
        }
    }
}

async function downloadFolder(drive, remoteFolderId, localPath, silent) {
    const remoteFiles = await getAllRemoteFiles(drive, remoteFolderId, true);
    for (const file of remoteFiles) {
        const destPath = path.join(localPath, file.name);
        await downloadFile(drive, file.id, destPath);
    }
}

async function findOrCreateAIHistoryFolder(drive, workspaceRoot, context) {
    const projectFolderId = await findOrCreateBaseProjectFolder(drive, workspaceRoot, context);
    return await ensureSingleFolder(drive, projectFolderId, 'ai-history', context);
}

async function findOrCreateAIHistoryManifest(drive, historyFolderId) {
    const fileName = 'history_manifest.json';
    const q = `name='${fileName}' and '${historyFolderId}' in parents and trashed=false`;
    const { data: { files } } = await drive.files.list({ q, fields: 'files(id)' });

    if (files.length > 0) {
        return files[0].id;
    }
}

async function findOrCreateAIKnowledgeFolder(drive, workspaceRoot, context) {
    const projectFolderId = await findOrCreateBaseProjectFolder(drive, workspaceRoot, context);
    return await ensureSingleFolder(drive, projectFolderId, 'knowledge', context);
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

async function findOrCreateProjectFolders(drive, workspaceRoot, context) {
    const projectFolderId = await findOrCreateBaseProjectFolder(drive, workspaceRoot, context);
    return await ensureSingleFolder(drive, projectFolderId, 'bundles', context);
}

async function findOrCreateUntrackedFilesFolder(drive, workspaceRoot, context) {
    const projectFolderId = await findOrCreateBaseProjectFolder(drive, workspaceRoot, context);
    return await ensureSingleFolder(drive, projectFolderId, 'untracked', context);
}

async function findOrCreateTombstonesFolder(drive, workspaceRoot, context) {
    const projectFolderId = await findOrCreateBaseProjectFolder(drive, workspaceRoot, context);
    return await ensureSingleFolder(drive, projectFolderId, 'tombstones', context);
}

async function findOrCreateBaseProjectFolder(drive, workspaceRoot, context) {
    const projectName = path.basename(workspaceRoot);
    const rootFolderId = await ensureSingleFolder(drive, null, '.gdrive-git', context);

    return await ensureSingleFolder(drive, rootFolderId, projectName, context);
}

async function findOrCreateSubFolder(drive, parentId, folderName, context) {
    return await ensureSingleFolder(drive, parentId, folderName, context);
}

// --- УПРАВЛЕНИЕ ПАПКАМИ И СЛИЯНИЕ ---

async function ensureSingleFolder(drive, parentId, folderName, context) {
    const q = `name='${escapeGdriveQueryParam(folderName)}' and mimeType='application/vnd.google-apps.folder' and ${parentId ? `'${parentId}' in parents` : "'root' in parents"} and trashed=false`;
    let { data: { files } } = await drive.files.list({ q, fields: 'files(id, name, createdTime)' });

    if (files.length === 0) {
        const resource = { name: folderName, mimeType: 'application/vnd.google-apps.folder' };
        if (parentId) resource.parents = [parentId];
        const { data } = await drive.files.create({ resource, fields: 'id' });
        return data.id;
    } else if (files.length === 1) {
        return files[0].id;
    } else {
        // Найдены дубликаты!
        return await reconcileFolderDuplicates(drive, files, folderName, parentId, context);
    }
}

async function reconcileFolderDuplicates(drive, folders, folderName, parentId, context) {
    vscode.window.showInformationMessage(`Обнаружены дубликаты папки "${folderName}". Начинаю автоматическое объединение...`);
    
    // Сортируем по времени создания: самая старая становится основной
    folders.sort((a, b) => new Date(a.createdTime) - new Date(b.createdTime));
    const primaryFolder = folders[0];
    const duplicates = folders.slice(1);

    const workspaceRoot = getWorkspaceRoot();
    const backupBaseId = await findOrCreateBackupsFolder(drive, workspaceRoot, context);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupSessionId = await ensureSingleFolder(drive, backupBaseId, `merge_${folderName}_${timestamp}`, context);

    for (const dup of duplicates) {
        await mergeFoldersRecursive(drive, primaryFolder.id, dup.id, backupSessionId);
        // Перемещаем теперь уже пустой дубликат в бэкап
        await drive.files.update({
            fileId: dup.id,
            addParents: backupSessionId,
            removeParents: parentId || 'root',
            fields: 'id, parents'
        });
    }

    vscode.window.showInformationMessage(`Объединение папки "${folderName}" завершено. Старые версии сохранены в .gdrive-git/backups.`);
    return primaryFolder.id;
}

async function mergeFoldersRecursive(drive, targetFolderId, sourceFolderId, backupFolderId) {
    const sourceItems = await getAllRemoteFiles(drive, sourceFolderId);
    const targetItems = await getAllRemoteFiles(drive, targetFolderId);
    const targetMap = new Map(targetItems.map(i => [i.name, i]));

    for (const item of sourceItems) {
        const targetItem = targetMap.get(item.name);

        if (item.mimeType === 'application/vnd.google-apps.folder') {
            if (targetItem && targetItem.mimeType === 'application/vnd.google-apps.folder') {
                // Рекурсивно объединяем подпапки
                const subBackupId = await ensureSingleFolder(drive, backupFolderId, item.name);
                await mergeFoldersRecursive(drive, targetItem.id, item.id, subBackupId);
            } else {
                // Переносим папку целиком
                if (targetItem) {
                    await drive.files.update({ fileId: targetItem.id, addParents: backupFolderId, removeParents: targetFolderId });
                }
                await drive.files.update({ fileId: item.id, addParents: targetFolderId, removeParents: sourceFolderId });
            }
        } else {
            // Это файл
            if (targetItem) {
                const sourceTime = new Date(item.modifiedTime).getTime();
                const targetTime = new Date(targetItem.modifiedTime).getTime();

                if (sourceTime > targetTime) {
                    await drive.files.update({ fileId: targetItem.id, addParents: backupFolderId, removeParents: targetFolderId });
                    await drive.files.update({ fileId: item.id, addParents: targetFolderId, removeParents: sourceFolderId });
                } else {
                    await drive.files.update({ fileId: item.id, addParents: backupFolderId, removeParents: sourceFolderId });
                }
            } else {
                await drive.files.update({ fileId: item.id, addParents: targetFolderId, removeParents: sourceFolderId });
            }
        }
    }
}

async function cleanupOldBackups(drive, workspaceRoot) {
    try {
        const backupsFolderId = await findOrCreateBackupsFolder(drive, workspaceRoot);
        const { data: { files: sessions } } = await drive.files.list({
            q: `'${backupsFolderId}' in parents and trashed=false`,
            fields: 'files(id, name, createdTime)'
        });

        const now = new Date();
        const thirtyDaysInMs = 30 * 24 * 60 * 60 * 1000;

        for (const session of sessions) {
            const createdTime = new Date(session.createdTime).getTime();
            if (now.getTime() - createdTime > thirtyDaysInMs) {
                console.log(`Cleaning up old backup session: ${session.name}`);
                await drive.files.delete({ fileId: session.id });
            }
        }
    } catch (e) {
        console.error('Error during backups cleanup:', e);
    }
}

async function findOrCreateBackupsFolder(drive, workspaceRoot, context) {
    const projectFolderId = await findOrCreateBaseProjectFolder(drive, workspaceRoot, context);
    // Для backups используем простую проверку, чтобы не уходить в бесконечный цикл рекурсии
    const q = `name='${BACKUPS_DIR_NAME}' and mimeType='application/vnd.google-apps.folder' and '${projectFolderId}' in parents and trashed=false`;
    const { data: { files } } = await drive.files.list({ q, fields: 'files(id)' });
    if (files.length > 0) return files[0].id;
    
    const { data } = await drive.files.create({
        resource: { name: BACKUPS_DIR_NAME, mimeType: 'application/vnd.google-apps.folder', parents: [projectFolderId] },
        fields: 'id'
    });
    return data.id;
}

// --- КЛОУД-КОНФИГ (Cloud Config) ---

async function getCloudConfig(drive, projectFolderId) {
    const q = `name='${CLOUD_CONFIG_FILE_NAME}' and '${projectFolderId}' in parents and trashed=false`;
    const { data: { files } } = await drive.files.list({ q, fields: 'files(id)' });
    
    if (files.length === 0) return null;

    try {
        const { data } = await drive.files.get({ fileId: files[0].id, alt: 'media' });
        // Обработка разных форматов ответа
        if (typeof data === 'string') return JSON.parse(data);
        return data;
    } catch (e) {
        console.error('Error reading cloud config:', e);
        return null;
    }
}

async function updateCloudConfig(drive, projectFolderId, config) {
    const q = `name='${CLOUD_CONFIG_FILE_NAME}' and '${projectFolderId}' in parents and trashed=false`;
    const { data: { files } } = await drive.files.list({ q, fields: 'files(id)' });

    const media = {
        mimeType: 'application/json',
        body: JSON.stringify(config, null, 2)
    };

    if (files.length > 0) {
        await drive.files.update({ fileId: files[0].id, media });
    } else {
        await drive.files.create({
            resource: { name: CLOUD_CONFIG_FILE_NAME, parents: [projectFolderId] },
            media
        });
    }
}

async function getEffectiveConfig(drive, projectFolderId) {
    const cloudConfig = await getCloudConfig(drive, projectFolderId);
    const localConfig = vscode.workspace.getConfiguration('changegittogoogledrive-extension.untrackedFiles');
    
    return {
        include: cloudConfig?.include || localConfig.get('include', []),
        exclude: cloudConfig?.exclude || localConfig.get('exclude', [])
    };
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

async function getAllRemoteFiles(drive, folderId, recursive = false, prefix = '') {
    let files = [];
    let pageToken = null;
    do {
        const res = await drive.files.list({
            q: `'${folderId}' in parents and trashed=false and name != '.deleted'`,
            fields: 'nextPageToken, files(id, name, md5Checksum, appProperties, mimeType, modifiedTime)',
            pageToken: pageToken,
        });
        
        for (const file of res.data.files) {
            const fullName = prefix ? `${prefix}/${file.name}` : file.name;
            if (recursive && file.mimeType === 'application/vnd.google-apps.folder') {
                const subFiles = await getAllRemoteFiles(drive, file.id, true, fullName);
                files = files.concat(subFiles);
            } else {
                files.push({ ...file, name: fullName });
            }
        }
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

async function uploadFile(drive, folderId, filePath, relativePath, machineId) {
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

async function getFilesRecursively(dir, baseDir) {
    let results = [];
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

async function getUntrackedAndIgnoredFiles(workspaceRoot) {
    try {
        // 1. Получаем список отдельных игнорируемых файлов
        const { stdout: filesStr } = await runCommand('git -c core.quotePath=false ls-files --others --ignored --exclude-standard', workspaceRoot);
        const files = filesStr.trim().split(/\r\n|\n/).filter(f => f);

        // 2. Получаем список игнорируемых директорий
        const { stdout: dirsStr } = await runCommand('git -c core.quotePath=false ls-files --others --ignored --exclude-standard --directory', workspaceRoot);
        const { stdout: untrackedDirsStr } = await runCommand('git -c core.quotePath=false ls-files --others --exclude-standard --directory', workspaceRoot);
        const dirs = [...new Set([
            ...dirsStr.trim().split(/\r\n|\n/).filter(d => d),
            ...untrackedDirsStr.trim().split(/\r\n|\n/).filter(d => d)
        ])];

        let allFiles = new Set(files);

        for (const dir of dirs) {
            const sanitizedDir = dir.replace(/\\/g, '/').replace(/\/$/, '');
            const fullPath = path.join(workspaceRoot, sanitizedDir);
            try {
                const stat = await fs.stat(fullPath);
                if (stat.isDirectory()) {
                    const subFiles = await getFilesRecursively(fullPath, workspaceRoot);
                    subFiles.forEach(f => allFiles.add(f));
                } else {
                    allFiles.add(sanitizedDir);
                }
            } catch (e) {
                // Путь может не существовать
            }
        }
        return Array.from(allFiles).sort();
    } catch (error) {
        console.error('Error getting untracked files:', error);
        return [];
    }
}

function isFileIncluded(filePath, includePatterns, excludePatterns) {
    if (!includePatterns || includePatterns.length === 0) return false;

    const sanitizePattern = (p) => p.replace(/\\/g, '/').replace(/\/$/, '');
    const sanitizedIncludes = includePatterns.map(sanitizePattern);
    const sanitizedExcludes = (excludePatterns || []).map(sanitizePattern);

    const checkMatch = (f, p) => {
        if (minimatch(f, p, { matchBase: true })) return true;
        // Умная проверка для папок: если файл внутри папки-шаблона
        if (f.startsWith(p + '/') || f === p) return true;
        return false;
    };

    const isIncluded = sanitizedIncludes.some(p => checkMatch(filePath, p));
    if (!isIncluded) return false;

    if (sanitizedExcludes.length > 0) {
        const isExcluded = sanitizedExcludes.some(p => checkMatch(filePath, p));
        if (isExcluded) return false;
    }

    return true;
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