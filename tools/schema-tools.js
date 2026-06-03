import { getDB } from '../lib/supabase.js';

function sbError(op, error) {
  console.error(`[mytwin/supabase] ${op} failed:`, {
    message: error.message, code: error.code, details: error.details, hint: error.hint, status: error.status,
  });
  const err = new Error(error.message);
  err.code = error.code; err.details = error.details; err.hint = error.hint; err.status = error.status;
  return err;
}

// ── get_schema ────────────────────────────────────────────────────────────────

export async function getSchema(ctx) {
  const db = getDB();

  let countsQ = db.from('knowledge').select('type').eq('user_id', ctx.userId).eq('tenant_id', ctx.tenantId);
  if (ctx.visibilityFilter === 'sharable') countsQ = countsQ.eq('visibility', 'sharable');

  const [{ data: types }, { data: counts }, synthesisRes] = await Promise.all([
    db.from('schema_types').select('*').eq('user_id', ctx.userId).eq('tenant_id', ctx.tenantId).order('created_at'),
    countsQ,
    // Synthesis-pages are agent-compiled distillations, stored separately in
    // concept_pages — not a knowledge type. Surfaced here so the model knows
    // the compiled wiki layer exists alongside the raw items.
    db.from('concept_pages').select('id, is_stale', { count: 'exact' })
      .eq('user_id', ctx.userId).eq('tenant_id', ctx.tenantId),
  ]);

  const countMap = {};
  for (const row of counts || []) {
    countMap[row.type] = (countMap[row.type] || 0) + 1;
  }

  const synthesisPages = synthesisRes.data || [];
  const synthesisTotal = synthesisRes.count ?? synthesisPages.length;
  const synthesisStale = synthesisPages.filter(p => p.is_stale).length;

  // The per-type list only includes types that have a schema_types row. Derive
  // total_items from the counts we actually return (not from every distinct
  // type in countMap), so the total can never disagree with the visible list.
  // A row whose type has no schema_types entry (e.g. a legacy "decision" type)
  // is therefore excluded from both, by construction.
  const typeList = (types || []).map(t => ({
    name: t.name,
    description: t.description,
    count: countMap[t.name] || 0,
  }));

  return {
    types: typeList,
    total_types: typeList.length,
    total_items: typeList.reduce((sum, t) => sum + t.count, 0),
    synthesis_pages: {
      count: synthesisTotal,
      stale: synthesisStale,
      note: 'Agent-compiled distillations of your knowledge clusters (the "what I know about X" layer above raw items). They recompile automatically when related items are added.',
    },
    note: 'Add new types with add_schema_type. Extend from Claude chat, no database access needed.',
  };
}

// ── add_schema_type ───────────────────────────────────────────────────────────

export async function addSchemaType(ctx, { name, description }) {
  const db = getDB();

  const clean = name.toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/-+/g, '-');

  const { data, error } = await db
    .from('schema_types')
    .insert({ user_id: ctx.userId, tenant_id: ctx.tenantId, name: clean, description })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') throw new Error(`Type "${clean}" already exists. Use update_schema_type to change its description.`);
    throw sbError('schema_types.insert', error);
  }

  return {
    added: true,
    type: { name: data.name, description: data.description },
    note: `You can now store knowledge with type "${data.name}". Use add_knowledge to add your first item.`,
  };
}

// ── update_schema_type ────────────────────────────────────────────────────────

export async function updateSchemaType(ctx, { name, description }) {
  const db = getDB();

  const { data, error } = await db
    .from('schema_types')
    .update({ description })
    .eq('user_id', ctx.userId).eq('tenant_id', ctx.tenantId)
    .eq('name', name)
    .select()
    .single();

  if (error) throw sbError('schema_types.update', error);
  if (!data) throw new Error(`Type "${name}" not found. Run get_schema to see available types.`);

  return { updated: true, type: { name: data.name, description: data.description } };
}
