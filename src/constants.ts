import * as path from 'path';
import * as os from 'os';

// Ключи для хранения (Global/Workspace State)
export const GOOGLE_DRIVE_CREDENTIALS_KEY = 'googleDriveCredentials';
export const GOOGLE_DRIVE_TOKENS_KEY = 'googleDriveTokens';
export const LAST_PUSHED_HASH_KEY_PREFIX = 'lastPushedHash_'; // Prefix + branch name
export const PROCESSED_TOMBSTONES_KEY = 'processedBranchTombstones';
export const ANTIGRAVITY_ENABLED_KEY = 'aiHistoryEnabled'; // Ключ оставлен старым для совместимости
export const ANTIGRAVITY_IDS_KEY = 'aiHistoryConversationIds'; // Ключ оставлен старым для совместимости
export const CONFLICT_DECISIONS_KEY = 'untrackedConflictDecisions';
export const LAST_CLIPBOARD_HASH_KEY = 'lastClipboardHash';
export const LAST_KNOWN_UNTRACKED_FILES_KEY = 'lastKnownUntrackedFiles';

// Пути локального окружения Antigravity
export const ANTIGRAVITY_BASE_PATH = path.join(os.homedir(), '.gemini', 'antigravity');
export const ANTIGRAVITY_BRAIN_PATH = path.join(ANTIGRAVITY_BASE_PATH, 'brain');
export const ANTIGRAVITY_CONVERSATIONS_PATH = path.join(ANTIGRAVITY_BASE_PATH, 'conversations');
export const ANTIGRAVITY_ANNOTATIONS_PATH = path.join(ANTIGRAVITY_BASE_PATH, 'annotations');
export const ANTIGRAVITY_IMPLICIT_PATH = path.join(ANTIGRAVITY_BASE_PATH, 'implicit');
export const ANTIGRAVITY_KNOWLEDGE_PATH = path.join(ANTIGRAVITY_BASE_PATH, 'knowledge');

// Имена вспомогательных файлов на Google Drive
export const CLIPBOARD_SYNC_FILE_NAME = 'clipboard_sync.json';
export const REFS_FILE_NAME = 'refs.json';
export const CLOUD_CONFIG_FILE_NAME = 'config.json';
export const BACKUPS_DIR_NAME = 'backups';
