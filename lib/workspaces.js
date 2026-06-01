// Phase 2: organisation workspaces.
//
// An org workspace is its OWN tenant (its own Pinecone namespace), with members
// linked via workspace_memberships. This keeps org content isolated in the org
// namespace; the asymmetric ratchet is preserved because nothing here ever
// copies org content into a member's personal tenant (contribution lives in
// lib/contribution.js and is one-directional, personal -> org only).
//
// This module owns workspace CRUD, membership management, and the workspace
// invitation accept flow. Roles: owner > admin > member > guest. New-email
// invitees join as 'member' and can be promoted by an owner/admin.

import { randomBytes } from 'node:crypto';
import { getDB } from './supabase.js';
import { getOrCreateUser, createSessionToken } from './auth.js';
import { sendShareEmail } from './sharing.js';

const APP_URL = (process.env.APP_URL || 'https://myaitwin.lutolearn.com').replace(/\/+$/, '');
const MANAGE_ROLES = new Set(['owner', 'admin']);
const ASSIGNABLE_ROLES = ['admin', 'member', 'guest']; // owner is never assigned by hand

function wsError(message, status) { const e = new Error(message); e.userFacing = true; if (status) e.status = status; return e; }
function newToken() { return randomBytes(48).toString('hex'); }
function isValidEmail(s) { return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim()); }

async function membershipOf(db, workspaceId, userId) {
  const { data } = await db.from('workspace_memberships')
    .select('id, role').eq('workspace_id', workspaceId).eq('user_id', userId).maybeSingle();
  return data || null;
}

// ── Create ────────────────────────────────────────────────────────────────────
export async function createOrgWorkspace({ ctx, name }) {
  const trimmed = (name || '').trim();
  if (!trimmed) throw wsError('A workspace name is required.', 400);
  if (trimmed.length > 80) throw wsError('That workspace name is too long.', 400);
  const db = getDB();

  // The workspace gets its own tenant, hence its own Pinecone namespace.
  const { data: tenant, error: tErr } = await db.from('tenants').insert({}).select('id').single();
  if (tErr) throw wsError('Could not create the workspace.', 500);

  const { data: ws, error: wErr } = await db.from('workspaces').insert({
    tenant_id: tenant.id, type: 'organisational', name: trimmed, owner_id: ctx.userId,
  }).select('id, name, type, owner_id, tenant_id, created_at').single();
  if (wErr) {
    await db.from('tenants').delete().eq('id', tenant.id);
    throw wsError('Could not create the workspace.', 500);
  }

  await db.from('workspace_memberships').insert({
    workspace_id: ws.id, user_id: ctx.userId, role: 'owner', invited_by: ctx.userId,
  });

  return { id: ws.id, name: ws.name, type: ws.type, role: 'owner', is_owner: true,
    tenant_id: ws.tenant_id, member_count: 1, created_at: ws.created_at };
}

// ── List mine ───────────────────────────────────────────────────────────────
export async function listMyWorkspaces(ctx) {
  const db = getDB();
  const { data: memberships } = await db.from('workspace_memberships')
    .select('role, workspaces!inner(id, name, type, owner_id, created_at)')
    .eq('user_id', ctx.userId);
  const rows = (memberships || []).filter(m => m.workspaces && m.workspaces.type === 'organisational');

  const ids = rows.map(m => m.workspaces.id);
  const counts = new Map();
  if (ids.length) {
    const { data: members } = await db.from('workspace_memberships').select('workspace_id').in('workspace_id', ids);
    (members || []).forEach(m => counts.set(m.workspace_id, (counts.get(m.workspace_id) || 0) + 1));
  }

  return {
    workspaces: rows.map(m => ({
      id: m.workspaces.id, name: m.workspaces.name, type: m.workspaces.type,
      role: m.role, is_owner: m.workspaces.owner_id === ctx.userId,
      member_count: counts.get(m.workspaces.id) || 1, created_at: m.workspaces.created_at,
    })).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)),
  };
}

// ── Detail ────────────────────────────────────────────────────────────────────
export async function getWorkspaceForMember({ ctx, workspaceId }) {
  const db = getDB();
  const mem = await membershipOf(db, workspaceId, ctx.userId);
  if (!mem) throw wsError('Workspace not found.', 404);
  const { data: ws } = await db.from('workspaces')
    .select('id, name, type, owner_id, tenant_id, created_at').eq('id', workspaceId).maybeSingle();
  if (!ws) throw wsError('Workspace not found.', 404);
  return { id: ws.id, name: ws.name, type: ws.type, role: mem.role,
    is_owner: ws.owner_id === ctx.userId, can_manage: MANAGE_ROLES.has(mem.role), created_at: ws.created_at };
}

