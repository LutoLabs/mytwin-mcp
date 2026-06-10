// Throwaway e2e for the compile-throttle fix (June 2026 cost work).
// Run: node --import ./scripts/_loadenv.mjs scripts/_compile-throttle-e2e.mjs
//
// Phase 1 (default): creates a fresh user/tenant (empty concept_pages), bulk-
// ingests 20 knowledge items, prints the tenant id. The Supabase INSERT webhook
// fires twin/item.stored per item; the new debounced compile-concepts-full job
// should produce exactly ONE bootstrap full compile ~5 min after the last item.
//
// Phase 2: node ... scripts/_compile-throttle-e2e.mjs verify <tenantId>
//   Checks background_log + concept_pages for that tenant and reports pass/fail.
//
// Phase 3: node ... scripts/_compile-throttle-e2e.mjs cleanup <userId>
//   Deletes the test account.

import { getOrCreateUser } from '../lib/auth.js';
import { deleteAccount } from '../lib/account.js';
import { getDB } from '../lib/supabase.js';
import { addKnowledge } from '../tools/storage.js';

const mode = process.argv[2] || 'ingest';

if (mode === 'ingest') {
  const ts = Date.now();
  const email = `compile-throttle-${ts}@test.invalid`;
  const r = await getOrCreateUser(email, { allowUninvited: true });
  const ctx = { userId: r.user.id, tenantId: r.user.tenant_id, isAnonymous: false };
  const db = getDB();

  const { data: pages } = await db.from('concept_pages')
    .select('id').eq('tenant_id', ctx.tenantId).limit(1);
  console.log(`user ${ctx.userId}  tenant ${ctx.tenantId}  concept_pages empty: ${!pages?.length}`);

  const topics = [
    ['Pricing anchors', 'Anchor high, justify with value tiers, never discount first.'],
    ['Pricing psychology', 'Decoy options shift perceived value toward the target tier.'],
    ['Workshop openers', 'Open with a provocation, not an agenda slide.'],
    ['Workshop energy', 'Rotate formats every 20 minutes to hold attention.'],
    ['Cold email structure', 'One idea per email; the ask fits in one line.'],
    ['Cold email subject lines', 'Specific beats clever; numbers beat adjectives.'],
    ['Proposal design', 'Lead with the client problem restated sharper than they said it.'],
    ['Proposal pricing page', 'Three options, middle one is the real offer.'],
    ['Keynote pacing', 'A story every seven minutes resets the room.'],
    ['Keynote slides', 'One claim per slide, image over bullet list.'],
    ['Hiring signals', 'Ship-rate over pedigree; ask for artifacts not stories.'],
    ['Hiring interviews', 'Work-sample tasks beat hypothetical questions.'],
    ['Newsletter voice', 'Write to one named reader, not an audience.'],
    ['Newsletter cadence', 'Weekly beats daily for retention past month three.'],
    ['Product onboarding', 'First session must produce one artifact the user keeps.'],
    ['Product metrics', 'Activation is the only metric that matters pre-PMF.'],
    ['Negotiation prep', 'Write the other side\'s best argument before the call.'],
    ['Negotiation concessions', 'Trade, never give; every concession gets a counter.'],
    ['Time blocking', 'Two deep-work blocks before noon, meetings after.'],
    ['Delegation rule', 'Delegate outcomes with constraints, not task lists.'],
  ];

  let ok = 0;
  for (const [title, content] of topics) {
    try {
      await addKnowledge(ctx, {
        type: 'knowledge', title, content,
        source_type: 'typed', provenance: 'personal',
      });
      ok++;
    } catch (err) {
      console.error(`FAIL add "${title}":`, err?.message);
    }
  }
  console.log(`ingested ${ok}/${topics.length} items at ${new Date().toISOString()}`);
  console.log(`\nnext:  node --import ./scripts/_loadenv.mjs scripts/_compile-throttle-e2e.mjs verify ${ctx.tenantId}`);
  console.log(`then:  node --import ./scripts/_loadenv.mjs scripts/_compile-throttle-e2e.mjs cleanup ${ctx.userId}`);
  process.exit(0);
}

if (mode === 'verify') {
  const tenantId = process.argv[3];
  if (!tenantId) { console.error('usage: verify <tenantId>'); process.exit(2); }
  const db = getDB();

  const { data: logs } = await db.from('background_log')
    .select('job_name, status, meta, created_at')
    .eq('tenant_id', tenantId)
    .in('job_name', ['concept-compile', 'concept-recompile'])
    .order('created_at', { ascending: true });

  console.log(`\nbackground_log rows for tenant ${tenantId.slice(0, 8)}:`);
  for (const l of logs || []) {
    console.log(`  ${l.created_at}  ${l.job_name}  ${l.status}  ${JSON.stringify(l.meta)}`);
  }

  const fullCompletes = (logs || []).filter(l =>
    l.job_name === 'concept-compile' && l.status === 'completed');
  const bootstraps = fullCompletes.filter(l => l.meta?.mode === 'bootstrap');

  const { data: pages } = await db.from('concept_pages')
    .select('id, title, flavour, version').eq('tenant_id', tenantId);

  console.log(`\nconcept_pages: ${pages?.length || 0}`);
  for (const p of pages || []) console.log(`  [${p.flavour}] v${p.version} ${p.title}`);

  const pass = fullCompletes.length === 1 && bootstraps.length === 1 && (pages?.length || 0) >= 1;
  console.log(`\n${pass ? 'PASS' : 'FAIL'}: completed full compiles = ${fullCompletes.length} (want 1), bootstrap-tagged = ${bootstraps.length} (want 1), pages = ${pages?.length || 0} (want >=1)`);
  process.exit(pass ? 0 : 1);
}

if (mode === 'cleanup') {
  const userId = process.argv[3];
  if (!userId) { console.error('usage: cleanup <userId>'); process.exit(2); }
  await deleteAccount({ userId });
  console.log(`deleted account ${userId}`);
  process.exit(0);
}

console.error(`unknown mode: ${mode}`);
process.exit(2);
