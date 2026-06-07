// POST /api/voice/token
//
// Creates a short-lived (60-second) Deepgram API key so the browser can open
// a WebSocket directly to api.deepgram.com without exposing the server key.
//
// Browsers can't set arbitrary HTTP headers on WebSocket connections, so
// Deepgram supports subprotocol auth:
//   new WebSocket(url, ['token', ephemeralKey])
//
// The browser calls this endpoint on each recording session, connects to
// Deepgram, then the key expires naturally.
//
// Response: { key: string }  — raw Deepgram key, never logged, 60-second TTL

import { createClient } from '@deepgram/sdk';
import { methodGuard, runTwin, HttpError } from '../../lib/twin-api.js';
import { checkRateLimit } from '../../lib/rate-limit.js';

let _dg = null;
function getDG() {
  if (!_dg) {
    if (!process.env.DEEPGRAM_API_KEY) throw new Error('DEEPGRAM_API_KEY is not set');
    _dg = createClient(process.env.DEEPGRAM_API_KEY);
  }
  return _dg;
}

// Cache the project ID so we don't fetch it on every call.
let _projectId = null;
async function getProjectId() {
  if (_projectId) return _projectId;
  const explicit = process.env.DEEPGRAM_PROJECT_ID;
  if (explicit) { _projectId = explicit; return _projectId; }
  const { result, error } = await getDG().manage.getProjects();
  if (error) throw new Error('Deepgram getProjects failed: ' + error.message);
  if (!result?.projects?.length) throw new Error('No Deepgram projects found for this API key');
  _projectId = result.projects[0].project_id;
  return _projectId;
}

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;

  return runTwin(req, res, {
    toolName: 'voice_token',
    fn: async (ctx) => {
      if (!process.env.DEEPGRAM_API_KEY) {
        throw new HttpError(503, { error: 'Voice transcription is not configured on this server.' });
      }

      // Warm path: prime the serverless instance + Deepgram project-id cache on
      // page load so the first real token mint is fast. Mints no key, costs no
      // rate-limit budget — it just removes the cold start from the trust moment.
      if (req.body && req.body.warm) {
        try { await getProjectId(); } catch { /* best-effort */ }
        return { warmed: true };
      }

      // 30 token mints per user per hour — each covers one recording session.
      const rl = await checkRateLimit(`voice_token:${ctx.userId}`, 30);
      if (rl.exceeded) {
        throw new HttpError(429, {
          error: 'Too many voice recordings. Try again in a few minutes.',
          retry_after: rl.retryAfterSeconds,
        });
      }

      const projectId = await getProjectId();

      const { result, error } = await getDG().manage.createProjectKey(projectId, {
        comment:                 `vc-${ctx.userId.slice(0, 8)}-${Date.now()}`,
        scopes:                  ['usage:write'],
        time_to_live_in_seconds: 60,
      });

      if (error || !result?.key) {
        const msg = error?.message || 'no key in response';
        console.error('[voice/token] Deepgram key creation failed:', msg);
        throw new HttpError(502, { error: 'Could not create transcription session. Try again.' });
      }

      return { key: result.key };
    },
  });
}
