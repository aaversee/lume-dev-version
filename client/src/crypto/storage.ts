/**
 * Безопасное локальное хранилище
 * Использует IndexedDB с шифрованием для хранения ключей
 */

import { get, set, del, clear } from "idb-keyval";
import nacl from "tweetnacl";
import { encodeBase64, decodeBase64 } from "tweetnacl-util";
import type { IdentityKeys, KeyPair } from "./keys";
import type { SerializedSession } from "./ratchet";
import type { Chat, Message } from "@/stores";

const STORAGE_KEYS = {
  IDENTITY: "identity_keys",
  CONTACTS: "contacts",
  CHATS: "chats",
  SESSIONS: "sessions",
  PREKEYS: "prekeys",
  SETTINGS: "settings",
  PIN_HASH: "pin_hash",
  ENCRYPTION_SALT: "encryption_salt",
  HIDDEN_CHAT_PIN: "hidden_chat_pin",
  LOCKOUT: "lockout_state",
  CHANGEPIN_BACKUP: "changepin_backup",
  GROUP_MESSAGES: "group_messages",
} as const;

interface EncryptedDataV1 {
  ciphertext: string;
  nonce: string;
  salt: string;
}

interface EncryptedDataV2 {
  v: 2;
  ciphertext: string;
  nonce: string;
}

type EncryptedData = EncryptedDataV1 | EncryptedDataV2;

interface BackupEnvelopeV1 {
  v: 1;
  salt: string;
  nonce: string;
  ciphertext: string;
}

interface BackupEnvelopeV2 {
  v: 2;
  salt: string;
  nonce: string;
  ciphertext: string;
  iterations: number;
}

type BackupEnvelope = BackupEnvelopeV1 | BackupEnvelopeV2;

/**
 * PBKDF2 iterations for backup envelope encryption.
 * 600,000 per OWASP 2023 recommendation for PBKDF2-SHA256.
 * Backups are exported/imported infrequently, so higher cost is acceptable.
 */
const BACKUP_PBKDF2_ITERATIONS = 600_000;

/**
 * Legacy iteration count used by BackupEnvelope v1.
 * Kept for backward-compatible import of old backups.
 */
const LEGACY_PBKDF2_ITERATIONS = 100_000;

/**
 * Derives an encryption key from a PIN with a specific iteration count.
 * Used for backup envelope encryption where iteration count may differ
 * from the main deriveKeyFromPin (which uses 100k for UX reasons).
 */
async function deriveKeyFromPinWithIterations(
  pin: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const pinBytes = stringToUint8Array(pin);

  const pinBuffer = new ArrayBuffer(pinBytes.length);
  new Uint8Array(pinBuffer).set(pinBytes);

  const saltBuffer = new ArrayBuffer(salt.length);
  new Uint8Array(saltBuffer).set(salt);

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    pinBuffer,
    "PBKDF2",
    false,
    ["deriveBits"],
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: saltBuffer,
      iterations,
      hash: "SHA-256",
    },
    keyMaterial,
    256,
  );

  return new Uint8Array(derivedBits);
}

// Helper functions for UTF8 encoding/decoding
function stringToUint8Array(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

function uint8ArrayToString(arr: Uint8Array): string {
  return new TextDecoder().decode(arr);
}

/**
 * Генерирует ключ шифрования из PIN или пароля
 */
async function deriveKeyFromPin(
  pin: string,
  salt: Uint8Array,
): Promise<Uint8Array> {
  const pinBytes = stringToUint8Array(pin);

  // Create ArrayBuffer copies to avoid SharedArrayBuffer type issues
  const pinBuffer = new ArrayBuffer(pinBytes.length);
  new Uint8Array(pinBuffer).set(pinBytes);

  const saltBuffer = new ArrayBuffer(salt.length);
  new Uint8Array(saltBuffer).set(salt);

  // Используем PBKDF2 через Web Crypto API
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    pinBuffer,
    "PBKDF2",
    false,
    ["deriveBits"],
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: saltBuffer,
      iterations: 600000,
      hash: "SHA-256",
    },
    keyMaterial,
    256,
  );

  return new Uint8Array(derivedBits);
}

/**
 * Расшифровывает данные с использованием PIN
 */
