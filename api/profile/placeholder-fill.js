// POST /api/profile/placeholder-fill
//   body: { placeholder_id, content }
//
// Fills an empty-state placeholder on the OWNER's personal workspace: creates a
// real knowledge item (seeded with the placeholder's tags) via the normal
// ingestion path, stamps it with the workspace_id, and records the slot as
// filled so it never reappears. Owner-only; the target is always the requester's
// own personal workspace (Profile v1 is personal-workspace only).

import { requireAuth } from '../../lib/auth.js';
import { getDB } from '../../lib/supabase.js';
import { getPersonalWorkspace, getPlaceholderDef } from '../../lib/profile.js';
import { addKnowledge } from '../../tools/storage.js';

const MAX_CONTENT = 20000;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const session = await requireAuth(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const placeholderId = String(req.body?.placeholder_id || '').trim();
  const content       = String(req.body?.content || '').trim();
  const def = getPlaceholderDef(placeholderId);
  if (!def) return res.status(400).json({ error: 'Unknown placeholder.' });
  if (!content) return res.status(400).json({ error: 'Content is required.' });
  if (content.length > MAX_CONTENT) return res.status(400).json({ error: 'Content is too long.' });

  const db = getDB();
  try {
    const workspace = await getPersonalWorkspace(db, session.userId);
    if (!workspace) return res.status(404).json({ error: 'No personal workspace' });
    if (workspace.owner_id !== session.userId) return res.status(403).json({ error: 'Forbidden' });

    const ctx = { userId: session.userId, tenantId: workspace.tenant_id, isAnonymous: false };
    const item = await addKnowledge(ctx, {
      type:        'knowledge',
      title:       def.label,
      content,
      source_type: 'typed',
      manual_tags: def.tags,
      provenance:  'personal',
    });

    // addKnowledge inserts without a workspace_id; stamp it so the new item
    // lands in this workspace's graph immediately (mirrors the insert backfill).
    await db.from('knowledge').update({ workspace_id: workspace.id }).eq('id', item.id);

    // Record the slot as filled (idempotent — a re-fill just keeps it hidden).
    await db.from('profile_placeholder_dismissals').upsert(
      { user_id: session.userId, workspace_id: workspace.id, placeholder_id: def.id, source: 'filled' },
      { onConflict: 'workspace_id,placeholder_id', ignoreDuplicates: true },
    );

    return res.status(200).json({ filled: true, id: item.id, placeholder_id: def.id });
  } catch (err) {
    console.error('[profile/placeholder-fill] error:', err?.message);
    return res.status(500).json({ error: 'Could not save. Try again.' });
  }
}
