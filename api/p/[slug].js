// GET /p/:slug  (rewritten here from /api/p/[slug]) — the public, logged-out
// storefront for ONE shared artifact. This is the first impression for a
// non-user, so it is on brand and premium, and it leaks nothing beyond the one
// artifact: it renders strictly the sanitized payload from resolvePublicArtifact
// (the Phase 0 safe read), which resolves the owner from the link row and never
// trusts the caller. Unknown / revoked / expired / private all render the same
// branded not-found page (no enumeration).
//
// Unauthenticated, so it is rate-limited by IP. Open Graph + meta tags make the
// link preview well when forwarded, without exposing any private field. The CTA
// drops the viewer into the anon -> claim signup, carrying the slug as a
// referrer for attribution.

import { createHash } from 'node:crypto';
import { resolvePublicArtifact } from '../../lib/public-links.js';
import { checkRateLimit } from '../../lib/rate-limit.js';
import { clientIp } from '../../lib/client-ip.js';

const PUBLIC_VIEW_PER_HOUR = 240;
const PUBLIC_SLUG_PER_HOUR = 2000; // coarse per-slug cap, independent of caller IP
const APP = (process.env.APP_URL || 'https://myaitwin.lutolearn.com').replace(/\/+$/, '');

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function plain(s, n) {
  const t = String(s == null ? '' : s).replace(/[#*_`>\[\]]/g, '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
}
function paragraphs(s) {
  return String(s || '').split(/\n{2,}/).map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('\n');
}

function ctaLine(p) {
  const named = p.owner_name && p.owner_name !== 'this twin';
  const who = named ? `${esc(p.owner_name)}'s` : 'an AI';
  if (p.type === 'concept') {
    const n = p.source_count || 0;
    const from = n ? ` from ${n} ${named ? `of ${esc(p.owner_name)}'s own notes` : (n === 1 ? 'note' : 'notes')}` : '';
    return `This page was compiled by ${named ? `${esc(p.owner_name)}'s` : 'an AI'} twin${from}. Build yours in two minutes.`;
  }
  if (p.type === 'answer') return `${named ? `${esc(p.owner_name)}'s` : 'An AI'} twin wrote this. Yours can too.`;
  return `${named ? `${esc(p.owner_name)}'s` : 'An AI'} twin keeps this. Build your own in two minutes.`;
}

function kicker(p) {
  if (p.type === 'concept') return p.flavour === 'skills' ? 'A skill, compiled by a twin' : 'Compiled by a twin';
  if (p.type === 'answer') return 'A twin wrote this';
  return 'From a twin';
}

const SHELL_HEAD = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,400;8..60,600;8..60,700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{--ink:#15130f;--paper:#faf7f1;--card:#fff;--line:#e8e2d6;--muted:#6f685c;--accent:#2d7d4d;--accent-deep:#1f5d39;}
*{box-sizing:border-box;}
body{margin:0;background:var(--paper);color:var(--ink);font-family:'Inter',system-ui,sans-serif;line-height:1.6;-webkit-font-smoothing:antialiased;}
.wrap{max-width:680px;margin:0 auto;padding:0 22px;}
.top{display:flex;align-items:center;justify-content:space-between;padding:20px 0;border-bottom:1px solid var(--line);}
.brand{font-family:'Source Serif 4',Georgia,serif;font-weight:700;font-size:19px;letter-spacing:-.01em;color:var(--ink);text-decoration:none;}
.brand .dot{color:var(--accent);}
.top a.cta-mini{font:600 12px/1 'Inter',sans-serif;color:var(--accent-deep);text-decoration:none;border:1.5px solid var(--line);padding:8px 14px;border-radius:999px;}
.top a.cta-mini:hover{border-color:var(--accent);}
.kicker{font:600 11px/1 'Inter',sans-serif;letter-spacing:.10em;text-transform:uppercase;color:var(--accent-deep);margin:44px 0 14px;}
h1.title{font-family:'Source Serif 4',Georgia,serif;font-weight:700;font-size:40px;line-height:1.12;letter-spacing:-.02em;margin:0 0 14px;}
.standfirst{font-family:'Source Serif 4',Georgia,serif;font-size:21px;line-height:1.45;color:#37322a;margin:0 0 18px;}
.meta{font:500 13px/1 'Inter',sans-serif;color:var(--muted);padding-bottom:26px;border-bottom:1px solid var(--line);margin-bottom:30px;}
.content{font-size:17.5px;line-height:1.72;}
.content h2,.content h3{font-family:'Source Serif 4',Georgia,serif;line-height:1.25;margin:1.7em 0 .5em;}
.content h2{font-size:25px;}.content h3{font-size:20px;}
.content p{margin:0 0 1.1em;}
.content ul,.content ol{margin:0 0 1.1em;padding-left:1.3em;}
.content li{margin:.3em 0;}
.content blockquote{margin:1.2em 0;padding:2px 0 2px 18px;border-left:3px solid var(--accent);color:#4a4439;font-style:italic;}
.content code{background:#f1ece1;padding:.1em .35em;border-radius:5px;font-size:.9em;}
.content pre{background:#15130f;color:#f7f4ee;padding:16px;border-radius:10px;overflow:auto;}
.content a{color:var(--accent-deep);}
.cta{margin:48px 0 60px;background:var(--ink);color:#faf7f1;border-radius:18px;padding:32px 30px;}
.cta .c-eyebrow{font:600 11px/1 'Inter',sans-serif;letter-spacing:.12em;text-transform:uppercase;color:#9bbfa8;margin:0 0 10px;}
.cta .c-line{font-family:'Source Serif 4',Georgia,serif;font-size:24px;line-height:1.3;margin:0 0 20px;color:#fdfbf6;}
.cta a.go{display:inline-block;background:var(--accent);color:#fff;text-decoration:none;font:600 15px/1 'Inter',sans-serif;padding:14px 26px;border-radius:999px;}
.cta a.go:hover{background:#3a9a61;}
.foot{padding:26px 0 48px;color:var(--muted);font-size:12.5px;border-top:1px solid var(--line);}
.foot a{color:var(--muted);}
.nf{padding:90px 0;text-align:center;}
.nf h1{font-family:'Source Serif 4',Georgia,serif;font-size:30px;margin:0 0 10px;}
.nf p{color:var(--muted);margin:0 0 26px;}
@media(max-width:560px){h1.title{font-size:31px;}.standfirst{font-size:18px;}.content{font-size:16.5px;}}
</style>`;

function notFound(res) {
  const html = `${SHELL_HEAD}<title>Not here · Luto</title><meta name="robots" content="noindex"></head><body>
<div class="wrap"><div class="top"><a class="brand" href="${APP}/twin">Luto<span class="dot">.</span></a>
<a class="cta-mini" href="${APP}/twin">Build your twin</a></div>
<div class="nf"><h1>Nothing here</h1><p>This link is not active. It may have been turned off, or it never existed.</p>
<a class="cta-mini" href="${APP}/twin">See what a twin can do</a></div>
<div class="foot">Luto. Your knowledge, connected.</div></div></body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(404).send(html);
}

function renderArtifact(res, p) {
  // Use the DB-stored slug from the payload, not the request value, so the
  // rendered URLs never depend on an implicit upstream validation of the input.
  const slug = p.slug;
  const url = `${APP}/p/${esc(slug)}`;
  const heading = p.title || (p.type === 'answer' ? 'A note from a twin' : 'Untitled');
  const desc = plain(p.type === 'concept' ? (p.summary || p.content) : p.content, 180);
  const signup = `${APP}/twin?ref=${encodeURIComponent(slug)}`;
  const dateStr = p.updated_at || p.created_at
    ? new Date(p.updated_at || p.created_at).toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' })
    : '';
  const metaBits = [];
  if (p.type === 'concept') { metaBits.push(`${p.source_count || 0} source ${p.source_count === 1 ? 'note' : 'notes'}`); }
  if (dateStr) metaBits.push(dateStr);

  // Raw markdown for progressive client-side rendering; escaped paragraphs are
  // the no-JS / crawler fallback (replaced by marked on load).
  const rawContent = p.type === 'concept' || p.type === 'item' || p.type === 'answer' ? (p.content || '') : '';

  const html = `${SHELL_HEAD}<title>${esc(heading)} · Luto</title>
<meta name="description" content="${esc(desc)}">
<meta name="robots" content="noindex, follow">
<link rel="canonical" href="${url}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Luto">
<meta property="og:title" content="${esc(heading)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${url}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(heading)}">
<meta name="twitter:description" content="${esc(desc)}">
</head><body>
<div class="wrap">
  <div class="top">
    <a class="brand" href="${APP}/twin">Luto<span class="dot">.</span></a>
    <a class="cta-mini" href="${signup}">Build your twin</a>
  </div>
  <div class="kicker">${esc(kicker(p))}</div>
  <h1 class="title">${esc(heading)}</h1>
  ${p.type === 'concept' && p.summary ? `<p class="standfirst">${esc(p.summary)}</p>` : ''}
  ${metaBits.length ? `<div class="meta">${metaBits.map(esc).join('  ·  ')}</div>` : ''}
  <div class="content" id="content">${paragraphs(rawContent)}</div>
  <div class="cta">
    <p class="c-eyebrow">A twin made this</p>
    <p class="c-line">${ctaLine(p)}</p>
    <a class="go" href="${signup}">Build your twin</a>
  </div>
  <div class="foot">Shared from a private knowledge twin on <a href="${APP}/twin">Luto</a>. Only this page is public.</div>
</div>
<script type="application/json" id="raw">${JSON.stringify({ md: rawContent }).replace(/</g, '\\u003c')}</script>
<script src="https://cdn.jsdelivr.net/npm/marked@13.0.3/marked.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js"></script>
<script>
  try {
    var raw = JSON.parse(document.getElementById('raw').textContent).md || '';
    if (raw && window.marked && window.DOMPurify) {
      document.getElementById('content').innerHTML = DOMPurify.sanitize(marked.parse(raw));
    }
  } catch (e) {}
</script>
</body></html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=120');
  return res.status(200).send(html);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).send('GET only'); }

  const slug = req.query.slug;
  if (typeof slug !== 'string' || !slug) return notFound(res);

  const ip = clientIp(req);

  // Unauthenticated abuse surface — rate limit by IP AND by slug. The per-slug
  // cap bounds load on a single hot link even if a caller rotates X-Forwarded-For
  // to dodge the per-IP cap (clientIp prefers the platform-trusted x-real-ip).
  // Fails open, which is acceptable for a read-only public page.
  try {
    const ipRl = await checkRateLimit(`pub-ip:${ip}`, PUBLIC_VIEW_PER_HOUR);
    const slugRl = await checkRateLimit(`pub-slug:${slug}`, PUBLIC_SLUG_PER_HOUR);
    if (ipRl.exceeded || slugRl.exceeded) {
      res.setHeader('Retry-After', String((ipRl.exceeded ? ipRl.retryAfterSeconds : slugRl.retryAfterSeconds) || 600));
      return res.status(429).send('Too many requests. Try again shortly.');
    }
  } catch (e) { /* limiter failure must not break the page */ }

  // Salted viewer fingerprint for unique-vs-total view analytics, no PII stored.
  const viewerFingerprint = createHash('sha256')
    .update(`${ip}|${req.headers['user-agent'] || ''}|${slug}|${process.env.JWT_SECRET || 'pub'}`)
    .digest('hex').slice(0, 32);

  let payload = null;
  try { payload = await resolvePublicArtifact(slug, { viewerFingerprint }); }
  catch (e) { console.error('[public/p] resolve failed:', e?.message); return notFound(res); }

  if (!payload) return notFound(res);
  return renderArtifact(res, payload);
}
