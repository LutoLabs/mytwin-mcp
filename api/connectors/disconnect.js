// POST /api/connectors/disconnect   { id }
//
// Disconnect a connection: delete the row. That destroys the encrypted
// credential (revokes our copy of the token/key) and cascade-deletes the
// connection_sources map — so no further webhook or poll can ingest for it.
// Already-ingested documents are left in place (they're the user's now); the
// user can delete them from the Library if they want.
//
// Note: for an API-key provider (Fireflies) there is no remote revoke endpoint —
// deleting our stored key stops ingestion. For OAuth providers (Fathom/Zoom),
// this is where a provider-side token revocation call will be added.

import { methodGuard, runTwin, HttpError } from '../../lib/twin-api.js';
import { getConnection, deleteConnection } from '../../lib/connections.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;

  return runTwin(req, res, {
    toolName: 'connector_disconnect',
    fn: async (ctx) => {
      if (ctx.isAnonymous) throw new HttpError(403, { error: 'Sign in first.' });
      const { id } = req.body || {};
      if (!id) throw new HttpError(400, { error: 'Missing connection id.' });

      const conn = await getConnection(ctx, id);
      if (!conn) throw new HttpError(404, { error: 'Connection not found.' });

      await deleteConnection(ctx, id);
      return { ok: true, disconnected: id, provider: conn.provider };
    },
  });
}
