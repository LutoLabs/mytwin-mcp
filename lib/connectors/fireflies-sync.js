// Fireflies sync driver — backfill + incremental, both cursor-resumable.
//
// No external job queue: a connect/sync call runs batches inline under a soft
// time budget (maxDuration is raised for those routes), persisting the cursor
// between pages so a timeout just resumes next call. The webhook handles the
// live "lands within minutes" path; a daily cron poll is the backstop. Inngest
// is intentionally NOT a dependency here (its keys may be unset) — the critical
// "backfill + auto-land" acceptance must work on Vercel functions alone.
//
// Cursor shape: { skip, backfill_done, since }
//   skip          — backfill pagination offset (resumes mid-backfill)
//   backfill_done — once the initial history is fully pulled
//   since         — ISO of the newest transcript seen; the incremental fromDate

import {
  listTranscripts, getTranscript, normaliseTranscript, FIREFLIES_PAGE_MAX, FirefliesError,
} from './fireflies.js';
import { decryptConnectionSecret, updateConnectionCursor } from '../connections.js';
import { ingestConnectorItem } from '../connector-ingest.js';

const PROVIDER = 'fireflies';
const DEFAULT_DEADLINE_MS = 45_000;   // leave headroom under a 300s maxDuration

const ctxOf = (row) => ({ tenantId: row.tenant_id, userId: row.user_id });

// Single transcript by id — the webhook's path. Idempotent via the native-id map.
export async function ingestOneFireflies(row, externalId) {
  const apiKey = decryptConnectionSecret(row);
  const t = await getTranscript(apiKey, externalId);
  if (!t) return { status: 'skipped-missing', external_id: externalId };
  const norm = normaliseTranscript(t);
  if (!norm) return { status: 'skipped-empty', external_id: externalId };
  const result = await ingestConnectorItem(ctxOf(row), {
    connectionId: row.id, provider: PROVIDER, ...norm,
  });
  // A live arrival advances `since` so the poll backstop won't re-walk it.
  try {
    const cursor = { skip: 0, backfill_done: false, since: null, ...(row.cursor || {}) };
    if (norm.date && (!cursor.since || norm.date > cursor.since)) {
      await updateConnectionCursor(row.tenant_id, row.id, {
        cursor: { ...cursor, since: norm.date },
        lastSyncedAt: new Date().toISOString(), status: 'active', lastError: null,
      });
    }
  } catch { /* cursor bookkeeping is best-effort */ }
  return result;
}

// Backfill (initial history) and/or incremental (new since last sync).
// mode: 'auto' (backfill until done, else incremental) | 'backfill' | 'incremental'.
export async function runFirefliesSync(row, { mode = 'auto', deadlineMs = DEFAULT_DEADLINE_MS } = {}) {
  const apiKey = decryptConnectionSecret(row);
  const ctx = ctxOf(row);
  const cursor = { skip: 0, backfill_done: false, since: null, ...(row.cursor || {}) };
  const started = Date.now();
  const tally = { processed: 0, created: 0, updated: 0, unchanged: 0, linked: 0, errors: 0 };
  let maxDate = cursor.since || null;
  const overBudget = () => (Date.now() - started) >= deadlineMs;

  const ingest = async (meta) => {
    const t = await getTranscript(apiKey, meta.id);
    const norm = normaliseTranscript(t || meta);
    if (!norm) return;
    const r = await ingestConnectorItem(ctx, { connectionId: row.id, provider: PROVIDER, ...norm });
    tally.processed++;
    if (r.status === 'created') tally.created++;
    else if (r.status === 'updated') tally.updated++;
    else if (r.status === 'unchanged') tally.unchanged++;
    else if (r.status === 'linked-existing') tally.linked++;
    if (norm.date && (!maxDate || norm.date > maxDate)) maxDate = norm.date;
  };

  const persist = async (status = 'active', lastError = null) =>
    updateConnectionCursor(row.tenant_id, row.id, {
      cursor: { skip: cursor.skip, backfill_done: cursor.backfill_done, since: maxDate || cursor.since },
      lastSyncedAt: new Date().toISOString(), status, lastError,
    });

  try {
    const doBackfill = mode === 'backfill' || (mode === 'auto' && !cursor.backfill_done);

    if (doBackfill) {
      while (!cursor.backfill_done && !overBudget()) {
        const page = await listTranscripts(apiKey, { limit: FIREFLIES_PAGE_MAX, skip: cursor.skip, mine: true });
        if (!page.length) { cursor.backfill_done = true; break; }
        for (const meta of page) {
          if (overBudget()) break;
          try { await ingest(meta); }
          catch (e) { tally.errors++; if (e instanceof FirefliesError && e.kind === 'rate_limit') throw e; }
          cursor.skip += 1;
        }
        if (page.length < FIREFLIES_PAGE_MAX) cursor.backfill_done = true;
        await persist();   // checkpoint between pages
      }
    } else {
      // Incremental: pull anything on/after the newest we have. The newest item
      // re-appears and dedupes to a no-op, so no gap and no duplicate.
      const fromDate = cursor.since || undefined;
      let skip = 0;
      while (!overBudget()) {
        const page = await listTranscripts(apiKey, { limit: FIREFLIES_PAGE_MAX, skip, mine: true, fromDate });
        if (!page.length) break;
        for (const meta of page) {
          if (overBudget()) break;
          try { await ingest(meta); }
          catch (e) { tally.errors++; if (e instanceof FirefliesError && e.kind === 'rate_limit') throw e; }
          skip += 1;
        }
        if (page.length < FIREFLIES_PAGE_MAX) break;
      }
    }

    await persist();
    return { ok: true, ...tally, backfill_done: cursor.backfill_done, since: maxDate || cursor.since };
  } catch (e) {
    const msg = e?.message || String(e);
    const status = (e instanceof FirefliesError && e.kind === 'auth') ? 'error' : 'active';
    try { await persist(status, msg); } catch { /* best-effort */ }
    return { ok: false, ...tally, backfill_done: cursor.backfill_done, error: msg };
  }
}
