// Throwaway e2e harness for Phase 2 S-G (workspace-safe account deletion).
// Run: node --import ./scripts/_loadenv.mjs scripts/_workspace-deletion-e2e.mjs

import { getOrCreateUser } from '../lib/auth.js';
import { deleteAccount } from '../lib/account.js';
import { getDB } from '../lib/supabase.js';
import { getNamespace } from '../lib/pinecone.js';
import { addKnowledge } from '../tools/storage.js';
import { createOrgWorkspace, addMember } from '../lib/workspaces.js';
import { contributeToWorkspace } from '../lib/contribution.js';

const ts = Date.now();
const checks = [];
const expect = (n, c, d) => { checks.push({ n, pass: !!c }); console.log((c ? 'PASS' : 'FAIL'), n, d ? JSON.stringify(d) : ''); };
const ctxOf = r => ({ userId: r.user.id, tenantId: r.user.tenant_id, isAnonymous: false });
const orphanTenants = new Set();
const leftoverUsers = new Set();

try {
  const db = getDB();

  // Case 1: owner + admin. Delete owner -> ownership transfers, item survives.
  const a1 = await getOrCreateUser(`wd-owner1-${ts}@test.invalid`, { allowUninvited: true });
  const b1 = await getOrCreateUser(`wd-admin1-${ts}@test.invalid`, { allowUninvited: true });
  leftoverUsers.add(b1.user.id);
  const ws1 = await createOrgWorkspace({ ctx: ctxOf(a1), name: `Del Org A ${ts}` });
  orphanTenants.add(ws1.tenant_id);
  await addMember({ ctx: ctxOf(a1), workspaceId: ws1.id, email: b1.user.email, role: 'admin' });
  const orig1 = await addKnowledge(ctxOf(a1), { type: 'knowledge', title: 'Owner contribution', content: `owner contributed ${ts}`, source_type: 'typed', provenance: 'personal' });
  const c1 = await contributeToWorkspace({ ctx: ctxOf(a1), workspaceId: ws1.id, itemId: orig1.id });
  await deleteAccount({ userId: a1.user.id });

  const { data: ws1after } = await db.from('workspaces').select('id, owner_id').eq('id', ws1.id).maybeSingle();
  expect('owner_delete_workspace_survives', !!ws1after);
  expect('ownership_transferred', ws1after && ws1after.owner_id === b1.user.id, { owner: ws1after?.owner_id });
  const { data: b1mem } = await db.from('workspace_memberships').select('role').eq('workspace_id', ws1.id).eq('user_id', b1.user.id).maybeSingle();
  expect('successor_role_owner', b1mem && b1mem.role === 'owner', { role: b1mem?.role });
  const { data: item1 } = await db.from('knowledge').select('id, user_id, workspace_id').eq('id', c1.item_id).maybeSingle();
  expect('contributed_item_survives', !!item1 && item1.user_id === b1.user.id && item1.workspace_id === ws1.id, { found: !!item1, user: item1?.user_id });

  // Case 2: non-owner member contributes. Delete member -> item survives, owner unchanged.
  const a2 = await getOrCreateUser(`wd-owner2-${ts}@test.invalid`, { allowUninvited: true });
  const b2 = await getOrCreateUser(`wd-member2-${ts}@test.invalid`, { allowUninvited: true });
  leftoverUsers.add(a2.user.id);
  const ws2 = await createOrgWorkspace({ ctx: ctxOf(a2), name: `Del Org B ${ts}` });
  orphanTenants.add(ws2.tenant_id);
  await addMember({ ctx: ctxOf(a2), workspaceId: ws2.id, email: b2.user.email, role: 'member' });
  const orig2 = await addKnowledge(ctxOf(b2), { type: 'knowledge', title: 'Member contribution', content: `member contributed ${ts}`, source_type: 'typed', provenance: 'personal' });
  const c2 = await contributeToWorkspace({ ctx: ctxOf(b2), workspaceId: ws2.id, itemId: orig2.id });
  await deleteAccount({ userId: b2.user.id });

  const { data: ws2after } = await db.from('workspaces').select('id, owner_id').eq('id', ws2.id).maybeSingle();
  expect('member_delete_workspace_survives', !!ws2after && ws2after.owner_id === a2.user.id);
  const { data: item2 } = await db.from('knowledge').select('id, user_id').eq('id', c2.item_id).maybeSingle();
  expect('member_contribution_survives', !!item2 && item2.user_id === a2.user.id, { found: !!item2, user: item2?.user_id });

  // Case 3: sole owner. Delete -> workspace + tenant torn down.
  const a3 = await getOrCreateUser(`wd-solo3-${ts}@test.invalid`, { allowUninvited: true });
  const ws3 = await createOrgWorkspace({ ctx: ctxOf(a3), name: `Del Org C ${ts}` });
  orphanTenants.add(ws3.tenant_id);
  await deleteAccount({ userId: a3.user.id });
  const { data: ws3after } = await db.from('workspaces').select('id').eq('id', ws3.id).maybeSingle();
  expect('sole_owner_workspace_deleted', !ws3after);
  const { data: tenant3 } = await db.from('tenants').select('id').eq('id', ws3.tenant_id).maybeSingle();
  expect('sole_owner_tenant_deleted', !tenant3);

} catch (err) {
  expect('harness_did_not_throw', false, { error: err?.message, stack: err?.stack?.split('\n').slice(0, 3).join(' | ') });
} finally {
  const db = getDB();
  for (const t of orphanTenants) { try { await getNamespace(t).deleteAll(); } catch {} try { await db.from('tenants').delete().eq('id', t); } catch {} }
  const cleanup = {};
  for (const uid of leftoverUsers) {
    try { await deleteAccount({ userId: uid }); cleanup[uid] = 'deleted'; }
    catch (e) { cleanup[uid] = 'FAILED: ' + e?.message; }
  }
  console.log('\nCLEANUP', JSON.stringify(cleanup));
  const failed = checks.filter(c => !c.pass);
  console.log(`\nRESULT pass=${failed.length === 0} total=${checks.length} failed=${failed.length}`);
  process.exit(failed.length === 0 ? 0 : 1);
}
