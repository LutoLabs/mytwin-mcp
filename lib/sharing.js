// Phase 1 personal sharing: grant ONE knowledge item to another person by
// email at one of five levels. The AI-native levels (can_use and above) are
// what make a shared item usable by the recipient's twin; lib/permissions.js
// consumes the resulting grants during retrieval.
//
// Two recipient paths:
//   * Existing user  -> create/update a `permissions` row immediately, then
//                       notify them by email. No acceptance step needed.
//   * New email      -> create/update a pending `invitations` row carrying a
//                       single-use magic token, then email the accept link.
//                       Accepting materialises the grant AND bypasses the
//                       invite-only signup gate (being invited to a shared
//                       item is itself the invitation).
//
// Owner-only: only the item's owner (knowledge.user_id) may share it. A
// can_edit / full_access recipient cannot re-share in Phase 1 (the door stays
// closed by simply not opening it).

import { randomBytes } from 'node:crypto';
import { Resend } from 'resend';
import { getDB } from './supabase.js';
import { getOrCreateUser, createSessionToken } from './auth.js';
import { BRAND_NAME, BRAND_BYLINE, BRAND_FULL, APP_URL, APP_HOST } from './brand.js';

// Ordered least -> most permissive. Mirrors the CHECK constraint in
// migration 018. lib/permissions.js owns the subset that enters retrieval.
export const SHARE_LEVELS = ['can_view', 'can_comment', 'can_use', 'can_edit', 'full_access'];

// Human-readable phrase per level, used in notification copy.
const LEVEL_PHRASE = {
  can_view:    'view it',
  can_comment: 'view and comment on it',
  can_use:     'let their twin draw on it',
  can_edit:    'edit it (and their twin can draw on it)',
  full_access: 'full access (their twin can draw on it)',
};


function isValidEmail(str) {
  return typeof str === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str);
}

function userError(message, status) {
  const e = new Error(message);
  e.userFacing = true;
  if (status) e.status = status;
  return e;
}

function newInvitationToken() {
  // 48 random bytes -> 96 hex chars. Bearer secret for the accept magic link.
  return randomBytes(48).toString('hex');
}

// Verify the caller owns the item; return its title/type for email copy.
// Throws a userFacing error otherwise (404 if missing, 403 if not the owner).
async function requireOwnedItem(db, ownerCtx, itemId) {
  if (typeof itemId !== 'string' || !itemId) throw userError('Item id is required.', 400);
  const { data: item, error } = await db
    .from('knowledge')
    .select('id, user_id, tenant_id, title, type')
    .eq('id', itemId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!item) throw userError('Item not found.', 404);
  if (item.user_id !== ownerCtx.userId) throw userError('You can only share items you own.', 403);
  return item;
}

// ── Share ────────────────────────────────────────────────────────────────────

