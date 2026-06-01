// Throwaway e2e harness for Phase 2 S-D.1 (contribution + asymmetric ratchet).
// Run: node --import ./scripts/_loadenv.mjs scripts/_contribution-e2e.mjs

import { getOrCreateUser } from '../lib/auth.js';
import { deleteAccount } from '../lib/account.js';
import { getDB } from '../lib/supabase.js';
import { getNamespace } from '../lib/pinecone.js';
import { addKnowledge } from '../tools/storage.js';
import { createOrgWorkspace, addMember } from '../lib/workspaces.js';
import { contributeToWorkspace, listWorkspaceItems } from '../lib/contribution.js';

const ts = Date.now();
const emails = {
  alice: `co-alice-${ts}@test.invalid`,
  dave:  `co-dave-${ts}@test.invalid`, // non-member
};
const checks = [];
const expect = (n, c, d) => { checks.push({ n, pass: !!c }); console.log((c ? 'PASS' : 'FAIL'), n, d ? JSON.stringify(d) : ''); };
const ctxOf = r => ({ userId: r.user.id, tenantId: r.user.tenant_id, isAnonymous: false });
const created = [];
let orgTenantId = null;

try {
  const aliceR = await getOrCreateUser(emails.alice, { allowUninvited: true });
  const daveR  = await getOrCreateUser(emails.dave,  { allowUninvited: true });
  created.push(aliceR.user.id, daveR.user.id);
  const alice = ctxOf(aliceR), dave = ctxOf(daveR);
  const db = getDB();

  const ws = await createOrgWorkspace({ ctx: alice, name: `Contrib Org ${ts}` });
  orgTenantId = ws.tenant_id;

  // Alice adds a personal item to her own twin.
  const original = await addKnowledge(alice, {
    type: 'knowledge', title: 'Pricing principle',
    content: `Our pricing follows the ${ts} rule: value-based tiers, anchor high.`,
    source_type: 'typed', provenance: 'personal',
  });
  expect('personal_item_created', !!original.id, { id: original.id });

  // Contribute it into the org workspace.
  const c = await contributeToWorkspace({ ctx: alice, workspaceId: ws.id, itemId: original.id });
  expect('contribute_ok', c.contributed && c.item_id && c.item_id !== original.id, { copy: c.item_id });

  // The copy lives in the ORG tenant, workspace-scoped, provenance organisational.
  const { data: copy } = await db.from('knowledge')
    .select('id, tenant_id, user_id, workspace_id, provenance').eq('id', c.item_id).maybeSingle();
  expect('copy_in_org_namespace', copy && copy.tenant_id === orgTenantId && copy.workspace_id === ws.id, { tenant: copy?.tenant_id });
  expect('copy_provenance_org', copy && copy.provenance === 'organisational', { prov: copy?.provenance });
  expect('copy_contributor_preserved', copy && copy.user_id === aliceR.user.id);

  // RATCHET: the original is untouched, stays personal, in Alice's own tenant.
  const { data: orig } = await db.from('knowledge')
    .select('id, tenant_id, workspace_id, provenance').eq('id', original.id).maybeSingle();
  expect('original_unchanged', orig && orig.tenant_id === aliceR.user.tenant_id && !orig.workspace_id && orig.provenance === 'personal', { ws: orig?.workspace_id, prov: orig?.provenance });
  expect('ratchet_distinct_namespaces', copy && orig && copy.tenant_id !== orig.tenant_id);

  // Member listing shows the contributed item.
  const list = await listWorkspaceItems({ ctx: alice, workspaceId: ws.id });
  expect('workspace_item_listed', list.items.some(i => i.id === c.item_id), { count: list.items.length });

  // Non-member cannot list or contribute.
  let listBlocked = false;
  try { await listWorkspaceItems({ ctx: dave, workspaceId: ws.id }); } catch (e) { listBlocked = e.status === 404; }
  expect('nonmember_cannot_list', listBlocked);

  let contribBlocked = false;
  try { await contributeToWorkspace({ ctx: dave, workspaceId: ws.id, itemId: original.id }); } catch (e) { contribBlocked = e.status === 404 || e.status === 403; }
  expect('nonmember_cannot_contribute', contribBlocked);

  // Cannot contribute an item you do not own.
  let notOwner = false;
  await addMember({ ctx: alice, workspaceId: ws.id, email: emails.dave, role: 'member' });
  try { await contributeToWorkspace({ ctx: dave, workspaceId: ws.id, itemId: original.id }); } catch (e) { notOwner = e.status === 403; }
  expect('cannot_contribute_others_item', notOwner);

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
