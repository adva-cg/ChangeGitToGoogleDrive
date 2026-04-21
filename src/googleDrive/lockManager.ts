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


const LOCK_STALE_MS = 10 * 60 * 1000; // 10 minutes

export class LockManager {
    // Maps category to state
    private static activeLocks = new Set<string>();
    private static remoteLockIds = new Map<string, string>();
    private static heartbeatIntervals = new Map<string, NodeJS.Timeout>();
    private static sessionId = `${vscode.env.machineId}-${process.pid}`;

    private static getLocalLockPath(category: string, repoRoot?: string): string | null {
        const fileName = `.${category}.sync.lock.local`;
        if (repoRoot) {
            return path.join(repoRoot, '.git', fileName);
        } else {
            // Global lock for things like Antigravity sync
            return path.join(os.homedir(), '.vscode-gdrive-git', fileName);
        }
    }

    private static acquireLocalLock(category: string, repoRoot?: string): boolean {
        const lockPath = this.getLocalLockPath(category, repoRoot);
        if (!lockPath) return false;

        if (fs.existsSync(lockPath)) {
            try {
                const content = fs.readFileSync(lockPath, 'utf8');
                const lockData = JSON.parse(content);
                if (lockData.pid === process.pid) return true;
                
                try {
                    process.kill(lockData.pid, 0);
                    return false;
                } catch (e) {
                    // Stale lock
                }
            } catch (e) {}
        }

        try {
            fs.mkdirSync(path.dirname(lockPath), { recursive: true });
            fs.writeFileSync(lockPath, JSON.stringify({
                pid: process.pid,
                machineId: vscode.env.machineId,
                timestamp: new Date().toISOString()
            }));
            return true;
        } catch (e) {
            console.error(`Failed to create local lock for ${category}:`, e);
            return false;
        }
    }

    private static releaseLocalLock(category: string, repoRoot?: string) {
        if (!repoRoot) return;
        const lockPath = this.getLocalLockPath(category, repoRoot);
        if (lockPath && fs.existsSync(lockPath)) {
            try {
                fs.unlinkSync(lockPath);
            } catch (e) {}
        }
    }

    static async acquireLock(drive: drive_v3.Drive, projectFolderId: string, category: string, componentName: string, silent: boolean, repoRoot?: string): Promise<boolean> {
        if (this.activeLocks.has(category)) {
            if (!silent) vscode.window.showWarningMessage(`Синхронизация ${componentName} уже запущена в этом окне.`);
            return false;
        }

        if (repoRoot && !this.acquireLocalLock(category, repoRoot)) {
            const msg = `Синхронизация ${componentName} заблокирована другим процессом на этой машине.`;
            if (!silent) vscode.window.showWarningMessage(msg);
            return false;
        }

        const machineId = vscode.env.machineId;
        const hostname = os.hostname();
        const lockFileName = `.${category}.sync.lock`;
        
        const existingLock = await getRemoteLock(drive, projectFolderId, lockFileName);
        if (existingLock) {
            const lockData = existingLock.description ? JSON.parse(existingLock.description) : {};
            const lastUpdate = new Date(existingLock.modifiedTime || 0).getTime();
            const now = Date.now();
            
            if (lockData.machineId === machineId && lockData.sessionId === this.sessionId) {
                this.remoteLockIds.set(category, existingLock.id!);
                await this.startHeartbeat(drive, category, componentName);
                this.activeLocks.add(category);
                return true;
            }

            if (now - lastUpdate < LOCK_STALE_MS) {
                const msg = `Проект (${componentName}) заблокирован ${lockData.machineId === machineId ? 'другим окном' : 'другой машиной'}: ${lockData.hostname || 'Unknown'}.`;
                if (!silent) vscode.window.showWarningMessage(msg, { modal: !silent });
                if (repoRoot) this.releaseLocalLock(category, repoRoot);
                return false;
            } else {
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
            category: category,
            timestamp: new Date().toISOString()
        };
        
        try {
            await createRemoteLock(drive, projectFolderId, lockData, lockFileName);
            const newLock = await getRemoteLock(drive, projectFolderId, lockFileName);
            if (newLock) {
                this.remoteLockIds.set(category, newLock.id!);
                await this.startHeartbeat(drive, category, componentName);
                this.activeLocks.add(category);
                return true;
            }
        } catch (error: any) {
            if (!silent) vscode.window.showErrorMessage(`Не удалось создать блокировку ${category}: ${error.message}`);
        }
        
        if (repoRoot) this.releaseLocalLock(category, repoRoot);
        return false;
    }

    static async releaseLock(drive: drive_v3.Drive, category: string, repoRoot?: string) {
        this.stopHeartbeat(category);
        const remoteId = this.remoteLockIds.get(category);
        if (remoteId) {
            try {
                await deleteRemoteLock(drive, remoteId);
            } catch (e) {}
            this.remoteLockIds.delete(category);
        }
        if (repoRoot) this.releaseLocalLock(category, repoRoot);
        this.activeLocks.delete(category);
    }

    private static async startHeartbeat(drive: drive_v3.Drive, category: string, componentName: string) {
        this.stopHeartbeat(category);
        const interval = setInterval(async () => {
            const remoteId = this.remoteLockIds.get(category);
            if (remoteId) {
                const lockData = {
                    machineId: vscode.env.machineId,
                    sessionId: this.sessionId,
                    hostname: os.hostname(),
                    component: componentName,
                    category: category,
                    timestamp: new Date().toISOString()
                };
                try {
                    await updateRemoteLock(drive, remoteId, lockData);
                } catch (e) {
                    console.error(`Failed to update heartbeat for ${category}:`, e);
                }
            }
        }, 2 * 60 * 1000);
        this.heartbeatIntervals.set(category, interval);
    }

    private static stopHeartbeat(category: string) {
        const interval = this.heartbeatIntervals.get(category);
        if (interval) {
            clearInterval(interval);
            this.heartbeatIntervals.delete(category);
        }
    }
}