// Returns one of:
//   { mode:'granted', level, recipientEmail, permissionId, email }
//   { mode:'invited', level, recipientEmail, invitationId, token, email }
// `email` is a ready-to-send payload { to, subject, html, text }; the route
// dispatches it best-effort so a delivery hiccup never voids the grant.
export async function shareItemWithEmail({ ownerCtx, itemId, email, level }) {
  const db = getDB();
  if (!isValidEmail(email))         throw userError('A valid email is required.', 400);
  if (!SHARE_LEVELS.includes(level)) throw userError('Invalid permission level.', 400);
  const recipientEmail = email.toLowerCase().trim();

  const item = await requireOwnedItem(db, ownerCtx, itemId);

  // Resolve the sharer's email for notification copy + self-share guard.
  const { data: sharer } = await db.from('users').select('email').eq('id', ownerCtx.userId).maybeSingle();
  const sharerEmail = (sharer?.email || '').toLowerCase();
  if (recipientEmail === sharerEmail) throw userError('That item is already yours.', 400);

  // Does a real account already exist for this email?
  const { data: existingUser } = await db.from('users').select('id').eq('email', recipientEmail).maybeSingle();

  if (existingUser) {
    // Immediate grant. Idempotent: a re-share updates the level in place so the
    // owner's latest decision wins (and we never accumulate duplicate rows).
    const { data: prior } = await db.from('permissions')
      .select('id')
      .eq('subject_user_id', existingUser.id)
      .eq('object_item_id', itemId)
      .limit(1);
    const priorRow = prior?.[0] || null;

    let permissionId;
    if (priorRow) {
      const { data, error } = await db.from('permissions')
        .update({ level, granted_by: ownerCtx.userId, granted_at: new Date().toISOString() })
        .eq('id', priorRow.id)
        .select('id')
        .single();
      if (error) throw new Error(error.message);
      permissionId = data.id;
    } else {
      const { data, error } = await db.from('permissions')
        .insert({ subject_user_id: existingUser.id, object_item_id: itemId, level, granted_by: ownerCtx.userId })
        .select('id')
        .single();
      if (error) throw new Error(error.message);
      permissionId = data.id;
    }

    return {
      mode: 'granted',
      level,
      recipientEmail,
      permissionId,
      email: buildNotificationEmail({ to: recipientEmail, sharerEmail, item, level }),
    };
  }

  // New email -> pending invitation. Idempotent on (email, item) while unaccepted:
  // reuse the existing token so an already-sent link keeps working.
  const { data: priorInvites } = await db.from('invitations')
    .select('id, token')
    .eq('email', recipientEmail)
    .eq('item_id', itemId)
    .is('accepted_at', null)
    .order('invited_at', { ascending: false })
    .limit(1);
  const priorInvite = priorInvites?.[0] || null;

  let token, invitationId;
  if (priorInvite) {
    token = priorInvite.token;
    const { error } = await db.from('invitations')
      .update({ level, invited_by: ownerCtx.userId, invited_at: new Date().toISOString() })
      .eq('id', priorInvite.id);
    if (error) throw new Error(error.message);
    invitationId = priorInvite.id;
  } else {
    token = newInvitationToken();
    const { data, error } = await db.from('invitations')
      .insert({ email: recipientEmail, item_id: itemId, level, invited_by: ownerCtx.userId, token })
      .select('id')
      .single();
    if (error) throw new Error(error.message);
    invitationId = data.id;
  }

  return {
    mode: 'invited',
    level,
    recipientEmail,
    invitationId,
    token,
    email: buildInviteEmail({ to: recipientEmail, sharerEmail, item, level, token }),
  };
}

// ── List ───────────────────────────────────────────────────────────────────

// Owner-only. Returns active grants (resolved to recipient emails) plus pending
// invitations. Used by the share modal to show who has access.
export async function listItemPermissions({ ownerCtx, itemId }) {
  const db = getDB();
  await requireOwnedItem(db, ownerCtx, itemId);

  const { data: grants } = await db.from('permissions')
    .select('id, subject_user_id, level, granted_at')
    .eq('object_item_id', itemId)
    .not('subject_user_id', 'is', null)
    .order('granted_at', { ascending: true });

  const userIds = [...new Set((grants || []).map(g => g.subject_user_id))];
  const emailById = new Map();
  if (userIds.length) {
    const { data: us } = await db.from('users').select('id, email').in('id', userIds);
    for (const u of us || []) emailById.set(u.id, u.email);
  }

  const { data: invites } = await db.from('invitations')
    .select('id, email, level, invited_at')
    .eq('item_id', itemId)
    .is('accepted_at', null)
    .order('invited_at', { ascending: true });

  return {
    item_id: itemId,
    grants: (grants || []).map(g => ({
      permission_id: g.id,
      email:         emailById.get(g.subject_user_id) || null,
      level:         g.level,
      granted_at:    g.granted_at,
      status:        'active',
    })),
    pending: (invites || []).map(i => ({
      invitation_id: i.id,
      email:         i.email,
      level:         i.level,
      invited_at:    i.invited_at,
      status:        'pending',
    })),
  };
}

// ── Revoke ─────────────────────────────────────────────────────────────────