// ── Members ───────────────────────────────────────────────────────────────────
export async function listMembers({ ctx, workspaceId }) {
  const db = getDB();
  const mem = await membershipOf(db, workspaceId, ctx.userId);
  if (!mem) throw wsError('Workspace not found.', 404);
  // workspace_memberships has two FKs to users (user_id + invited_by), which
  // makes a PostgREST embed on `users` ambiguous. Resolve emails separately.
  const { data: rows } = await db.from('workspace_memberships')
    .select('user_id, role, joined_at').eq('workspace_id', workspaceId);
  const userIds = [...new Set((rows || []).map(r => r.user_id))];
  let emailById = new Map();
  if (userIds.length) {
    const { data: users } = await db.from('users').select('id, email').in('id', userIds);
    emailById = new Map((users || []).map(u => [u.id, u.email]));
  }
  const { data: pending } = await db.from('invitations')
    .select('id, email, invited_at').eq('workspace_id', workspaceId).is('accepted_at', null);
  return {
    members: (rows || []).map(m => ({ user_id: m.user_id, email: emailById.get(m.user_id) || null, role: m.role, joined_at: m.joined_at }))
      .sort((a, b) => new Date(a.joined_at) - new Date(b.joined_at)),
    pending: (pending || []).map(p => ({ invitation_id: p.id, email: p.email, invited_at: p.invited_at })),
    your_role: mem.role, can_manage: MANAGE_ROLES.has(mem.role),
  };
}

export async function addMember({ ctx, workspaceId, email, role = 'member' }) {
  if (!isValidEmail(email)) throw wsError('A valid email is required.', 400);
  if (!ASSIGNABLE_ROLES.includes(role)) throw wsError('Invalid role.', 400);
  const db = getDB();
  const mem = await membershipOf(db, workspaceId, ctx.userId);
  if (!mem) throw wsError('Workspace not found.', 404);
  if (!MANAGE_ROLES.has(mem.role)) throw wsError('Only an owner or admin can add members.', 403);

  const { data: ws } = await db.from('workspaces').select('id, name').eq('id', workspaceId).maybeSingle();
  if (!ws) throw wsError('Workspace not found.', 404);

  const recipient = email.trim().toLowerCase();
  const { data: inviter } = await db.from('users').select('email').eq('id', ctx.userId).maybeSingle();
  const { data: existing } = await db.from('users').select('id, email').ilike('email', recipient).maybeSingle();

  if (existing) {
    if (existing.id === ctx.userId) throw wsError('You are already in this workspace.', 400);
    const already = await membershipOf(db, workspaceId, existing.id);
    if (already) {
      if (already.role !== 'owner' && already.role !== role) {
        await db.from('workspace_memberships').update({ role }).eq('id', already.id);
      }
      return { mode: 'added', email: existing.email, role };
    }
    await db.from('workspace_memberships').insert({
      workspace_id: workspaceId, user_id: existing.id, role, invited_by: ctx.userId,
    });
    return {
      mode: 'added', email: existing.email, role,
      emailPayload: buildWorkspaceEmail({ to: existing.email, workspaceName: ws.name, inviter: inviter?.email, token: null }),
    };
  }

  // New email -> workspace invitation. invitations.level is required by the
  // schema but irrelevant for workspace membership, so it carries a benign
  // default; the accepted member joins as 'member'.
  const { data: openInv } = await db.from('invitations')
    .select('id, token').eq('workspace_id', workspaceId).ilike('email', recipient).is('accepted_at', null).maybeSingle();
  let token = openInv?.token;
  if (openInv) {
    await db.from('invitations').update({ invited_by: ctx.userId }).eq('id', openInv.id);
  } else {
    token = newToken();
    const { error } = await db.from('invitations').insert({
      email: recipient, workspace_id: workspaceId, item_id: null, level: 'can_use',
      invited_by: ctx.userId, token,
    });
    if (error) throw wsError('Could not create the invitation.', 500);
  }
  return {
    mode: 'invited', email: recipient, role: 'member', token,
    emailPayload: buildWorkspaceEmail({ to: recipient, workspaceName: ws.name, inviter: inviter?.email, token }),
  };
}

export async function changeMemberRole({ ctx, workspaceId, userId, role }) {
  if (!ASSIGNABLE_ROLES.includes(role)) throw wsError('Invalid role.', 400);
  const db = getDB();
  const mem = await membershipOf(db, workspaceId, ctx.userId);
  if (!mem || !MANAGE_ROLES.has(mem.role)) throw wsError('Only an owner or admin can change roles.', 403);
  const target = await membershipOf(db, workspaceId, userId);
  if (!target) throw wsError('That person is not a member.', 404);
  if (target.role === 'owner') throw wsError('The owner role cannot be changed here.', 400);
  await db.from('workspace_memberships').update({ role }).eq('id', target.id);
  return { user_id: userId, role };
}

