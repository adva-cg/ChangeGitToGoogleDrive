import * as vscode from 'vscode';
import { drive_v3 } from 'googleapis';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { 
    getRemoteLock, 
    createRemoteLock, 
    updateRemoteLock, 
    deleteRemoteLock 
} from './operations';
import { getWorkspaceRoot } from '../utils/common';

const LOCK_STALE_MS = 10 * 60 * 1000; // 10 minutes

export class LockManager {
    private static isLocalSyncInProgress = false;
    private static remoteLockId: string | undefined = undefined;
    private static heartbeatInterval: NodeJS.Timeout | undefined = undefined;
    private static sessionId = `${vscode.env.machineId}-${process.pid}`;

    private static getLocalLockPath(): string | null {
        const root = getWorkspaceRoot();
        if (!root) return null;
        return path.join(root, '.git', '.sync.lock.local');
    }

    private static acquireLocalLock(): boolean {
        const lockPath = this.getLocalLockPath();
        if (!lockPath) return false;

        if (fs.existsSync(lockPath)) {
            try {
                const content = fs.readFileSync(lockPath, 'utf8');
                const lockData = JSON.parse(content);
                // If it's the same PID, we somehow re-entered (shouldn't happen with isLocalSyncInProgress)
                if (lockData.pid === process.pid) return true;
                
                // Check if process still exists (basic check)
                try {
                    process.kill(lockData.pid, 0);
                    // Process exists, lock is valid
                    return false;
                } catch (e) {
                    // Process doesn't exist, lock is stale
                }
            } catch (e) {}
        }

        try {
            fs.writeFileSync(lockPath, JSON.stringify({
                pid: process.pid,
                machineId: vscode.env.machineId,
                timestamp: new Date().toISOString()
            }));
            return true;
        } catch (e) {
            console.error('Failed to create local lock:', e);
            return false;
        }
    }

    private static releaseLocalLock() {
        const lockPath = this.getLocalLockPath();
        if (lockPath && fs.existsSync(lockPath)) {
            try {
                fs.unlinkSync(lockPath);
            } catch (e) {}
        }
    }

    static async acquireLock(drive: drive_v3.Drive, projectFolderId: string, componentName: string, silent: boolean): Promise<boolean> {
        if (this.isLocalSyncInProgress) {
            if (!silent) vscode.window.showWarningMessage(`Локальная синхронизация (${componentName}) уже в процессе.`);
            return false;
        }

        // 1. Try to acquire Local Lock (file-based, across processes)
        if (!this.acquireLocalLock()) {
            const msg = `Проект заблокирован другим процессом на этой машине.`;
            if (!silent) vscode.window.showWarningMessage(msg);
            return false;
        }

        const machineId = vscode.env.machineId;
        const hostname = os.hostname();
        
        // 2. Try to acquire Remote Lock (Google Drive)
        const existingLock = await getRemoteLock(drive, projectFolderId);
        if (existingLock) {
            const lockData = existingLock.description ? JSON.parse(existingLock.description) : {};
            const lastUpdate = new Date(existingLock.modifiedTime || 0).getTime();
            const now = Date.now();
            
            // Check if it's our OWN lock (same machine AND same session/process)
            if (lockData.machineId === machineId && lockData.sessionId === this.sessionId) {
                this.remoteLockId = existingLock.id!;
                await this.startHeartbeat(drive, componentName);
                this.isLocalSyncInProgress = true;
                return true;
            }

            // If it's same machine but different session, we already failed at local lock check above,
            // but just in case, handle it here too.
            if (now - lastUpdate < LOCK_STALE_MS) {
                const msg = `Проект заблокирован ${lockData.machineId === machineId ? 'другим окном' : 'другой машиной'}: ${lockData.hostname || 'Unknown'} (${lockData.component || 'Processing'}).`;
                if (!silent) vscode.window.showWarningMessage(msg, { modal: true });
                this.releaseLocalLock();
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
            sessionId: this.sessionId,
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
        
        this.releaseLocalLock();
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
        this.releaseLocalLock();
        this.isLocalSyncInProgress = false;
    }

    private static async startHeartbeat(drive: drive_v3.Drive, componentName: string) {
        this.stopHeartbeat();
        this.heartbeatInterval = setInterval(async () => {
            if (this.remoteLockId) {
                const lockData = {
                    machineId: vscode.env.machineId,
                    sessionId: this.sessionId,
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

