// lib/public-links.js
//
// Link-to-anyone public sharing. A public_links row is the SOLE authorization
// for a logged-out read of one artifact (a knowledge item XOR a concept page).
// This system is deliberately separate from the per-item email grants
// (permissions/invitations) and from the visibility column (the shared MCP
// pool); see schema/migrations/029-public-links.sql.
//
// Security contract for the public read (resolvePublicArtifact):
//   * The owner tenant/user is resolved FROM the public_links row, never from
//     anything the caller supplies. A logged-out caller has no tenant context.
//   * The single artifact is then fetched scoped to that owner, and only
//     public-safe fields are returned. No siblings, no graph, no provenance,
//     no source_ref, no owner email, no tenant/user ids.
//   * Missing slug, revoked link, expired link, or deleted artifact all return
//     null (caller -> 404). No distinction, so existence never leaks.

import { randomBytes } from 'node:crypto';
import { getDB } from './supabase.js';
import { stripDashes, cleanTitle } from './text-clean.js';
import { logAudit } from './audit.js';

// 18 bytes = 144 bits of entropy, url-safe. Unguessable; not derived from any
// id or title. The raw slug lives in the URL and in the row (these are public
// artifacts, so the slug is not a secret credential the way an API token is).
export function generatePublicSlug() {
  return randomBytes(18).toString('base64url');
}

const OBJECT_COLUMN = { item: 'object_item_id', concept: 'object_concept_page_id', answer: 'object_answer_id' };
const SOURCE_TABLE  = { item: 'knowledge',      concept: 'concept_pages',         answer: 'shared_answers' };

function normaliseType(objectType) {
  const t = objectType === 'concept' || objectType === 'concept_page' ? 'concept'
          : objectType === 'item' || objectType === 'knowledge' ? 'item'
          : objectType === 'answer' || objectType === 'shared_answer' ? 'answer'
          : null;
  if (!t) throw new Error(`public-links: unknown objectType "${objectType}"`);
  return t;
}

// A presentable owner name for the public page CTA, derived WITHOUT exposing the
// email. Placeholder/system identities collapse to a neutral label. Capped to two
// tokens so a multi-segment local-part (e.g. jane.smith.1234) cannot render an
// arbitrary embedded string on the public page.
export function ownerDisplayName(email) {
  const e = String(email || '').toLowerCase();
  if (!e || e.startsWith('anon+') || e.endsWith('@mytwin.local') || e.endsWith('@system.local')) {
    return 'this twin';
  }
  const local = e.split('@')[0].replace(/[._-]+/g, ' ').trim().split(/\s+/).slice(0, 2).join(' ');
  if (!local) return 'this twin';
  return local.replace(/\b\w/g, c => c.toUpperCase());
}

// Confirm the artifact is owned by ctx (tenant + user). Returns the row
// { id, visibility } or null. This is what gates who may MINT a link — only the
// owner — and supplies the visibility used to gate concept publication.
async function assertOwnedArtifact(ctx, type, objectId) {
  if (!ctx?.tenantId || !ctx?.userId) throw new Error('public-links: missing tenant context');
  const db = getDB();
  // shared_answers has no visibility column (it is created explicitly for
  // sharing); items + concept pages do, and the concept gate reads it.
  const cols = type === 'answer' ? 'id' : 'id, visibility';
  const { data } = await db
    .from(SOURCE_TABLE[type])
    .select(cols)
    .eq('id', objectId)
    .eq('user_id', ctx.userId)
    .eq('tenant_id', ctx.tenantId)
    .maybeSingle();
  return data || null;
}

