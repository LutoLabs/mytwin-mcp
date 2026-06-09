// POST /api/twin/compile-concepts
//
// Triggers a full concept-page compilation pass for the authenticated tenant
// and AWAITS it, so the caller (the Wiki "Compile now" button) sees a real
// outcome. Background recompilation still happens automatically via the
// Inngest job on every store; this endpoint is the on-demand, observable path.
//
// No request body required — tenant is resolved from the auth token.
// Returns { ok: true, clusters, pagesWritten, failures } on success, or
// { ok: false, error } when compilation failed (so the UI can surface it).

import { methodGuard, runTwin } from '../../lib/twin-api.js';
import { compileConceptsForTenant } from '../../lib/compile-concepts.js';
import { safeUpstreamError } from '../../lib/errors.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;

  return runTwin(req, res, {
    toolName: 'compile_concepts',
    fn: async (ctx) => {
      try {
        const summary = await compileConceptsForTenant({
          userId:   ctx.userId,
          tenantId: ctx.tenantId,
          mode:     'on-demand',
        });
        return { ok: true, ...summary };
      } catch (err) {
        // compileConceptsForTenant has already written a 'failed' background_log
        // entry. Return a structured body (HTTP 200) with a typed code + safe
        // message so the UI can surface it. Never forward the raw error text.
        const { code, message } = safeUpstreamError(err, 'compile-concepts');
        return { ok: false, code, error: message };
      }
    },
  });
}
