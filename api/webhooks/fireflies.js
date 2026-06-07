// POST /api/webhooks/fireflies?c=<connectionId>
//
// Fireflies "Transcription completed" webhook → live ingest. This is the
// "lands automatically each time they record" half of the connector.
//
// Routing: the connection id rides in the ?c= query param (the user pastes this
// exact URL into Fireflies). We load that connection, verify the HMAC with ITS
// per-connection secret, then fetch + ingest the one transcript idempotently.
//
// Signature: Fireflies sends `x-hub-signature` = HMAC-SHA256 of the raw request
// body, keyed by the shared webhook secret. We MUST verify over the raw bytes,
// so the body parser is disabled and we buffer the stream ourselves. We accept
// the digest as hex or base64, with or without a `sha256=` prefix, since the
// docs don't pin the encoding.
//
// Payload: { meetingId, eventType: "Transcription completed", clientReferenceId }

import { createHmac, timingSafeEqual } from 'node:crypto';
import { getConnectionForWebhook, decryptConnectionWebhookSecret } from '../../lib/connections.js';
import { ingestOneFireflies } from '../../lib/connectors/fireflies-sync.js';

export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

function getConnectionId(req) {
  if (req.query && (req.query.c || req.query.connection)) return req.query.c || req.query.connection;
  try {
    const u = new URL(req.url, 'http://localhost');
    return u.searchParams.get('c') || u.searchParams.get('connection');
  } catch { return null; }
}

function safeEq(a, b) {
  try {
    const ab = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    return ab.length === bb.length && timingSafeEqual(ab, bb);
  } catch { return false; }
}

function verifySignature(rawBody, header, secret) {
  if (!header || !secret) return false;
  const provided = String(header).replace(/^sha256=/i, '').trim();
  const hex = createHmac('sha256', secret).update(rawBody).digest('hex');
  const b64 = createHmac('sha256', secret).update(rawBody).digest('base64');
  return safeEq(provided, hex) || safeEq(provided, b64);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const connectionId = getConnectionId(req);

  let raw;
  try { raw = await readRawBody(req); }
  catch { raw = Buffer.alloc(0); }
  // Defence against a runtime that parsed the body despite bodyParser:false —
  // the stream is then drained, so reconstruct the compact JSON Fireflies signs.
  if ((!raw || !raw.length) && req.body != null) {
    raw = Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body), 'utf8');
  }
  if (!raw || !raw.length) return res.status(400).json({ error: 'empty body' });

  let payload;
  try { payload = JSON.parse(raw.toString('utf8') || '{}'); }
  catch { return res.status(400).json({ error: 'invalid json' }); }

  const conn = await getConnectionForWebhook(connectionId).catch(() => null);
  if (!conn || conn.provider !== 'fireflies' || conn.status === 'revoked') {
    return res.status(404).json({ error: 'unknown connection' });
  }

  let secret = null;
  try { secret = decryptConnectionWebhookSecret(conn); } catch { /* missing/garbled → fail closed below */ }

  const sigHeader = req.headers['x-hub-signature'] || req.headers['x-hub-signature-256'];
  if (!verifySignature(raw, sigHeader, secret)) {
    return res.status(401).json({ error: 'invalid signature' });
  }

  const meetingId = payload.meetingId || payload.meeting_id || payload.transcriptId || payload.transcript_id;
  if (!meetingId) return res.status(200).json({ ok: true, skipped: 'no meetingId' });

  try {
    const result = await ingestOneFireflies(conn, meetingId);
    return res.status(200).json({ ok: true, result });
  } catch (err) {
    // 200 so Fireflies doesn't retry-storm on our transient errors; the daily
    // poll backstop (incremental, fromDate) re-pulls anything we dropped here.
    console.error('[webhook/fireflies] ingest failed:', err?.message);
    return res.status(200).json({ ok: false, error: err?.message || 'ingest failed' });
  }
}