async function decryptWithPin(
  encrypted: EncryptedDataV1,
  pin: string,
): Promise<string | null> {
  const salt = decodeBase64(encrypted.salt);
  const key = await deriveKeyFromPin(pin, salt);
  const nonce = decodeBase64(encrypted.nonce);
  const ciphertext = decodeBase64(encrypted.ciphertext);

  const decrypted = nacl.secretbox.open(ciphertext, nonce, key);

  if (!decrypted) {
    return null;
  }

  return uint8ArrayToString(decrypted);
}

async function getOrCreateEncryptionSalt(): Promise<Uint8Array> {
  const existing = await get<string>(STORAGE_KEYS.ENCRYPTION_SALT);
  if (existing) {
    try {
      const decoded = decodeBase64(existing);
      if (decoded.length === 16) return decoded;
    } catch {
      // fallthrough to regenerate
    }
  }

  const salt = nacl.randomBytes(16);
  await set(STORAGE_KEYS.ENCRYPTION_SALT, encodeBase64(salt));
  return salt;
}

let cachedMasterKey: { pinHash: string; saltB64: string; key: Uint8Array } | null =
  null;

/**
 * Hash a PIN string for cache comparison (not for storage).
 * Uses nacl.hash (SHA-512) which is fast enough for an in-memory cache guard.
 */
function hashPinForCache(pin: string): string {
  return encodeBase64(nacl.hash(stringToUint8Array(pin)));
}

/**
 * Clears the in-memory cached master key.
 * Zeroes out the key material before releasing the reference.
 * Must be called on logout / clearAuth.
 */
export function clearCachedMasterKey(): void {
  if (cachedMasterKey) {
    cachedMasterKey.key.fill(0);
    cachedMasterKey = null;
  }
}

/**
 * Derives and returns the master encryption key from a PIN.
 * Caches the result keyed by a hash of the PIN (never the PIN itself).
 * This is the ONLY function that should accept a raw PIN for key derivation.
 */
export async function deriveMasterKeyFromPin(pin: string): Promise<Uint8Array> {
  const salt = await getOrCreateEncryptionSalt();
  const saltB64 = encodeBase64(salt);
  const pinH = hashPinForCache(pin);

  if (
    cachedMasterKey &&
    cachedMasterKey.pinHash === pinH &&
    cachedMasterKey.saltB64 === saltB64
  ) {
    return cachedMasterKey.key;
  }

  const key = await deriveKeyFromPin(pin, salt);
  cachedMasterKey = { pinHash: pinH, saltB64, key };
  return key;
}

/**
 * Internal helper: returns the master key. Accepts the already-derived key directly.
 * All storage functions now use this instead of raw PINs.
 */
function resolveMasterKey(masterKey: Uint8Array): Uint8Array {
  return masterKey;
}

function encryptWithKey(
  data: string,
  masterKey: Uint8Array,
): EncryptedDataV2 {
  const key = resolveMasterKey(masterKey);
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const messageBytes = stringToUint8Array(data);
  const ciphertext = nacl.secretbox(messageBytes, nonce, key);

  return {
    v: 2,
    ciphertext: encodeBase64(ciphertext),
    nonce: encodeBase64(nonce),
  };
}

async function decryptFromStorage(
  encrypted: EncryptedData,
  masterKey: Uint8Array,
): Promise<string | null> {
  if ((encrypted as EncryptedDataV2).v === 2) {
    const key = resolveMasterKey(masterKey);
    const nonce = decodeBase64((encrypted as EncryptedDataV2).nonce);
    const ciphertext = decodeBase64((encrypted as EncryptedDataV2).ciphertext);
    const decrypted = nacl.secretbox.open(ciphertext, nonce, key);
    return decrypted ? uint8ArrayToString(decrypted) : null;
  }

  // v1 legacy records contain their own embedded salt and require a raw PIN
  // to derive the key. This path is only reachable during migration (first unlock
  // after upgrade). Callers that may encounter v1 data must pass `legacyPin` via
  // the dedicated `decryptFromStorageV1Compat` helper.
  return null;
}

/**
 * Сохраняет ключи идентификации (encrypted with master key).
 */
export async function saveIdentityKeys(
  keys: IdentityKeys,
  masterKey: Uint8Array,
): Promise<void> {
  const data = JSON.stringify(keys);
  const encrypted = encryptWithKey(data, masterKey);
  await set(STORAGE_KEYS.IDENTITY, encrypted);

  // Store a PIN verification hash so we can validate PINs at unlock.
  // The hash is already stored by deriveMasterKeyFromPin callers.
}

