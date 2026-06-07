// POST /api/auth/claim — start the anonymous-to-real claim flow.
//
// Called from the "Save your twin" modal on /twin when an anonymous user
// wants to save their session. Sends a magic link that, on verify, either
// upgrades the placeholder user (new email) or merges the anon data into
// an existing account (known email).
//
// Body:   { email: string, tenant_id: string }
//
// Response: { sent: true } — same regardless of outcome (timing + enum safety).
//
// Security:
//   - Per-IP rate limit: 3 claim attempts per hour.
//   - Min response time: 800 ms (prevents timing attacks).
//   - Response never reveals whether the email is registered (item 13).
//   - The claim_tenant_id stored in magic_tokens is validated at verify time
//     (server checks tenant exists + is_anonymous, not just trusts the claim).

import { Resend }          from 'resend';
import { createMagicToken } from '../../lib/auth.js';
import { checkRateLimit }   from '../../lib/rate-limit.js';
import { logAudit }         from '../../lib/audit.js';
import { getDB }            from '../../lib/supabase.js';

const CLAIM_PER_HOUR  = 3;
const MIN_RESPONSE_MS = 800;

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function isValidEmail(str) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str);
}

export default async function handler(req, res) {
  const APP_URL = process.env.APP_URL || 'https://myaitwin.lutolearn.com';
  const FROM    = process.env.RESEND_FROM || 'team@lutolearn.com';
  const resend  = new Resend(process.env.RESEND_API_KEY);

  res.setHeader('Access-Control-Allow-Origin',  APP_URL);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST')    { res.status(405).json({ error: 'Method not allowed' }); return; }

  const startedAt = Date.now();

  try {
    const { email, tenant_id, referrer } = req.body || {};
    const cleanReferrer = typeof referrer === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(referrer) ? referrer : null;

    if (email && isValidEmail(email) && tenant_id && typeof tenant_id === 'string') {
      const cleaned = email.toLowerCase().trim();

      const ip = clientIp(req);
      const rl = await checkRateLimit(`claim:${ip}`, CLAIM_PER_HOUR);

      if (!rl.exceeded) {
        let sendOk = true;
        try {
          // Check whether this is a new or returning email — used only to
          // personalise the subject line. The claim_tenant_id is included
          // regardless; verify.js sorts out which path to take.
          const db = getDB();
          const { data: existingUser } = await db
            .from('users')
            .select('id')
            .eq('email', cleaned)
            .maybeSingle();

          const token    = await createMagicToken(cleaned, null, tenant_id, cleanReferrer);
          const magicUrl = `${APP_URL}/api/auth/verify?token=${token}`;

          await resend.emails.send({
            from:    FROM,
            to:      email,
            subject: existingUser ? 'Sign in to MyAITwin' : 'Save your Twin — MyAITwin',
            html:    buildClaimEmailHtml(magicUrl, !!existingUser),
            text:    buildClaimEmailText(magicUrl),
          });
        } catch (err) {
          sendOk = false;
          console.error('[auth/claim] internal error:', err?.message);
        }

        logAudit({
          eventType: 'claim_magic_link_requested',
          success:   sendOk,
          errorType: sendOk ? null : 'EmailSendFailed',
        });
      } else {
        console.warn(`[auth/claim] rate-limited IP ${ip.slice(0, 8)}… — dropped silently`);
        logAudit({
          eventType: 'claim_magic_link_requested',
          success:   false,
          errorType: 'RateLimited',
        });
      }
    }
  } finally {
    const elapsed = Date.now() - startedAt;
    if (elapsed < MIN_RESPONSE_MS) {
      await new Promise(r => setTimeout(r, MIN_RESPONSE_MS - elapsed));
    }
    res.status(200).json({ sent: true });
  }
}

function buildClaimEmailHtml(url, isReturning) {
  const headline = isReturning ? 'Welcome back.' : 'Your twin is waiting.';
  const body     = isReturning
    ? 'Click below to sign in. Your captures will merge with your existing account.'
    : 'Click below to save your twin permanently. Everything you captured comes with you.';

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#FDFCFA;margin:0;padding:0">

  <div style="height:6px;background:#FFE34A;width:100%"></div>

  <div style="max-width:520px;margin:0 auto;padding:48px 32px 56px">

    <div style="display:flex;align-items:center;gap:10px;margin-bottom:48px">
      <div style="width:24px;height:24px;background:#FFE34A;border:1.5px solid #0F0E0D;border-radius:4px;box-shadow:2px 2px 0 #0F0E0D;flex-shrink:0"></div>
      <span style="font-size:15px;font-weight:600;color:#0F0E0D;letter-spacing:-0.01em">MyAITwin</span>
      <span style="font-size:10px;color:#857C6E;letter-spacing:0.1em;text-transform:uppercase;font-family:monospace;margin-left:2px">by Luto</span>
    </div>

    <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:28px;font-weight:400;color:#0F0E0D;margin:0 0 16px;line-height:1.15;letter-spacing:-0.02em">
      ${headline}
    </h1>
    <p style="font-size:15px;color:#3A352E;line-height:1.6;margin:0 0 36px">
      ${body} This link expires in 15 minutes and works once.
    </p>

    <a href="${url}" style="display:inline-block;background:#FFE34A;color:#0F0E0D;text-decoration:none;padding:14px 28px;border-radius:8px;border:1.5px solid #0F0E0D;box-shadow:3px 3px 0 #0F0E0D;font-size:15px;font-weight:600;letter-spacing:-0.01em">
      Open my Twin &rarr;
    </a>

    <div style="height:1px;background:#E8E2D4;margin:48px 0 32px"></div>

    <p style="font-size:12px;color:#857C6E;line-height:1.7;margin:0;font-family:monospace;letter-spacing:0.02em">
      myaitwin.lutolearn.com &nbsp;&middot;&nbsp; No password needed &nbsp;&middot;&nbsp; Link expires in 15 minutes<br>
      If you did not request this, ignore this email. Nothing will happen.
    </p>
    <p style="font-size:11px;color:#B6AD9C;margin:16px 0 0;font-family:monospace;word-break:break-all">
      ${url}
    </p>

  </div>
</body>
</html>`;
}

function buildClaimEmailText(url) {
  return `MyAITwin by Luto\n\nYour twin is waiting.\n\nClick the link below to save your twin permanently. Everything you captured comes with you. This link expires in 15 minutes and works once.\n\n${url}\n\nIf you did not request this, ignore this email. Nothing will happen.`;
}