// Owner-only. Revokes by id, scoped to THIS item. Tries an active grant first,
// then a pending invitation, so the UI can pass either id to one endpoint.
export async function revokeAccess({ ownerCtx, itemId, id }) {
  const db = getDB();
  if (typeof id !== 'string' || !id) throw userError('A permission id is required.', 400);
  await requireOwnedItem(db, ownerCtx, itemId);

  const { data: perm } = await db.from('permissions')
    .delete().eq('id', id).eq('object_item_id', itemId).select('id').maybeSingle();
  if (perm) return { revoked: true, kind: 'permission', id };

  const { data: inv } = await db.from('invitations')
    .delete().eq('id', id).eq('item_id', itemId).is('accepted_at', null).select('id').maybeSingle();
  if (inv) return { revoked: true, kind: 'invitation', id };

  throw userError('No matching grant or pending invitation for this item.', 404);
}

// ── Invitation lookup + accept ───────────────────────────────────────────────

// Public (token is the bearer secret). Returns metadata for the accept page.
// Deliberately exposes only the item TITLE and TYPE, never its content, so the
// token alone cannot leak the owner's data across the trust boundary.
export async function getInvitationByToken(token) {
  const db = getDB();
  if (typeof token !== 'string' || !token) return null;

  const { data: inv } = await db.from('invitations')
    .select('id, email, item_id, level, invited_by, invited_at, accepted_at')
    .eq('token', token)
    .maybeSingle();
  if (!inv) return null;

  const { data: item }    = await db.from('knowledge').select('title, type').eq('id', inv.item_id).maybeSingle();
  const { data: inviter } = await db.from('users').select('email').eq('id', inv.invited_by).maybeSingle();

  return {
    email:            inv.email,
    level:            inv.level,
    accepted:         !!inv.accepted_at,
    invited_at:       inv.invited_at,
    invited_by_email: inviter?.email || null,
    item:             { title: item?.title || null, type: item?.type || null },
  };
}

// Public, token-gated, single-use. Materialises the grant, provisioning the
// recipient's account if needed (bypassing the invite-only gate), and returns
// a session JWT so the route can sign them in. Possessing the token proves
// control of the invited email, the same trust model as a magic link.
export async function acceptInvitation(token) {
  const db = getDB();
  if (typeof token !== 'string' || !token) throw userError('Invalid invitation.', 400);

  // Atomic single-use claim: only one accept can win the row.
  const { data: inv, error } = await db.from('invitations')
    .update({ accepted_at: new Date().toISOString() })
    .eq('token', token)
    .is('accepted_at', null)
    .select('id, email, item_id, level, invited_by')
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!inv) throw userError('This invitation link is invalid or has already been used.', 410);

  const recipientEmail = inv.email.toLowerCase().trim();

  // Bypass the invite-only signup gate — the share IS the invitation.
  const { user } = await getOrCreateUser(recipientEmail, { allowUninvited: true });

  // Materialise the grant. Idempotent if one already exists for this pair.
  const { data: prior } = await db.from('permissions')
    .select('id').eq('subject_user_id', user.id).eq('object_item_id', inv.item_id).limit(1);
  const priorRow = prior?.[0] || null;

  let permissionId;
  if (priorRow) {
    await db.from('permissions')
      .update({ level: inv.level, granted_by: inv.invited_by, granted_at: new Date().toISOString() })
      .eq('id', priorRow.id);
    permissionId = priorRow.id;
  } else {
    const { data: created, error: insErr } = await db.from('permissions')
      .insert({ subject_user_id: user.id, object_item_id: inv.item_id, level: inv.level, granted_by: inv.invited_by })
      .select('id')
      .single();
    if (insErr) throw new Error(insErr.message);
    permissionId = created.id;
  }

  const sessionJwt = await createSessionToken(user.id, user.email);
  return { user, level: inv.level, itemId: inv.item_id, permissionId, sessionJwt };
}

// ── Email ────────────────────────────────────────────────────────────────────

// Best-effort send. Throws on hard failure so the route can log it; the route
// must NOT let a send failure void the grant.
export async function sendShareEmail(payload) {
  if (!payload?.to) return;
  const FROM   = process.env.RESEND_FROM || 'team@lutolearn.com';
  const resend = new Resend(process.env.RESEND_API_KEY);
  await resend.emails.send({
    from:    FROM,
    to:      payload.to,
    subject: payload.subject,
    html:    payload.html,
    text:    payload.text,
  });
}

