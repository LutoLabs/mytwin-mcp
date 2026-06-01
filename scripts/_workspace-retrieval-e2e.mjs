// Throwaway e2e harness for Phase 2 S-D.2 (workspace retrieval). A member's twin
// retrieves contributed org items (flagged workspace), a non-member does not, and
// personal items are unaffected. Run:
//   node --import ./scripts/_loadenv.mjs scripts/_workspace-retrieval-e2e.mjs

import { getOrCreateUser } from '../lib/auth.js';
import { deleteAccount } from '../lib/account.js';
import { getDB } from '../lib/supabase.js';
import { getNamespace } from '../lib/pinecone.js';
import { addKnowledge } from '../tools/storage.js';
import { searchTwin } from '../tools/retrieval.js';
import { createOrgWorkspace, addMember } from '../lib/workspaces.js';
import { contributeToWorkspace } from '../lib/contribution.js';

const ts = Date.now();
const MARKER = `quasar${ts}`;
const emails = { alice: `wr-alice-${ts}@test.invalid`, bob: `wr-bob-${ts}@test.invalid`, dave: `wr-dave-${ts}@test.invalid` };
const checks = [];
const expect = (n, c, d) => { checks.push({ n, pass: !!c }); console.log((c ? 'PASS' : 'FAIL'), n, d ? JSON.stringify(d) : ''); };
const ctxOf = r => ({ userId: r.user.id, tenantId: r.user.tenant_id, isAnonymous: false });
const created = [];
let orgTenantId = null;

try {
  const aR = await getOrCreateUser(emails.alice, { allowUninvited: true });
  const bR = await getOrCreateUser(emails.bob, { allowUninvited: true });
  const dR = await getOrCreateUser(emails.dave, { allowUninvited: true });
  created.push(aR.user.id, bR.user.id, dR.user.id);
  const alice = ctxOf(aR), bob = ctxOf(bR), dave = ctxOf(dR);
  const db = getDB();

  const ws = await createOrgWorkspace({ ctx: alice, name: `Retr Org ${ts}` });
  orgTenantId = ws.tenant_id;

  const original = await addKnowledge(alice, {
    type: 'knowledge', title: 'North star metric',
    content: `Our north star metric is the ${MARKER} ratio: weekly active twins divided by total twins.`,
    source_type: 'typed', provenance: 'personal',
  });
  const c = await contributeToWorkspace({ ctx: alice, workspaceId: ws.id, itemId: original.id });
  await addMember({ ctx: alice, workspaceId: ws.id, email: emails.bob, role: 'member' });

  const bobOwn = await addKnowledge(bob, {
    type: 'knowledge', title: 'Bob note',
    content: `Bob's personal note mentioning ${MARKER}, an unrelated grocery list.`,
    source_type: 'typed', provenance: 'personal',
  });

  await new Promise(r => setTimeout(r, 2500)); // give Pinecone a moment to index

  const q = `${MARKER} north star metric weekly active twins`;

  const bobSearch = await searchTwin(bob, { query: q });
  const wsHit = bobSearch.results.find(r => r.id === c.item_id);
  expect('member_retrieves_workspace_item', !!wsHit && wsHit.workspace === true && !wsHit.shared, { found: !!wsHit, workspace: wsHit?.workspace });

  const bobOwnHit = bobSearch.results.find(r => r.id === bobOwn.id);
  expect('own_item_not_flagged_workspace', !!bobOwnHit && !bobOwnHit.workspace && !bobOwnHit.shared, { found: !!bobOwnHit });

  const daveSearch = await searchTwin(dave, { query: q });
  expect('nonmember_no_workspace_retrieval', !daveSearch.results.some(r => r.id === c.item_id), { count: daveSearch.results.length });

  const aliceSearch = await searchTwin(alice, { query: q });
  const aliceOrig = aliceSearch.results.find(r => r.id === original.id);
  const aliceWs   = aliceSearch.results.find(r => r.id === c.item_id);
  expect('alice_sees_personal_original', !!aliceOrig && !aliceOrig.workspace);
  expect('alice_sees_workspace_copy', !!aliceWs && aliceWs.workspace === true);

} catch (err) {
  expect('harness_did_not_throw', false, { error: err?.message, stack: err?.stack?.split('\n').slice(0, 3).join(' | ') });
} finally {
  try { if (orgTenantId) await getNamespace(orgTenantId).deleteAll(); } catch {}
  const db = getDB();
  if (orgTenantId) { try { await db.from('tenants').delete().eq('id', orgTenantId); } catch {} }
  const cleanup = {};
  for (const uid of created) {
    try { await deleteAccount({ userId: uid }); cleanup[uid] = 'deleted'; }
    catch (e) { cleanup[uid] = 'FAILED: ' + e?.message; }
  }
  console.log('\nCLEANUP', JSON.stringify(cleanup));
  const failed = checks.filter(c => !c.pass);
  console.log(`\nRESULT pass=${failed.length === 0} total=${checks.length} failed=${failed.length}`);
  process.exit(failed.length === 0 ? 0 : 1);
}
