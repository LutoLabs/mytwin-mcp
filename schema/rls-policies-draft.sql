-- rls-policies-draft.sql
-- Draft RLS policies for the Phase 1 workspace/permissions tables.
--
-- STATUS: DRAFT ONLY. Do NOT apply without human review.
--
-- IMPORTANT CONTEXT: This application uses its OWN JWT system (lib/auth.js,
-- jose library, JWT_SECRET env var). It does NOT use Supabase Auth, so
-- auth.uid() / auth.jwt() are NEVER populated for any request coming through
-- the app layer. ALL database access happens via the service role key (which
-- bypasses RLS entirely). This means:
--
--   * RLS policies using auth.uid() would provide ZERO protection for
--     the actual application -- the service role always skips them.
--
--   * The real security boundary IS the application layer (lib/sharing.js,
--     lib/permissions.js, lib/auth.js, the requireAuth middleware).
--
--   * What RLS DOES protect against: direct Supabase dashboard queries,
--     the PostgREST REST API calls with an anon key, and future MCP direct
--     DB integrations that don't use the service role.
--
-- CURRENT STATE (verified 2026-06-02 via live pg_policies query):
--   * All 6 new tables have ENABLE ROW LEVEL SECURITY.
--   * Zero CREATE POLICY statements exist for any of these tables.
--   * With RLS enabled + no policies: the default is DENY ALL for
--     non-service-role roles. Tested empirically: unauthenticated REST calls
--     return 0 rows (correct). The service role bypasses this and sees all rows.
--
-- VERDICT: The tables are currently "deny all to non-service-role" which is
-- the safest default. The app itself is not protected by RLS (it uses service
-- role), but direct API access is locked down.
--
-- These policies are BELT-AND-BRACES: they add meaningful protection IF the
-- app is ever switched to use Supabase Auth JWTs, or if a Supabase function /
-- MCP integration uses user-scoped keys. Apply them as a defence-in-depth
-- measure -- they do NOT replace the application-layer permission checks.
--
-- The policies reference auth.uid() which maps to the user row id. For this
-- to work with the current custom-JWT auth, you would need to either:
--   a) Switch to Supabase Auth (requires auth migration), OR
--   b) Create a custom auth function using the JWT_SECRET + jose pattern, OR
--   c) Keep the policies as "deny all by default" (current state) and rely
--      solely on the application layer.
--
-- RECOMMENDATION: Apply these policies as-is. They tighten the posture for
-- any future direct-DB access paths. The application layer (service role) is
-- unaffected and will continue to work correctly.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- HELPER: membership check used in multiple policies below.
-- Returns true if the calling user is a member of the given workspace.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.is_workspace_member(ws_id uuid)
returns boolean language sql security definer stable as $$
  select exists (
    select 1 from public.workspace_memberships
    where workspace_id = ws_id and user_id = auth.uid()
  );
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- workspaces
--   * Any member (including owner via workspace_memberships) can SELECT.
--   * Only the owner can UPDATE or DELETE.
--   * Anyone authenticated can INSERT (app creates personal workspaces for new
--     users; the owner_id must match the creating user).
-- ─────────────────────────────────────────────────────────────────────────────

-- Allow a user to read any workspace they are a member of.
create policy "workspace_members_can_select"
  on public.workspaces for select
  using (is_workspace_member(id));

-- Allow a user to insert a workspace where they are the owner.
create policy "workspace_owner_can_insert"
  on public.workspaces for insert
  with check (owner_id = auth.uid());

-- Allow only the owner to update the workspace.
create policy "workspace_owner_can_update"
  on public.workspaces for update
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- Allow only the owner to delete the workspace.
create policy "workspace_owner_can_delete"
  on public.workspaces for delete
  using (owner_id = auth.uid());

-- ─────────────────────────────────────────────────────────────────────────────
-- workspace_memberships
--   * A user can see their own memberships, and any memberships in workspaces
--     they own (so owners can list their workspace's members).
--   * Only workspace owners and admins can insert/update/delete memberships.
-- ─────────────────────────────────────────────────────────────────────────────

-- A user sees memberships in workspaces they are a member of (needed so they
-- can see the roster), plus their own membership row regardless of workspace.
create policy "members_can_select_workspace_memberships"
  on public.workspace_memberships for select
  using (
    user_id = auth.uid()
    or is_workspace_member(workspace_id)
  );

-- Only workspace owners or admins can insert new memberships.
create policy "owners_admins_can_insert_memberships"
  on public.workspace_memberships for insert
  with check (
    exists (
      select 1 from public.workspace_memberships m
      where m.workspace_id = workspace_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'admin')
    )
  );

-- Only owners or admins can update memberships.
create policy "owners_admins_can_update_memberships"
  on public.workspace_memberships for update
  using (
    exists (
      select 1 from public.workspace_memberships m
      where m.workspace_id = workspace_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'admin')
    )
  );

