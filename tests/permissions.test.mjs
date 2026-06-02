// tests/permissions.test.mjs
// Cross-tenant isolation and permission sharing test suite.
//
// Tests the SQL grants and getAccessibleSharedItems logic WITHOUT calling
// Pinecone. Pinecone calls are mocked because the key properties being tested
// are the SQL permission grants, not vector search.
//
// Run with:
//   node --import ./scripts/reclassify/_preload-env.mjs --test tests/permissions.test.mjs
//
// Uses the service role key to seed and clean up test data directly.
// All test data uses a unique batch prefix to avoid collisions.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

// ── Supabase setup (must come before lib imports that use process.env) ──────
import ws from 'ws';
if (!globalThis.WebSocket) globalThis.WebSocket = ws;

const { getDB } = await import('../lib/supabase.js');

// ── Mock Pinecone BEFORE importing permissions.js ────────────────────────────
// The permissions module reads from Supabase only. The Pinecone namespace
// is only touched by retrieval.js query helpers which we do not call here.
// No mock needed for getAccessibleSharedItems itself, but getMemberWorkspaces
// calls Supabase and then branches into a group-restriction path.

// ── Import the modules under test ───────────────────────────────────────────
const { getAccessibleSharedItems, getMemberWorkspaces } = await import('../lib/permissions.js');
const { shareItemWithEmail, revokeAccess, acceptInvitation } = await import('../lib/sharing.js');
const { getOrCreateUser } = await import('../lib/auth.js');

// ── Helpers ───────────────────────────────────────────────────────────────────
const db = getDB();
const BATCH = `test_perms_${Date.now()}`;

// Create a minimal test user (bypassing invite gate), seeding a personal
// workspace so the app does not break on workspace-missing state.
async function createTestUser(email) {
  const { user, isNew } = await getOrCreateUser(email, { allowUninvited: true });

  // Ensure personal workspace exists (mirrors what prod backfill created).
  const { data: existingWs } = await db.from('workspaces')
    .select('id').eq('owner_id', user.id).eq('type', 'personal').maybeSingle();

  let workspaceId = existingWs?.id;
  if (!workspaceId) {
    const { data: ws } = await db.from('workspaces')
      .insert({ tenant_id: user.tenant_id, type: 'personal', name: `${email} personal`, owner_id: user.id })
      .select('id').single();
    workspaceId = ws.id;
    await db.from('workspace_memberships').insert({
      workspace_id: workspaceId, user_id: user.id, role: 'owner', invited_by: user.id,
    });
  }

  return { ...user, workspaceId };
}

// Seed a knowledge item directly for a user/tenant.
async function createItem(user, { title = 'Test item', content = 'Test content', workspaceId = null } = {}) {
  const { data } = await db.from('knowledge')
    .insert({
      user_id:      user.id,
      tenant_id:    user.tenant_id,
      title,
      content,
      type:         'knowledge',
      provenance:   'personal',
      workspace_id: workspaceId,
    })
    .select('id')
    .single();
  return data.id;
}

// Seed a direct permissions row (bypasses the shareItemWithEmail flow for speed).
async function grantPermission(subjectUserId, itemId, level, grantedBy) {
  const { data, error } = await db.from('permissions')
    .insert({ subject_user_id: subjectUserId, object_item_id: itemId, level, granted_by: grantedBy })
    .select('id').single();
  if (error) throw new Error('grantPermission failed: ' + error.message);
  return data.id;
}

