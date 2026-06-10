// scripts/audit-compile-runs.js
//
// Read-only spend audit for the concept-page compiler. Reports, per day, how
// many full compiles (background_log job_name 'concept-compile') and stale
// recompiles ('concept-recompile') ran — split by trigger mode and status — so a
// spend spike (a pile of bootstrap/fallback full compiles) is visible at a
// glance and regressions can be re-checked in seconds.
//
// Usage:
//   node scripts/audit-compile-runs.js [startDate] [endDate] [tenantId]
//   node scripts/audit-compile-runs.js 2026-06-01 2026-06-08
//
// Dates are inclusive, YYYY-MM-DD (UTC). Defaults to 2026-06-01..2026-06-08.
// Rows written before `mode` was recorded in the meta show as 'legacy/no-mode'
// (so historical spikes still surface as raw counts, just without a mode label).
//
// Read-only: this script never writes. Same Supabase service-key pattern as the
// other scripts in this dir (env from .env.local, getDB() from lib/supabase.js).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Load .env.local (lenient; never echoes any value) ─────────────────────────
for (const raw of readFileSync(resolve(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  const l = raw.trim(); if (!l || l.startsWith('#')) continue;
  const eq = l.indexOf('='); if (eq < 1) continue;
  const k = l.slice(0, eq).trim(); let v = l.slice(eq + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (v) process.env[k] = v;
}

const startDate = process.argv[2] || '2026-06-01';
const endDate   = process.argv[3] || '2026-06-08';
const tenantId  = process.argv[4] || null;

const startISO = `${startDate}T00:00:00.000Z`;
// Inclusive end date → query strictly less than the following midnight.
const endExclusive = new Date(`${endDate}T00:00:00.000Z`);
endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
const endISO = endExclusive.toISOString();

const { getDB } = await import('../lib/supabase.js');
const db = getDB();

let query = db
  .from('background_log')
  .select('job_name, status, meta, created_at, tenant_id')
  .in('job_name', ['concept-compile', 'concept-recompile'])
  .gte('created_at', startISO)
  .lt('created_at', endISO)
  .order('created_at', { ascending: true })
  .limit(100000);
if (tenantId) query = query.eq('tenant_id', tenantId);

const { data: rows, error } = await query;
if (error) { console.error('query failed:', error.message); process.exit(1); }

const dayOf  = (iso)  => String(iso).slice(0, 10);
const modeOf = (meta) => meta?.mode || meta?.reason || 'legacy/no-mode';

// day -> { compile: Map<mode, {status: n}>, recompile: Map<status, n> }
const byDay = new Map();
const ensureDay = (d) => {
  if (!byDay.has(d)) byDay.set(d, { compile: new Map(), recompile: new Map() });
  return byDay.get(d);
};

let totalCompile = 0;
let totalRecompile = 0;
for (const r of rows || []) {
  const bucket = ensureDay(dayOf(r.created_at));
  if (r.job_name === 'concept-compile') {
    totalCompile++;
    const m = modeOf(r.meta);
    if (!bucket.compile.has(m)) bucket.compile.set(m, {});
    const s = bucket.compile.get(m);
    s[r.status] = (s[r.status] || 0) + 1;
  } else {
    totalRecompile++;
    bucket.recompile.set(r.status, (bucket.recompile.get(r.status) || 0) + 1);
  }
}

// ── Report ────────────────────────────────────────────────────────────────────
const fmtStatuses = (obj) => Object.entries(obj).map(([s, n]) => `${s}:${n}`).join('  ');
const sumStatuses = (obj) => Object.values(obj).reduce((a, n) => a + n, 0);

const scope = tenantId ? `tenant ${tenantId.slice(0, 8)}` : 'all tenants';
console.log(`\n── Concept-compile spend audit · ${startDate}..${endDate} · ${scope} ──\n`);

if (!byDay.size) {
  console.log('  (no concept-compile / concept-recompile rows in range)\n');
  process.exit(0);
}

for (const d of [...byDay.keys()].sort()) {
  const { compile, recompile } = byDay.get(d);
  const compileTotal   = [...compile.values()].reduce((a, s) => a + sumStatuses(s), 0);
  const recompileTotal = [...recompile.values()].reduce((a, n) => a + n, 0);
  console.log(`${d}   full-compiles: ${compileTotal}   recompiles: ${recompileTotal}`);
  for (const [m, s] of [...compile.entries()].sort()) {
    console.log(`             compile[${m}]   ${fmtStatuses(s)}`);
  }
  if (recompileTotal) {
    console.log(`             recompile        ${fmtStatuses(Object.fromEntries(recompile))}`);
  }
}

console.log(`\ntotals: full-compiles ${totalCompile} · recompiles ${totalRecompile}\n`);
