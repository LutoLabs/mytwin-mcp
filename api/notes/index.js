// /api/notes
//
//   GET  /api/notes  — list the caller's notes, newest first.
//   POST /api/notes  — save a transcript as a Note.
//
// A Note is a private capture, not a twin item: addNote never embeds the text,
// so a note can never surface in twin search, synthesis, pattern-finding, or
// concept pages. Promotion to the twin is a separate, deliberate act handled by
// the "Add to Twin" flow (→ /api/twin/confirm-store).
//
// Deliberately UNCAPPED. The storage cap guards twin contributions; taking a
// note must never feel as heavy as committing to the twin. The cap is charged
// only when a note is promoted (confirm-store increments it there).

import { methodGuard, runTwin } from '../../lib/twin-api.js';
import { addNote, listNotes } from '../../tools/storage.js';
import { callFastJson } from '../../lib/anthropic.js';

// A short, scannable "gist" title — what the note is about, not its first words.
// Best-effort: a fast Haiku call with a hard timeout; on any failure we return
// null and let addNote fall back to its first-words derivation.
async function gistTitle(transcript) {
  const text = String(transcript || '').trim();
  if (text.split(/\s+/).length < 4) return null;   // too short to bother — derive
  try {
    const result = await Promise.race([
      callFastJson({
        system: 'Write a short, specific title (3 to 7 words) capturing the gist of this voice note. '
              + 'Sentence case, no quotation marks, no trailing punctuation. Return only the title.',
        messages: [{ role: 'user', content: text.slice(0, 4000) }],
        schema: { type: 'object', additionalProperties: false, properties: { title: { type: 'string' } }, required: ['title'] },
        maxTokens: 40,
      }),
      new Promise((resolve) => setTimeout(() => resolve(null), 6000)),
    ]);
    const t = result?.data?.title?.trim();
    return t ? t.replace(/^["'""]|["'""]$/g, '').replace(/[.\s]+$/, '').slice(0, 90) : null;
  } catch { return null; }
}

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET', 'POST'])) return;

  if (req.method === 'GET') {
    return runTwin(req, res, {
      toolName: 'notes_list',
      fn: async (ctx) => ({ notes: await listNotes(ctx, { limit: 200 }) }),
    });
  }

  const { transcript, title, duration_ms } = req.body || {};
  return runTwin(req, res, {
    toolName: 'notes_create',
    fn: async (ctx) => {
      const finalTitle = title || await gistTitle(transcript);   // null → addNote derives
      return { note: await addNote(ctx, { transcript, title: finalTitle, duration_ms }) };
    },
  });
}
