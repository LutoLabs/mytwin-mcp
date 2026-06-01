// Throwaway e2e harness for Phase 2 S-C (org workspace API). Drives the full
// lifecycle against the real DB with synthetic accounts, then cleans up.
// Run: node --import ./scripts/_loadenv.mjs scripts/_workspace-e2e.mjs

import { getOrCreateUser } from '../lib/auth.js';
import { deleteAccount } from '../lib/account.js';
import { getDB } from '../lib/supabase.js';
import {
  createOrgWorkspace, listMyWorkspaces, getWorkspaceForMember,
  listMembers, addMember, changeMemberRole, removeMember,
  getWorkspaceInvitation, acceptWorkspaceInvitation,
} from '../lib/workspaces.js';

const ts = Date.now();
const emails = {
  alice: `ws-alice-${ts}@test.invalid`, // owner/creator
  bob:   `ws-bob-${ts}@test.invalid`,   // existing-user member -> promoted to admin
  carol: `ws-carol-${ts}@test.invalid`, // new-email invitee
  dave:  `ws-dave-${ts}@test.invalid`,  // non-member / added then removed
};
const checks = [];
const expect = (n, c, d) => { checks.push({ n, pass: !!c }); console.log((c ? 'PASS' : 'FAIL'), n, d ? JSON.stringify(d) : ''); };
const ctxOf = r => ({ userId: r.user.id, tenantId: r.user.tenant_id, isAnonymous: false });
const created = [];
let orgTenantId = null;

try {
  const aliceR = await getOrCreateUser(emails.alice, { allowUninvited: true });
  const bobR   = await getOrCreateUser(emails.bob,   { allowUninvited: true });
  const daveR  = await getOrCreateUser(emails.dave,  { allowUninvited: true });
  created.push(aliceR.user.id, bobR.user.id, daveR.user.id);
  const alice = ctxOf(aliceR), bob = ctxOf(bobR), dave = ctxOf(daveR);

  const ws = await createOrgWorkspace({ ctx: alice, name: `Test Org ${ts}` });
  orgTenantId = ws.tenant_id;
  expect('create_org_workspace', !!ws.id && ws.role === 'owner' && ws.type === 'organisational', { id: ws.id });

  expect('owner_sees_workspace', (await listMyWorkspaces(alice)).workspaces.some(w => w.id === ws.id && w.is_owner));
  expect('nonmember_no_workspace', !(await listMyWorkspaces(dave)).workspaces.some(w => w.id === ws.id));

  const add1 = await addMember({ ctx: alice, workspaceId: ws.id, email: emails.bob, role: 'member' });
  expect('add_existing_member', add1.mode === 'added' && add1.role === 'member', { mode: add1.mode });

  let members = await listMembers({ ctx: alice, workspaceId: ws.id });
  expect('members_owner_plus_member', members.members.length === 2 && members.members.some(m => m.email === emails.bob && m.role === 'member'));

  const bobView = await getWorkspaceForMember({ ctx: bob, workspaceId: ws.id });
  expect('member_can_read', bobView.id === ws.id && bobView.role === 'member' && bobView.can_manage === false);

  let memberBlocked = false;
  try { await addMember({ ctx: bob, workspaceId: ws.id, email: emails.dave, role: 'member' }); }
  catch (e) { memberBlocked = e.status === 403; }
  expect('member_cannot_add', memberBlocked);

  const inv = await addMember({ ctx: alice, workspaceId: ws.id, email: emails.carol, role: 'member' });
  expect('invite_new_email', inv.mode === 'invited' && !!inv.token, { mode: inv.mode });

  const meta = await getWorkspaceInvitation(inv.token);
  expect('invitation_lookup', !!meta && meta.workspace && meta.workspace.name === `Test Org ${ts}`, { name: meta?.workspace?.name });

  const acc = await acceptWorkspaceInvitation(inv.token);
  created.push(acc.user.id);
  expect('accept_creates_membership', acc.workspaceId === ws.id && !!acc.sessionJwt);

  let singleUse = false;
  try { await acceptWorkspaceInvitation(inv.token); } catch (e) { singleUse = e.status === 410; }
  expect('accept_single_use', singleUse);

  members = await listMembers({ ctx: alice, workspaceId: ws.id });
  expect('members_after_accept', members.members.length === 3 && members.members.some(m => m.email === emails.carol));

  await changeMemberRole({ ctx: alice, workspaceId: ws.id, userId: bobR.user.id, role: 'admin' });
  members = await listMembers({ ctx: alice, workspaceId: ws.id });
  expect('promote_to_admin', members.members.some(m => m.user_id === bobR.user.id && m.role === 'admin'));

  const add2 = await addMember({ ctx: bob, workspaceId: ws.id, email: emails.dave, role: 'member' });
  expect('admin_can_add', add2.mode === 'added');

  await removeMember({ ctx: alice, workspaceId: ws.id, userId: daveR.user.id });
  members = await listMembers({ ctx: alice, workspaceId: ws.id });
  expect('remove_member', !members.members.some(m => m.user_id === daveR.user.id), { count: members.members.length });

  let daveBlocked = false;
  try { await getWorkspaceForMember({ ctx: dave, workspaceId: ws.id }); }
  catch (e) { daveBlocked = e.status === 404; }
  expect('nonmember_cannot_read', daveBlocked);

  let ownerProtected = false;
  try { await removeMember({ ctx: alice, workspaceId: ws.id, userId: aliceR.user.id }); }
  catch (e) { ownerProtected = e.status === 400; }
  expect('owner_cannot_be_removed', ownerProtected);

} catch (err) {
  expect('harness_did_not_throw', false, { error: err?.message, stack: err?.stack?.split('\n').slice(0, 3).join(' | ') });
} finally {
  const db = getDB();
  // Delete the org workspace's tenant first; cascades the workspace + memberships.
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
