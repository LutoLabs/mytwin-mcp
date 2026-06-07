// POST /api/connectors/sync   { id, mode? }
//
// On-demand "sync now": continue a backfill, or pull anything new since the last
// sync. Idempotent — re-pulled/edited transcripts dedupe via the native-id map.
// mode: 'backfill' (force a backfill pass) | omitted/'auto' (backfill if not
// done, else incremental).

import { methodGuard, runTwin, HttpError } from '../../lib/twin-api.js';
import { getConnection } from '../../lib/connections.js';
import { runFirefliesSync } from '../../lib/connectors/fireflies-sync.js';

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;

  return runTwin(req, res, {
    toolName: 'connector_sync',
    fn: async (ctx) => {
      if (ctx.isAnonymous) throw new HttpError(403, { error: 'Sign in first.' });
      const { id, mode } = req.body || {};
      if (!id) throw new HttpError(400, { error: 'Missing connection id.' });

      const conn = await getConnection(ctx, id);
      if (!conn) throw new HttpError(404, { error: 'Connection not found.' });
      if (conn.status === 'revoked') throw new HttpError(409, { error: 'This connection is disconnected.' });

      if (conn.provider !== 'fireflies') {
        throw new HttpError(400, { error: `Sync isn’t wired for ${conn.provider} yet.` });
      }

      const summary = await runFirefliesSync(conn, { mode: mode === 'backfill' ? 'backfill' : 'auto' });
      const fresh = await getConnection(ctx, id);
      return {
        sync: summary,
        connection: {
          id:             fresh?.id || id,
          status:         fresh?.status || conn.status,
          last_synced_at: fresh?.last_synced_at || null,
          backfill_done:  !!(fresh?.cursor && fresh.cursor.backfill_done),
        },
      };
    },
  });
}
