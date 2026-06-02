// POST   /api/library/upvote   { knowledge_id }  → cast a vote (idempotent)
// DELETE /api/library/upvote   { knowledge_id }  → remove this user's vote
//
// Returns { knowledge_id, count, voted } so the UI can update the button and
// count in place. A vote is a toggle; the composite primary key on
// upvotes(user_id, knowledge_id) makes a second POST a no-op.
//
// Identity is ALWAYS server-derived (ctx.userId from the session) and never
// read from the request body — the body carries only the object of the vote
// (which item), never the subject (who voted).
//
// The item must belong to the caller (user_id + tenant_id check), which both
// validates the id and prevents voting on items in other tenants.

import { methodGuard, runTwin, HttpError } from '../../lib/twin-api.js';
import { getDB } from '../../lib/supabase.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST', 'DELETE'])) return;

  return runTwin(req, res, {
    toolName: 'library_upvote',
    fn: async (ctx) => {
      const knowledgeId =
        (req.body && req.body.knowledge_id) || req.query.knowledge_id;
      if (!knowledgeId) throw new HttpError(400, { error: 'knowledge_id is required' });

      const db = getDB();

      // Item must exist and belong to this user in their tenant.
      const { data: item, error: itemErr } = await db
        .from('knowledge')
        .select('id')
        .eq('id', knowledgeId)
        .eq('user_id', ctx.userId)
        .eq('tenant_id', ctx.tenantId)
        .maybeSingle();
      if (itemErr) throw new Error(itemErr.message);
      if (!item)   throw new HttpError(404, { error: 'Item not found' });

      if (req.method === 'POST') {
        const { error } = await db
          .from('upvotes')
          .upsert(
            { user_id: ctx.userId, knowledge_id: knowledgeId },
            { onConflict: 'user_id,knowledge_id', ignoreDuplicates: true },
          );
        if (error) throw new Error(error.message);
      } else {
        const { error } = await db
          .from('upvotes')
          .delete()
          .eq('user_id', ctx.userId)
          .eq('knowledge_id', knowledgeId);
        if (error) throw new Error(error.message);
      }

      // Fresh total + this viewer's state, so the client never guesses.
      const [countRes, mineRes] = await Promise.all([
        db.from('upvotes')
          .select('user_id', { count: 'exact', head: true })
          .eq('knowledge_id', knowledgeId),
        db.from('upvotes')
          .select('user_id')
          .eq('knowledge_id', knowledgeId)
          .eq('user_id', ctx.userId)
          .maybeSingle(),
      ]);
      if (countRes.error) throw new Error(countRes.error.message);
      if (mineRes.error)  throw new Error(mineRes.error.message);

      return {
        knowledge_id: knowledgeId,
        count:        countRes.count ?? 0,
        voted:        !!mineRes.data,
      };
    },
  });
}