function itemLabel(item) {
  const type  = (item?.type || 'item').toLowerCase();
  const title = item?.title ? `“${item.title}”` : `a ${type}`;
  return { type, title };
}

function buildNotificationEmail({ to, sharerEmail, item, level }) {
  const { title } = itemLabel(item);
  const who     = sharerEmail || 'Someone';
  const what    = LEVEL_PHRASE[level] || 'access it';
  const url     = `${APP_URL}/twin`;
  const heading = 'Something was shared with you.';
  const body    = `${who} shared ${title} with you on ${BRAND_NAME}. You can ${what}. It is ready in your twin now.`;
  return {
    to,
    subject: `${who} shared ${title} with you`,
    html:    brandEmailHtml({ heading, body, ctaUrl: url, ctaLabel: 'Open your twin' }),
    text:    brandEmailText({ heading, body, url }),
  };
}

function buildInviteEmail({ to, sharerEmail, item, level, token }) {
  const { title } = itemLabel(item);
  const who     = sharerEmail || 'Someone';
  const what    = LEVEL_PHRASE[level] || 'access it';
  const url     = `${APP_URL}/twin?invite=${encodeURIComponent(token)}`;
  const heading = 'You have been invited.';
  const body    = `${who} shared ${title} with you on ${BRAND_NAME} and wants to ${what}. Accept the invitation to set up your own twin and start using it.`;
  return {
    to,
    subject: `${who} shared ${title} with you on ${BRAND_NAME}`,
    html:    brandEmailHtml({ heading, body, ctaUrl: url, ctaLabel: 'Accept invitation' }),
    text:    brandEmailText({ heading, body, url }),
  };
}

// Shared Luto-branded email shell. Mirrors the sign-in email styling.
function brandEmailHtml({ heading, body, ctaUrl, ctaLabel }) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#FDFCFA;margin:0;padding:0">

  <div style="height:6px;background:#FFE34A;width:100%"></div>

  <div style="max-width:520px;margin:0 auto;padding:48px 32px 56px">

    <div style="display:flex;align-items:center;gap:10px;margin-bottom:48px">
      <div style="width:24px;height:24px;background:#FFE34A;border:1.5px solid #0F0E0D;border-radius:4px;box-shadow:2px 2px 0 #0F0E0D;flex-shrink:0"></div>
      <span style="font-size:15px;font-weight:600;color:#0F0E0D;letter-spacing:-0.01em">${BRAND_NAME}</span>
      <span style="font-size:10px;color:#857C6E;letter-spacing:0.1em;text-transform:uppercase;font-family:monospace;margin-left:2px">${BRAND_BYLINE}</span>
    </div>

    <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:28px;font-weight:400;color:#0F0E0D;margin:0 0 16px;line-height:1.15;letter-spacing:-0.02em">
      ${heading}
    </h1>
    <p style="font-size:15px;color:#3A352E;line-height:1.6;margin:0 0 36px">
      ${body}
    </p>

    <a href="${ctaUrl}" style="display:inline-block;background:#FFE34A;color:#0F0E0D;text-decoration:none;padding:14px 28px;border-radius:8px;border:1.5px solid #0F0E0D;box-shadow:3px 3px 0 #0F0E0D;font-size:15px;font-weight:600;letter-spacing:-0.01em">
      ${ctaLabel} &rarr;
    </a>

    <div style="height:1px;background:#E8E2D4;margin:48px 0 32px"></div>

    <p style="font-size:12px;color:#857C6E;line-height:1.7;margin:0;font-family:monospace;letter-spacing:0.02em">
      ${APP_HOST}<br>
      If you did not expect this, you can ignore this email.
    </p>
    <p style="font-size:11px;color:#B6AD9C;margin:16px 0 0;font-family:monospace;word-break:break-all">
      ${ctaUrl}
    </p>

  </div>
</body>
</html>`;
}

function brandEmailText({ heading, body, url }) {
  return `${BRAND_FULL}\n\n${heading}\n\n${body}\n\n${url}\n\nIf you did not expect this, you can ignore this email.`;
}
