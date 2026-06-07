import { Pinecone } from '@pinecone-database/pinecone';
import { CANON_NAMESPACE } from './canon.js';

let _pc = null;
let _baseIndex = null;

function getPC() {
  if (!_pc) _pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
  return _pc;
}

function getBaseIndex() {
  if (!_baseIndex) _baseIndex = getPC().index(process.env.PINECONE_INDEX_NAME || 'mytwin');
  return _baseIndex;
}

// ── Cold-start retry ──────────────────────────────────────────────────────────
//
// Pinecone serverless indexes hibernate after a period of inactivity; the next
// query from a cold Vercel container can fail with a transient network or 5xx
// error before the index warms up (usually <2s). We wrap every namespace method
// in a single-retry on those transient errors. All Pinecone operations on a
// namespace are idempotent (upsert by id, query, deleteOne by id, deleteAll),
// so the retry is safe.
//
// Retries fire only on shapes that look transient — never on 4xx / auth / not
// found, which never improve on retry.

const RETRY_METHODS = new Set([
  'upsert', 'query', 'fetch', 'update', 'deleteOne', 'deleteMany', 'deleteAll', 'listPaginated',
]);
const RETRY_DELAY_MS = 600;

export function isTransientError(err) {
  if (!err) return false;
  const msg    = String(err.message || err);
  const status = Number(err.status || err.statusCode || 0);
  if (status >= 500 && status <= 599) return true; // 5xx server-side
  if (/\bECONNRESET\b/i.test(msg))   return true;
  if (/\bETIMEDOUT\b/i.test(msg))    return true;
  if (/\bENOTFOUND\b/i.test(msg))    return true;
  if (/\bEAI_AGAIN\b/i.test(msg))    return true; // transient DNS
  if (/fetch failed/i.test(msg))      return true;
  if (/socket hang up/i.test(msg))    return true;
  if (/network|connection/i.test(msg) && !/auth/i.test(msg)) return true;
  if (/timeout/i.test(msg))           return true;
  if (/\b50[234]\b/.test(msg))        return true; // 502/503/504 in message text
  return false;
}

// Every record in a Pinecone upsert MUST carry `knowledge_type` metadata. The
// wrapper enriches missing entries by falling back to `type` (or 'knowledge'
// as a last-resort default) so we never write an unfiltered-able vector.
function ensureKnowledgeType(records) {
  const list = Array.isArray(records) ? records : [records];
  return list.map(r => {
    const md = r?.metadata || {};
    const k  = md.knowledge_type || md.type || 'knowledge';
    return { ...r, metadata: { ...md, knowledge_type: k } };
  });
}

export function wrapWithRetry(target, label) {
  return new Proxy(target, {
    get(t, prop) {
      const v = t[prop];
      if (typeof v !== 'function' || !RETRY_METHODS.has(prop)) return v;
      return async function (...args) {
        // Enrich upsert payloads with knowledge_type before sending to Pinecone.
        const finalArgs = (prop === 'upsert') ? [ensureKnowledgeType(args[0]), ...args.slice(1)] : args;
        try {
          return await v.apply(t, finalArgs);
        } catch (err) {
          if (!isTransientError(err)) throw err;
          console.warn(`[pinecone] ${label}.${prop} failed transiently (${err.message}) — retrying once after ${RETRY_DELAY_MS}ms`);
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
          return v.apply(t, finalArgs);
        }
      };
    },
  });
}

// Per-tenant namespace. Every vector lives under `tenant_${tenantId}`.
// Throws if tenantId is missing — no unscoped Pinecone access is allowed.
// Replaces the legacy `getIndex(userId)` per-user namespace scheme.
// Returns a retry-wrapped namespace so cold-start transients self-heal.
export function getNamespace(tenantId) {
  if (!tenantId) {
    throw new Error('getNamespace: tenantId is required (no unscoped Pinecone access)');
  }
  const ns = getBaseIndex().namespace(`tenant_${tenantId}`);
  return wrapWithRetry(ns, `namespace[tenant_${tenantId}]`);
}

// Shared canon namespace — the Eleusis seed (lib/canon.js). Unlike getNamespace,
// this is a single fixed namespace that every tenant's retrieval also searches;
// it is not derived from a tenant id. Retry-wrapped like the per-tenant ones so
// cold-start transients self-heal. Used by retrieval (read) and the loader (upsert).
export function getCanonNamespace() {
  const ns = getBaseIndex().namespace(CANON_NAMESPACE);
  return wrapWithRetry(ns, `namespace[${CANON_NAMESPACE}]`);
}

// Raw base index — only for migration scripts that need to enumerate or
// delete entire namespaces. Tool code must use getNamespace(ctx.tenantId).
export function getRawIndex() {
  return getBaseIndex();
}

export async function ensureIndex() {
  const name = process.env.PINECONE_INDEX_NAME || 'mytwin';
  const pc = getPC();
  try {
    const { indexes = [] } = await pc.listIndexes();
    if (indexes.some(i => i.name === name)) return { existed: true, created: false };
    await pc.createIndex({
      name,
      dimension: 1536,
      metric: 'cosine',
      spec: { serverless: { cloud: 'aws', region: 'us-east-1' } },
    });
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const desc = await pc.describeIndex(name);
      if (desc.status?.ready) break;
    }
    _baseIndex = null;
    return { existed: false, created: true };
  } catch (err) {
    throw new Error(`Pinecone index error: ${err.message}`);
  }
}
