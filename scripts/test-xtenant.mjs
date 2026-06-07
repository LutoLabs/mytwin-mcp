// scripts/test-xtenant.mjs
//
// Phase 0 merge gate. POSTs the deployed cross-tenant + public-link isolation
// suite (api/admin/test-cross-tenant.js) and exits non-zero if any check fails,
// printing the failures. Wired into deploy:prod so it runs on every production
// deploy, and into CI (.github/workflows/ci.yml) so it runs on push.
//
// Auth: set ADMIN_TOKEN (preferred) or ADMIN_DASHBOARD_PASSWORD in the env.
// Target: DEPLOY_URL (defaults to the live production domain).
//
//   ADMIN_TOKEN=... node scripts/test-xtenant.mjs
//   DEPLOY_URL=https://my-preview.vercel.app ADMIN_TOKEN=... node scripts/test-xtenant.mjs

const base = (process.env.DEPLOY_URL || 'https://myaitwin.lutolearn.com').replace(/\/+$/, '');
const url = `${base}/api/admin/test-cross-tenant`;
const token = process.env.ADMIN_TOKEN || '';
const pw = process.env.ADMIN_DASHBOARD_PASSWORD || '';

if (!token && !pw) {
  console.error('✗ cross-tenant gate: set ADMIN_TOKEN or ADMIN_DASHBOARD_PASSWORD to run the gate.');
  process.exit(2);
}

const headers = { 'Content-Type': 'application/json' };
if (token) headers['X-Admin-Token'] = token;
if (pw) headers['X-Admin-Password'] = pw;

let res, body;
try {
  res = await fetch(url, { method: 'POST', headers });
  body = await res.json().catch(() => ({}));
} catch (err) {
  console.error(`✗ cross-tenant gate: request to ${url} failed — ${err?.message || err}`);
  process.exit(1);
}

const checks = Array.isArray(body.checks) ? body.checks : [];
const failed = checks.filter(c => !c.pass);
const skipped = checks.filter(c => c.pass && c.details && c.details.skipped);

if (res.ok && body.pass) {
  console.log(`✓ cross-tenant gate PASSED — ${body.total} checks green at ${url}`);
  for (const s of skipped) console.log(`   (skipped) ${s.name}: ${s.details?.reason || ''}`);
  process.exit(0);
}

console.error(`✗ cross-tenant gate FAILED — ${failed.length}/${body.total ?? '?'} checks failed (HTTP ${res.status}) at ${url}`);
for (const c of failed) console.error(`   - ${c.name}: ${JSON.stringify(c.details)}`);
process.exit(1);
