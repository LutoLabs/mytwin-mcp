// /api/notes/:id
//
//   GET    — read one note (full transcript).
//   PATCH  — rename, edit the transcript, or mark it promoted to the twin
//            (body: { title?, transcript?, promoted_knowledge_id? }).
//   DELETE — delete the note.
//
// Every operation is scoped to the caller (user_id + tenant_id); a note that
// isn't yours reads as 404, never leaks.

import { methodGuard, runTwin, HttpError } from '../../lib/twin-api.js';
import { getNote, updateNote, deleteNote } from '../../tools/storage.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET', 'PATCH', 'DELETE'])) return;

  const id = req.query?.id;
  if (typeof id !== 'string' || !id) {
    return res.status(400).json({ error: 'A note id is required.' });
  }

  if (req.method === 'GET') {
    return runTwin(req, res, {
      toolName: 'notes_get',
      fn: async (ctx) => {
        const note = await getNote(ctx, id);
        if (!note) throw new HttpError(404, { error: 'Note not found.' });
        return { note };
      },
    });
  }

  if (req.method === 'PATCH') {
    const { title, transcript, promoted_knowledge_id } = req.body || {};
    return runTwin(req, res, {
      toolName: 'notes_update',
      fn: async (ctx) => {
        const note = await updateNote(ctx, id, { title, transcript, promoted_knowledge_id });
        if (!note) throw new HttpError(404, { error: 'Note not found.' });
        return { note };
      },
    });
  }

  // DELETE
  return runTwin(req, res, {
    toolName: 'notes_delete',
    fn: async (ctx) => {
      const result = await deleteNote(ctx, id);
      if (!result.deleted) throw new HttpError(404, { error: 'Note not found.' });
      return { deleted: true };
    },
  });
}