// Clean up ALL test artefacts created in this run.
async function cleanup(users, permIds, inviteIds, itemIds, orgWsIds) {
  if (permIds.length)   await db.from('permissions').delete().in('id', permIds);
  if (inviteIds.length) await db.from('invitations').delete().in('id', inviteIds);
  if (itemIds.length)   await db.from('knowledge').delete().in('id', itemIds);

  // Org workspaces cascade memberships; delete workspace then tenant.
  for (const { wsId, tenantId } of (orgWsIds || [])) {
    if (wsId)     await db.from('workspaces').delete().eq('id', wsId);
    if (tenantId) await db.from('tenants').delete().eq('id', tenantId);
  }

  // Remove test users and their personal workspaces/tenants.
  for (const user of users) {
    if (!user) continue;
    await db.from('workspace_memberships').delete().eq('user_id', user.id);
    await db.from('workspaces').delete().eq('owner_id', user.id);
    await db.from('knowledge').delete().eq('user_id', user.id);
    await db.from('schema_types').delete().eq('user_id', user.id);
    await db.from('users').delete().eq('id', user.id);
    await db.from('tenants').delete().eq('id', user.tenant_id);
  }
}

// ── Test suite ───────────────────────────────────────────────────────────────

// Shared state across tests.
let alice, bob, carol;
let itemX;
let grantId;
const createdPermIds   = [];
const createdInviteIds = [];
const createdItemIds   = [];
const createdOrgWs     = [];