export async function removeMember({ ctx, workspaceId, userId }) {
  const db = getDB();
  const mem = await membershipOf(db, workspaceId, ctx.userId);
  if (!mem) throw wsError('Workspace not found.', 404);
  const target = await membershipOf(db, workspaceId, userId);
  if (!target) throw wsError('That person is not a member.', 404);
  if (target.role === 'owner') throw wsError('The owner cannot be removed.', 400);
  // A member may remove themselves; otherwise an owner/admin may remove others.
  if (userId !== ctx.userId && !MANAGE_ROLES.has(mem.role)) {
    throw wsError('Only an owner or admin can remove members.', 403);
  }
  await db.from('workspace_memberships').delete().eq('id', target.id);
  return { removed: true, user_id: userId };
}

// ── Workspace invitation lookup + accept ──────────────────────────────────────
export async function getWorkspaceInvitation(token) {
  if (typeof token !== 'string' || !token) return null;
  const db = getDB();
  const { data: inv } = await db.from('invitations')
    .select('email, accepted_at, invited_at, invited_by, workspace_id')
    .eq('token', token).not('workspace_id', 'is', null).maybeSingle();
  if (!inv) return null;
  const { data: ws } = await db.from('workspaces').select('name, type').eq('id', inv.workspace_id).maybeSingle();
  const { data: inviter } = await db.from('users').select('email').eq('id', inv.invited_by).maybeSingle();
  return {
    email: inv.email,
    accepted: !!inv.accepted_at,
    invited_at: inv.invited_at,
    invited_by_email: inviter?.email || null,
    workspace: ws ? { name: ws.name, type: ws.type } : null,
  };
}

export async function acceptWorkspaceInvitation(token) {
  if (typeof token !== 'string' || !token) throw wsError('Invalid invitation.', 400);
  const db = getDB();

  // Atomic single-use claim.
  const { data: claimed, error } = await db.from('invitations')
    .update({ accepted_at: new Date().toISOString() })
    .eq('token', token).not('workspace_id', 'is', null).is('accepted_at', null)
    .select('email, workspace_id').maybeSingle();
  if (error)   throw wsError('Could not accept the invitation.', 500);
  if (!claimed) throw wsError('This invitation link is invalid or has already been used.', 410);

  const { user } = await getOrCreateUser(claimed.email, { allowUninvited: true });

  // Idempotent membership; new members join as 'member'.
  const existing = await membershipOf(db, claimed.workspace_id, user.id);
  if (!existing) {
    await db.from('workspace_memberships').insert({
      workspace_id: claimed.workspace_id, user_id: user.id, role: 'member', invited_by: null,
    });
  }

  const sessionJwt = await createSessionToken(user.id, user.email);
  return { user, workspaceId: claimed.workspace_id, sessionJwt };
}

// ── Email ─────────────────────────────────────────────────────────────────────
function buildWorkspaceEmail({ to, workspaceName, inviter, token }) {
  const who = inviter ? `${inviter} added you to` : 'You have been added to';
  const heading = `${workspaceName} on MyAITwin`;
  const url = token ? `${APP_URL}/twin?winvite=${encodeURIComponent(token)}` : `${APP_URL}/twin`;
  const body = token
    ? `${who} the workspace "${workspaceName}". Accept to join. If you do not have an account yet, accepting creates one for ${to}.`
    : `${who} the workspace "${workspaceName}". Open your twin to see what the team shares.`;
  return {
    to,
    subject: token ? `Join ${workspaceName} on MyAITwin` : `You were added to ${workspaceName}`,
    html: minimalBrandHtml({ heading, body, ctaUrl: url, ctaLabel: token ? 'Join workspace' : 'Open your twin' }),
    text: `${heading}\n\n${body}\n\n${url}\n`,
  };
}

// Compact Luto-brand email shell (kept local so lib/sharing.js stays untouched).
function minimalBrandHtml({ heading, body, ctaUrl, ctaLabel }) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!DOCTYPE html><html><body style="margin:0;background:#FDFCFA;font-family:Inter,Arial,sans-serif;color:#0F0E0D;">
  <div style="max-width:480px;margin:0 auto;padding:36px 28px;">
    <div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#857C6E;margin-bottom:18px;">MyAITwin by Luto</div>
    <h1 style="font-family:Georgia,serif;font-size:24px;line-height:1.2;margin:0 0 14px;">${esc(heading)}</h1>
    <p style="font-size:15px;line-height:1.6;color:#3A352E;margin:0 0 24px;">${esc(body)}</p>
    <a href="${esc(ctaUrl)}" style="display:inline-block;background:#FFE34A;color:#0F0E0D;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:9px;border:1.5px solid #0F0E0D;">${esc(ctaLabel)}</a>
    <p style="font-size:12px;color:#857C6E;margin:28px 0 0;">If you were not expecting this, you can ignore this email.</p>
  </div></body></html>`;
}

export { sendShareEmail as sendWorkspaceEmail };