/**
 * Save PIN verification token (called at setup / unlock time).
 * Derives a key via PBKDF2 (600K iterations) and encrypts a known sentinel.
 * Verification: derive key from candidate PIN, try to decrypt. Success = correct PIN.
 */
export async function savePinHash(pin: string): Promise<void> {
  const salt = nacl.randomBytes(16);
  const key = await deriveKeyFromPinWithIterations(pin, salt, 600_000);
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const sentinel = stringToUint8Array("LUME_PIN_VERIFY");
  const ciphertext = nacl.secretbox(sentinel, nonce, key);
  const token = JSON.stringify({
    v: 2,
    salt: encodeBase64(salt),
    nonce: encodeBase64(nonce),
    ciphertext: encodeBase64(ciphertext),
  });
  await set(STORAGE_KEYS.PIN_HASH, token);
}

/**
 * Загружает ключи идентификации.
 * Accepts a derived master key. For v1 legacy data, pass `legacyPin` to allow migration.
 */
export async function loadIdentityKeys(
  masterKey: Uint8Array,
  legacyPin?: string,
): Promise<IdentityKeys | null> {
  const encrypted = await get<EncryptedData>(STORAGE_KEYS.IDENTITY);

  if (!encrypted) {
    return null;
  }

  let decrypted = await decryptFromStorage(encrypted, masterKey);

  // v1 fallback: try legacy PIN-based decryption and re-encrypt as v2
  if (!decrypted && legacyPin && !((encrypted as EncryptedDataV2).v === 2)) {
    decrypted = await decryptWithPin(encrypted as EncryptedDataV1, legacyPin);
    if (decrypted) {
      // Migrate to v2 format
      const reEncrypted = encryptWithKey(decrypted, masterKey);
      await set(STORAGE_KEYS.IDENTITY, reEncrypted);
    }
  }

  if (!decrypted) {
    return null;
  }

  try {
    return JSON.parse(decrypted) as IdentityKeys;
  } catch {
    // Decryption succeeded but payload is corrupted: reset only the affected keys.
    await del(STORAGE_KEYS.IDENTITY);
    await del(STORAGE_KEYS.PIN_HASH);
    return null;
  }
}

/**
 * Проверяет, существует ли аккаунт
 */
export async function hasAccount(): Promise<boolean> {
  const identity = await get(STORAGE_KEYS.IDENTITY);
  return identity !== undefined;
}

// ==================== Контакты ====================

export interface Contact {
  id: string;
  username: string;
  publicKey: string;
  exchangeKey: string;
  displayName?: string;
  addedAt: number;
  verified?: boolean;
  verifiedAt?: number;
  isHidden?: boolean;
}

/**
 * Сохраняет список контактов
 */
export async function saveContacts(
  contacts: Contact[],
  masterKey: Uint8Array,
): Promise<void> {
  const data = JSON.stringify(contacts);
  const encrypted = encryptWithKey(data, masterKey);
  await set(STORAGE_KEYS.CONTACTS, encrypted);
}

/**
 * Загружает список контактов
 */
export async function loadContacts(masterKey: Uint8Array): Promise<Contact[]> {
  const encrypted = await get<EncryptedData>(STORAGE_KEYS.CONTACTS);

  if (!encrypted) {
    return [];
  }

  const decrypted = await decryptFromStorage(encrypted, masterKey);

  if (!decrypted) {
    return [];
  }

  try {
    const parsed = JSON.parse(decrypted) as unknown;
    return Array.isArray(parsed) ? (parsed as Contact[]) : [];
  } catch {
    await del(STORAGE_KEYS.CONTACTS);
    return [];
  }
}

// ==================== Chats ====================

export async function saveChats(chats: Chat[], masterKey: Uint8Array): Promise<void> {
  const data = JSON.stringify(chats);
  const encrypted = encryptWithKey(data, masterKey);
  await set(STORAGE_KEYS.CHATS, encrypted);
}

export async function loadChats(masterKey: Uint8Array): Promise<Chat[]> {
  const encrypted = await get<EncryptedData>(STORAGE_KEYS.CHATS);

  if (!encrypted) {
    return [];
  }

  const decrypted = await decryptFromStorage(encrypted, masterKey);

  if (!decrypted) {
    return [];
  }

  try {
    const parsed = JSON.parse(decrypted) as unknown;
    return Array.isArray(parsed) ? (parsed as Chat[]) : [];
  } catch {
    await del(STORAGE_KEYS.CHATS);
    return [];
  }
}

