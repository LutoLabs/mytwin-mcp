// Fireflies provider — GraphQL read client.
//
// Auth: Authorization: Bearer <api_key> (no OAuth, no token refresh — this is
// why Fireflies is the first connector: it proves the whole sync/dedup pattern
// without the OAuth framework). API + webhook contract verified against
// docs.fireflies.ai at build time (2026-06-07):
//   * endpoint   POST https://api.fireflies.ai/graphql
//   * user       { user { user_id name email } }            (validate the key)
//   * transcripts(mine, limit≤50, skip, fromDate, toDate)   (list)
//   * transcript(id)  → sentences { speaker_name text } + summary  (fetch one)
//   * webhook    { meetingId, eventType:"Transcription completed" }, header
//                x-hub-signature = HMAC-SHA256(rawBody, secret)   (see api/webhooks/fireflies.js)

import { stripDashes } from '../text-clean.js';

const FIREFLIES_GRAPHQL = 'https://api.fireflies.ai/graphql';
export const FIREFLIES_PAGE_MAX = 50;   // Fireflies caps `limit` at 50.

// Typed error so routes can map auth failures (bad key) to a 400 and rate
// limits / outages to a retryable signal.
export class FirefliesError extends Error {
  constructor(message, { kind = 'api', status = null } = {}) {
    super(message);
    this.name = 'FirefliesError';
    this.kind = kind;        // 'auth' | 'rate_limit' | 'api' | 'network'
    this.status = status;
    this.userFacing = kind === 'auth';
  }
}

