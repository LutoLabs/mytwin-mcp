// lib/background-jobs.js
//
// Three durable Inngest background jobs:
//
//   1. compile-concepts  — fires on every item store; replaces the old setTimeout
//   2. detect-skill      — fires on every item store; writes to skill_proposals when a
//                          repeatable pattern is visible across recent craft items
//   3. nightly-lint      — cron at 2am UTC; checks twin health across active tenants
//
// All failures are caught, logged to background_log, and never surfaced to users.
// Inngest handles retries automatically per each function's `retries` setting.

import { inngest } from './inngest.js';

// ── Job 1 — Concept compilation (synthesis-page maintenance) ──────────────────
// Triggered by every knowledge INSERT via Supabase webhook → Inngest event.
//
// Cost guardrail: this no longer recompiles every page on every insert. Instead:
//   • First item for a tenant with no pages yet → bootstrap: full compile once.
//   • Otherwise → mark only the pages whose topic matches the new item as stale
//     (cheap, no LLM), then emit twin/concepts.stale to schedule a debounced
//     recompile. Pages that don't match are never touched and cost nothing.

export const compileConceptsJob = inngest.createFunction(
  {
    id: 'compile-concepts',
    retries: 2,
    // Serialize per tenant. Without this, a bulk ingest into an empty tenant
    // runs many store-handlers at once, each reading zero pages before any has
    // written — the read-before-write race that fired a dozen parallel full
    // compiles. With one in flight per tenant, the first store schedules the
    // (debounced) bootstrap and the rest fall through to cheap stale-marking.
    concurrency: { limit: 1, key: 'event.data.tenant_id' },
  },
  { event: 'twin/item.stored' },
  async ({ event, step }) => {
    const { tenant_id, user_id, item_id } = event.data;

    const outcome = await step.run('mark-stale-or-bootstrap', async () => {
      const { getDB } = await import('./supabase.js');
      const db = getDB();

      // Do any synthesis pages exist yet for this user?
      const { data: existing } = await db
        .from('concept_pages')
        .select('id')
        .eq('tenant_id', tenant_id)
        .eq('user_id', user_id)
        .limit(1);

      // No pages yet → needs a first full compile. We do NOT compile inline here
      // (that bypassed all throttling). Instead emit twin/concepts.compile, which
      // a debounced + concurrency-capped job consumes: one bootstrap per tenant
      // per quiet window, regardless of how many items land in the burst.
      if (!existing?.length) {
        return { mode: 'needs-bootstrap' };
      }

      // Targeted stale marking — no LLM, no recompile on the write path.
      const { markStalePagesForItem } = await import('./compile-concepts.js');
      try {
        const staleCount = await markStalePagesForItem({
          userId: user_id, tenantId: tenant_id, itemId: item_id,
        });
        return { mode: 'mark-stale', staleCount };
      } catch (err) {
        // Migration gap: the is_stale/stale_since columns are missing. This is an
        // operational error, NOT a signal to full-compile per item — that path
        // amplified spend (one full compile on EVERY store). Surface it loudly
        // and skip; applying migration 024 restores the cheap path. The brief's
        // preferred option (a): fail loud, don't let a migration gap burn tokens.
        if (/is_stale|stale_since|column|schema cache/i.test(err?.message || '')) {
          const { writeBackgroundLog } = await import('./background-log.js');
          await writeBackgroundLog(tenant_id, 'concept-compile', 'failed', {
            stage: 'mark-stale', reason: 'missing_stale_columns', error: err?.message,
          });
          return { mode: 'schema-missing-skipped' };
        }
        throw err;
      }
    });

    // Bootstrap and stale-recompile both run through their own debounced jobs so
    // a burst collapses to a single full/recompile per tenant per quiet window.
    if (outcome?.mode === 'needs-bootstrap') {
      await step.sendEvent('schedule-bootstrap-compile', {
        name: 'twin/concepts.compile',
        data: { tenant_id, user_id },
      });
    } else if (outcome?.mode === 'mark-stale' && outcome.staleCount > 0) {
      await step.sendEvent('schedule-recompile', {
        name: 'twin/concepts.stale',
        data: { tenant_id, user_id },
      });
    }
  },
);

