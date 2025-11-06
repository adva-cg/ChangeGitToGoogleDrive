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
const MACHINE_ID_KEY = 'machineId';
const CONFLICT_DECISIONS_KEY = 'conflictDecisions';

function escapeGdriveQueryParam(param) {
    if (!param) return "";
    return param.replace(/\\/g, '/').replace(/'/g, "'\'");
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
        vscode.commands.registerCommand('changegittogoogledrive-extension.syncUntrackedFiles', () => syncUntrackedFiles(context, false)),
        vscode.commands.registerCommand('changegittogoogledrive-extension.deleteUntrackedFile', () => deleteUntrackedFile(context)),
        vscode.commands.registerCommand('changegittogoogledrive-extension.clearTombstones', () => clearTombstones(context))
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
        const machineId = context.globalState.get(MACHINE_ID_KEY);
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
                                    if(fsSync.existsSync(tempRemotePath)) await fs.unlink(tempRemotePath);
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

        const machineId = context.globalState.get(MACHINE_ID_KEY);

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
                                    if(fsSync.existsSync(tempRemotePath)) await fs.unlink(tempRemotePath);
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
        await pullCommits(context);
        await pushCommits(context);
        vscode.window.showInformationMessage('Sync finished.');
    } catch (error) {
        vscode.window.showErrorMessage(`Sync failed: ${error.message}`);
    }
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
        const branchName = parts[0];
        
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
            const { tokens: newTokens } = await oauth2Client.refreshAccessToken();
            const oldTokens = JSON.parse(tokensStr);
            if (oldTokens.refresh_token && !newTokens.refresh_token) {
                newTokens.refresh_token = oldTokens.refresh_token;
            }
            await context.secrets.store(GOOGLE_DRIVE_TOKENS_KEY, JSON.stringify(newTokens));
            oauth2Client.setCredentials(newTokens);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to refresh token: ${error.message}. Please run the 'Authenticate with Google' command again.`);
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

function deactivate() {}module.exports = {    activate,    deactivate};