// ==================== Group Messages ====================

export async function saveGroupMessages(
  messagesByGroup: Record<string, Message[]>,
  masterKey: Uint8Array,
): Promise<void> {
  const data = JSON.stringify(messagesByGroup);
  const encrypted = encryptWithKey(data, masterKey);
  await set(STORAGE_KEYS.GROUP_MESSAGES, encrypted);
}

export async function loadGroupMessages(
  masterKey: Uint8Array,
): Promise<Record<string, Message[]>> {
  const encrypted = await get<EncryptedData>(STORAGE_KEYS.GROUP_MESSAGES);

  if (!encrypted) {
    return {};
  }

  const decrypted = await decryptFromStorage(encrypted, masterKey);

  if (!decrypted) {
    return {};
  }

  try {
    const parsed = JSON.parse(decrypted) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, Message[]>;
    }
    return {};
  } catch {
    await del(STORAGE_KEYS.GROUP_MESSAGES);
    return {};
  }
}

// ==================== Prekeys (X3DH) ====================

export interface LocalPreKeyMaterial {
  signedPreKey: KeyPair;
  oneTimePreKeys: KeyPair[];
  updatedAt: number;
  /** Timestamp (ms) when the current SPK was generated. Used for rotation checks. */
  spkCreatedAt?: number;
  /** Previous SPK kept during grace period so pending X3DH sessions can still complete. */
  previousSignedPreKey?: KeyPair;
  /** Timestamp (ms) when the previous SPK was retired. */
  previousSpkRetiredAt?: number;
}

export async function savePreKeyMaterial(
  material: LocalPreKeyMaterial,
  masterKey: Uint8Array,
): Promise<void> {
  const data = JSON.stringify(material);
  const encrypted = encryptWithKey(data, masterKey);
  await set(STORAGE_KEYS.PREKEYS, encrypted);
}

export async function loadPreKeyMaterial(
  masterKey: Uint8Array,
): Promise<LocalPreKeyMaterial | null> {
  const encrypted = await get<EncryptedData>(STORAGE_KEYS.PREKEYS);
  if (!encrypted) return null;

  const decrypted = await decryptFromStorage(encrypted, masterKey);
  if (!decrypted) return null;

  try {
    const parsed = JSON.parse(decrypted) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const material = parsed as LocalPreKeyMaterial;
    if (!material.signedPreKey || !Array.isArray(material.oneTimePreKeys))
      return null;
    return material;
  } catch {
    await del(STORAGE_KEYS.PREKEYS);
    return null;
  }
}

export async function consumeOneTimePreKey(
  publicKey: string,
  masterKey: Uint8Array,
): Promise<KeyPair | null> {
  const material = await loadPreKeyMaterial(masterKey);
  if (!material) return null;

  const index = material.oneTimePreKeys.findIndex(
    (k) => k.publicKey === publicKey,
  );
  if (index < 0) return null;

  const [keyPair] = material.oneTimePreKeys.splice(index, 1) as [KeyPair];
  material.updatedAt = Date.now();
  await savePreKeyMaterial(material, masterKey);
  return keyPair;
}

// ==================== Сессии (Double Ratchet) ====================

export type RatchetSessions = Record<string, SerializedSession>;

export async function saveRatchetSessions(
  sessions: RatchetSessions,
  masterKey: Uint8Array,
): Promise<void> {
  const data = JSON.stringify(sessions);
  const encrypted = encryptWithKey(data, masterKey);
  await set(STORAGE_KEYS.SESSIONS, encrypted);
}

export async function loadRatchetSessions(
  masterKey: Uint8Array,
): Promise<RatchetSessions> {
  const encrypted = await get<EncryptedData>(STORAGE_KEYS.SESSIONS);
  if (!encrypted) return {};

  const decrypted = await decryptFromStorage(encrypted, masterKey);
  if (!decrypted) return {};

  try {
    const parsed = JSON.parse(decrypted) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    return parsed as RatchetSessions;
  } catch {
    await del(STORAGE_KEYS.SESSIONS);
    return {};
  }
}

export async function deleteRatchetSession(
  contactId: string,
  masterKey: Uint8Array,
): Promise<void> {
  const sessions = await loadRatchetSessions(masterKey);
  if (!(contactId in sessions)) return;
  delete sessions[contactId];
  await saveRatchetSessions(sessions, masterKey);
}