// ── Job 1b — Debounced bootstrap / full compile ───────────────────────────────
// Consumes twin/concepts.compile (emitted above when a tenant has no concept
// pages yet). Debounced 5 minutes per tenant so a bulk ingest into an empty
// tenant collapses to ONE full compile, and concurrency-capped at 1 per tenant
// as a second guard. Re-checks pages-empty immediately before compiling, closing
// the read-before-write race if events were already in flight. Runs the compile
// WITH `step`, so a retry replays already-written pages from memoized state
// instead of regenerating (and re-paying for) them.

export const compileConceptsFullJob = inngest.createFunction(
  {
    id: 'compile-concepts-full',
    retries: 2,
    debounce: { period: '5m', key: 'event.data.tenant_id' },
    concurrency: { limit: 1, key: 'event.data.tenant_id' },
  },
  { event: 'twin/concepts.compile' },
  async ({ event, step }) => {
    const { tenant_id, user_id } = event.data;

    // Guard: a prior window may have already bootstrapped this tenant. If pages
    // now exist, skip — the cheap mark-stale path owns maintenance from here.
    const stillEmpty = await step.run('check-still-empty', async () => {
      const { getDB } = await import('./supabase.js');
      const db = getDB();
      const { data } = await db
        .from('concept_pages')
        .select('id')
        .eq('tenant_id', tenant_id)
        .eq('user_id', user_id)
        .limit(1);
      return !data?.length;
    });

    if (!stillEmpty) {
      const { writeBackgroundLog } = await import('./background-log.js');
      await writeBackgroundLog(tenant_id, 'concept-compile', 'skipped', {
        mode: 'bootstrap', reason: 'pages_already_exist',
      });
      return;
    }

    // compileConceptsForTenant writes its own background_log entry (mode tagged)
    // and THROWS on fatal failure so Inngest retries; per-page steps make the
    // retry idempotent (only the failed page re-runs).
    const { compileConceptsForTenant } = await import('./compile-concepts.js');
    await compileConceptsForTenant({
      userId: user_id, tenantId: tenant_id, step, mode: 'bootstrap',
    });
  },
);

// ── Job 1b — Debounced stale-page recompile ───────────────────────────────────
// Fires after twin/concepts.stale, debounced 5 minutes per tenant. Recompiles
// ONLY pages already flagged stale; idempotent (a no-op if none remain). This is
// the only place the recompile LLM cost is paid, and never on the ingest path.

export const recompileStaleJob = inngest.createFunction(
  {
    id: 'recompile-stale-concepts',
    retries: 2,
    debounce: { period: '5m', key: 'event.data.tenant_id' },
  },
  { event: 'twin/concepts.stale' },
  async ({ event, step }) => {
    const { tenant_id, user_id } = event.data;
    await step.run('recompile', async () => {
      const { recompileStalePages } = await import('./compile-concepts.js');
      await recompileStalePages({ userId: user_id, tenantId: tenant_id });
    });
  },
);

// ── Job 1c — Reconciliation (shadow mode) ─────────────────────────────────────
// Runs on every store. Reconciles the new item against existing ones and LOGS
// the decision (relationship + would-be action) to reconciliation_decisions —
// taking NO write action in Phase 2 (shadow). This proves the system is additive
// and produces the data to tune thresholds before any auto-action is enabled.
//
// concurrency-limited so a burst (bulk contribute, doc chunking) can't spike the
// classifier cost; idempotent + fail-safe inside reconcileItem.

export const reconcileItemJob = inngest.createFunction(
  { id: 'reconcile-item', retries: 2, concurrency: { limit: 3 } },
  { event: 'twin/item.stored' },
  async ({ event, step }) => {
    const { tenant_id, user_id, item_id } = event.data;
    if (!item_id || !tenant_id || !user_id) return;
    await step.run('reconcile-shadow', async () => {
      const { reconcileItem } = await import('./reconciliation/engine.js');
      // shadow defaults from RECON_CONFIG.shadowMode (true in Phase 2).
      return await reconcileItem({ tenantId: tenant_id, userId: user_id, itemId: item_id });
    });
  },
);

// ── Job 2 — Skill detection ───────────────────────────────────────────────────
// Runs on every store. Looks for a repeatable skill pattern across recent
// craft-oriented items. When found, writes a proposal to skill_proposals.

