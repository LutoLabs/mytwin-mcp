// Append-only audit log.
//
// Writes are fire-and-forget — we never block the request on the log. If the
// insert fails we log to stderr and move on. Errors during audit must never
// be allowed to take down a user-facing request.
//
// We intentionally do NOT log private content (knowledge bodies, transcripts,
// raw token values, email addresses in clear). We record identifiers,
// outcomes, and short error messages.

import { getDB } from './supabase.js';

// Bounded length for any free-text field — defence against accidentally
// logging large payloads if a caller misuses the helper.
const MAX_TEXT = 1000;

function clip(s) {
  return typeof s === 'string' ? s.slice(0, MAX_TEXT) : s;
}

/**
 * Record an event in the audit log. Never throws — caller never blocks.
 *
 * @param {object} ev
 * @param {string|null} ev.userId
 * @param {string|null} ev.tenantId
 * @param {string} ev.eventType   e.g. 'tool_call' | 'magic_link_requested' |
 *                                'magic_link_verified' | 'token_minted' |
 *                                'token_regenerated' | 'account_deletion_started' |
 *                                'account_deletion_completed'
 * @param {string} [ev.toolName]  for event_type='tool_call'
 * @param {string} [ev.itemId]    knowledge_id (etc) touched, if any
 * @param {boolean} [ev.success=true]
 * @param {string} [ev.errorType] short tag, e.g. 'UserError' | 'RateLimit'
 * @param {string} [ev.errorMsg]  short message (clipped to 1000 chars)
 * @param {object} [ev.context]   small JSON blob for extra metadata
 */
export function logAudit(ev) {
  try {
    const db = getDB();
    const row = {
      user_id:    ev.userId    || null,
      tenant_id:  ev.tenantId  || null,
      event_type: ev.eventType,
      tool_name:  ev.toolName  || null,
      item_id:    ev.itemId    || null,
      success:    ev.success !== false,
      error_type: ev.errorType ? clip(ev.errorType) : null,
      error_msg:  ev.errorMsg  ? clip(ev.errorMsg)  : null,
      context:    ev.context   || null,
    };
    // Fire and forget by default — callers don't await. But the returned promise
    // (which never rejects) lets a caller `await logAudit(...)` when the event
    // MUST flush before a serverless function freezes after responding.
    return db.from('audit_log').insert(row).then(
      () => {},
      (err) => console.error('[audit] insert failed:', err?.message),
    );
  } catch (err) {
    console.error('[audit] threw:', err?.message);
    return Promise.resolve();
  }
}
