import * as vscode from 'vscode';
import { drive_v3 } from 'googleapis';
import * as os from 'os';
import { 
    getRemoteLock, 
    createRemoteLock, 
    updateRemoteLock, 
    deleteRemoteLock 
} from './operations';

const LOCK_STALE_MS = 10 * 60 * 1000; // 10 minutes

export class LockManager {
    private static isLocalSyncInProgress = false;
    private static remoteLockId: string | undefined = undefined;
    private static heartbeatInterval: NodeJS.Timeout | undefined = undefined;

    static async acquireLock(drive: drive_v3.Drive, projectFolderId: string, componentName: string, silent: boolean): Promise<boolean> {
        if (this.isLocalSyncInProgress) {
            if (!silent) vscode.window.showWarningMessage(`Локальная синхронизация (${componentName}) уже в процессе.`);
            return false;
        }

        const machineId = vscode.env.machineId;
        const hostname = os.hostname();
        
        const existingLock = await getRemoteLock(drive, projectFolderId);
        if (existingLock) {
            const lockData = existingLock.description ? JSON.parse(existingLock.description) : {};
            const lastUpdate = new Date(existingLock.modifiedTime || 0).getTime();
            const now = Date.now();
            
            if (lockData.machineId === machineId) {
                // It's our own lock (maybe from a previous crash)
                this.remoteLockId = existingLock.id!;
                await this.startHeartbeat(drive, componentName);
                this.isLocalSyncInProgress = true;
                return true;
            }

            if (now - lastUpdate < LOCK_STALE_MS) {
                const msg = `Проект заблокирован другой машиной: ${lockData.hostname || 'Unknown'} (${lockData.component || 'Processing'}).`;
                if (!silent) vscode.window.showWarningMessage(msg, { modal: true });
                return false;
            } else {
                // Lock is stale, delete it
                try {
                    await deleteRemoteLock(drive, existingLock.id!);
                } catch (e) {}
            }
        }

        const lockData = {
            machineId,
            hostname,
            component: componentName,
            timestamp: new Date().toISOString()
        };
        
        try {
            await createRemoteLock(drive, projectFolderId, lockData);
            const newLock = await getRemoteLock(drive, projectFolderId);
            if (newLock) {
                this.remoteLockId = newLock.id!;
                await this.startHeartbeat(drive, componentName);
                this.isLocalSyncInProgress = true;
                return true;
            }
        } catch (error: any) {
            if (!silent) vscode.window.showErrorMessage(`Не удалось создать блокировку: ${error.message}`);
        }
        
        return false;
    }

    static async releaseLock(drive: drive_v3.Drive) {
        this.stopHeartbeat();
        if (this.remoteLockId) {
            try {
                await deleteRemoteLock(drive, this.remoteLockId);
            } catch (e) {}
            this.remoteLockId = undefined;
        }
        this.isLocalSyncInProgress = false;
    }

    private static async startHeartbeat(drive: drive_v3.Drive, componentName: string) {
        this.stopHeartbeat();
        this.heartbeatInterval = setInterval(async () => {
            if (this.remoteLockId) {
                const lockData = {
                    machineId: vscode.env.machineId,
                    hostname: os.hostname(),
                    component: componentName,
                    timestamp: new Date().toISOString()
                };
                try {
                    await updateRemoteLock(drive, this.remoteLockId, lockData);
                } catch (e) {
                    console.error('Failed to update heartbeat:', e);
                }
            }
        }, 2 * 60 * 1000); // every 2 minutes
    }

    private static stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = undefined;
        }
    }
}
