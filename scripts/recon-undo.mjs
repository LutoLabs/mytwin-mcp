// Reverse reconciliation auto-actions from the CLI.
//   node scripts/recon-undo.mjs decision <decisionId> [tenantId]
//   node scripts/recon-undo.mjs item <incomingItemId> <tenantId>
//   node scripts/recon-undo.mjs last <N> <tenantId>        — undo the N most recent live auto-actions
//
// Idempotent: reverting an already-reverted decision is a no-op. Reversibility is
// structural (reverse_token on each decision). tenantId, when given, scopes the
// undo so you can never touch another tenant's decisions.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

for (const raw of readFileSync(resolve(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  const l = raw.trim(); if (!l || l.startsWith('#')) continue;
  const eq = l.indexOf('='); if (eq < 1) continue;
  const k = l.slice(0, eq).trim(); let v = l.slice(eq + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (v) process.env[k] = v;
}

const { getDB }           = await import('/Users/piotrkurzepa/mytwin/lib/supabase.js');
const { reverseDecision } = await import('/Users/piotrkurzepa/mytwin/lib/reconciliation/executor.js');

const [mode, arg, tenantId] = process.argv.slice(2);
if (!mode) {
  console.error('usage:\n  recon-undo.mjs decision <decisionId> [tenantId]\n  recon-undo.mjs item <incomingItemId> <tenantId>\n  recon-undo.mjs last <N> <tenantId>');
  process.exit(2);
}
const db = getDB();

async function reverseIds(ids) {
  let undone = 0;
  for (const id of ids) {
    const r = await reverseDecision({ decisionId: id, tenantId: tenantId || null });
    console.log(`  ${id.slice(0, 8)}  ${r.reversed ? 'REVERSED ' + r.kind : 'skip — ' + r.reason}`);
    if (r.reversed) undone++;
  }
  console.log(`\nundone ${undone}/${ids.length}`);
}

if (mode === 'decision') {
  if (!arg) { console.error('decision id required'); process.exit(2); }
  await reverseIds([arg]);
} else if (mode === 'item') {
  if (!arg || !tenantId) { console.error('item mode needs <incomingItemId> <tenantId>'); process.exit(2); }
  const { data } = await db.from('reconciliation_decisions')
    .select('id').eq('tenant_id', tenantId).eq('incoming_item_id', arg)
    .not('reverse_token', 'is', null).order('created_at', { ascending: false });
  await reverseIds((data || []).map(r => r.id));
} else if (mode === 'last') {
  const n = Number(arg) || 1;
  if (!tenantId) { console.error('last mode needs <N> <tenantId>'); process.exit(2); }
  const { data } = await db.from('reconciliation_decisions')
    .select('id').eq('tenant_id', tenantId).eq('shadow', false)
    .not('reverse_token', 'is', null).order('created_at', { ascending: false }).limit(n);
  await reverseIds((data || []).map(r => r.id));
} else {
  console.error('unknown mode', mode); process.exit(2);
}
process.exit(0);
