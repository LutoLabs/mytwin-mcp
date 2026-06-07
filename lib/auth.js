import { SignJWT, jwtVerify } from 'jose';
import { createHash, randomBytes } from 'node:crypto';
import { getDB } from './supabase.js';
import { redeemInviteForNewUser } from './invites.js';
import { logAudit } from './audit.js';

// Resolve a referral slug (a public-link slug carried via /twin?ref=...) to the
// owner user who shared it. Returns null on any miss or malformed input — a bad
// referrer must never block a signup.
async function ownerFromReferrer(slug) {
  if (!slug || typeof slug !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(slug)) return null;
  try {
    const db = getDB();
    const { data } = await db.from('public_links').select('owner_user_id').eq('slug', slug).maybeSingle();
    return data?.owner_user_id || null;
  } catch { return null; }
}

if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET env var is required. Generate with: openssl rand -base64 32');
}
const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET);

const TOKEN_EXPIRY_MINUTES = 15;
const SESSION_EXPIRY_DAYS  = 30;

// ── Magic link ─────────────────────────────────────────────────────────────────

export async function createMagicToken(email, inviteCode = null, claimTenantId = null, referrer = null) {
  const db = getDB();
  const token = crypto.randomUUID() + '-' + crypto.randomUUID();
  const expires_at = new Date(Date.now() + TOKEN_EXPIRY_MINUTES * 60 * 1000).toISOString();

  const row = { email, token, expires_at };
  if (inviteCode)     row.invite_code      = inviteCode;
  if (claimTenantId)  row.claim_tenant_id  = claimTenantId;
  if (referrer)       row.referrer         = String(referrer).slice(0, 64);

  const { error } = await db.from('magic_tokens').insert(row);
  if (error) throw new Error(error.message);

  return token;
}

export async function verifyMagicToken(token) {
  const db = getDB();
  const now = new Date().toISOString();

  // Atomic single-use: one UPDATE that only succeeds if the token exists,
  // is unused, AND is still within its expiry window. Race-condition proof —
  // two concurrent verifies of the same token can't both win, because the
  // database serialises the row update. We deliberately collapse "not found",
  // "already used", and "expired" into one unified error (per security brief
  // item 13: auth errors must not leak which sub-state failed).
  const { data, error } = await db
    .from('magic_tokens')
    .update({ used: true })
    .eq('token', token)
    .eq('used', false)
    .gte('expires_at', now)
    .select()
    .single();

  if (error || !data) {
    throw new Error('Invalid or expired link.');
  }

  // Return email, optional invite_code, and optional claim_tenant_id so the
  // verify endpoint can route to the right onboarding path.
  return {
    email:         data.email,
    inviteCode:    data.invite_code    || null,
    claimTenantId: data.claim_tenant_id || null,
    referrer:      data.referrer       || null,
  };
}

// ── User provisioning ──────────────────────────────────────────────────────────

const DEFAULT_SCHEMA_TYPES = [
  { name: 'voice',     description: 'Writing style, tone, how you communicate' },
  { name: 'brand',     description: 'Visual preferences, aesthetic principles, brand rules' },
  { name: 'knowledge', description: 'Expertise areas, domain knowledge, what you know deeply' },
  { name: 'skill',     description: 'Methods, frameworks, how you do specific things' },
  { name: 'template',  description: 'Reusable structures, formats, scaffolding' },
  { name: 'idea',      description: 'Concepts, hypotheses, things you\'re exploring' },
  { name: 'resource',  description: 'Links, documents, references you trust' },
  { name: 'principle', description: 'Repeating values, rules, guidelines you apply consistently' },
];

