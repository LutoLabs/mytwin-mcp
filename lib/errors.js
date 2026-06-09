// Errors that are safe to show directly to the user.
// `wrap()` in create-server.js passes UserError.message through unchanged;
// any other thrown error gets mapped to a generic "something went wrong" string.
export class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserError';
    this.userFacing = true;
  }
}

// ── Upstream error mapping ───────────────────────────────────────────────────
// Model and other upstream provider calls (Anthropic, transcription) can fail
// with raw error bodies that must NEVER reach the client: they may contain
// account state, request ids, or the provider's name. We map any such error to
// a small set of typed codes and a short, brand-voice message. The full upstream
// detail is logged server-side (see safeUpstreamError) with the request id.
export const ERROR_CODES = {
  UPSTREAM_UNAVAILABLE: 'upstream_unavailable',
  RATE_LIMITED:         'rate_limited',
  PAYLOAD_TOO_LARGE:    'payload_too_large',
  UNKNOWN:              'unknown',
};

// One short, plain line per code. Brand voice: terse, human, no dashes, no
// jokes. The client mirrors this map (public pages can't import server code),
// so keep the two in sync.
export const ERROR_MESSAGES = {
  [ERROR_CODES.UPSTREAM_UNAVAILABLE]: 'Your twin could not answer just now. Try again in a moment.',
  [ERROR_CODES.RATE_LIMITED]:         'Too many requests at once. Give it a few seconds.',
  [ERROR_CODES.PAYLOAD_TOO_LARGE]:    'That was too much to take in at once. Try a shorter message.',
  [ERROR_CODES.UNKNOWN]:              'Your twin could not answer just now. Try again in a moment.',
};

// Map an arbitrary upstream/SDK error to a typed code + a safe HTTP status.
// Anthropic SDK errors carry a numeric `.status`. We never read the message.
export function classifyUpstreamError(err) {
  const status = typeof err?.status === 'number' ? err.status : null;
  if (status === 429) return { code: ERROR_CODES.RATE_LIMITED,      status: 429 };
  if (status === 413) return { code: ERROR_CODES.PAYLOAD_TOO_LARGE, status: 413 };
  // 400 invalid_request (this is the credit-balance case), 401/403 auth, and
  // any 5xx (incl. 529 overloaded) all read to the user as "try again later".
  if (status === 400 || status === 401 || status === 403 || (status && status >= 500)) {
    return { code: ERROR_CODES.UPSTREAM_UNAVAILABLE, status: 502 };
  }
  return { code: ERROR_CODES.UNKNOWN, status: 502 };
}

// Log the full upstream detail server-side (with request id when present) and
// return only the client-safe { code, status, message }. `where` tags the log.
export function safeUpstreamError(err, where) {
  const { code, status } = classifyUpstreamError(err);
  const requestId = err?.request_id || err?.requestID
    || (err?.headers && (err.headers['request-id'] || err.headers['x-request-id'])) || null;
  console.error(`[${where}] upstream error`, {
    code,
    upstreamStatus: err?.status ?? null,
    requestId,
    message: err?.message,
    stack: err?.stack?.split('\n').slice(0, 4).join(' | '),
  });
  return { code, status, message: ERROR_MESSAGES[code] };
}
