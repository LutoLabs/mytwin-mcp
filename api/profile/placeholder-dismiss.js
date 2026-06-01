// POST /api/profile/placeholder-dismiss
//   body: { placeholder_id }
//
// Dismisses an empty-state placeholder on the OWNER's personal workspace (the X
// on hover) so the slot never reappears. No knowledge item is created. Owner-only;
// the target is always the requester's own personal workspace.

import { requireAuth } from '../../lib/auth.js';
import { getDB } from '../../lib/supabase.js';
import { getPersonalWorkspace, getPlaceholderDef } from '../../lib/profile.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const session = await requireAuth(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const placeholderId = String(req.body?.placeholder_id || '').trim();
  const def = getPlaceholderDef(placeholderId);
  if (!def) return res.status(400).json({ error: 'Unknown placeholder.' });

  const db = getDB();
  try {
    const workspace = await getPersonalWorkspace(db, session.userId);
    if (!workspace) return res.status(404).json({ error: 'No personal workspace' });
    if (workspace.owner_id !== session.userId) return res.status(403).json({ error: 'Forbidden' });

    await db.from('profile_placeholder_dismissals').upsert(
      { user_id: session.userId, workspace_id: workspace.id, placeholder_id: def.id, source: 'dismissed' },
      { onConflict: 'workspace_id,placeholder_id', ignoreDuplicates: true },
    );

    return res.status(200).json({ dismissed: true, placeholder_id: def.id });
  } catch (err) {
    console.error('[profile/placeholder-dismiss] error:', err?.message);
    return res.status(500).json({ error: 'Could not dismiss. Try again.' });
  }
}
