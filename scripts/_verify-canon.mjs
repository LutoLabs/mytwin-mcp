// Throwaway verification for the Eleusis canon seed. Safe, read-mostly: creates
// one disposable test tenant, runs retrieval, then deletes it.
//   node --import ./scripts/_loadenv.mjs scripts/_verify-canon.mjs

import { getOrCreateUser } from '../lib/auth.js';
import { deleteAccount } from '../lib/account.js';
import { searchTwin } from '../tools/retrieval.js';
import { getCanonNamespace } from '../lib/pinecone.js';
import { embed } from '../lib/embed.js';
import { getDB } from '../lib/supabase.js';
import { CANON_TENANT_ID, CANON_MIN_SCORE } from '../lib/canon.js';

const log = (...a) => console.log(...a);
let userId = null;
const checks = [];
const expect = (name, pass, detail) => { checks.push(pass); log(pass ? 'PASS' : 'FAIL', name, detail ? JSON.stringify(detail) : ''); };

try {
  const db = getDB();

  // 1. Canon rows are isolated under the system tenant, with provenance 'canon'.
  const { data: rows } = await db.from('knowledge').select('id, title, provenance').eq('tenant_id', CANON_TENANT_ID);
  expect('canon rows under system tenant (==2, all canon)',
    (rows?.length === 2) && rows.every(r => r.provenance === 'canon'),
    (rows || []).map(r => `${r.provenance}:${r.title}`));

  // 2. Score floor behaves: on-topic clears the floor, off-topic stays below it.
  const ns = getCanonNamespace();
  const on  = await ns.query({ vector: await embed('how do you work and what can you do'), topK: 3, includeMetadata: true });
  const off = await ns.query({ vector: await embed('schedule a dentist appointment for tuesday at 3pm'), topK: 3, includeMetadata: true });
  const onTop  = on.matches?.[0]?.score || 0;
  const offTop = off.matches?.[0]?.score || 0;
  log(`  on-topic top score ${onTop.toFixed(3)} | off-topic top score ${offTop.toFixed(3)} | floor ${CANON_MIN_SCORE}`);
  expect('on-topic canon clears the score floor', onTop >= CANON_MIN_SCORE, { onTop: +onTop.toFixed(3) });

  // 3. End-to-end through searchTwin from a BRAND-NEW foreign tenant:
  //    it owns nothing, yet canon is retrieved and tagged.
  const r = await getOrCreateUser(`canon-verify-${Date.now()}@test.invalid`, { allowUninvited: true });
  userId = r.user.id;
  const ctx = { userId: r.user.id, tenantId: r.user.tenant_id, isAnonymous: false };
  const res = await searchTwin(ctx, { query: 'how do you work, what are you?', top_k: 6 });
  const canonHits = res.results.filter(x => x.canon || x.provenance === 'canon');
  const ownHits   = res.results.filter(x => !x.canon && x.provenance !== 'canon');
  log('  searchTwin results:', res.results.map(x => ({ title: x.title, prov: x.provenance, canon: !!x.canon, rel: x.relevance })));
  expect('fresh tenant retrieves canon', canonHits.length > 0, { canonHits: canonHits.length });
  expect('fresh tenant owns nothing (cold-start intact)', ownHits.length === 0, { ownHits: ownHits.length });
  expect('canon hit carries provenance=canon + canon flag',
    canonHits.every(c => c.provenance === 'canon' && c.canon === true));

} catch (e) {
  console.error('verify error:', e?.stack || e?.message || e);
  checks.push(false);
} finally {
  if (userId) { try { await deleteAccount({ userId }); log('  cleaned up test account', userId); } catch (e) { console.error('  cleanup failed:', e?.message); } }
  const passed = checks.filter(Boolean).length;
  log(`\nVERDICT: ${passed}/${checks.length} checks passed — ${passed === checks.length && checks.length ? 'ALL PASS' : 'SEE FAILURES'}`);
  process.exit(passed === checks.length && checks.length ? 0 : 1);
}