export const detectSkillJob = inngest.createFunction(
  { id: 'detect-skill', retries: 1 },
  { event: 'twin/item.stored' },
  async ({ event, step }) => {
    const { tenant_id, user_id } = event.data;

    const proposal = await step.run('detect', async () => {
      const { getDB } = await import('./supabase.js');
      const db = getDB();

      // Only look at craft-type items — the raw material for skill detection.
      const { data: items } = await db
        .from('knowledge')
        .select('id, title, content, type, created_at')
        .eq('tenant_id', tenant_id)
        .eq('user_id', user_id)
        .in('type', ['skill', 'knowledge'])  // knowledge items can also contribute to craft skills
        .order('created_at', { ascending: false })
        .limit(20);

      // Need at least 3 items before a pattern can form.
      if (!items || items.length < 3) return null;

      // Ask Haiku if a repeatable skill is forming across these items.
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

      let responseText;
      try {
        const response = await client.messages.create({
          model: 'claude-haiku-4-5',
          max_tokens: 300,
          messages: [{
            role: 'user',
            content: `These are recent items from a personal knowledge base:
${items.map(i => `- ${i.title || '(no title)'}: ${(i.content || '').slice(0, 100)}`).join('\n')}

Is there a clear reusable skill visible across these items?
A skill is a repeatable pattern for creating a specific type of output.
Only return true if the skill is unmistakably evident across multiple items.

Return JSON only, no markdown:
{"detected": true, "skill_title": "...", "description": "one sentence"}
or
{"detected": false}`,
          }],
        });
        responseText = response.content?.[0]?.text?.trim() || '{"detected":false}';
      } catch {
        return null;
      }

      let result;
      try {
        result = JSON.parse(responseText);
      } catch {
        return null;
      }
      return result?.detected ? result : null;
    });

    if (!proposal) return;

    await step.run('store-proposal', async () => {
      const { getDB } = await import('./supabase.js');
      const db = getDB();

      // Idempotent — skip if a pending proposal with the same title already exists.
      const { data: existing } = await db
        .from('skill_proposals')
        .select('id')
        .eq('tenant_id', tenant_id)
        .eq('title', proposal.skill_title)
        .eq('status', 'pending')
        .maybeSingle();

      if (existing) return;

      await db.from('skill_proposals').insert({
        tenant_id,
        user_id,
        title:       proposal.skill_title,
        description: proposal.description,
        status:      'pending',
      });
    });

    await step.run('log', async () => {
      const { writeBackgroundLog } = await import('./background-log.js');
      await writeBackgroundLog(tenant_id, 'skill-detect', 'completed');
    });
  },
);

// ── Job 3 — Nightly lint ──────────────────────────────────────────────────────
// Runs every night at 2am UTC. Checks twin health across all active tenants.
// Writes orphaned item counts and thin concept pages to background_log.

export const nightlyLintJob = inngest.createFunction(
  { id: 'nightly-lint', retries: 1 },
  { cron: '0 2 * * *' },
  async ({ step }) => {
    const { getDB } = await import('./supabase.js');
    const db = getDB();

    // Tenants active in the last 30 days.
    const { data: tenants } = await db
      .from('tenants')
      .select('id')
      .gte('updated_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());

    if (!tenants?.length) return;

    for (const tenant of tenants) {
      await step.run(`lint-${tenant.id}`, async () => {
        try {
          const { getDB: getDB2 }     = await import('./supabase.js');
          const { writeBackgroundLog } = await import('./background-log.js');
          const db2 = getDB2();

          const [{ data: items }, { data: pages }] = await Promise.all([
            db2.from('knowledge').select('id, type, title').eq('tenant_id', tenant.id),
            db2.from('concept_pages').select('id, title, source_ids').eq('tenant_id', tenant.id),
          ]);

          if (!items?.length) return;

          // Orphaned = items not referenced in any concept page.
          const allSourceIds = new Set((pages || []).flatMap(p => p.source_ids || []));
          const orphanedCount = items.filter(i => !allSourceIds.has(i.id)).length;

          // Thin = concept pages with only 1 source item.
          const thinCount = (pages || []).filter(p => (p.source_ids || []).length <= 1).length;

          await writeBackgroundLog(tenant.id, 'lint', 'completed', {
            orphaned_item_count:      orphanedCount,
            thin_concept_page_count:  thinCount,
            total_items:              items.length,
          });
        } catch (err) {
          const { writeBackgroundLog } = await import('./background-log.js');
          await writeBackgroundLog(tenant.id, 'lint', 'failed', { error: err?.message });
        }
      });
    }
  },
);
