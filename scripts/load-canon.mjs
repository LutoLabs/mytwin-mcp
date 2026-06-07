// scripts/load-canon.mjs
// Re-runnable loader for the Eleusis canon seed — the twin's own self-knowledge
// and worldview. See lib/canon.js, schema/canon/, and the build brief.
//
//   node --import ./scripts/_loadenv.mjs scripts/load-canon.mjs            # load / update
//   node --import ./scripts/_loadenv.mjs scripts/load-canon.mjs --dry-run  # preview only
//
// Apply migration 027 once before the first run (it adds the 'canon' provenance
// value and the system tenant/user that own canon rows):
//   node scripts/run-migration.mjs schema/migrations/027-canon-provenance.sql
//
// Idempotent: every canon item has a stable row id and Pinecone id, so a re-run
// UPSERTS the same row/vector rather than duplicating. Edit a file under
// schema/canon/, re-run, and every account receives the update on its next
// session — one shared copy, no per-account backfill.

import { getDB } from '../lib/supabase.js';
import { embed } from '../lib/embed.js';
import { getCanonNamespace } from '../lib/pinecone.js';
import {
  CANON_TENANT_ID, CANON_USER_ID, CANON_PROVENANCE, CANON_NAMESPACE,
  CANON_DISPLAY_LABEL, CANON_ITEMS, readCanonContent,
} from '../lib/canon.js';

const DRY = process.argv.includes('--dry-run');

async function main() {
  const db = getDB();

  // Precondition: migration 027 must have created the system tenant. Fail fast
  // with guidance rather than emitting a confusing FK / CHECK error mid-loop.
  const { data: tenant, error: tErr } = await db
    .from('tenants').select('id').eq('id', CANON_TENANT_ID).maybeSingle();
  if (tErr) throw new Error(`tenant precondition check failed: ${tErr.message}`);
  if (!tenant) {
    throw new Error(
      `Canon system tenant ${CANON_TENANT_ID} not found. Apply migration 027 first:\n` +
      `  node scripts/run-migration.mjs schema/migrations/027-canon-provenance.sql`,
    );
  }

  const ns = getCanonNamespace();
  let written = 0;

  for (const item of CANON_ITEMS) {
    const content = readCanonContent(item);
    console.log(`${DRY ? '[dry-run] ' : ''}"${item.title}" (${item.id}) — ${content.length} chars`);
    if (DRY) continue;

    // 1. Upsert the Supabase row. Column set mirrors tools/storage.js addKnowledge
    //    (version_number / visibility / workspace_id keep their DB defaults).
    //    onConflict:'id' → a re-run updates content in place; created_at is left
    //    untouched on update, the knowledge_updated_at trigger bumps updated_at.
    const { data: row, error: upErr } = await db
      .from('knowledge')
      .upsert({
        id:                 item.id,
        user_id:            CANON_USER_ID,
        tenant_id:          CANON_TENANT_ID,
        type:               item.type,
        title:              item.title,
        content,
        source_type:        'canon',
        source_ref:         CANON_DISPLAY_LABEL,   // "Source: Eleusis" in the context block
        tags:               ['eleusis', 'canon'],
        pinecone_id:        item.pinecone_id,
        provenance:         CANON_PROVENANCE,
        is_living_document: false,
      }, { onConflict: 'id' })
      .select()
      .single();
    if (upErr) {
      if (/provenance/i.test(upErr.message)) {
        throw new Error(`Rejected by the provenance CHECK constraint — apply migration 027 first.\n  ${upErr.message}`);
      }
      throw new Error(`knowledge upsert failed for ${item.id}: ${upErr.message}`);
    }

    // 2. Embed + upsert the vector into the shared canon namespace. metadata
    //    mirrors addKnowledge so retrieval reads canon exactly like any item.
    const embedding = await embed(content);
    await ns.upsert([{
      id:     item.pinecone_id,
      values: embedding,
      metadata: {
        knowledge_id:   item.id,
        user_id:        CANON_USER_ID,
        tenant_id:      CANON_TENANT_ID,
        type:           item.type,
        knowledge_type: item.type,
        provenance:     CANON_PROVENANCE,
        source_type:    'canon',
        source_ref:     CANON_DISPLAY_LABEL,
        created_at:     row.created_at,
      },
    }]);
    written++;
  }

  console.log(
    DRY
      ? `\n[dry-run] would load ${CANON_ITEMS.length} canon item(s) into namespace "${CANON_NAMESPACE}".`
      : `\nLoaded ${written} canon item(s) into namespace "${CANON_NAMESPACE}". Every account receives them on next session.`,
  );
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('[load-canon] ' + (err?.message || err));
  process.exit(1);
});