async function ffRequest(apiKey, query, variables = {}) {
  if (!apiKey) throw new FirefliesError('Missing Fireflies API key.', { kind: 'auth' });
  let res;
  try {
    res = await fetch(FIREFLIES_GRAPHQL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
        'Accept':        'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (err) {
    throw new FirefliesError(`Network error reaching Fireflies: ${err.message}`, { kind: 'network' });
  }

  if (res.status === 401 || res.status === 403) {
    throw new FirefliesError('Fireflies rejected the API key. Check it and reconnect.', { kind: 'auth', status: res.status });
  }
  if (res.status === 429) {
    throw new FirefliesError('Fireflies rate limit hit — try again shortly.', { kind: 'rate_limit', status: 429 });
  }

  let body;
  try { body = await res.json(); }
  catch { throw new FirefliesError(`Fireflies returned a non-JSON response (HTTP ${res.status}).`, { kind: 'api', status: res.status }); }

  if (Array.isArray(body?.errors) && body.errors.length) {
    const first = body.errors[0];
    const code  = first?.extensions?.code || '';
    const msg   = first?.message || 'Fireflies GraphQL error.';
    if (/unauthor|invalid.*token|invalid.*key|forbidden/i.test(msg) || code === 'UNAUTHENTICATED') {
      throw new FirefliesError('Fireflies rejected the API key. Check it and reconnect.', { kind: 'auth' });
    }
    if (/rate.?limit|too.?many/i.test(msg) || code === 'too_many_requests') {
      throw new FirefliesError('Fireflies rate limit hit — try again shortly.', { kind: 'rate_limit' });
    }
    throw new FirefliesError(`Fireflies: ${msg}`, { kind: 'api', status: res.status });
  }
  return body?.data || {};
}

// ── Validate the key + identify the account ────────────────────────────────────
export async function validateKey(apiKey) {
  const data = await ffRequest(apiKey, `query { user { user_id name email } }`);
  const u = data?.user || {};
  return {
    userId: u.user_id ? String(u.user_id) : null,
    name:   u.name || null,
    email:  u.email || null,
  };
}

// ── List transcripts (lightweight; ids + metadata only) ────────────────────────
// `mine: true` scopes to the authenticated user's own meetings (the brief's
// default). Newest-first; paginate with `skip`, or window with from/toDate.
export async function listTranscripts(apiKey, { limit = FIREFLIES_PAGE_MAX, skip = 0, fromDate, toDate, mine = true } = {}) {
  const cappedLimit = Math.min(Math.max(1, limit), FIREFLIES_PAGE_MAX);
  const query = `
    query Transcripts($limit: Int, $skip: Int, $mine: Boolean, $fromDate: DateTime, $toDate: DateTime) {
      transcripts(limit: $limit, skip: $skip, mine: $mine, fromDate: $fromDate, toDate: $toDate) {
        id
        title
        date
        host_email
        organizer_email
      }
    }`;
  const vars = { limit: cappedLimit, skip, mine };
  if (fromDate) vars.fromDate = fromDate;
  if (toDate)   vars.toDate   = toDate;
  const data = await ffRequest(apiKey, query, vars);
  return Array.isArray(data?.transcripts) ? data.transcripts : [];
}

// ── Fetch one transcript in full (sentences + summary) ─────────────────────────
export async function getTranscript(apiKey, id) {
  const query = `
    query Transcript($id: String!) {
      transcript(id: $id) {
        id
        title
        date
        duration
        host_email
        organizer_email
        participants
        transcript_url
        summary { overview short_summary action_items keywords }
        sentences { speaker_name text }
      }
    }`;
  const data = await ffRequest(apiKey, query, { id: String(id) });
  return data?.transcript || null;
}

// ── Normalise a Fireflies transcript to text + metadata for ingestion ──────────
function readableDate(date) {
  if (date == null) return null;
  // Fireflies returns `date` as epoch milliseconds; tolerate ISO strings too.
  const ms = typeof date === 'number' ? date : (/^\d+$/.test(String(date)) ? Number(date) : Date.parse(date));
  if (!ms || Number.isNaN(ms)) return typeof date === 'string' ? date : null;
  return new Date(ms).toISOString();
}

export function normaliseTranscript(t) {
  if (!t || !t.id) return null;
  const title = (t.title && String(t.title).trim()) || 'Fireflies meeting';
  const iso = readableDate(t.date);

  const header = [];
  header.push(`# ${title}`);
  const meta = [];
  if (iso) meta.push(iso.slice(0, 10));
  if (t.duration) meta.push(`${Math.round(Number(t.duration))} min`);
  if (meta.length) header.push(meta.join(' · '));
  const people = Array.isArray(t.participants) ? t.participants.filter(Boolean) : [];
  if (people.length) header.push(`Participants: ${people.join(', ')}`);

  const sum = t.summary || {};
  const overview = sum.overview || sum.short_summary || '';
  const actions = Array.isArray(sum.action_items) ? sum.action_items.filter(Boolean)
                : (typeof sum.action_items === 'string' && sum.action_items.trim() ? [sum.action_items.trim()] : []);

  // Collapse consecutive same-speaker sentences into one paragraph for a clean,
  // readable transcript body (better chunking than one line per sentence).
  const lines = [];
  let curSpeaker = null;
  let buf = [];
  const flush = () => {
    if (buf.length) {
      lines.push(curSpeaker ? `${curSpeaker}: ${buf.join(' ')}` : buf.join(' '));
      buf = [];
    }
  };
  for (const s of (Array.isArray(t.sentences) ? t.sentences : [])) {
    const text = (s?.text || '').trim();
    if (!text) continue;
    const sp = s?.speaker_name || null;
    if (sp !== curSpeaker) { flush(); curSpeaker = sp; }
    buf.push(text);
  }
  flush();

  const parts = [header.join('\n')];
  if (overview) parts.push(`## Summary\n${overview.trim()}`);
  if (actions.length) parts.push(`## Action items\n${actions.map(a => `- ${a}`).join('\n')}`);
  if (lines.length) parts.push(`## Transcript\n${lines.join('\n\n')}`);
  const content = parts.join('\n\n').trim();

  const summary = stripDashes(overview || `${title}${iso ? ` (${iso.slice(0, 10)})` : ''}`).slice(0, 500);

  return {
    externalId: String(t.id),
    title,
    content,
    summary,
    externalUpdatedAt: iso,
    date: iso,
  };
}