// ==================== PIN Brute-force Protection ====================

let failedPinAttempts = 0;
let lockedUntil = 0;
let lockoutLoaded = false;

const LOCKOUT_THRESHOLDS = [
  { attempts: 3, lockSeconds: 15 },
  { attempts: 5, lockSeconds: 60 },
  { attempts: 8, lockSeconds: 300 },
  { attempts: 12, lockSeconds: 900 },
];

/**
 * Load lockout state from IDB (once). Survives page refresh.
 */
async function loadLockoutState(): Promise<void> {
  if (lockoutLoaded) return;
  lockoutLoaded = true;
  try {
    const state = await get<{ attempts: number; lockedUntil: number }>(STORAGE_KEYS.LOCKOUT);
    if (state) {
      failedPinAttempts = state.attempts;
      lockedUntil = state.lockedUntil;
    }
  } catch {
    // ignore
  }
}

async function persistLockoutState(): Promise<void> {
  try {
    await set(STORAGE_KEYS.LOCKOUT, { attempts: failedPinAttempts, lockedUntil });
  } catch {
    // ignore
  }
}

export async function checkPinLockout(): Promise<void> {
  await loadLockoutState();
  if (lockedUntil > Date.now()) {
    const remaining = Math.ceil((lockedUntil - Date.now()) / 1000);
    throw new Error(`Too many attempts. Try again in ${remaining}s`);
  }
}

export async function recordPinFailure(): Promise<void> {
  failedPinAttempts++;
  for (let i = LOCKOUT_THRESHOLDS.length - 1; i >= 0; i--) {
    if (failedPinAttempts >= LOCKOUT_THRESHOLDS[i]!.attempts) {
      lockedUntil = Date.now() + LOCKOUT_THRESHOLDS[i]!.lockSeconds * 1000;
      break;
    }
  }
  await persistLockoutState();
}

export async function resetPinFailures(): Promise<void> {
  failedPinAttempts = 0;
  lockedUntil = 0;
  await persistLockoutState();
}

// ==================== Hidden Chat PIN Hashing ====================

export const HIDDEN_PIN_PBKDF2_ITERATIONS = 600_000; // OWASP 2023 for PBKDF2-SHA256
const LEGACY_HIDDEN_PIN_ITERATIONS = 100_000;

/**
 * Constant-time comparison to prevent timing attacks.
 */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

/**
 * Хеширует PIN скрытых чатов через PBKDF2.
 * Format: "salt:iterations:hash" (base64-encoded salt and hash).
 */
export async function hashHiddenChatPin(pin: string): Promise<string> {
  const salt = nacl.randomBytes(16);
  const key = await deriveKeyFromPinWithIterations(pin, salt, HIDDEN_PIN_PBKDF2_ITERATIONS);
  return `${encodeBase64(salt)}:${HIDDEN_PIN_PBKDF2_ITERATIONS}:${encodeBase64(key)}`;
}

/**
 * Проверяет PIN скрытых чатов против сохранённого хеша.
 * Supports new format "salt:iterations:hash" and legacy "salt:hash" (100k iterations).
 * Uses constant-time comparison to prevent timing attacks.
 */
export async function verifyHiddenChatPin(
  input: string,
  storedHash: string,
): Promise<boolean> {
  const parts = storedHash.split(':');

  let salt: Uint8Array;
  let expectedBytes: Uint8Array;
  let iterations: number;

  if (parts.length === 3) {
    // New format: "salt:iterations:hash"
    salt = decodeBase64(parts[0]!);
    iterations = parseInt(parts[1]!, 10);
    expectedBytes = decodeBase64(parts[2]!);
  } else if (parts.length === 2) {
    // Legacy format: "salt:hash" (100k iterations)
    salt = decodeBase64(parts[0]!);
    iterations = LEGACY_HIDDEN_PIN_ITERATIONS;
    expectedBytes = decodeBase64(parts[1]!);
  } else {
    return false;
  }

  const derivedBytes = await deriveKeyFromPinWithIterations(input, salt, iterations);
  return constantTimeEqual(expectedBytes, derivedBytes);
}

/**
 * Checks if stored PIN hash uses the legacy 2-part format and needs re-hashing.
 */
export function isLegacyHiddenPinHash(storedHash: string): boolean {
  return storedHash.split(':').length === 2;
}

