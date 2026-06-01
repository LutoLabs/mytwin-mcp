// Throwaway e2e for the S-F follow-ups: cancel pending invite + delete workspace.
// Run: node --import ./scripts/_loadenv.mjs scripts/_workspace-admin-e2e.mjs

import { getOrCreateUser } from '../lib/auth.js';
import { deleteAccount } from '../lib/account.js';
import { getDB } from '../lib/supabase.js';
import { getNamespace } from '../lib/pinecone.js';
import { createOrgWorkspace, addMember, listMembers, cancelWorkspaceInvitation, deleteWorkspace } from '../lib/workspaces.js';

const ts = Date.now();
const emails = { alice: `wa-alice-${ts}@test.invalid`, bob: `wa-bob-${ts}@test.invalid`, carol: `wa-carol-${ts}@test.invalid` };
const checks = [];
const expect = (n, c, d) => { checks.push({ n, pass: !!c }); console.log((c ? 'PASS' : 'FAIL'), n, d ? JSON.stringify(d) : ''); };
const ctxOf = r => ({ userId: r.user.id, tenantId: r.user.tenant_id, isAnonymous: false });
const created = [];
let orgTenantId = null, wsDeleted = false;

try {
  const aR = await getOrCreateUser(emails.alice, { allowUninvited: true });
  const bR = await getOrCreateUser(emails.bob, { allowUninvited: true });
  created.push(aR.user.id, bR.user.id);
  const alice = ctxOf(aR), bob = ctxOf(bR);

  const ws = await createOrgWorkspace({ ctx: alice, name: `Admin Org ${ts}` });
  orgTenantId = ws.tenant_id;
  await addMember({ ctx: alice, workspaceId: ws.id, email: emails.bob, role: 'member' });

  await addMember({ ctx: alice, workspaceId: ws.id, email: emails.carol, role: 'member' });
  let m = await listMembers({ ctx: alice, workspaceId: ws.id });
  const inv = m.pending.find(p => p.email.toLowerCase() === emails.carol.toLowerCase());
  expect('invite_pending', !!inv, { pending: m.pending.length });

  let memberBlocked = false;
  try { await cancelWorkspaceInvitation({ ctx: bob, workspaceId: ws.id, invitationId: inv.invitation_id }); }
  catch (e) { memberBlocked = e.status === 403; }
  expect('member_cannot_cancel', memberBlocked);

  const cancelled = await cancelWorkspaceInvitation({ ctx: alice, workspaceId: ws.id, invitationId: inv.invitation_id });
  expect('owner_cancels_invite', cancelled.cancelled);
  m = await listMembers({ ctx: alice, workspaceId: ws.id });
  expect('pending_gone', !m.pending.some(p => p.invitation_id === inv.invitation_id), { pending: m.pending.length });

  let delBlocked = false;
  try { await deleteWorkspace({ ctx: bob, workspaceId: ws.id }); } catch (e) { delBlocked = e.status === 403; }
  expect('member_cannot_delete', delBlocked);

  const del = await deleteWorkspace({ ctx: alice, workspaceId: ws.id });
  expect('owner_deletes_workspace', del.deleted);
  wsDeleted = true;

  const db = getDB();
  const { data: wsAfter } = await db.from('workspaces').select('id').eq('id', ws.id).maybeSingle();
  expect('workspace_gone', !wsAfter);
  const { data: tenantAfter } = await db.from('tenants').select('id').eq('id', orgTenantId).maybeSingle();
  expect('tenant_gone', !tenantAfter);

} catch (err) {
  expect('harness_did_not_throw', false, { error: err?.message, stack: err?.stack?.split('\n').slice(0, 3).join(' | ') });
} finally {
  const db = getDB();
  if (orgTenantId && !wsDeleted) { try { await getNamespace(orgTenantId).deleteAll(); } catch {} try { await db.from('tenants').delete().eq('id', orgTenantId); } catch {} }
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
