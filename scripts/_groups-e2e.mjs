// Throwaway e2e for Phase 3 permission groups: group CRUD + item restriction +
// retrieval enforcement. Run: node --import ./scripts/_loadenv.mjs scripts/_groups-e2e.mjs

import { getOrCreateUser } from '../lib/auth.js';
import { deleteAccount } from '../lib/account.js';
import { getDB } from '../lib/supabase.js';
import { getNamespace } from '../lib/pinecone.js';
import { addKnowledge } from '../tools/storage.js';
import { searchTwin } from '../tools/retrieval.js';
import { createOrgWorkspace, addMember } from '../lib/workspaces.js';
import { contributeToWorkspace } from '../lib/contribution.js';
import { createGroup, listGroups, addGroupMember, removeGroupMember, listGroupMembers, deleteGroup, setItemGroups, getItemGroups } from '../lib/groups.js';

const ts = Date.now();
const MARKER = `pulsar${ts}`;
const emails = { alice: `gr-alice-${ts}@test.invalid`, bob: `gr-bob-${ts}@test.invalid`, dave: `gr-dave-${ts}@test.invalid` };
const checks = [];
const expect = (n, c, d) => { checks.push({ n, pass: !!c }); console.log((c ? 'PASS' : 'FAIL'), n, d ? JSON.stringify(d) : ''); };
const ctxOf = r => ({ userId: r.user.id, tenantId: r.user.tenant_id, isAnonymous: false });
const created = [];
let orgTenantId = null;
const q = `${MARKER} restricted leadership memo board`;

try {
  const aR = await getOrCreateUser(emails.alice, { allowUninvited: true });
  const bR = await getOrCreateUser(emails.bob, { allowUninvited: true });
  const dR = await getOrCreateUser(emails.dave, { allowUninvited: true });
  created.push(aR.user.id, bR.user.id, dR.user.id);
  const alice = ctxOf(aR), bob = ctxOf(bR), dave = ctxOf(dR);

  const ws = await createOrgWorkspace({ ctx: alice, name: `Groups Org ${ts}` });
  orgTenantId = ws.tenant_id;
  await addMember({ ctx: alice, workspaceId: ws.id, email: emails.bob, role: 'member' });
  await addMember({ ctx: alice, workspaceId: ws.id, email: emails.dave, role: 'member' });

  const orig = await addKnowledge(alice, { type: 'knowledge', title: 'Leadership memo', content: `The ${MARKER} restricted leadership memo: board compensation plan details.`, source_type: 'typed', provenance: 'personal' });
  const c = await contributeToWorkspace({ ctx: alice, workspaceId: ws.id, itemId: orig.id });

  const g = await createGroup({ ctx: alice, workspaceId: ws.id, name: 'Leadership' });
  expect('create_group', !!g.id, { id: g.id });

  let mblocked = false;
  try { await createGroup({ ctx: bob, workspaceId: ws.id, name: 'X' }); } catch (e) { mblocked = e.status === 403; }
  expect('member_cannot_create_group', mblocked);

  await addGroupMember({ ctx: alice, workspaceId: ws.id, groupId: g.id, userId: bR.user.id });
  const gm = await listGroupMembers({ ctx: alice, workspaceId: ws.id, groupId: g.id });
  expect('group_member_added', gm.members.some(m => m.user_id === bR.user.id), { count: gm.members.length });

  await setItemGroups({ ctx: alice, workspaceId: ws.id, itemId: c.item_id, groupIds: [g.id] });
  const ig = await getItemGroups({ ctx: alice, workspaceId: ws.id, itemId: c.item_id });
  expect('item_restricted', ig.restricted && ig.group_ids.includes(g.id));

  let setBlocked = false;
  try { await setItemGroups({ ctx: bob, workspaceId: ws.id, itemId: c.item_id, groupIds: [] }); } catch (e) { setBlocked = e.status === 403; }
  expect('member_cannot_restrict', setBlocked);

  await new Promise(r => setTimeout(r, 2500));

  const bobS = await searchTwin(bob, { query: q });
  expect('group_member_retrieves', bobS.results.some(r => r.id === c.item_id && r.workspace === true), { found: bobS.results.some(r => r.id === c.item_id) });

  const daveS = await searchTwin(dave, { query: q });
  expect('nongroup_member_denied', !daveS.results.some(r => r.id === c.item_id), { count: daveS.results.length });

  const aliceS = await searchTwin(alice, { query: q });
  expect('owner_bypass_sees_restricted', aliceS.results.some(r => r.id === c.item_id));

  await setItemGroups({ ctx: alice, workspaceId: ws.id, itemId: c.item_id, groupIds: [] });
  await new Promise(r => setTimeout(r, 600));
  const daveS2 = await searchTwin(dave, { query: q });
  expect('cleared_restriction_visible', daveS2.results.some(r => r.id === c.item_id), { count: daveS2.results.length });

  await removeGroupMember({ ctx: alice, workspaceId: ws.id, groupId: g.id, userId: bR.user.id });
  const gm2 = await listGroupMembers({ ctx: alice, workspaceId: ws.id, groupId: g.id });
  expect('group_member_removed', !gm2.members.some(m => m.user_id === bR.user.id));

  await deleteGroup({ ctx: alice, workspaceId: ws.id, groupId: g.id });
  const gl = await listGroups({ ctx: alice, workspaceId: ws.id });
  expect('group_deleted', !gl.groups.some(x => x.id === g.id));

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
