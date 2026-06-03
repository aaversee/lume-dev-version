/**
 * SQLite Database Setup
 * Minimal storage: public keys, prekeys, and pending messages.
 */

import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'

const DEFAULT_DB_PATH = path.join(__dirname, '../../data/messenger.db')
const DB_PATH = (process.env.DB_PATH || DEFAULT_DB_PATH).trim()
const RESOLVED_DB_PATH = DB_PATH === ':memory:' ? DB_PATH : path.resolve(DB_PATH)

if (RESOLVED_DB_PATH !== ':memory:') {
  fs.mkdirSync(path.dirname(RESOLVED_DB_PATH), { recursive: true })
}

const db = new Database(RESOLVED_DB_PATH)

// Pragmas
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')
db.pragma('busy_timeout = 3000')
db.pragma('synchronous = NORMAL')
db.pragma('cache_size = -64000') // 64MB cache
db.pragma('temp_store = MEMORY')
db.pragma('auto_vacuum = INCREMENTAL')

// ==================== Tables ====================

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    identity_key TEXT NOT NULL,
    exchange_identity_key TEXT,
    signed_prekey TEXT NOT NULL,
    signed_prekey_signature TEXT NOT NULL,
    push_token TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    last_seen INTEGER
  );

  CREATE TABLE IF NOT EXISTS one_time_prekeys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    public_key TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS pending_messages (
    id TEXT PRIMARY KEY,
    sender_id TEXT NOT NULL,
    recipient_id TEXT NOT NULL,
    encrypted_payload TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (recipient_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS request_signatures (
    request_hash TEXT PRIMARY KEY,
    identity_key TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
  );

  CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_identity_key_unique ON users(identity_key);
  CREATE INDEX IF NOT EXISTS idx_prekeys_user ON one_time_prekeys(user_id);
  CREATE INDEX IF NOT EXISTS idx_messages_recipient ON pending_messages(recipient_id);
  CREATE INDEX IF NOT EXISTS idx_messages_sender ON pending_messages(sender_id);
  CREATE INDEX IF NOT EXISTS idx_messages_recipient_time ON pending_messages(recipient_id, created_at ASC);
  CREATE INDEX IF NOT EXISTS idx_request_signatures_created_at ON request_signatures(created_at);

  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    uploader_id TEXT NOT NULL,
    size INTEGER NOT NULL,
    mime_hint TEXT NOT NULL DEFAULT 'application/octet-stream',
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    expires_at INTEGER,
    FOREIGN KEY (uploader_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_files_uploader ON files(uploader_id);
  CREATE INDEX IF NOT EXISTS idx_files_expires ON files(expires_at);

  CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    creator_id TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (creator_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS group_members (
    group_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    joined_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    PRIMARY KEY (group_id, user_id),
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);

  CREATE TABLE IF NOT EXISTS blocked_users (
    blocker_id TEXT NOT NULL,
    blocked_id TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    PRIMARY KEY (blocker_id, blocked_id),
    FOREIGN KEY (blocker_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (blocked_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS invite_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token TEXT UNIQUE NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    expires_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_invite_tokens_token ON invite_tokens(token);
  CREATE INDEX IF NOT EXISTS idx_invite_tokens_user ON invite_tokens(user_id);
  CREATE INDEX IF NOT EXISTS idx_invite_tokens_expires ON invite_tokens(expires_at);
`)

// ==================== Lightweight migrations ====================
// Older DBs were created before `exchange_identity_key` existed.
// Ensure the column exists before creating the unique index.
try {
  const userColumns = db.prepare(`PRAGMA table_info(users)`).all() as Array<{
    name: string
  }>
  const hasExchange = userColumns.some(col => col.name === 'exchange_identity_key')

  if (!hasExchange) {
    db.exec(`ALTER TABLE users ADD COLUMN exchange_identity_key TEXT`)
  }

  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_exchange_identity_key_unique ON users(exchange_identity_key)`
  )

  // Backfill for existing rows (safe to run repeatedly).
  db.exec(
    `UPDATE users SET exchange_identity_key = signed_prekey WHERE exchange_identity_key IS NULL`
  )
} catch (migrationError) {
  // Acceptable: new DBs will still be created correctly above.
  // Log for debugging if the migration query itself is broken.
  if (process.env.LOG_SECURITY === '1') {
    console.warn('[db] Migration skipped:', migrationError)
  }
}

// Migration: add profile columns (display_name, avatar_file_id)
try {
  const userCols = db.prepare(`PRAGMA table_info(users)`).all() as Array<{ name: string }>
  const colNames = new Set(userCols.map(c => c.name))
  if (!colNames.has('display_name')) {
    db.exec(`ALTER TABLE users ADD COLUMN display_name TEXT`)
  }
  if (!colNames.has('avatar_file_id')) {
    db.exec(`ALTER TABLE users ADD COLUMN avatar_file_id TEXT`)
  }
} catch {
  // Acceptable for fresh DBs
}

// Migration: add discoverable column
try {
  const userCols = db.prepare(`PRAGMA table_info(users)`).all() as Array<{ name: string }>
  const colNames = new Set(userCols.map(c => c.name))
  if (!colNames.has('discoverable')) {
    db.exec(`ALTER TABLE users ADD COLUMN discoverable INTEGER NOT NULL DEFAULT 1`)
  }
} catch {
  // Acceptable for fresh DBs
}

// Migration: add recipient_id column to files for access control
try {
  const fileCols = db.prepare(`PRAGMA table_info(files)`).all() as Array<{ name: string }>
  const fileColNames = new Set(fileCols.map(c => c.name))
  if (!fileColNames.has('recipient_id')) {
    db.exec(`ALTER TABLE files ADD COLUMN recipient_id TEXT DEFAULT NULL`)
  }
} catch {
  // Acceptable for fresh DBs
}

// ==================== Prepared Statements ====================

const insertUser = db.prepare(`
  INSERT INTO users (id, username, identity_key, exchange_identity_key, signed_prekey, signed_prekey_signature)
  VALUES (?, ?, ?, ?, ?, ?)
`)

const findUserByUsername = db.prepare(`
  SELECT * FROM users WHERE username = ?
`)

const findUserById = db.prepare(`
  SELECT * FROM users WHERE id = ?
`)

const findUserByIdentityKey = db.prepare(`
  SELECT * FROM users WHERE identity_key = ?
`)

const updatePushToken = db.prepare(`
  UPDATE users SET push_token = ? WHERE id = ?
`)

const updateLastSeen = db.prepare(`
  UPDATE users SET last_seen = strftime('%s', 'now') WHERE id = ?
`)

const updateProfile = db.prepare(`
  UPDATE users SET display_name = ?, avatar_file_id = ? WHERE id = ?
`)

const updateSignedPrekey = db.prepare(`
  UPDATE users
  SET signed_prekey = ?, signed_prekey_signature = ?
  WHERE id = ?
`)

const deleteUser = db.prepare(`
  DELETE FROM users WHERE id = ?
`)

const insertPrekey = db.prepare(`
  INSERT OR IGNORE INTO one_time_prekeys (id, user_id, public_key)
  VALUES (?, ?, ?)
`)

const deletePrekeysForUser = db.prepare(`
  DELETE FROM one_time_prekeys WHERE user_id = ?
`)

const updateExchangeIdentityKey = db.prepare(`
  UPDATE users SET exchange_identity_key = ? WHERE id = ?
`)

const getAndDeletePrekey = db.prepare(`
  DELETE FROM one_time_prekeys
  WHERE id = (
    SELECT id FROM one_time_prekeys
    WHERE user_id = ?
    ORDER BY created_at ASC
    LIMIT 1
  )
  RETURNING public_key
`)

const peekPrekey = db.prepare(`
  SELECT public_key FROM one_time_prekeys
  WHERE user_id = ?
  ORDER BY created_at ASC
  LIMIT 1
`)

const countPrekeys = db.prepare(`
  SELECT COUNT(*) as count FROM one_time_prekeys WHERE user_id = ?
`)

const countPendingForRecipient = db.prepare(`
  SELECT COUNT(*) as count FROM pending_messages WHERE recipient_id = ?
`)

const insertMessage = db.prepare(`
  INSERT INTO pending_messages (id, sender_id, recipient_id, encrypted_payload)
  VALUES (?, ?, ?, ?)
`)

const getPendingMessagesFirst = db.prepare(`
  SELECT * FROM pending_messages
  WHERE recipient_id = ?
  ORDER BY created_at ASC, id ASC
  LIMIT ?
`)

const getPendingMessagesAfter = db.prepare(`
  SELECT * FROM pending_messages
  WHERE recipient_id = ?
    AND (created_at > ? OR (created_at = ? AND id > ?))
  ORDER BY created_at ASC, id ASC
  LIMIT ?
`)

const getMessageById = db.prepare(`
  SELECT * FROM pending_messages WHERE id = ?
`)

const deleteMessage = db.prepare(`
  DELETE FROM pending_messages WHERE id = ?
`)

const deleteUserMessages = db.prepare(`
  DELETE FROM pending_messages WHERE recipient_id = ?
`)

const deleteStaleMessages = db.prepare(`
  DELETE FROM pending_messages WHERE created_at < ?
`)

const insertRequestSignature = db.prepare(`
  INSERT OR IGNORE INTO request_signatures (request_hash, identity_key)
  VALUES (?, ?)
`)

const cleanupOldRequestSignatures = db.prepare(`
  DELETE FROM request_signatures WHERE created_at < ?
`)

const countRequestSignatures = db.prepare(`
  SELECT COUNT(*) as cnt FROM request_signatures
`)

const truncateOldestRequestSignatures = db.prepare(`
  DELETE FROM request_signatures WHERE rowid IN (SELECT rowid FROM request_signatures ORDER BY created_at ASC LIMIT ?)
`)

// Throttle COUNT(*) checks: only query every 1000 inserts
const SIG_ROW_CAP = 100_000
const SIG_TRUNCATE_AMOUNT = 10_000
const SIG_CHECK_INTERVAL = 1000
let sigInsertsSinceCheck = 0

const insertBlock = db.prepare(`
  INSERT OR IGNORE INTO blocked_users (blocker_id, blocked_id)
  VALUES (?, ?)
`)

const removeBlock = db.prepare(`
  DELETE FROM blocked_users WHERE blocker_id = ? AND blocked_id = ?
`)

const checkBlocked = db.prepare(`
  SELECT 1 FROM blocked_users WHERE blocker_id = ? AND blocked_id = ? LIMIT 1
`)

const getBlockedByUser = db.prepare(`
  SELECT blocked_id FROM blocked_users WHERE blocker_id = ?
`)

const insertFile = db.prepare(`
  INSERT INTO files (id, uploader_id, size, mime_hint, expires_at, recipient_id)
  VALUES (?, ?, ?, ?, ?, ?)
`)

const getFileById = db.prepare(`
  SELECT * FROM files WHERE id = ?
`)

const deleteExpiredFiles = db.prepare(`
  DELETE FROM files WHERE expires_at IS NOT NULL AND expires_at < ? RETURNING id
`)

const countUserFiles = db.prepare(`
  SELECT COUNT(*) as count FROM files WHERE uploader_id = ?
`)

const countAllFiles = db.prepare(`
  SELECT COUNT(*) as count FROM files
`)

const insertGroup = db.prepare(`
  INSERT INTO groups (id, name, creator_id) VALUES (?, ?, ?)
`)

const getGroupById = db.prepare(`
  SELECT * FROM groups WHERE id = ?
`)

const insertGroupMember = db.prepare(`
  INSERT OR IGNORE INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)
`)

const removeGroupMember = db.prepare(`
  DELETE FROM group_members WHERE group_id = ? AND user_id = ?
`)

const getGroupMembers = db.prepare(`
  SELECT gm.*, u.username FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ?
`)

const getUserGroups = db.prepare(`
  SELECT g.* FROM groups g JOIN group_members gm ON g.id = gm.group_id WHERE gm.user_id = ?
`)

const deleteGroup = db.prepare(`
  DELETE FROM groups WHERE id = ?
`)

const insertInviteToken = db.prepare(`
  INSERT INTO invite_tokens (id, user_id, token, expires_at)
  VALUES (?, ?, ?, ?)
`)

const findInviteByToken = db.prepare(`
  SELECT * FROM invite_tokens WHERE token = ?
`)

const deleteExpiredInviteTokens = db.prepare(`
  DELETE FROM invite_tokens WHERE expires_at < ?
`)

const deleteUserInviteTokens = db.prepare(`
  DELETE FROM invite_tokens WHERE user_id = ?
`)

const countUserInviteTokens = db.prepare(`
  SELECT COUNT(*) as count FROM invite_tokens WHERE user_id = ?
`)

const updateDiscoverable = db.prepare(`
  UPDATE users SET discoverable = ? WHERE id = ?
`)

export interface FileRecord {
  id: string
  uploader_id: string
  recipient_id: string | null
  size: number
  mime_hint: string
  created_at: number
  expires_at: number | null
}

export interface Group {
  id: string
  name: string
  creator_id: string
  created_at: number
}

export interface GroupMember {
  group_id: string
  user_id: string
  role: string
  joined_at: number
  username: string
}

export interface User {
  id: string
  username: string
  identity_key: string
  exchange_identity_key: string | null
  signed_prekey: string
  signed_prekey_signature: string
  push_token: string | null
  display_name: string | null
  avatar_file_id: string | null
  discoverable: number
  created_at: number
  last_seen: number | null
}

export interface InviteToken {
  id: string
  user_id: string
  token: string
  created_at: number
  expires_at: number
}

export interface PendingMessage {
  id: string
  sender_id: string
  recipient_id: string
  encrypted_payload: string
  created_at: number
}

export const database = {
  createUser(
    id: string,
    username: string,
    identityKey: string,
    exchangeIdentityKey: string,
    signedPrekey: string,
    signedPrekeySignature: string
  ): void {
    insertUser.run(
      id,
      username,
      identityKey,
      exchangeIdentityKey,
      signedPrekey,
      signedPrekeySignature
    )
  },

  getUserByUsername(username: string): User | undefined {
    return findUserByUsername.get(username) as User | undefined
  },

  getUserById(id: string): User | undefined {
    return findUserById.get(id) as User | undefined
  },

  getUserByIdentityKey(identityKey: string): User | undefined {
    return findUserByIdentityKey.get(identityKey) as User | undefined
  },

  setPushToken(userId: string, token: string): void {
    updatePushToken.run(token, userId)
  },

  setProfile(userId: string, displayName: string | null, avatarFileId: string | null): void {
    updateProfile.run(displayName, avatarFileId, userId)
  },

  touchLastSeen(userId: string): void {
    updateLastSeen.run(userId)
  },

  setSignedPrekey(userId: string, signedPrekey: string, signedPrekeySignature: string): void {
    updateSignedPrekey.run(signedPrekey, signedPrekeySignature, userId)
  },

  deleteUser(userId: string): void {
    deleteUser.run(userId)
  },

  addPrekeys(userId: string, prekeys: Array<{ id: string; publicKey: string }>): void {
    const insertMany = db.transaction((keys: typeof prekeys) => {
      for (const key of keys) {
        insertPrekey.run(`${userId}:${key.id}`, userId, key.publicKey)
      }
    })
    insertMany(prekeys)
  },

  replacePrekeys(userId: string, prekeys: Array<{ id: string; publicKey: string }>): void {
    const replace = db.transaction(() => {
      deletePrekeysForUser.run(userId)
      for (const key of prekeys) {
        insertPrekey.run(`${userId}:${key.id}`, userId, key.publicKey)
      }
    })
    replace()
  },

  updateExchangeIdentityKey(userId: string, exchangeIdentityKey: string): void {
    updateExchangeIdentityKey.run(exchangeIdentityKey, userId)
  },

  peekPrekey(userId: string): string | null {
    const result = peekPrekey.get(userId) as { public_key: string } | undefined
    return result?.public_key ?? null
  },

  consumePrekey(userId: string): string | null {
    const result = getAndDeletePrekey.get(userId) as { public_key: string } | undefined
    return result?.public_key ?? null
  },

  getPrekeyCount(userId: string): number {
    const result = countPrekeys.get(userId) as { count: number }
    return result.count
  },

  getPendingMessageCount(recipientId: string): number {
    const result = countPendingForRecipient.get(recipientId) as { count: number }
    return result.count
  },

  queueMessage(id: string, senderId: string, recipientId: string, encryptedPayload: string): void {
    insertMessage.run(id, senderId, recipientId, encryptedPayload)
  },

  getPendingMessages(
    recipientId: string,
    options?: { limit?: number; afterId?: string }
  ): { messages: PendingMessage[]; hasMore: boolean } {
    const limit = Math.min(options?.limit ?? 100, 200)
    const fetchCount = limit + 1

    let rows: PendingMessage[]

    if (options?.afterId) {
      const cursor = getMessageById.get(options.afterId) as PendingMessage | undefined
      if (!cursor) {
        return { messages: [], hasMore: false }
      }
      rows = getPendingMessagesAfter.all(
        recipientId,
        cursor.created_at,
        cursor.created_at,
        cursor.id,
        fetchCount
      ) as PendingMessage[]
    } else {
      rows = getPendingMessagesFirst.all(recipientId, fetchCount) as PendingMessage[]
    }

    const hasMore = rows.length > limit
    if (hasMore) {
      rows = rows.slice(0, limit)
    }

    return { messages: rows, hasMore }
  },

  getUsersByIds(userIds: string[]): User[] {
    if (userIds.length === 0) return []
    const stmt = db.prepare('SELECT * FROM users WHERE id = ?')
    const results: User[] = []
    const run = db.transaction((ids: string[]) => {
      for (const id of ids) {
        const row = stmt.get(id) as User | undefined
        if (row) results.push(row)
      }
    })
    run(userIds)
    return results
  },

  getMessageById(messageId: string): PendingMessage | undefined {
    return getMessageById.get(messageId) as PendingMessage | undefined
  },

  deleteMessage(messageId: string): void {
    deleteMessage.run(messageId)
  },

  /**
   * Batch-delete messages in a single transaction.
   * Only deletes messages that belong to the given recipientId.
   * Returns the number of actually deleted messages.
   */
  batchDeleteMessages(messageIds: string[], recipientId: string): number {
    if (messageIds.length === 0) return 0
    const stmt = db.prepare('DELETE FROM pending_messages WHERE id = ? AND recipient_id = ?')
    let totalDeleted = 0
    const run = db.transaction((ids: string[]) => {
      for (const id of ids) {
        totalDeleted += stmt.run(id, recipientId).changes
      }
    })
    run(messageIds)
    return totalDeleted
  },

  deleteAllMessages(recipientId: string): void {
    deleteUserMessages.run(recipientId)
  },

  /**
   * Удаляет сообщения старше указанного количества секунд.
   * Возвращает количество удалённых сообщений.
   */
  purgeStaleMessages(maxAgeSec: number): number {
    const cutoff = Math.floor(Date.now() / 1000) - maxAgeSec
    const result = deleteStaleMessages.run(cutoff)
    return result.changes
  },

  rememberRequestSignature(requestHash: string, identityKey: string): boolean {
    const result = insertRequestSignature.run(requestHash, identityKey)
    if (result.changes > 0) {
      sigInsertsSinceCheck++
      if (sigInsertsSinceCheck >= SIG_CHECK_INTERVAL) {
        sigInsertsSinceCheck = 0
        const row = countRequestSignatures.get() as { cnt: number }
        if (row.cnt >= SIG_ROW_CAP) {
          truncateOldestRequestSignatures.run(SIG_TRUNCATE_AMOUNT)
        }
      }
    }
    return result.changes > 0
  },

  cleanupRequestSignatures(cutoff: number): number {
    return cleanupOldRequestSignatures.run(cutoff).changes
  },

  // ── Blocking ──

  blockUser(blockerId: string, blockedId: string): void {
    insertBlock.run(blockerId, blockedId)
  },

  unblockUser(blockerId: string, blockedId: string): void {
    removeBlock.run(blockerId, blockedId)
  },

  isBlocked(blockerId: string, blockedId: string): boolean {
    return !!checkBlocked.get(blockerId, blockedId)
  },

  getBlockedUsers(userId: string): string[] {
    const rows = getBlockedByUser.all(userId) as Array<{ blocked_id: string }>
    return rows.map(r => r.blocked_id)
  },

  // ── Files ──

  createFile(
    id: string,
    uploaderId: string,
    size: number,
    mimeHint: string,
    expiresAt?: number,
    recipientId?: string
  ): void {
    insertFile.run(id, uploaderId, size, mimeHint, expiresAt ?? null, recipientId ?? null)
  },

  getFileById(fileId: string): FileRecord | undefined {
    return getFileById.get(fileId) as FileRecord | undefined
  },

  getUserFileCount(userId: string): number {
    const result = countUserFiles.get(userId) as { count: number }
    return result.count
  },

  getAllFilesCount(): number {
    const result = countAllFiles.get() as { count: number }
    return result.count
  },

  purgeExpiredFiles(nowSec: number): string[] {
    const rows = deleteExpiredFiles.all(nowSec) as Array<{ id: string }>
    return rows.map(row => row.id)
  },

  // ── Invite Tokens ──

  createInviteToken(id: string, userId: string, token: string, expiresAt: number): void {
    insertInviteToken.run(id, userId, token, expiresAt)
  },

  getInviteByToken(token: string): InviteToken | undefined {
    return findInviteByToken.get(token) as InviteToken | undefined
  },

  deleteExpiredInviteTokens(nowSec: number): number {
    return deleteExpiredInviteTokens.run(nowSec).changes
  },

  deleteUserInviteTokens(userId: string): void {
    deleteUserInviteTokens.run(userId)
  },

  getUserInviteTokenCount(userId: string): number {
    const result = countUserInviteTokens.get(userId) as { count: number }
    return result.count
  },

  setDiscoverable(userId: string, discoverable: boolean): void {
    updateDiscoverable.run(discoverable ? 1 : 0, userId)
  },

  // ── Groups ──

  createGroup(id: string, name: string, creatorId: string): void {
    db.transaction(() => {
      insertGroup.run(id, name, creatorId)
      insertGroupMember.run(id, creatorId, 'admin')
    })()
  },

  getGroupById(groupId: string): Group | undefined {
    return getGroupById.get(groupId) as Group | undefined
  },

  addGroupMember(groupId: string, userId: string, role = 'member'): void {
    insertGroupMember.run(groupId, userId, role)
  },

  removeGroupMember(groupId: string, userId: string): void {
    removeGroupMember.run(groupId, userId)
  },

  getGroupMembers(groupId: string): GroupMember[] {
    return getGroupMembers.all(groupId) as GroupMember[]
  },

  getGroupMembersForGroups(groupIds: string[]): Record<string, GroupMember[]> {
    if (groupIds.length === 0) return {}
    const result = new Map<string, GroupMember[]>()
    for (const id of groupIds) {
      result.set(id, [])
    }
    for (let i = 0; i < groupIds.length; i += 500) {
      const chunk = groupIds.slice(i, i + 500)
      const placeholders = chunk.map(() => '?').join(', ')
      const rows = db
        .prepare(
          `SELECT gm.*, u.username FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id IN (${placeholders})`
        )
        .all(...chunk) as GroupMember[]
      for (const row of rows) {
        result.get(row.group_id)?.push(row)
      }
    }
    return Object.fromEntries(result)
  },

  getUserGroups(userId: string): Group[] {
    return getUserGroups.all(userId) as Group[]
  },

  deleteGroup(groupId: string): void {
    deleteGroup.run(groupId)
  },

  ping(): void {
    db.prepare('SELECT 1').get()
  },

  close(): void {
    db.close()
  },

  getStartupDiagnostics(): { path: string; userCount: number; sizeBytes: number } {
    const userCount = (db.prepare('SELECT COUNT(*) AS cnt FROM users').get() as { cnt: number }).cnt
    let sizeBytes = 0
    if (RESOLVED_DB_PATH !== ':memory:') {
      try {
        sizeBytes = fs.statSync(RESOLVED_DB_PATH).size
      } catch {
        // File may not exist yet
      }
    }
    return { path: RESOLVED_DB_PATH, userCount, sizeBytes }
  },
}

export default database
