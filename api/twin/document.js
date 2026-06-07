// POST /api/twin/document — commit a document the user has confirmed.
//
// New flow (per the chat-behaviour brief):
//   1. Frontend POSTs to /api/twin/document-propose with the file content
//   2. User reviews the proposal card and clicks "Store as proposed"
//   3. Frontend POSTs HERE with filename + content + the confirmed metadata
//   4. We call addDocument (chunks + embeds + stores via existing tool)
//   5. We generate an in-voice acknowledgement via Sonnet
//   6. Return both the storage result and the ack
//
// No silent storage. No "Stored as 10 chunks" robotic ack.

import { methodGuard, runTwin } from '../../lib/twin-api.js';
import { addDocument } from '../../tools/storage.js';
import { generateAck } from '../../lib/ack.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;

  const { filename, content, notes, title, tags, provenance, type, summary, replace } = req.body || {};
  if (typeof filename !== 'string' || !filename.trim()) {
    return res.status(400).json({ error: 'filename is required' });
  }
  if (typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: 'content is required' });
  }

  // Coerce any invalid/unrecognised type to 'knowledge'. Only 'skill' is
  // a meaningful override — anything else (legacy values, typos, etc.) falls back.
  const VALID_DOC_TYPES = new Set(['knowledge', 'skill']);
  const knowledgeType = typeof type === 'string' && VALID_DOC_TYPES.has(type.toLowerCase())
    ? type.toLowerCase()
    : 'knowledge';

  return runTwin(req, res, {
    toolName: 'add_document',
    cap:      'storage',
    fn: async (ctx) => {
      const result = await addDocument(ctx, {
        filename, content, notes, type: knowledgeType, summary,
        replace: Boolean(replace),
      });
      // Already in the twin and the user didn't ask to replace: return the
      // duplicate signal with no ack. The UI offers "already in your twin,
      // replace it?" — confirming re-POSTs with replace: true.
      if (result.duplicate) return result;
      const ack = await generateAck({
        type:            knowledgeType === 'skill' ? 'skill' : 'document',
        title:           title || filename,
        extractedItems:  result.chunks || 1,
        quality:         'typical',
      });
      return {
        ...result,
        ack,
      };
    },
  });
}