// Get-or-create the single active link for an artifact the caller owns.
// Returns { slug, objectType, objectId, created_at, revoked:false, view_count }.
export async function createPublicLink({ ctx, objectType, objectId }) {
  const type = normaliseType(objectType);
  if (!objectId) throw new Error('public-links: objectId required');

  const owned = await assertOwnedArtifact(ctx, type, objectId);
  if (!owned) { const e = new Error('Artifact not found.'); e.status = 404; throw e; }

  // A concept page's compiled body can quote its source items verbatim, so it is
  // only safe to publish when EVERY source is sharable. The compiler already
  // encodes exactly that: concept_pages.visibility is 'sharable' iff all sources
  // are. Refuse to publish a concept page that is not fully sharable, so private
  // sibling material can never reach a public reader.
  if (type === 'concept' && owned.visibility !== 'sharable') {
    const e = new Error('This page draws on private notes, so it cannot be shared publicly yet.');
    e.status = 409;
    throw e;
  }

  const db = getDB();
  const col = OBJECT_COLUMN[type];

  // Existing active link? Return it (idempotent create). Use order+limit rather
  // than maybeSingle so a duplicate-active-row anomaly degrades to "newest"
  // instead of throwing — the single-active invariant is a DB index, not a law
  // the app should crash on.
  const readActive = async () => {
    const { data } = await db
      .from('public_links')
      .select('slug, created_at, view_count')
      .eq(col, objectId)
      .eq('revoked', false)
      .order('created_at', { ascending: false })
      .limit(1);
    return data?.[0] || null;
  };

  const existing = await readActive();
  if (existing?.slug) {
    return { slug: existing.slug, objectType: type, objectId, created_at: existing.created_at, revoked: false, view_count: existing.view_count || 0 };
  }

  const slug = generatePublicSlug();
  const { data: inserted, error } = await db
    .from('public_links')
    .insert({ slug, owner_user_id: ctx.userId, tenant_id: ctx.tenantId, [col]: objectId })
    .select('slug, created_at, view_count')
    .single();
  if (error) {
    // A unique-violation (23505) means we lost the get-or-create race; re-read
    // and return the winning link. Any OTHER error is a genuine failure and is
    // surfaced with context rather than masked as a race.
    const isRace = error.code === '23505' || /duplicate key|unique constraint/i.test(error.message || '');
    const race = await readActive();
    if (race?.slug) return { slug: race.slug, objectType: type, objectId, created_at: race.created_at, revoked: false, view_count: race.view_count || 0 };
    if (!isRace) throw new Error(`Could not create the public link: ${error.message}`);
    throw new Error('Could not create the public link.');
  }
  return { slug: inserted.slug, objectType: type, objectId, created_at: inserted.created_at, revoked: false, view_count: 0 };
}

// Snapshot a twin chat answer into shared_answers and mint a public link for it,
// in one explicit act. The caller has the answer text on screen and is choosing
// to publish it; the content is cleaned of dashes like every other public copy.
export async function createSharedAnswerLink({ ctx, title, content, citations = null }) {
  if (!ctx?.tenantId || !ctx?.userId) throw new Error('public-links: missing tenant context');
  const body = stripDashes(String(content || '')).trim();
  if (!body) { const e = new Error('There is nothing to share yet.'); e.status = 400; throw e; }
  const db = getDB();
  const { data: ans, error } = await db
    .from('shared_answers')
    .insert({
      user_id:   ctx.userId,
      tenant_id: ctx.tenantId,
      title:     title ? cleanTitle(String(title)).slice(0, 200) : null,
      content:   body,
      citations: citations || null,
    })
    .select('id')
    .single();
  if (error || !ans?.id) throw new Error('Could not save the answer for sharing.');
  return createPublicLink({ ctx, objectType: 'answer', objectId: ans.id });
}

// The active public link for an artifact the caller owns, or null.
export async function getActivePublicLink({ ctx, objectType, objectId }) {
  const type = normaliseType(objectType);
  const owned = await assertOwnedArtifact(ctx, type, objectId);
  if (!owned) return null;
  const db = getDB();
  const { data } = await db
    .from('public_links')
    .select('slug, created_at, view_count, last_viewed_at')
    .eq(OBJECT_COLUMN[type], objectId)
    .eq('revoked', false)
    .order('created_at', { ascending: false })
    .limit(1);
  const row = data?.[0];
  if (!row?.slug) return null;
  return { slug: row.slug, objectType: type, objectId, created_at: row.created_at, revoked: false, view_count: row.view_count || 0, last_viewed_at: row.last_viewed_at || null };
}

// Revoke the active link(s) for an artifact the caller owns. Idempotent.
// After this, resolvePublicArtifact(slug) returns null immediately.
export async function revokePublicLink({ ctx, objectType, objectId }) {
  const type = normaliseType(objectType);
  const owned = await assertOwnedArtifact(ctx, type, objectId);
  if (!owned) { const e = new Error('Artifact not found.'); e.status = 404; throw e; }
  const db = getDB();
  await db
    .from('public_links')
    .update({ revoked: true })
    .eq(OBJECT_COLUMN[type], objectId)
    .eq('revoked', false);
  return { revoked: true, objectType: type, objectId };
}

// Public-safe field sets. Deliberately omit user_id, tenant_id, visibility,
// provenance, source_ref, and anything that exposes siblings or the graph.
const PUBLIC_CONCEPT_SELECT = 'id, flavour, title, summary, content, version, source_ids, updated_at, created_at';
const PUBLIC_ITEM_SELECT    = 'id, type, title, content, tags, updated_at, created_at';
// Citations are deliberately NOT selected: they can name private source items.
const PUBLIC_ANSWER_SELECT  = 'id, title, content, created_at';

