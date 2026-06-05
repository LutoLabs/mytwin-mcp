// Reconciliation shadow-soak review (§15).
//   node scripts/recon-stats.mjs [tenantId] [days]
// Prints the aggregate decision distribution for a tenant so the shadow soak
// can be judged before enabling Phase 3 auto-actions. Read-only.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

for (const raw of readFileSync(resolve(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  const l = raw.trim(); if (!l || l.startsWith('#')) continue;
  const eq = l.indexOf('='); if (eq < 1) continue;
  const k = l.slice(0, eq).trim(); let v = l.slice(eq + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (v) process.env[k] = v;
}

const { reconciliationStats } = await import('/Users/piotrkurzepa/mytwin/lib/reconciliation/stats.js');

const tenantId = process.argv[2];
const days     = Number(process.argv[3]) || 30;
if (!tenantId) { console.error('usage: node scripts/recon-stats.mjs <tenantId> [days]'); process.exit(2); }

const s = await reconciliationStats({ tenantId, sinceDays: days });
console.log(`\n── Reconciliation soak — tenant ${tenantId.slice(0, 8)} · last ${s.window_days}d ──\n`);
console.log(`decisions: ${s.decisions}   fragments reconciled: ${s.fragments_reconciled}   avg candidates/fragment: ${s.avg_candidates_per_fragment}`);
console.log(`mode: shadow ${s.mode.shadow} · live ${s.mode.live}   avg confidence: ${s.avg_confidence ?? '—'}`);
console.log(`\nby relationship:`);
for (const [k, v] of Object.entries(s.by_relationship)) if (v) console.log(`  ${k.padEnd(14)} ${v}`);
console.log(`\nby would-be action:`);
for (const [k, v] of Object.entries(s.by_action)) if (v) console.log(`  ${k.padEnd(10)} ${v}`);
console.log(`\nwould-auto: ${s.auto_vs_escalate.would_auto}   would-escalate: ${s.auto_vs_escalate.would_escalate}   would-merge signals: ${s.would_merge_signals}\n`);