export async function getOrCreateUser(email, opts = {}) {
  const db = getDB();
  const { inviteCode = null, allowUninvited = false, referrerSlug = null } = opts;

  // Try to find existing user — returning users sign in regardless of invite.
  const { data: existing } = await db.from('users').select('*').eq('email', email).maybeSingle();
  if (existing) return { user: existing, isNew: false };

  // Prelaunch gate: new users must come through the invite flow OR be
  // explicitly allowed (cross-tenant test suite passes allowUninvited: true).
  if (!inviteCode && !allowUninvited) {
    throw new Error('Signup is invite-only right now. Use an invite link or join the waitlist.');
  }

  // New user — create a tenant first (1:1 with the user for MVP), then the
  // user with its tenant_id set, then seed default schema types.
  const { data: tenant, error: tenantErr } = await db
    .from('tenants')
    .insert({})
    .select('id')
    .single();
  if (tenantErr) throw new Error(tenantErr.message);

  // Referral attribution: who shared the link that brought this signup in.
  const referrerOwner = referrerSlug ? await ownerFromReferrer(referrerSlug) : null;

  const { data: user, error: userErr } = await db
    .from('users')
    .insert({
      email,
      tenant_id: tenant.id,
      ...(referrerOwner ? { referred_by_user_id: referrerOwner, referred_via: String(referrerSlug).slice(0, 64) } : {}),
    })
    .select()
    .single();
  if (userErr) throw new Error(userErr.message);

  if (referrerOwner) {
    logAudit({ userId: user.id, tenantId: tenant.id, eventType: 'signup_attributed',
      context: { referrer_user_id: referrerOwner, referred_via: String(referrerSlug).slice(0, 64), path: 'regular' } });
  }

  // Seed default schema types — also stamped with tenant_id.
  await db.from('schema_types').insert(
    DEFAULT_SCHEMA_TYPES.map(t => ({ ...t, user_id: user.id, tenant_id: tenant.id }))
  );

  // Redeem the invite + mint a new outbound invite for this user. If the
  // invite is no longer valid (race, cap reached) we surface a clear error
  // — the caller (verify endpoint) can flash it to the user.
  let mintedInviteCode = null;
  if (inviteCode) {
    const result = await redeemInviteForNewUser({ code: inviteCode, userId: user.id });
    mintedInviteCode = result.minted_code || null;
  }

  return { user, isNew: true, mintedInviteCode };
}

// ── Claim flow ─────────────────────────────────────────────────────────────────
//
// Two paths when a user on /twin claims their anonymous session:
//   a) claimAnonTenantAsNewUser  — the email is brand-new. Upgrade the
//      placeholder user row (anon+<id>@mytwin.local) to a real email account,
//      mark the tenant non-anonymous, skip tenant creation entirely.
//   b) mergeAnonIntoExistingUser — the email is already registered. Move all
//      knowledge + concept pages from the anon tenant into the real tenant,
//      then mark the anon tenant as claimed.

export async function claimAnonTenantAsNewUser(email, anonTenantId, referrerSlug = null) {
  const db = getDB();

  // Guard: tenant must exist and be unclaimed.
  const { data: tenant, error: tenantErr } = await db
    .from('tenants')
    .select('id, is_anonymous, claimed_by_user_id')
    .eq('id', anonTenantId)
    .maybeSingle();
  if (tenantErr || !tenant)               throw new Error('Anonymous tenant not found');
  if (!tenant.is_anonymous)               throw new Error('Tenant is not anonymous');
  if (tenant.claimed_by_user_id)          throw new Error('Tenant already claimed');

  // Update the placeholder user row in-place — reuses its id so every
  // existing knowledge/schema_types row (which stores user_id) stays valid.
  const placeholderEmail = `anon+${anonTenantId}@mytwin.local`;

  // Referral attribution, with a self-referral guard: a visitor who shared
  // their OWN artifact while anonymous and then claims must not be attributed
  // to themselves (the placeholder user becomes this account).
  const referrerOwner = referrerSlug ? await ownerFromReferrer(referrerSlug) : null;
  const { data: ph } = await db.from('users').select('id').eq('email', placeholderEmail).eq('tenant_id', anonTenantId).maybeSingle();
  const attribute = referrerOwner && referrerOwner !== ph?.id;

  const { data: user, error: userErr } = await db
    .from('users')
    .update({ email, ...(attribute ? { referred_by_user_id: referrerOwner, referred_via: String(referrerSlug).slice(0, 64) } : {}) })
    .eq('email', placeholderEmail)
    .eq('tenant_id', anonTenantId)
    .select()
    .single();
  if (userErr || !user) throw new Error('Could not upgrade placeholder user: ' + (userErr?.message || 'not found'));

  if (attribute) {
    logAudit({ userId: user.id, tenantId: anonTenantId, eventType: 'signup_attributed',
      context: { referrer_user_id: referrerOwner, referred_via: String(referrerSlug).slice(0, 64), path: 'claim' } });
  }

  // Mark the tenant as a real, claimed tenant.
  await db.from('tenants').update({
    is_anonymous:       false,
    claimed_by_user_id: user.id,
  }).eq('id', anonTenantId);

  return { user, isNew: true };
}

