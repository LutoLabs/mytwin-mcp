// Reversible encryption for outbound connector credentials.
//
// The inbound oauth_* tables store sha256 HASHES — correct there, because the
// twin only ever VERIFIES a presented token. Connectors are the opposite: the
// twin must REPLAY the stored API key / OAuth token to the provider on every
// pull, so the secret has to be recoverable. Hashing is useless here.
//
// Design decision (the "connector decision" the brief leaves open): app-key
// envelope encryption with AES-256-GCM via node's built-in crypto. Chosen over
// Supabase Vault because it needs no extra DB-side setup, is portable across the
// Vercel serverless runtime, and keeps the key out of the database entirely
// (defence-in-depth: a DB leak yields only ciphertext). The interface
// (encryptSecret / decryptSecret) is deliberately small so a future swap to
// Vault/KMS is a one-file change.
//
// Key: CONNECTOR_ENCRYPTION_KEY env var. Accepts a 32-byte key as base64 or hex;
// any other non-empty value is stretched to 32 bytes via sha256 (so a strong
// passphrase also works). Generate a good one with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
//
// Ciphertext format (self-describing, versioned for future algorithm swaps):
//   v1.<base64( iv[12] || authTag[16] || ciphertext )>

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const IV_LEN  = 12;   // 96-bit nonce — the GCM standard
const TAG_LEN = 16;   // 128-bit auth tag

let cachedKey = null;

function resolveKey() {
  if (cachedKey) return cachedKey;
  const raw = process.env.CONNECTOR_ENCRYPTION_KEY;
  if (!raw || !raw.trim()) {
    throw new Error(
      'CONNECTOR_ENCRYPTION_KEY is not set. Connectors cannot store credentials ' +
      'without it. Generate one: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'
    );
  }
  const s = raw.trim();
  let key = null;
  // 64 hex chars → 32 bytes.
  if (/^[0-9a-fA-F]{64}$/.test(s)) {
    key = Buffer.from(s, 'hex');
  } else {
    // Try base64 → exactly 32 bytes.
    try {
      const b = Buffer.from(s, 'base64');
      if (b.length === 32) key = b;
    } catch { /* fall through */ }
  }
  // Anything else: stretch to 32 bytes deterministically.
  if (!key) key = createHash('sha256').update(s, 'utf8').digest();
  cachedKey = key;
  return key;
}

// True when a usable key is configured — lets callers degrade gracefully
// (e.g. surface "connectors are not configured" instead of a 500).
export function connectorCryptoReady() {
  try { resolveKey(); return true; } catch { return false; }
}

/**
 * Encrypt a secret string. Returns the versioned, self-describing ciphertext
 * string to store in the DB, or null for null/empty input (so optional fields
 * like a refresh token round-trip cleanly).
 */
export function encryptSecret(plaintext) {
  if (plaintext == null || plaintext === '') return null;
  const key = resolveKey();
  const iv  = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}.${Buffer.concat([iv, tag, enc]).toString('base64')}`;
}

/**
 * Decrypt a ciphertext produced by encryptSecret. Returns null for null/empty
 * input. Throws on a malformed payload or an authentication-tag mismatch
 * (tampering / wrong key) — callers should treat that as a hard failure.
 */
export function decryptSecret(ciphertext) {
  if (ciphertext == null || ciphertext === '') return null;
  const s = String(ciphertext);
  const dot = s.indexOf('.');
  const version = dot === -1 ? '' : s.slice(0, dot);
  if (version !== VERSION) {
    throw new Error(`Unsupported connector ciphertext version: ${version || '(none)'}`);
  }
  const buf = Buffer.from(s.slice(dot + 1), 'base64');
  if (buf.length < IV_LEN + TAG_LEN + 1) throw new Error('Connector ciphertext is truncated.');
  const iv  = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = buf.subarray(IV_LEN + TAG_LEN);
  const key = resolveKey();
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}
