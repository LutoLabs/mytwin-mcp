// POST /api/webhooks/knowledge-inserted
//
// Supabase webhook handler — fires on every INSERT into the `knowledge` table.
// Translates the Supabase webhook payload into an Inngest event so background
// jobs can react to new knowledge items being stored.
//
// Supabase webhook setup (Database → Webhooks → Create):
//   Table:   knowledge
//   Events:  INSERT
//   URL:     https://myaitwin.lutolearn.com/api/webhooks/knowledge-inserted
//   Method:  POST
//   Headers: Content-Type: application/json
//
// The `record` field in the Supabase payload is the newly inserted row.

import { inngest } from '../../lib/inngest.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { record } = req.body || {};

  // Require tenant context — silently drop malformed payloads.
  if (!record?.tenant_id || !record?.user_id) {
    return res.status(400).json({ error: 'missing record fields' });
  }

  // Document parent-summary rows (chunk_index 0) are a derived rollup of chunks
  // that have ALREADY triggered compilation — they are not new source material,
  // so they must not fire the concept-compile job again. (Pre-030 the column is
  // absent → undefined !== 0 → behaves exactly as before.)
  if (record.chunk_index === 0) {
    return res.status(200).json({ ok: true, skipped: 'document-parent' });
  }

  try {
    await inngest.send({
      name: 'twin/item.stored',
      data: {
        tenant_id: record.tenant_id,
        user_id:   record.user_id,
        item_id:   record.id,
        type:      record.type,
        title:     record.title,
      },
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    // Log but don't expose internal error details to Supabase.
    console.error('[webhook] inngest.send failed:', err?.message);
    return res.status(500).json({ error: 'event delivery failed' });
  }
}