/**
 * Checks whether an encrypted hidden chat PIN exists in storage (without decrypting).
 * Useful for consistency checks where masterKey may not be available yet.
 */
export async function hasHiddenChatPin(): Promise<boolean> {
  const raw = await get<EncryptedDataV2 | string>(STORAGE_KEYS.HIDDEN_CHAT_PIN);
  if (!raw) return false;
  if (typeof raw === "string") return raw.length > 0;
  if (typeof raw === "object" && (raw as EncryptedDataV2).v === 2) return true;
  return false;
}

// ==================== Настройки ====================

export interface Settings {
  username?: string;
  userId?: string;
  theme: "light" | "dark" | "system";
  notifications: boolean;
  selfDestructDefault: number | null;
  hiddenChatsEnabled: boolean;
  /** Hashed hidden chat PIN ("salt:iterations:hash" format, legacy: "salt:hash") — never stored in plaintext */
  hiddenChatPinHash?: string;
}

const DEFAULT_SETTINGS: Settings = {
  theme: "light",
  notifications: true,
  selfDestructDefault: null,
  hiddenChatsEnabled: false,
};

/**
 * Сохраняет настройки.
 * The hiddenChatPinHash is stored separately and encrypted with the master key.
 * Non-sensitive fields (theme, notifications, etc.) stay plaintext so they can be read pre-auth.
 *
 * @param masterKey - Required when hiddenChatPinHash is being saved. Optional otherwise
 *                    (e.g. when only toggling theme before unlock).
 */
export async function saveSettings(
  settings: Settings,
  masterKey?: Uint8Array,
): Promise<void> {
  // Strip hiddenChatPinHash from plaintext store
  const { hiddenChatPinHash, ...safeSettings } = settings;
  await set(STORAGE_KEYS.SETTINGS, safeSettings);

  // Persist hidden chat PIN hash encrypted with masterKey
  if (hiddenChatPinHash !== undefined) {
    if (masterKey) {
      const encrypted = encryptWithKey(hiddenChatPinHash, masterKey);
      await set(STORAGE_KEYS.HIDDEN_CHAT_PIN, encrypted);
    } else {
      // Fallback: caller didn't provide masterKey — store as-is (legacy path).
      // This should not happen in normal flow after the hardening.
      await set(STORAGE_KEYS.HIDDEN_CHAT_PIN, hiddenChatPinHash);
    }
  }
}

/**
 * Загружает настройки.
 * Merges the encrypted hiddenChatPinHash back into the Settings object.
 *
 * @param masterKey - When provided, decrypts the hidden chat PIN hash.
 *                    Without it, hiddenChatPinHash will be omitted (pre-auth reads).
 */
export async function loadSettings(masterKey?: Uint8Array): Promise<Settings> {
  const settings = await get<Settings>(STORAGE_KEYS.SETTINGS);
  const base = settings || DEFAULT_SETTINGS;

  // Merge hidden chat PIN hash from separate encrypted store
  const raw = await get<EncryptedDataV2 | string>(STORAGE_KEYS.HIDDEN_CHAT_PIN);
  if (!raw) return base;

  // Encrypted (v2) format — requires masterKey to decrypt
  if (typeof raw === "object" && (raw as EncryptedDataV2).v === 2) {
    if (!masterKey) {
      // Can't decrypt without masterKey — return base with flag that PIN exists
      return { ...base, hiddenChatsEnabled: base.hiddenChatsEnabled };
    }
    const decrypted = await decryptFromStorage(raw as EncryptedDataV2, masterKey);
    if (decrypted) {
      return { ...base, hiddenChatPinHash: decrypted };
    }
    return base;
  }

  // Legacy plaintext format — migrate to encrypted if masterKey is available
  if (typeof raw === "string" && raw.length > 0) {
    if (masterKey) {
      // Migrate: encrypt and re-save
      const encrypted = encryptWithKey(raw, masterKey);
      await set(STORAGE_KEYS.HIDDEN_CHAT_PIN, encrypted);
    }
    return { ...base, hiddenChatPinHash: raw };
  }

  return base;
}

// ==================== Panic Mode ====================

/**
 * Полностью очищает все данные (Panic Mode)
 */
