// GET /api/connectors
//
// The Connections surface payload: the provider catalog (what can be connected,
// with plan-gating + consent copy) plus this tenant's existing connections with
// status, last-synced, and how many items each has ingested.

import { methodGuard, runTwin } from '../../lib/twin-api.js';
import { PROVIDERS } from '../../lib/connectors/registry.js';
import { listConnections, countMappings } from '../../lib/connections.js';
import { connectorCryptoReady } from '../../lib/connector-crypto.js';

function publicShape(row, itemCount) {
  return {
    id:                  row.id,
    provider:            row.provider,
    auth_type:           row.auth_type,
    display_name:        row.display_name || null,
    status:              row.status,
    last_error:          row.last_error || null,
    last_synced_at:      row.last_synced_at || null,
    backfill_done:       !!(row.cursor && row.cursor.backfill_done),
    item_count:          itemCount,
    created_at:          row.created_at,
  };
}

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;

  return runTwin(req, res, {
    toolName: 'connector_list',
    fn: async (ctx) => {
      const configured = connectorCryptoReady();
      // Connectors are an authenticated-account feature; anonymous twins see the
      // catalog but can't connect (they have no durable account to attach to).
      if (ctx.isAnonymous) {
        return { configured, anonymous: true, providers: PROVIDERS, connections: [] };
      }
      const conns = await listConnections(ctx);
      const connections = await Promise.all(
        conns.map(async (c) => publicShape(c, await countMappings(ctx, c.id)))
      );
      return { configured, anonymous: false, providers: PROVIDERS, connections };
    },
  });
}
