// GET /api/cron/inngest-sync   (Vercel Cron, daily)
//
// Self-healing guard against Inngest sync drift. The recompile-stale job once
// vanished from production for a day because nothing re-registered the function
// set after a deploy, and nothing noticed. This cron closes both gaps:
//
//   1. It PUTs the serve endpoint, which forces the Inngest SDK to re-register
//      the current function manifest with Inngest Cloud. Registration is
//      idempotent, so running it daily can only heal drift, never cause it.
//   2. It writes the outcome to background_log under job_name 'inngest-sync'.
//      If sync ever breaks, the failing rows are the alarm, and the absence of
//      fresh rows is itself detectable. Drift can no longer hide for a day.
//
// This is belt-and-braces with the deploy-time sync in package.json's
// deploy:prod script. The deploy hook syncs immediately; the cron catches any
// deploy that skipped it (or a manual `vercel deploy --prod`).
//
// Auth: Vercel sets `Authorization: Bearer $CRON_SECRET` on cron invocations
// when CRON_SECRET is configured. We honour it when present; the action is
// idempotent and harmless, so we do not hard-fail when it is absent.

import { writeBackgroundLog } from '../../lib/background-log.js';

// A stable tenant bucket for infra-level logs not tied to a user. background_log
// .tenant_id is a uuid column, so this must be a valid uuid (the nil uuid), not a
// label like 'system' — otherwise the insert fails the cast and the heartbeat is
// silently dropped, which is the exact failure mode this cron exists to prevent.
const INFRA_TENANT = '00000000-0000-0000-0000-000000000000';

function authorised(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // not configured — allow (idempotent + harmless)
  const header = String(req.headers.authorization || '');
  return header === `Bearer ${secret}`;
}

function serveUrl(req) {
  const host =
    req.headers['x-forwarded-host'] ||
    req.headers.host ||
    'myaitwin.lutolearn.com';
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}/api/inngest`;
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'GET only' });
  }
  if (!authorised(req)) {
    return res.status(401).json({ error: 'Unauthorised' });
  }

  const url = serveUrl(req);
  let status = 0;
  let body = '';
  let registered = null;

  try {
    const r = await fetch(url, { method: 'PUT' });
    status = r.status;
    body = (await r.text()).slice(0, 2000);
    // The register response includes a function count on success; capture it
    // when present so the heartbeat row records how many functions registered.
    try {
      const json = JSON.parse(body);
      if (typeof json.modified === 'boolean' || json.message) {
        registered = json;
      }
    } catch { /* non-JSON body — keep the raw text */ }

    const ok = status >= 200 && status < 300;
    await writeBackgroundLog(INFRA_TENANT, 'inngest-sync', ok ? 'completed' : 'failed', {
      url,
      status,
      registered,
      body: registered ? undefined : body,
    });

    return res.status(ok ? 200 : 502).json({ ok, url, status, registered });
  } catch (err) {
    await writeBackgroundLog(INFRA_TENANT, 'inngest-sync', 'failed', {
      url,
      error: err?.message || String(err),
    });
    return res.status(502).json({ ok: false, url, error: err?.message || String(err) });
  }
}