export async function panicWipe(): Promise<void> {
  await clear();
  if (cachedMasterKey) {
    cachedMasterKey.key.fill(0);
    cachedMasterKey = null;
  }

  // Очищаем также localStorage и sessionStorage
  if (typeof localStorage !== "undefined") {
    localStorage.clear();
  }
  if (typeof sessionStorage !== "undefined") {
    sessionStorage.clear();
  }

  // Очищаем Service Worker caches
  if (typeof caches !== "undefined") {
    try {
      const names = await caches.keys();
      await Promise.all(names.map((n) => caches.delete(n)));
    } catch {
      // caches API may be unavailable in some contexts
    }
  }
}

/**
 * Удаляет только ключи (оставляет настройки)
 */
export async function deleteKeys(): Promise<void> {
  await del(STORAGE_KEYS.IDENTITY);
  await del(STORAGE_KEYS.SESSIONS);
  await del(STORAGE_KEYS.PREKEYS);
  await del(STORAGE_KEYS.PIN_HASH);
  if (cachedMasterKey) {
    cachedMasterKey.key.fill(0);
    cachedMasterKey = null;
  }
}

/**
 * Удаляет контакт и его сессию
 */
export async function deleteContact(
  contactId: string,
  masterKey: Uint8Array,
): Promise<void> {
  const contacts = await loadContacts(masterKey);
  const filtered = contacts.filter((c) => c.id !== contactId);
  await saveContacts(filtered, masterKey);

  await deleteRatchetSession(contactId, masterKey);
}

// ==================== Change PIN ====================

/**
 * Меняет PIN-код: расшифровывает все данные старым ключом, перешифровывает новым.
 * Выбрасывает ошибку если старый PIN неверный.
 * Returns the new master key so the caller can update the store.
 */
export async function changePin(oldPin: string, newPin: string): Promise<Uint8Array> {
  // Brute-force lockout check
  await checkPinLockout();

  // Derive old master key and verify
  const oldMasterKey = await deriveMasterKeyFromPin(oldPin);
  const identity = await loadIdentityKeys(oldMasterKey, oldPin);
  if (!identity) {
    await recordPinFailure();
    throw new Error('Invalid current PIN');
  }

  // PIN verified — reset lockout counter
  await resetPinFailures();

  // Load all encrypted data with old key
  const contacts = await loadContacts(oldMasterKey);
  const chats = await loadChats(oldMasterKey);
  const sessions = await loadRatchetSessions(oldMasterKey);
  const prekeys = await loadPreKeyMaterial(oldMasterKey);
  const settingsData = await loadSettings(oldMasterKey);

  // Save backup of current encrypted data before overwriting.
  // If changePin is interrupted (crash, tab close), the backup allows recovery.
  const backupSnapshot: Record<string, unknown> = {};
  for (const key of [
    STORAGE_KEYS.IDENTITY,
    STORAGE_KEYS.CONTACTS,
    STORAGE_KEYS.CHATS,
    STORAGE_KEYS.SESSIONS,
    STORAGE_KEYS.PREKEYS,
    STORAGE_KEYS.SETTINGS,
    STORAGE_KEYS.PIN_HASH,
    STORAGE_KEYS.ENCRYPTION_SALT,
    STORAGE_KEYS.HIDDEN_CHAT_PIN,
  ] as const) {
    const val = await get(key);
    if (val !== undefined) {
      backupSnapshot[key] = val;
    }
  }
  await set(STORAGE_KEYS.CHANGEPIN_BACKUP, backupSnapshot);

  // Generate a new encryption salt for new master key
  const newSalt = nacl.randomBytes(16);
  const newMasterKey = await deriveKeyFromPin(newPin, newSalt);

  // Store the new salt (used by v2 encrypt/decrypt)
  await set(STORAGE_KEYS.ENCRYPTION_SALT, encodeBase64(newSalt));

  // Update cache with new key (no PIN stored)
  const newPinHash = hashPinForCache(newPin);
  cachedMasterKey = { pinHash: newPinHash, saltB64: encodeBase64(newSalt), key: newMasterKey };

  // Re-save everything with new master key
  await saveIdentityKeys(identity, newMasterKey);
  await savePinHash(newPin);
  await saveContacts(contacts, newMasterKey);
  await saveChats(chats, newMasterKey);
  await saveRatchetSessions(sessions, newMasterKey);
  if (prekeys) {
    await savePreKeyMaterial(prekeys, newMasterKey);
  }

  // Re-encrypt hidden chat PIN hash with new master key (if set)
  if (settingsData.hiddenChatPinHash) {
    await saveSettings(settingsData, newMasterKey);
  }

  // All writes succeeded — remove the backup
  await del(STORAGE_KEYS.CHANGEPIN_BACKUP);

  // Zero out old key material
  oldMasterKey.fill(0);

  return newMasterKey;
}

