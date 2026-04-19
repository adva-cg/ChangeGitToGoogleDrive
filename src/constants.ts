import * as path from 'path';
import * as os from 'os';

// Ключи для хранения (Global/Workspace State)
export const GOOGLE_DRIVE_CREDENTIALS_KEY = 'googleDriveCredentials';
export const GOOGLE_DRIVE_TOKENS_KEY = 'googleDriveTokens';
export const LAST_PUSHED_HASH_KEY_PREFIX = 'lastPushedHash_'; // Prefix + branch name
export const PROCESSED_TOMBSTONES_KEY = 'processedBranchTombstones';
export const AI_HISTORY_ENABLED_KEY = 'aiHistoryEnabled'; // Stores true/false/undefined for the current project
export const AI_HISTORY_IDS_KEY = 'aiHistoryConversationIds'; // Array of IDs for the current project
export const CONFLICT_DECISIONS_KEY = 'untrackedConflictDecisions';
export const LAST_CLIPBOARD_HASH_KEY = 'lastClipboardHash';

// Пути локального окружения
export const AI_HISTORY_LOCAL_PATH = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
export const AI_HISTORY_CONVERSATIONS_PATH = path.join(os.homedir(), '.gemini', 'antigravity', 'conversations');
export const AI_KNOWLEDGE_LOCAL_PATH = path.join(os.homedir(), '.gemini', 'antigravity', 'knowledge');

// Имена вспомогательных файлов на Google Drive
export const CLIPBOARD_SYNC_FILE_NAME = 'clipboard_sync.json';
export const REFS_FILE_NAME = 'refs.json';
export const CLOUD_CONFIG_FILE_NAME = 'config.json';
export const BACKUPS_DIR_NAME = 'backups';
