// lib/client-ip.js
//
// Single source for extracting the caller IP from a Vercel serverless request.
// Previously duplicated verbatim in api/anon/init.js and api/auth/claim.js; the
// public-share surface adds a third caller, so it now lives in one place that
// can be hardened (e.g. trust only Vercel's set hop) as the abuse surface grows.
//
// On Vercel, x-real-ip is set by the platform edge to the actual connecting IP
// and a client-supplied header of the same name is overwritten, so it is the
// trustworthy key for rate limiting. x-forwarded-for's first hop is
// client-spoofable upstream (a caller can rotate it to dodge a per-IP limit), so
// it is only a fallback. Still not for any security decision, but good enough to
// make abuse limits hard to bypass.

export function clientIp(req) {
  const real = req.headers['x-real-ip'];
  if (real) {
    const v = String(real).trim();
    if (v) return v;
  }
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const first = String(xff).split(',')[0].trim();
    if (first) return first;
  }
  return req.socket?.remoteAddress || 'unknown';
}