// ==================== Backup / Restore ====================

/**
 * Экспортирует все чувствительные данные (ключи, контакты, чаты, сессии, prekeys, настройки)
 * в один зашифрованный бэкап. Формат: base64(JSON{v, salt, nonce, ciphertext}).
 *
 * Accepts a masterKey (the current session key) plus a PIN for the backup envelope
 * encryption (backup uses its own salt).
 */
export async function exportEncryptedBackup(
  masterKey: Uint8Array,
  pin: string,
): Promise<string> {
  const payload = {
    identity: await loadIdentityKeys(masterKey),
    contacts: await loadContacts(masterKey),
    chats: await loadChats(masterKey),
    sessions: await loadRatchetSessions(masterKey),
    prekeys: await loadPreKeyMaterial(masterKey),
    settings: await loadSettings(masterKey),
  };

  const salt = nacl.randomBytes(16);
  const key = await deriveKeyFromPinWithIterations(pin, salt, BACKUP_PBKDF2_ITERATIONS);
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const plaintext = stringToUint8Array(JSON.stringify(payload));
  const ciphertext = nacl.secretbox(plaintext, nonce, key);

  const envelope: BackupEnvelopeV2 = {
    v: 2,
    salt: encodeBase64(salt),
    nonce: encodeBase64(nonce),
    ciphertext: encodeBase64(ciphertext),
    iterations: BACKUP_PBKDF2_ITERATIONS,
  };

  return encodeBase64(stringToUint8Array(JSON.stringify(envelope)));
}

/**
 * Импортирует бэкап, созданный exportEncryptedBackup. Полностью очищает локальное хранилище.
 * Returns the new master key derived from the provided PIN so the caller can update the store.
 */
export async function importEncryptedBackup(
  encoded: string,
  pin: string,
): Promise<Uint8Array> {
  let envelope: BackupEnvelope;
  try {
    const json = uint8ArrayToString(decodeBase64(encoded));
    envelope = JSON.parse(json) as BackupEnvelope;
    if (
      (envelope.v !== 1 && envelope.v !== 2) ||
      !envelope.salt ||
      !envelope.nonce ||
      !envelope.ciphertext
    ) {
      throw new Error("Invalid envelope");
    }
  } catch {
    throw new Error("Неверный формат бэкапа");
  }

  const salt = decodeBase64(envelope.salt);
  const nonce = decodeBase64(envelope.nonce);
  const ciphertext = decodeBase64(envelope.ciphertext);

  // v2 envelopes store their iteration count; v1 used the legacy 100k default
  const iterations = envelope.v === 2
    ? (envelope as BackupEnvelopeV2).iterations
    : LEGACY_PBKDF2_ITERATIONS;
  const key = await deriveKeyFromPinWithIterations(pin, salt, iterations);
  const decrypted = nacl.secretbox.open(ciphertext, nonce, key);
  if (!decrypted) {
    throw new Error("Не удалось расшифровать бэкап (PIN?)");
  }

  let payload: {
    identity: IdentityKeys | null;
    contacts: Contact[];
    chats: Chat[];
    sessions: RatchetSessions;
    prekeys: LocalPreKeyMaterial | null;
    settings: Settings;
  };

  try {
    payload = JSON.parse(uint8ArrayToString(decrypted));
  } catch {
    throw new Error("Поврежденное содержимое бэкапа");
  }

  // Полная очистка
  await panicWipe();

  // Derive a fresh master key for storage
  const masterKey = await deriveMasterKeyFromPin(pin);

  // Восстановление
  if (payload.identity) {
    await saveIdentityKeys(payload.identity, masterKey);
  }
  await savePinHash(pin);
  if (payload.prekeys) {
    await savePreKeyMaterial(payload.prekeys, masterKey);
  }
  await saveContacts(payload.contacts || [], masterKey);
  await saveChats(payload.chats || [], masterKey);
  await saveRatchetSessions(payload.sessions || {}, masterKey);
  await saveSettings(payload.settings || DEFAULT_SETTINGS, masterKey);

  return masterKey;
}
