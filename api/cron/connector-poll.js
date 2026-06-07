// GET /api/cron/connector-poll   (Vercel Cron, daily)
//
// Backstop for the webhook. Webhooks deliver new transcripts within minutes, but
// a missed/failed delivery (or a connection still mid-backfill) would otherwise
// stall. This poll walks every active connection and runs an incremental sync
// (or continues an unfinished backfill), idempotently — the native-id map means
// re-pulled items are no-ops.
//
// Auth: Vercel sets `Authorization: Bearer $CRON_SECRET` when configured; we
// honour it when present and allow otherwise (the work is idempotent + safe),
// matching api/cron/inngest-sync.js.

import { getDB } from '../../lib/supabase.js';
import { writeBackgroundLog } from '../../lib/background-log.js';
import { runFirefliesSync } from '../../lib/connectors/fireflies-sync.js';

export const config = { maxDuration: 300 };

const INFRA_TENANT = '00000000-0000-0000-0000-000000000000';
const MAX_CONNECTIONS = 50;       // per run; raise if fleet grows
const PER_CONN_DEADLINE_MS = 20_000;
const OVERALL_DEADLINE_MS = 260_000;

function authorised(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return String(req.headers.authorization || '') === `Bearer ${secret}`;
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'GET only' });
  if (!authorised(req)) return res.status(401).json({ error: 'Unauthorised' });

  const db = getDB();
  const { data: conns, error } = await db
    .from('connections')
    .select('*')
    .eq('provider', 'fireflies')
    .eq('status', 'active')
    .order('last_synced_at', { ascending: true, nullsFirst: true })
    .limit(MAX_CONNECTIONS);

  if (error) {
    await writeBackgroundLog(INFRA_TENANT, 'connector-poll', 'failed', { error: error.message });
    return res.status(502).json({ ok: false, error: error.message });
  }

  const started = Date.now();
  const results = [];
  for (const conn of (conns || [])) {
    if (Date.now() - started >= OVERALL_DEADLINE_MS) break;
    try {
      const summary = await runFirefliesSync(conn, { mode: 'auto', deadlineMs: PER_CONN_DEADLINE_MS });
      results.push({ id: conn.id, ...summary });
    } catch (e) {
      results.push({ id: conn.id, ok: false, error: e?.message || String(e) });
    }
  }

  const processed = results.reduce((n, r) => n + (r.processed || 0), 0);
  await writeBackgroundLog(INFRA_TENANT, 'connector-poll', 'completed', {
    connections: results.length, processed,
  });
  return res.status(200).json({ ok: true, connections: results.length, processed, results });
}