// THE public read. Resolves a slug to a sanitized single-artifact payload, or
// null. Never trusts caller-supplied tenant; resolves owner from the link row.
export async function resolvePublicArtifact(slug, opts = {}) {
  if (!slug || typeof slug !== 'string') return null;
  // Cheap input bound: our slugs are base64url and <= 24 chars. Reject malformed
  // or oversized caller input before the DB round-trip. Not a security control
  // (the unique slug match already is) — just avoids wide pointless queries.
  if (slug.length > 64 || !/^[A-Za-z0-9_-]+$/.test(slug)) return null;
  const db = getDB();

  const { data: link } = await db
    .from('public_links')
    .select('id, slug, object_item_id, object_concept_page_id, object_answer_id, owner_user_id, tenant_id, revoked, expires_at, view_count')
    .eq('slug', slug)
    .eq('revoked', false)
    .maybeSingle();
  if (!link) return null;
  if (link.expires_at && new Date(link.expires_at).getTime() < Date.now()) return null;

  const type = link.object_concept_page_id ? 'concept'
             : link.object_answer_id ? 'answer'
             : 'item';
  const objectId = link.object_concept_page_id || link.object_answer_id || link.object_item_id;
  if (!objectId) return null;

  // Owner identity comes from the LINK ROW, never the caller.
  const ownerUserId = link.owner_user_id;
  const ownerTenantId = link.tenant_id;

  let payload = null;
  if (type === 'concept') {
    const { data: c } = await db
      .from('concept_pages')
      .select(PUBLIC_CONCEPT_SELECT)
      .eq('id', objectId)
      .eq('user_id', ownerUserId)
      .eq('tenant_id', ownerTenantId)
      // Defense in depth: a concept page is only resolvable while it is fully
      // sharable. If a source item is later made private and the page recompiled
      // to 'private', this link stops resolving — private source material can
      // never surface through a stale public link.
      .eq('visibility', 'sharable')
      .maybeSingle();
    if (!c) return null;
    payload = {
      type: 'concept',
      flavour: c.flavour,
      title: c.title,
      summary: c.summary,
      content: c.content,
      version: c.version,
      source_count: Array.isArray(c.source_ids) ? c.source_ids.length : 0,
      updated_at: c.updated_at,
      created_at: c.created_at,
    };
  } else if (type === 'answer') {
    const { data: ans } = await db
      .from('shared_answers')
      .select(PUBLIC_ANSWER_SELECT)
      .eq('id', objectId)
      .eq('user_id', ownerUserId)
      .eq('tenant_id', ownerTenantId)
      .maybeSingle();
    if (!ans) return null;
    payload = {
      type: 'answer',
      title: ans.title || null,
      content: ans.content,
      created_at: ans.created_at,
    };
  } else {
    const { data: k } = await db
      .from('knowledge')
      .select(PUBLIC_ITEM_SELECT)
      .eq('id', objectId)
      .eq('user_id', ownerUserId)
      .eq('tenant_id', ownerTenantId)
      .maybeSingle();
    if (!k) return null;
    payload = {
      type: 'item',
      item_type: k.type,
      title: k.title,
      content: k.content,
      tags: Array.isArray(k.tags) ? k.tags : [],
      source_count: 1,
      updated_at: k.updated_at,
      created_at: k.created_at,
    };
  }

  // Owner display name only (never the email). Separate read, scoped to the
  // owner tenant for symmetry. The email is reduced to a presentational label
  // and never assigned to the payload.
  let ownerName = 'this twin';
  try {
    const { data: u } = await db
      .from('users')
      .select('email')
      .eq('id', ownerUserId)
      .eq('tenant_id', ownerTenantId)
      .maybeSingle();
    ownerName = ownerDisplayName(u?.email);
  } catch (err) {
    console.error('[public-links] owner-name lookup failed:', err?.message);
  }
  payload.owner_name = ownerName;
  payload.slug = link.slug;

  // Fire-and-forget view bump (read-then-write; a tiny undercount race is fine
  // for a public counter). Phase 3 layers unique-view tracking on top. Errors
  // are logged, not silently dropped, so a persistent failure is observable.
  db.from('public_links')
    .update({ view_count: (link.view_count || 0) + 1, last_viewed_at: new Date().toISOString() })
    .eq('id', link.id)
    .then(() => {}, (err) => console.error('[public-links] view bump failed:', err?.message));

  // Owner-attributed view event for the dashboard (Phase 3). A salted viewer
  // fingerprint (set by the public route from IP + user agent) lets us derive
  // unique vs total views without storing PII. Only written when a fingerprint
  // is supplied, so direct lib callers (e.g. the test suite) emit nothing.
  if (opts.viewerFingerprint) {
    logAudit({
      userId:    ownerUserId,
      tenantId:  ownerTenantId,
      eventType: 'public_link_viewed',
      itemId:    objectId,
      context:   { slug: link.slug, object_type: type, viewer: String(opts.viewerFingerprint).slice(0, 64) },
    });
  }

  return payload;
}