export async function mergeAnonIntoExistingUser(existingUser, anonTenantId) {
  const db = getDB();

  // Resolve the anon placeholder user_id so we can filter knowledge rows.
  const { data: anonUser } = await db
    .from('users')
    .select('id')
    .eq('tenant_id', anonTenantId)
    .maybeSingle();
  if (!anonUser) return; // nothing to merge (tenant already empty / deleted)

  // Move knowledge items — keeps the same rows, just re-stamps tenant+user.
  await db.from('knowledge')
    .update({ tenant_id: existingUser.tenant_id, user_id: existingUser.id })
    .eq('tenant_id', anonTenantId)
    .eq('user_id',   anonUser.id);

  // Move concept pages similarly.
  await db.from('concept_pages')
    .update({ tenant_id: existingUser.tenant_id, user_id: existingUser.id })
    .eq('tenant_id', anonTenantId)
    .eq('user_id',   anonUser.id);

  // Mark anon tenant as claimed (leave is_anonymous true so cleanup jobs
  // can identify it, but link it so it won't be picked up as unclaimed).
  await db.from('tenants')
    .update({ claimed_by_user_id: existingUser.id })
    .eq('id', anonTenantId);
}

// ── JWT session ────────────────────────────────────────────────────────────────

export async function createSessionToken(userId, email) {
  return new SignJWT({ userId, email })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_EXPIRY_DAYS}d`)
    .sign(JWT_SECRET);
}

export async function verifySessionToken(token) {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    return { userId: payload.userId, email: payload.email };
  } catch {
    return null;
  }
}

// ── Cookie helpers ─────────────────────────────────────────────────────────────

export function getSessionCookie(req) {
  const raw = req.headers.cookie || '';
  const match = raw.match(/(?:^|;\s*)mt_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function setSessionCookie(res, token) {
  const maxAge = SESSION_EXPIRY_DAYS * 24 * 60 * 60;
  res.setHeader('Set-Cookie', [
    `mt_session=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`,
  ]);
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', [
    'mt_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
  ]);
}

// ── Request auth middleware ────────────────────────────────────────────────────

export async function requireAuth(req) {
  const cookie = getSessionCookie(req);
  if (!cookie) return null;
  return verifySessionToken(cookie);
}

// ── MCP bearer tokens ──────────────────────────────────────────────────────────
//
// Tokens are issued once per user and used to authenticate every MCP request.
// We store SHA-256 hashes only; the raw value is returned to the user exactly
// once (on first issue or after regenerate) and never again.
//
// One active token per user (enforced by the partial unique index on
// mcp_tokens). Regenerate revokes the previous and mints a new one.

const MCP_TOKEN_PREFIX = 'mt_';

function generateMcpToken() {
  const raw    = randomBytes(32).toString('hex'); // 64 hex chars
  const token  = MCP_TOKEN_PREFIX + raw;          // 'mt_' + 64 hex = 67 chars
  const hash   = createHash('sha256').update(token).digest('hex');
  const prefix = token.slice(0, 11);              // 'mt_' + 8 hex chars — safe to show in UI
  return { token, hash, prefix };
}

function hashMcpToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

// Mint a new token for the user. Revokes the previous active token in the
// SAME bucket so the partial unique index isn't violated:
//   * Legacy URL-paste tokens (clientId omitted) — one active per user.
//   * OAuth-issued tokens — one active per (user, client_id). Multiple OAuth
//     clients (Claude hosted + Claude Code + …) coexist without fighting.
// expiresInSeconds is null for legacy tokens (never expire) and ~86400 for
// OAuth-issued tokens.
export async function mintMcpTokenForUser(userId, opts = {}) {
  const { clientId = null, expiresInSeconds = null } = opts;
  const db = getDB();

  const { data: user, error: userErr } = await db
    .from('users')
    .select('tenant_id')
    .eq('id', userId)
    .single();
  if (userErr || !user) throw new Error('User not found');

  const nowIso = new Date().toISOString();

  // Revoke previous active token in the matching bucket.
  let revokeQuery = db.from('mcp_tokens')
    .update({ revoked_at: nowIso })
    .eq('user_id', userId)
    .is('revoked_at', null);
  revokeQuery = clientId
    ? revokeQuery.eq('client_id', clientId)
    : revokeQuery.is('client_id', null);
  await revokeQuery;

  const expiresAt = expiresInSeconds
    ? new Date(Date.now() + expiresInSeconds * 1000).toISOString()
    : null;

  const { token, hash, prefix } = generateMcpToken();
  const { data, error } = await db.from('mcp_tokens')
    .insert({
      user_id:      userId,
      tenant_id:    user.tenant_id,
      token_hash:   hash,
      token_prefix: prefix,
      client_id:    clientId,
      expires_at:   expiresAt,
    })
    .select('token_prefix, created_at')
    .single();
  if (error) throw new Error(error.message);

  return { token, prefix: data.token_prefix, createdAt: data.created_at, expiresAt };
}

// Look up the active token's display info — never returns the raw value
// (we can't; we only stored the hash).
export async function getActiveMcpTokenInfo(userId) {
  const db = getDB();
  const { data } = await db.from('mcp_tokens')
    .select('token_prefix, created_at, last_used_at')
    .eq('user_id', userId)
    .is('revoked_at', null)
    .maybeSingle();
  if (!data) return null;
  return { prefix: data.token_prefix, createdAt: data.created_at, lastUsedAt: data.last_used_at };
}

// Verify a presented token. Returns { userId, tenantId, clientId } on
// success, null on any failure (including expiry). Fire-and-forget bumps
// last_used_at; we don't block the request.
export async function verifyMcpToken(token) {
  if (!token || typeof token !== 'string' || !token.startsWith(MCP_TOKEN_PREFIX)) return null;
  const db   = getDB();
  const hash = hashMcpToken(token);
  const now  = new Date().toISOString();

  const { data } = await db.from('mcp_tokens')
    .select('user_id, tenant_id, client_id, expires_at')
    .eq('token_hash', hash)
    .is('revoked_at', null)
    .maybeSingle();
  if (!data) return null;
  if (data.expires_at && data.expires_at <= now) return null;

  // Bump last_used_at — best effort, never blocks
  db.from('mcp_tokens')
    .update({ last_used_at: now })
    .eq('token_hash', hash)
    .is('revoked_at', null)
    .then(() => {}, () => {});

  return { userId: data.user_id, tenantId: data.tenant_id, clientId: data.client_id };
}

// ── Shared MCP tokens ──────────────────────────────────────────────────────────
//
// Read-only tokens for sharing a filtered view of the twin (sharable items only).
// One active token per user. Format: 'smt_' + 64 hex chars.
// We store SHA-256 hash only — raw token returned to user exactly once.

const SHARED_TOKEN_PREFIX = 'smt_';

function generateSharedMcpToken() {
  const raw    = randomBytes(32).toString('hex'); // 64 hex chars
  const token  = SHARED_TOKEN_PREFIX + raw;       // 'smt_' + 64 hex = 68 chars
  const hash   = createHash('sha256').update(token).digest('hex');
  const prefix = token.slice(0, 12);              // 'smt_' + 8 hex — safe to show in UI
  return { token, hash, prefix };
}

// Mint a new shared token for the user. Revokes any existing one first.
// Returns { token, prefix, id, createdAt } — token is the raw value, shown once.
export async function mintSharedTokenForUser(userId) {
  const db = getDB();

  const { data: user, error: userErr } = await db
    .from('users')
    .select('tenant_id')
    .eq('id', userId)
    .single();
  if (userErr || !user) throw new Error('User not found');

  // Revoke all active shared tokens for this user
  await db.from('shared_mcp_tokens')
    .update({ revoked: true })
    .eq('user_id', userId)
    .eq('revoked', false);

  const { token, hash, prefix } = generateSharedMcpToken();
  const { data, error } = await db.from('shared_mcp_tokens')
    .insert({
      user_id:      userId,
      tenant_id:    user.tenant_id,
      token_hash:   hash,
      token_prefix: prefix,
    })
    .select('id, token_prefix, created_at')
    .single();
  if (error) throw new Error(error.message);

  return { token, prefix: data.token_prefix, id: data.id, createdAt: data.created_at };
}

// Get the current active shared token info for a user (never returns the raw token).
// Returns null if no active token exists.
export async function getActiveSharedTokenInfo(userId) {
  const db = getDB();
  const { data } = await db.from('shared_mcp_tokens')
    .select('id, token_prefix, created_at, last_used_at')
    .eq('user_id', userId)
    .eq('revoked', false)
    .maybeSingle();
  if (!data) return null;
  return {
    id:          data.id,
    prefix:      data.token_prefix,
    createdAt:   data.created_at,
    lastUsedAt:  data.last_used_at,
  };
}

// Revoke all active shared tokens for a user.
export async function revokeSharedTokenForUser(userId) {
  const db = getDB();
  await db.from('shared_mcp_tokens')
    .update({ revoked: true })
    .eq('user_id', userId)
    .eq('revoked', false);
}

// Verify a shared token. Returns { userId, tenantId, tokenId } on success,
// null on any failure. Bumps last_used_at fire-and-forget.
export async function verifySharedMcpToken(token) {
  if (!token || typeof token !== 'string' || !token.startsWith(SHARED_TOKEN_PREFIX)) return null;
  const db   = getDB();
  const hash = createHash('sha256').update(token).digest('hex');

  const { data } = await db.from('shared_mcp_tokens')
    .select('id, user_id, tenant_id')
    .eq('token_hash', hash)
    .eq('revoked', false)
    .maybeSingle();
  if (!data) return null;

  // Bump last_used_at — best effort, never blocks
  db.from('shared_mcp_tokens')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', data.id)
    .then(() => {}, () => {});

  return { userId: data.user_id, tenantId: data.tenant_id, tokenId: data.id };
}