-- Only owners or admins can delete memberships.
create policy "owners_admins_can_delete_memberships"
  on public.workspace_memberships for delete
  using (
    exists (
      select 1 from public.workspace_memberships m
      where m.workspace_id = workspace_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'admin')
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- permissions (the grants table)
--   * The subject user (the one who received the grant) can see their own
--     grants so they can reason about what is shared with them.
--   * The granter (granted_by) can see and manage the grants they issued.
--   * No one else can see grants -- the object content may be sensitive.
-- ─────────────────────────────────────────────────────────────────────────────

-- Recipient can see grants addressed to them.
create policy "recipient_can_select_own_grants"
  on public.permissions for select
  using (subject_user_id = auth.uid() or granted_by = auth.uid());

-- Only the granter (object owner) can insert a grant.
-- Note: the application already verifies item ownership before calling
-- shareItemWithEmail; this policy is belt-and-braces.
create policy "granter_can_insert_grant"
  on public.permissions for insert
  with check (granted_by = auth.uid());

-- Only the granter can update the grant level.
create policy "granter_can_update_grant"
  on public.permissions for update
  using (granted_by = auth.uid())
  with check (granted_by = auth.uid());

-- Only the granter can revoke (delete) the grant.
create policy "granter_can_delete_grant"
  on public.permissions for delete
  using (granted_by = auth.uid());

-- ─────────────────────────────────────────────────────────────────────────────
-- invitations
--   * A specific token lookup is public (anonymous can look up by token for
--     the accept flow). But we limit it to the minimal fields needed -- the
--     application's getInvitationByToken does this via service role, so this
--     policy is for any future direct-API path.
--   * The granter can see and manage their own invitations.
--   * IMPORTANT: the token is the bearer secret. A policy that exposed full
--     invitation rows to "anyone" would leak tokens. We allow token-specific
--     SELECT via the application layer (service role), not via RLS.
-- ─────────────────────────────────────────────────────────────────────────────

-- Granter can see all their invitations for the items they own.
create policy "granter_can_select_invitations"
  on public.invitations for select
  using (invited_by = auth.uid());

-- Granter can insert invitations.
create policy "granter_can_insert_invitation"
  on public.invitations for insert
  with check (invited_by = auth.uid());

-- Granter can update (e.g. resend with new level).
create policy "granter_can_update_invitation"
  on public.invitations for update
  using (invited_by = auth.uid())
  with check (invited_by = auth.uid());

-- Granter can revoke (delete) pending invitations.
create policy "granter_can_delete_invitation"
  on public.invitations for delete
  using (invited_by = auth.uid());

-- ─────────────────────────────────────────────────────────────────────────────
-- permission_groups (Phase 3 -- created dormant, no data in Phase 1)
--   * Workspace members can read groups in their workspace.
--   * Workspace owners and admins can manage groups.
-- ─────────────────────────────────────────────────────────────────────────────

create policy "workspace_members_can_see_groups"
  on public.permission_groups for select
  using (is_workspace_member(workspace_id));

create policy "owners_admins_can_insert_groups"
  on public.permission_groups for insert
  with check (
    exists (
      select 1 from public.workspace_memberships m
      where m.workspace_id = workspace_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'admin')
    )
  );

create policy "owners_admins_can_update_groups"
  on public.permission_groups for update
  using (
    exists (
      select 1 from public.workspace_memberships m
      where m.workspace_id = workspace_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'admin')
    )
  );

create policy "owners_admins_can_delete_groups"
  on public.permission_groups for delete
  using (
    exists (
      select 1 from public.workspace_memberships m
      where m.workspace_id = workspace_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'admin')
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- permission_group_members (Phase 3 -- dormant)
--   * Group members can see their own membership.
--   * Workspace owners and admins manage membership.
-- ─────────────────────────────────────────────────────────────────────────────

create policy "own_group_membership_select"
  on public.permission_group_members for select
  using (
    user_id = auth.uid()
    or exists (
      select 1 from public.permission_groups g
      join public.workspace_memberships m on m.workspace_id = g.workspace_id
      where g.id = group_id and m.user_id = auth.uid() and m.role in ('owner', 'admin')
    )
  );

create policy "owners_admins_can_insert_group_members"
  on public.permission_group_members for insert
  with check (
    exists (
      select 1 from public.permission_groups g
      join public.workspace_memberships m on m.workspace_id = g.workspace_id
      where g.id = group_id and m.user_id = auth.uid() and m.role in ('owner', 'admin')
    )
  );

create policy "owners_admins_can_delete_group_members"
  on public.permission_group_members for delete
  using (
    exists (
      select 1 from public.permission_groups g
      join public.workspace_memberships m on m.workspace_id = g.workspace_id
      where g.id = group_id and m.user_id = auth.uid() and m.role in ('owner', 'admin')
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- knowledge -- extending existing RLS (if any) to cover workspace members.
--
-- Note: the knowledge table may ALREADY have policies. Check pg_policies
-- before applying. If it already has a SELECT policy, add a permissive
-- sub-policy or amend the existing one rather than creating a duplicate.
--
-- This policy extends access to workspace members for org workspace items.
-- Personal items remain protected by the existing tenant_id + user_id filter.
-- ─────────────────────────────────────────────────────────────────────────────

-- Allow workspace MEMBERS to read knowledge items that belong to their
-- workspace (workspace_id is set) in an organisational workspace.
-- This is additive: if a "owner can always read own items" policy already
-- exists, this just opens the additional membership path.
create policy "workspace_members_can_read_workspace_knowledge"
  on public.knowledge for select
  using (
    workspace_id is not null
    and exists (
      select 1 from public.workspaces w
      join public.workspace_memberships m on m.workspace_id = w.id
      where w.id = workspace_id
        and w.type = 'organisational'
        and m.user_id = auth.uid()
    )
  );
