// POST /api/admin/dashboard
//
// Internal prelaunch cohort dashboard. Returns the 5 signals per invite:
//   1. clicked        — invite.first_visited_at IS NOT NULL
//   2. set_up         — invite.redeemed_by_user_id IS NOT NULL (user exists)
//   3. first_message  — at least one tool_call event in audit_log for that user
//   4. returning      — audit_log activity on >=2 distinct days
//   5. sessions       — count of distinct days with audit_log activity (proxy)
//
// Gated by X-Admin-Password header (constant-time compare against
// ADMIN_DASHBOARD_PASSWORD env var). Separate from ADMIN_TOKEN so the
// dashboard password can be shared with operators without granting broader
// admin access (seeding invites, running test suites, etc.).

import { createHash, timingSafeEqual } from 'node:crypto';
import { getDB } from '../../lib/supabase.js';
import { MAX_REDEMPTIONS, capacityStatus } from '../../lib/invites.js';

export const config = { maxDuration: 30 };

function authed(req) {
  const provided = String(req.headers['x-admin-password'] || '');
  const expected = String(process.env.ADMIN_DASHBOARD_PASSWORD || '');
  if (expected.length < 8) return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST')    { return res.status(405).json({ error: 'POST only' }); }
  if (!authed(req))             { return res.status(401).json({ error: 'Unauthorised' }); }

  try {
    const db = getDB();

    // 1. All invites
    const { data: invites, error: invErr } = await db.from('invites')
      .select('id, code, generated_by_user_id, redeemed_by_user_id, redeemed_at, first_visited_at, visit_count, created_at')
      .order('created_at', { ascending: true });
    if (invErr) throw new Error(invErr.message);

    // 2. All users (just the ones referenced by invites)
    const userIds = (invites || [])
      .flatMap(i => [i.generated_by_user_id, i.redeemed_by_user_id])
      .filter(Boolean);
    let userMap = {};
    if (userIds.length) {
      const { data: users } = await db.from('users').select('id, email, created_at').in('id', userIds);
      for (const u of users || []) userMap[u.id] = u;
    }

    // 3. Activity across ALL users from audit_log — tool_call events only.
    // For each user: count of distinct days with any tool_call, last_seen,
    // and total tool_calls. "Session" proxy = distinct days with activity.
    // (Previously this was scoped to invite-redeemed users only — pre-existing
    // users wouldn't show. Now every user with audit activity is counted, and
    // we expose them in the users[] panel further down.)
    const { data: allUsers } = await db.from('users').select('id, email, tenant_id, created_at, referred_by_user_id, referred_via');
    const allUserIds = (allUsers || []).map(u => u.id);
    const emailById = {}; for (const u of allUsers || []) emailById[u.id] = u.email;

    const activity = {};
    if (allUserIds.length) {
      const { data: events } = await db.from('audit_log')
        .select('user_id, event_type, created_at')
        .in('user_id', allUserIds)
        .order('created_at', { ascending: true });
      for (const e of events || []) {
        const uid = e.user_id;
        if (!uid) continue;
        const a = activity[uid] ||= { tool_calls: 0, distinct_days: new Set(), last_seen: null, first_call_at: null };
        if (e.event_type === 'tool_call') {
          a.tool_calls += 1;
          if (!a.first_call_at) a.first_call_at = e.created_at;
        }
        a.distinct_days.add((e.created_at || '').slice(0, 10));
        a.last_seen = e.created_at;
      }
    }

    // 3b. Submissions per user — count of knowledge rows grouped by user_id.
    // Cheap at prelaunch scale (<50 users); group in JS rather than relying on
    // PostgREST aggregate syntax which is fiddly via the supabase-js client.
    const dayAgoIso  = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const submissionsByUser = {};
    let totalSubmissions = 0;
    let submissions24h   = 0;
    {
      const { data: kn } = await db.from('knowledge').select('user_id, created_at');
      for (const k of kn || []) {
        if (!k.user_id) continue;
        submissionsByUser[k.user_id] = (submissionsByUser[k.user_id] || 0) + 1;
        totalSubmissions += 1;
        if (k.created_at && k.created_at >= dayAgoIso) submissions24h += 1;
      }
    }

    // 3c. tool_calls in the last 24h across all users (independent of attribution).
    let toolCalls24h = 0;
    {
      const { count } = await db.from('audit_log')
        .select('id', { count: 'exact', head: true })
        .eq('event_type', 'tool_call')
        .gte('created_at', dayAgoIso);
      toolCalls24h = count || 0;
    }

    // 3c-bis. Active-user windows: distinct user_ids with at least one
    // tool_call in the last 24h / 7d / 30d, plus a daily time series for the
    // Growth chart on the LutoDashboard. PostgREST has no DISTINCT or
    // date_trunc from the JS client, so we fetch the user_ids over the 30-day
    // window once and bucket in JS. Cheap at prelaunch scale.
    const weekAgoIso  = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const monthAgoIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    let activeUsers24h = 0;
    let activeUsers7d  = 0;
    let activeUsers30d = 0;
    let activeUsersDaily = [];
    {
      const { data: events30d } = await db.from('audit_log')
        .select('user_id, created_at')
        .eq('event_type', 'tool_call')
        .gte('created_at', monthAgoIso);
      const seen24h = new Set();
      const seen7d  = new Set();
      const seen30d = new Set();
      const byDay   = new Map(); // YYYY-MM-DD → Set<user_id>
      for (const e of events30d || []) {
        if (!e.user_id || !e.created_at) continue;
        seen30d.add(e.user_id);
        if (e.created_at >= weekAgoIso) seen7d.add(e.user_id);
        if (e.created_at >= dayAgoIso)  seen24h.add(e.user_id);
        const day = e.created_at.slice(0, 10);
        if (!byDay.has(day)) byDay.set(day, new Set());
        byDay.get(day).add(e.user_id);
      }
      activeUsers24h = seen24h.size;
      activeUsers7d  = seen7d.size;
      activeUsers30d = seen30d.size;

      // Build a contiguous 30-day series ending today — fill empty days with 0
      // so the chart can render a complete window.
      const series = [];
      for (let i = 29; i >= 0; i--) {
        const d = new Date();
        d.setUTCHours(0, 0, 0, 0);
        d.setUTCDate(d.getUTCDate() - i);
        const key = d.toISOString().slice(0, 10);
        series.push({ day: key, active_users: byDay.get(key)?.size || 0 });
      }
      activeUsersDaily = series;
    }

    // 3c-tris. Hourly series for the 24h chart. Bucket every tool_call from the
    // last 24 hours into its UTC hour, then build a 24-slot contiguous series
    // ending at the current hour. Distinct user_ids per hour.
    let activeUsersHourly = [];
    {
      const { data: events24h } = await db.from('audit_log')
        .select('user_id, created_at')
        .eq('event_type', 'tool_call')
        .gte('created_at', dayAgoIso);

      const byHour = new Map(); // ISO hour bucket "YYYY-MM-DDTHH" → Set<user_id>
      for (const e of events24h || []) {
        if (!e.user_id || !e.created_at) continue;
        const key = e.created_at.slice(0, 13); // YYYY-MM-DDTHH
        if (!byHour.has(key)) byHour.set(key, new Set());
        byHour.get(key).add(e.user_id);
      }

      const now    = new Date();
      const hours  = [];
      // Anchor at the current hour, walk back 23 hours so the series is exactly
      // 24 ascending hourly slots ending "now".
      for (let i = 23; i >= 0; i--) {
        const d = new Date(now.getTime() - i * 60 * 60 * 1000);
        d.setUTCMinutes(0, 0, 0);
        const iso = d.toISOString().slice(0, 13);
        hours.push({ hour: iso, active_users: byHour.get(iso)?.size || 0 });
      }
      activeUsersHourly = hours;
    }

    // ── Viral / public-sharing funnel (Phase 3) ───────────────────────────────
    // The single number to watch: did a real user share or invite someone who
    // then signed up. We build it from four event types + the public_links and
    // invitations tables, all bucketed in JS at prelaunch scale.
    const sharesByType = { item: 0, concept: 0, answer: 0 };
    const sharesByUser = {};      // sharer user_id → count of public links created
    const viewsByOwner = {};      // owner user_id → public-link view events
    const uniqueViewers = new Set();
    let viewEventTotal = 0;
    {
      const { data: viralEvents } = await db.from('audit_log')
        .select('user_id, event_type, context')
        .in('event_type', ['share_created', 'public_link_viewed', 'signup_attributed']);
      for (const e of viralEvents || []) {
        const ctx = e.context || {};
        if (e.event_type === 'share_created') {
          if (sharesByType[ctx.object_type] !== undefined) sharesByType[ctx.object_type] += 1;
          if (e.user_id) sharesByUser[e.user_id] = (sharesByUser[e.user_id] || 0) + 1;
        } else if (e.event_type === 'public_link_viewed') {
          viewEventTotal += 1;
          if (ctx.viewer) uniqueViewers.add(ctx.viewer);
          if (e.user_id) viewsByOwner[e.user_id] = (viewsByOwner[e.user_id] || 0) + 1;
        }
      }
    }

    // public_links: total views (counter) + active links by type/owner.
    let publicLinksTotalViews = 0, activePublicLinks = 0;
    const linksByType = { item: 0, concept: 0, answer: 0 };
    const linksByOwner = {};
    {
      const { data: publicLinks } = await db.from('public_links')
        .select('view_count, revoked, object_item_id, object_concept_page_id, object_answer_id, owner_user_id');
      for (const l of publicLinks || []) {
        publicLinksTotalViews += (l.view_count || 0);
        if (!l.revoked) {
          activePublicLinks += 1;
          const t = l.object_concept_page_id ? 'concept' : l.object_answer_id ? 'answer' : 'item';
          linksByType[t] += 1;
          if (l.owner_user_id) linksByOwner[l.owner_user_id] = (linksByOwner[l.owner_user_id] || 0) + 1;
        }
      }
    }

    // Item-share invitations (person-to-person), distinct from prelaunch codes.
    let itemInvitesSent = 0, itemInvitesAccepted = 0;
    {
      const { data: itemInvites } = await db.from('invitations').select('accepted_at');
      itemInvitesSent = (itemInvites || []).length;
      itemInvitesAccepted = (itemInvites || []).filter(i => i.accepted_at).length;
    }

    // Attributed signups: new accounts stamped with referred_by_user_id (set when
    // a public link's viewer signed up). Grouped by the referring user.
    const attributedUsers = (allUsers || []).filter(u => u.referred_by_user_id);
    const attributedByReferrer = {};
    const referredEmailsByReferrer = {};
    for (const u of attributedUsers) {
      attributedByReferrer[u.referred_by_user_id] = (attributedByReferrer[u.referred_by_user_id] || 0) + 1;
      (referredEmailsByReferrer[u.referred_by_user_id] ||= []).push(u.email);
    }
    const referrers = Object.keys(referredEmailsByReferrer).map(rid => ({
      user_id: rid,
      email: emailById[rid] || null,
      attributed_signups: attributedByReferrer[rid],
      referred_emails: referredEmailsByReferrer[rid],
    })).sort((a, b) => b.attributed_signups - a.attributed_signups);

    const sharesCreatedTotal = sharesByType.item + sharesByType.concept + sharesByType.answer;
    const viral = {
      shares_created_total:    sharesCreatedTotal,
      shares_by_type:          sharesByType,
      active_public_links:     activePublicLinks,
      public_links_by_type:    linksByType,
      public_link_views_total: publicLinksTotalViews,   // total view events (counter)
      public_link_views_unique: uniqueViewers.size,     // distinct viewer fingerprints
      item_invites_sent:       itemInvitesSent,
      item_invites_accepted:   itemInvitesAccepted,
      attributed_signups_total: attributedUsers.length,
      // The funnel to watch day to day during the beta.
      funnel: {
        shares_created:    sharesCreatedTotal,
        views_unique:      uniqueViewers.size,
        attributed_signups: attributedUsers.length,
      },
    };

    // 3d. Set of user_ids that came in through an invite redemption — used to
    // tag rows in the users[] panel so you can tell invited vs pre-existing apart.
    const invitedUserIdSet = new Set((invites || []).map(i => i.redeemed_by_user_id).filter(Boolean));

    // 4. Compose per-invite rows
    const rows = (invites || []).map(inv => {
      const redeemedUser = inv.redeemed_by_user_id ? userMap[inv.redeemed_by_user_id] : null;
      const generatedByUser = inv.generated_by_user_id ? userMap[inv.generated_by_user_id] : null;
      const act = inv.redeemed_by_user_id ? activity[inv.redeemed_by_user_id] : null;

      const sessions       = act ? act.distinct_days.size : 0;
      const firstMessage   = !!act && act.tool_calls > 0;
      const returning      = sessions >= 2;

      return {
        code:                inv.code,
        kind:                inv.generated_by_user_id ? 'minted' : 'seed',
        minted_by_email:     generatedByUser?.email || null,
        created_at:          inv.created_at,
        // Signal 1: clicked
        clicked:             !!inv.first_visited_at,
        first_visited_at:    inv.first_visited_at,
        visit_count:         inv.visit_count,
        // Signal 2: set up (= redeemed → user exists)
        set_up:              !!inv.redeemed_by_user_id,
        redeemed_by_email:   redeemedUser?.email || null,
        redeemed_at:         inv.redeemed_at,
        // Signals 3,4,5 (only meaningful once set_up)
        first_message:       firstMessage,
        returning,
        sessions,
        last_seen:           act?.last_seen || null,
        tool_calls_total:    act?.tool_calls || 0,
      };
    });

    // 5. Top-line stats
    const cap = await capacityStatus();
    const stats = {
      cap:                   MAX_REDEMPTIONS,
      redemptions_total:     cap.redemptions_total,
      spots_left:            cap.spots_left,
      invites_total:         rows.length,
      invites_seed:          rows.filter(r => r.kind === 'seed').length,
      invites_minted:        rows.filter(r => r.kind === 'minted').length,
      clicked_total:         rows.filter(r => r.clicked).length,
      set_up_total:          rows.filter(r => r.set_up).length,
      first_message_total:   rows.filter(r => r.first_message).length,
      returning_total:       rows.filter(r => r.returning).length,

      // New: system-wide stats (independent of invite attribution)
      total_users:           (allUsers || []).length,
      total_submissions:     totalSubmissions,
      submissions_24h:       submissions24h,
      tool_calls_24h:        toolCalls24h,
      active_users_24h:      activeUsers24h,
      active_users_7d:       activeUsers7d,
      active_users_30d:      activeUsers30d,
    };

    // 6a. Invite lineage — for each user, which invite brought them in and
    // (if they minted one) which user redeemed it. allUsers already covers
    // every account, so we build two lookups off the `invites` array we
    // fetched earlier and resolve emails via userMap (refilled below if a
    // referenced user isn't already in there).
    const inboundByUserId  = new Map();  // user.id → invite that redeemed them
    const outboundByUserId = new Map();  // user.id → invite they minted
    for (const inv of invites || []) {
      if (inv.redeemed_by_user_id)  inboundByUserId.set(inv.redeemed_by_user_id, inv);
      if (inv.generated_by_user_id) outboundByUserId.set(inv.generated_by_user_id, inv);
    }

    // Backfill userMap with any users referenced by invite lineage that
    // weren't already loaded (e.g. inviters whose own invite hasn't been
    // redeemed yet but who appear in outbound rows).
    const lineageUserIds = new Set();
    for (const inv of invites || []) {
      if (inv.generated_by_user_id) lineageUserIds.add(inv.generated_by_user_id);
      if (inv.redeemed_by_user_id)  lineageUserIds.add(inv.redeemed_by_user_id);
    }
    const missingIds = [...lineageUserIds].filter(id => !userMap[id]);
    if (missingIds.length) {
      const { data: more } = await db.from('users').select('id, email').in('id', missingIds);
      for (const u of more || []) userMap[u.id] = u;
    }

    // 6b. All accounts — sorted by submissions desc, ties broken by tool_calls.
    const users = (allUsers || []).map(u => {
      const a   = activity[u.id];
      const inv = inboundByUserId.get(u.id);   // how they got in
      const out = outboundByUserId.get(u.id);  // what they sent forward

      const invited_via = inv
        ? {
            code:           inv.code,
            kind:           inv.generated_by_user_id ? 'minted' : 'seed',
            inviter_email:  inv.generated_by_user_id ? (userMap[inv.generated_by_user_id]?.email || null) : null,
          }
        : null;

      const invited_someone = out
        ? {
            code:               out.code,
            redeemed:           !!out.redeemed_by_user_id,
            redeemed_by_email:  out.redeemed_by_user_id ? (userMap[out.redeemed_by_user_id]?.email || null) : null,
            redeemed_at:        out.redeemed_at || null,
          }
        : null;

      return {
        user_id:          u.id,
        email:            u.email,
        created_at:       u.created_at,
        attribution:      invitedUserIdSet.has(u.id) ? 'invited' : 'pre-invite',
        submissions:      submissionsByUser[u.id] || 0,
        tool_calls:       a ? a.tool_calls   : 0,
        sessions:         a ? a.distinct_days.size : 0,
        last_seen:        a ? a.last_seen    : null,
        first_message:    !!(a && a.tool_calls > 0),
        returning:        !!(a && a.distinct_days.size >= 2),
        invited_via,
        invited_someone,
        // Public-sharing activity for this account.
        shares_created:     sharesByUser[u.id] || 0,
        public_link_views:  viewsByOwner[u.id] || 0,
        attributed_signups: attributedByReferrer[u.id] || 0,
        referred_by:        u.referred_by_user_id ? (emailById[u.referred_by_user_id] || u.referred_by_user_id) : null,
      };
    }).sort((x, y) =>
      (y.submissions - x.submissions) || (y.tool_calls - x.tool_calls)
    );

    // 7. Waitlist size
    const { count: waitlistCount } = await db.from('waitlist').select('id', { count: 'exact', head: true });

    return res.status(200).json({
      stats: { ...stats, waitlist: waitlistCount || 0, viral },
      viral,
      referrers,
      rows,
      users,
      active_users_daily:  activeUsersDaily,
      active_users_hourly: activeUsersHourly,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[admin/dashboard] failed:', err && err.message);
    return res.status(500).json({ error: 'Could not load dashboard.' });
  }
}