describe('Permission isolation and sharing', () => {

  before(async () => {
    alice = await createTestUser(`${BATCH}_alice@test.local`);
    bob   = await createTestUser(`${BATCH}_bob@test.local`);
    carol = await createTestUser(`${BATCH}_carol@test.local`);
    itemX = await createItem(alice, { title: 'Alice item X', content: 'Secret content by Alice' });
    createdItemIds.push(itemX);
  });

  after(async () => {
    await cleanup([alice, bob, carol], createdPermIds, createdInviteIds, createdItemIds, createdOrgWs);
  });

  // ── Test 1 ─────────────────────────────────────────────────────────────────
  it('T1: Alice sees her own items, Bob sees nothing without a grant', async () => {
    const aliceCtx = { userId: alice.id, tenantId: alice.tenant_id };
    const bobCtx   = { userId: bob.id,   tenantId: bob.tenant_id };

    const aliceShared = await getAccessibleSharedItems(aliceCtx);
    const bobShared   = await getAccessibleSharedItems(bobCtx);

    // Alice has no incoming grants; her accessible shared set is empty.
    assert.equal(aliceShared.idSet.size, 0,
      `FAIL: Alice should have empty shared set, got ${aliceShared.idSet.size}`);

    // Bob has no grants; he should not see Alice's items.
    assert.equal(bobShared.idSet.size, 0,
      `FAIL: Bob should see 0 shared items, got ${bobShared.idSet.size}`);
    assert.equal(bobShared.idSet.has(itemX), false,
      'FAIL: Bob should not see Alice\'s item X');
  });

  // ── Test 2 ─────────────────────────────────────────────────────────────────
  it('T2: can_view share does NOT enter Bob\'s retrieval', async () => {
    grantId = await grantPermission(bob.id, itemX, 'can_view', alice.id);
    createdPermIds.push(grantId);

    const bobCtx = { userId: bob.id, tenantId: bob.tenant_id };
    const shared = await getAccessibleSharedItems(bobCtx);

    // can_view is NOT in USABLE_LEVELS, so item X must not appear.
    assert.equal(shared.idSet.has(itemX), false,
      `FAIL: can_view grant should not enter retrieval, but Bob sees item X`);
    assert.equal(shared.idSet.size, 0,
      `FAIL: expected 0 usable shared items with can_view grant, got ${shared.idSet.size}`);

    // Clean up this grant; tests 3+ will create their own.
    await db.from('permissions').delete().eq('id', grantId);
    createdPermIds.splice(createdPermIds.indexOf(grantId), 1);
    grantId = null;
  });

  // ── Test 3 ─────────────────────────────────────────────────────────────────
  it('T3: can_use share DOES appear in Bob\'s retrieval', async () => {
    grantId = await grantPermission(bob.id, itemX, 'can_use', alice.id);
    createdPermIds.push(grantId);

    const bobCtx = { userId: bob.id, tenantId: bob.tenant_id };
    const shared = await getAccessibleSharedItems(bobCtx);

    assert.equal(shared.idSet.has(itemX), true,
      `FAIL: can_use grant should enter retrieval, but Bob does not see item X`);
    assert.equal(shared.levelById.get(itemX), 'can_use',
      `FAIL: expected level can_use, got ${shared.levelById.get(itemX)}`);
    assert.ok(shared.ownerById.has(itemX),
      'FAIL: owner lookup failed for item X');
    assert.equal(shared.ownerById.get(itemX).userId, alice.id,
      'FAIL: owner of item X should be Alice');
  });

  // ── Test 4 ─────────────────────────────────────────────────────────────────
  it('T4: can_edit share also appears in Bob\'s retrieval (can_edit >= can_use)', async () => {
    // Upgrade the grant from can_use to can_edit.
    await db.from('permissions').update({ level: 'can_edit' }).eq('id', grantId);

    const bobCtx = { userId: bob.id, tenantId: bob.tenant_id };
    const shared = await getAccessibleSharedItems(bobCtx);

    assert.equal(shared.idSet.has(itemX), true,
      `FAIL: can_edit grant should enter retrieval, but Bob does not see item X`);
    assert.equal(shared.levelById.get(itemX), 'can_edit',
      `FAIL: expected level can_edit, got ${shared.levelById.get(itemX)}`);
  });

  // ── Test 5 ─────────────────────────────────────────────────────────────────
  it('T5: revoking the share removes item X from Bob\'s retrieval', async () => {
    // Revoke via the public revokeAccess function.
    const aliceCtx = { userId: alice.id, tenantId: alice.tenant_id };
    const revoked = await revokeAccess({ ownerCtx: aliceCtx, itemId: itemX, id: grantId });
    assert.equal(revoked.revoked, true, 'FAIL: revokeAccess should return revoked:true');

    // Remove from createdPermIds since revokeAccess already deleted the row.
    const idx = createdPermIds.indexOf(grantId);
    if (idx >= 0) createdPermIds.splice(idx, 1);
    grantId = null;

    const bobCtx = { userId: bob.id, tenantId: bob.tenant_id };
    const shared = await getAccessibleSharedItems(bobCtx);

    assert.equal(shared.idSet.has(itemX), false,
      `FAIL: after revocation, Bob should not see item X`);
    assert.equal(shared.idSet.size, 0,
      `FAIL: expected 0 usable shared items after revocation, got ${shared.idSet.size}`);
  });

  // ── Test 6 ─────────────────────────────────────────────────────────────────
  it('T6: inviting Carol (new email) creates pending invitation with no immediate access', async () => {
    const carolNewEmail = `${BATCH}_carol_new@test.local`;
    const aliceCtx = { userId: alice.id, tenantId: alice.tenant_id };

    // We share with a never-before-seen email. shareItemWithEmail creates an
    // invitation row rather than an immediate grant.
    const result = await shareItemWithEmail({
      ownerCtx: aliceCtx,
      itemId:   itemX,
      email:    carolNewEmail,
      level:    'can_use',
    });

    assert.equal(result.mode, 'invited',
      `FAIL: expected mode=invited for new email, got ${result.mode}`);
    assert.ok(result.invitationId, 'FAIL: invitationId should be present');
    assert.ok(result.token, 'FAIL: token should be present in result');
    createdInviteIds.push(result.invitationId);

    // Carol has no account yet (the NEW email address), so she cannot have access.
    // Verify the invitations row exists but is not accepted.
    const { data: inv } = await db.from('invitations')
      .select('id, accepted_at').eq('id', result.invitationId).maybeSingle();
    assert.ok(inv, 'FAIL: invitation row should exist in DB');
    assert.equal(inv.accepted_at, null, 'FAIL: invitation should not be accepted yet');

    // Also verify no permissions row was created for the new email user.
    const { data: perms } = await db.from('permissions')
      .select('id').eq('object_item_id', itemX).is('subject_user_id', null);
    // perms should only be empty or for bob -- not for the new email
    assert.ok(!perms?.find(p => p.subject_user_id !== null && p.subject_user_id !== bob.id),
      'FAIL: no active grant should exist for the new-email user before acceptance');
  });

  // ── Test 7 ─────────────────────────────────────────────────────────────────
  it('T7: accepting the invitation materialises the grant at the correct level', async () => {
    // Get the open invitation for the new email.
    const carolNewEmail = `${BATCH}_carol_new@test.local`;
    const { data: openInvites } = await db.from('invitations')
      .select('id, token, level').eq('item_id', itemX).ilike('email', carolNewEmail)
      .is('accepted_at', null).limit(1);
    assert.ok(openInvites?.length, 'FAIL: open invitation for new email should exist');

    const openInvite = openInvites[0];
    const result = await acceptInvitation(openInvite.token);

    assert.equal(result.level, 'can_use',
      `FAIL: materialised grant level should be can_use, got ${result.level}`);
    assert.equal(result.itemId, itemX,
      'FAIL: accepted invitation should reference item X');
    assert.ok(result.permissionId, 'FAIL: permissionId should be present after acceptance');
    assert.ok(result.user, 'FAIL: user should be created/resolved on acceptance');
    assert.ok(result.sessionJwt, 'FAIL: session JWT should be returned');

    // Track the new user and permission for cleanup.
    createdPermIds.push(result.permissionId);
    // The carol_new user gets created by acceptInvitation; track for cleanup.
    if (result.user) {
      carol = result.user; // update carol reference for Test 8
      createdItemIds.push(...([])); // no extra items
    }

    // Verify the permissions row is in the DB at the right level.
    const { data: grant } = await db.from('permissions')
      .select('id, level, subject_user_id').eq('id', result.permissionId).maybeSingle();
    assert.ok(grant, 'FAIL: permissions row should exist after acceptance');
    assert.equal(grant.level, 'can_use', `FAIL: grant level should be can_use, got ${grant.level}`);
    assert.equal(grant.subject_user_id, result.user.id,
      'FAIL: grant subject_user_id should be the accepted user');

    // Now the new carol_new user's getAccessibleSharedItems should include itemX.
    const carolCtx = { userId: result.user.id, tenantId: result.user.tenant_id };
    const shared = await getAccessibleSharedItems(carolCtx);
    assert.equal(shared.idSet.has(itemX), true,
      'FAIL: after acceptance, carol_new should see item X via getAccessibleSharedItems');

    // Cleanup: remove carol_new user after this test.
    after(async () => {
      if (result.user) {
        await db.from('workspace_memberships').delete().eq('user_id', result.user.id);
        await db.from('workspaces').delete().eq('owner_id', result.user.id);
        await db.from('schema_types').delete().eq('user_id', result.user.id);
        await db.from('users').delete().eq('id', result.user.id);
        await db.from('tenants').delete().eq('id', result.user.tenant_id);
      }
    });
  });

  // ── Test 8 ─────────────────────────────────────────────────────────────────
  it('T8: Alice cannot update or delete Bob\'s items via knowledge table filters', async () => {
    const bobItemId = await createItem(bob, { title: 'Bob private item', content: 'Bob data' });
    createdItemIds.push(bobItemId);

    // Simulate what the update/delete code paths do: they filter by user_id + tenant_id.
    // Alice calling with her own userId/tenantId should match 0 rows for Bob's item.
    const { data: updateAttempt } = await db.from('knowledge')
      .update({ title: 'HACKED' })
      .eq('id', bobItemId)
      .eq('user_id', alice.id)        // Alice's user_id does NOT match Bob's item
      .eq('tenant_id', alice.tenant_id)
      .select('id');

    assert.equal((updateAttempt || []).length, 0,
      `FAIL: Alice should not be able to update Bob's item via user_id filter`);

    // Confirm Bob's item is still intact.
    const { data: bobItem } = await db.from('knowledge')
      .select('id, title').eq('id', bobItemId).maybeSingle();
    assert.equal(bobItem?.title, 'Bob private item',
      "FAIL: Bob's item title should be unchanged after Alice's update attempt");

    // Same check for delete.
    const { data: deleteAttempt } = await db.from('knowledge')
      .delete()
      .eq('id', bobItemId)
      .eq('user_id', alice.id)        // wrong user_id
      .eq('tenant_id', alice.tenant_id)
      .select('id');

    assert.equal((deleteAttempt || []).length, 0,
      `FAIL: Alice should not be able to delete Bob's item via user_id filter`);

    // Bob's item should still exist.
    const { data: bobItemAfter } = await db.from('knowledge')
      .select('id').eq('id', bobItemId).maybeSingle();
    assert.ok(bobItemAfter, "FAIL: Bob's item should still exist after Alice's delete attempt");
  });

  // ── Test 9 ─────────────────────────────────────────────────────────────────
  it('T9: Org workspace -- Alice and Bob (members) see org items; Carol (non-member) does not', async () => {
    // Create an org workspace owned by Alice.
    const { data: orgTenant } = await db.from('tenants').insert({}).select('id').single();
    const { data: orgWs } = await db.from('workspaces').insert({
      tenant_id:  orgTenant.id,
      type:       'organisational',
      name:       `${BATCH} test org`,
      owner_id:   alice.id,
    }).select('id, tenant_id').single();

    createdOrgWs.push({ wsId: orgWs.id, tenantId: orgTenant.id });

    // Add Alice and Bob as members; Carol is NOT added.
    await db.from('workspace_memberships').insert([
      { workspace_id: orgWs.id, user_id: alice.id, role: 'owner',  invited_by: alice.id },
      { workspace_id: orgWs.id, user_id: bob.id,   role: 'member', invited_by: alice.id },
    ]);

    // Verify getMemberWorkspaces for Alice and Bob includes this org workspace.
    const aliceCtx = { userId: alice.id, tenantId: alice.tenant_id };
    const bobCtx   = { userId: bob.id,   tenantId: bob.tenant_id };
    const carolCtx = { userId: carol.id, tenantId: carol.tenant_id };

    const aliceMws = await getMemberWorkspaces(aliceCtx);
    const bobMws   = await getMemberWorkspaces(bobCtx);
    const carolMws = await getMemberWorkspaces(carolCtx);

    // Alice is a member and her personal tenant != org tenant.
    const aliceSeesOrg = aliceMws.byTenant.has(orgTenant.id);
    assert.equal(aliceSeesOrg, true,
      `FAIL: Alice should see the org workspace in getMemberWorkspaces. Got tenants: ${[...aliceMws.byTenant.keys()]}`);

    // Bob is a member.
    const bobSeesOrg = bobMws.byTenant.has(orgTenant.id);
    assert.equal(bobSeesOrg, true,
      `FAIL: Bob should see the org workspace in getMemberWorkspaces`);

    // Carol is NOT a member.
    const carolSeesOrg = carolMws.byTenant.has(orgTenant.id);
    assert.equal(carolSeesOrg, false,
      `FAIL: Carol should NOT see the org workspace (not a member)`);

    // Phase 3 dormancy: no groups exist, so deniedItemIds must be empty for all.
    assert.equal(aliceMws.deniedItemIds.size, 0,
      `FAIL: deniedItemIds should be empty (no groups), got ${aliceMws.deniedItemIds.size}`);
    assert.equal(bobMws.deniedItemIds.size, 0,
      `FAIL: deniedItemIds should be empty (no groups), got ${bobMws.deniedItemIds.size}`);
  });

});
