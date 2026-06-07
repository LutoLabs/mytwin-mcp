// POST /api/connectors/connect   { provider, api_key }
//
// Connect a provider. For Fireflies (api_key): validate the key against the
// Fireflies API, store it encrypted, mint a per-connection webhook secret, then
// run a budgeted backfill synchronously so the user immediately sees meetings
// land. Returns the webhook URL + secret to paste into Fireflies for live sync.

import { randomBytes } from 'node:crypto';
import { methodGuard, runTwin, HttpError } from '../../lib/twin-api.js';
import { getProvider, isLive } from '../../lib/connectors/registry.js';
import { connectorCryptoReady } from '../../lib/connector-crypto.js';
import { upsertConnection, getConnection } from '../../lib/connections.js';
import { validateKey, FirefliesError } from '../../lib/connectors/fireflies.js';
import { runFirefliesSync } from '../../lib/connectors/fireflies-sync.js';

export const config = { maxDuration: 300 };

function webhookUrl(connectionId) {
  const base = (process.env.APP_URL || '').replace(/\/$/, '');
  return `${base}/api/webhooks/fireflies?c=${connectionId}`;
}

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;

  return runTwin(req, res, {
    toolName: 'connector_connect',
    fn: async (ctx) => {
      if (ctx.isAnonymous) throw new HttpError(403, { error: 'Sign in to connect your accounts.' });
      if (!connectorCryptoReady()) {
        throw new HttpError(500, { error: 'Connectors are not configured yet (missing CONNECTOR_ENCRYPTION_KEY).' });
      }

      const { provider, api_key } = req.body || {};
      const meta = getProvider(provider);
      if (!meta) throw new HttpError(400, { error: 'Unknown provider.' });
      if (!isLive(provider)) throw new HttpError(400, { error: `${meta.label} isn’t available to connect yet.` });

      if (provider === 'fireflies') {
        const key = typeof api_key === 'string' ? api_key.trim() : '';
        if (!key) throw new HttpError(400, { error: 'Paste your Fireflies API key to connect.' });

        // Validate (and identify the account) BEFORE storing anything.
        let account;
        try {
          account = await validateKey(key);
        } catch (e) {
          if (e instanceof FirefliesError && e.kind === 'auth') throw new HttpError(400, { error: e.message });
          throw new HttpError(502, { error: `Could not reach Fireflies: ${e.message}` });
        }

        const webhookSecret = randomBytes(24).toString('hex');
        const conn = await upsertConnection(ctx, {
          provider:          'fireflies',
          authType:          'api_key',
          secret:            key,
          webhookSecret,
          externalAccountId: account.userId || null,
          displayName:       account.email || account.name || 'Fireflies',
          cursor:            { skip: 0, backfill_done: false, since: null },
          status:            'active',
        });

        // Budgeted backfill now — best-effort; partial progress is persisted and
        // resumable via Sync / the cron backstop.
        let backfill;
        try { backfill = await runFirefliesSync(conn, { mode: 'auto' }); }
        catch (e) { backfill = { ok: false, error: e?.message || String(e) }; }

        const fresh = await getConnection(ctx, conn.id);
        return {
          connection: {
            id:             conn.id,
            provider:       'fireflies',
            display_name:   fresh?.display_name || conn.display_name,
            status:         fresh?.status || 'active',
            last_synced_at: fresh?.last_synced_at || null,
            backfill_done:  !!(fresh?.cursor && fresh.cursor.backfill_done),
          },
          account: { email: account.email || null, name: account.name || null },
          webhook: {
            url:    webhookUrl(conn.id),
            secret: webhookSecret,   // shown ONCE — the user pastes it into Fireflies
            instructions: 'In Fireflies → Settings → Developer Settings → Webhooks, paste this URL and secret. New meetings will then land in your twin automatically.',
          },
          backfill,
        };
      }

      throw new HttpError(400, { error: 'Unsupported provider.' });
    },
  });
}
