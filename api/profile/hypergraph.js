// GET /api/profile/hypergraph?workspace_id={uuid}
//
// The permission-scoped hypergraph for a workspace. Defaults to the requester's
// personal workspace when workspace_id is omitted (the only v1 case in practice;
// the param exists so Org/Team Profile reuse this endpoint unchanged).
//
// Returns: { workspace:{id,type,owner,member_since,stats}, nodes[], edges[], domains{} }
//
// Permission scoping (non-negotiable): only items the requester may see are
// returned, and edges connect only accessible nodes (induced subgraph). No
// "redacted" markers. Multi-tenant safe: see lib/profile.js for the access rules.

import { requireAuth } from '../../lib/auth.js';
import { getDB } from '../../lib/supabase.js';
import {
  getPersonalWorkspace,
  getWorkspaceById,
  resolveAccessibleItems,
  countConceptPages,
  getOwnerIdentity,
  getActivePlaceholders,
  isoDate,
} from '../../lib/profile.js';

// ── Static domain inference (v1) ────────────────────────────────────────────
// Six domains, matched against the live tag vocabulary. Each node scores against
// every domain by counting tags that contain any of the domain's keyword tokens;
// the highest-scoring domain wins, ties break by DOMAIN_KEYS order, and a node
// that matches nothing defaults to "Vision & positioning". Colours mirror the
// render spec's DOMAIN_COLOR exactly.
const DOMAIN_COLOR = {
  'Vision & positioning':       '0xFFD400',
  'Twin architecture':          '0x00E0C6',
  'Voice & craft':              '0xFF3D8B',
  'Roadmap & product build':    '0x5B8CFF',
  'Orchestration & automation': '0xFF7A1A',
  'Capability & clients':       '0xA85CFF',
};
const DOMAIN_KEYS = Object.keys(DOMAIN_COLOR);

const DOMAIN_KEYWORDS = {
  'Vision & positioning':       ['vision', 'positioning', 'strategy', 'product-strategy', 'product-vision', 'one-person-unicorn', 'ai-native', 'prelaunch', 'distribution', 'trust', 'credibility', 'compounding', 'thesis', 'moat'],
  'Twin architecture':          ['supabase', 'pinecone', 'mcp', 'rag', 'semantic search', 'architecture', 'system-prompt', 'system prompt', 'intelligence-layer', 'intelligence layer', 'context engineering', 'security', 'dashboard', 'schema', 'retrieval', 'embedding', 'vector', 'database', 'server'],
  'Voice & craft':              ['voice', 'brand', 'branding', 'design', 'ux', 'user experience', 'font', 'color', 'colour', 'logo', 'typography', 'action titles', 'presentation layout', 'vertical outline', 'design-thinking', 'design thinking', 'executive summary', 'craft', 'aesthetic', 'tone'],
  'Roadmap & product build':    ['roadmap', 'product-roadmap', 'product roadmap', 'execution', 'onboarding', 'power-user', 'maia', 'build', 'feature', 'milestone', 'sprint', 'phase', 'launch'],
  'Orchestration & automation': ['orchestration', 'automation', 'workflow', 'pptxgenjs', 'proposal-templates', 'scaffolding', 'chatgpt', 'pipeline', 'agent', 'integration', 'script', 'template'],
  'Capability & clients':       ['cfte', 'mubadala', 'miraval', 'client', 'clients', 'proposal', 'proposal-principles', 'investment', 'hands-on', 'meetings', 'mindfulness', 'spa', 'dossier', 'solution designer', 'tilio', 'cattail', 'dschool', 'clinic', 'capability', 'engagement'],
};

function inferDomain(tags) {
  const lc = (tags || []).map(t => String(t || '').toLowerCase());
  let best = DOMAIN_KEYS[0];
  let bestScore = 0;
  for (const domain of DOMAIN_KEYS) {
    const kws = DOMAIN_KEYWORDS[domain];
    let score = 0;
    for (const tag of lc) {
      for (const kw of kws) {
        if (tag.includes(kw)) { score++; break; }
      }
    }
    if (score > bestScore) { bestScore = score; best = domain; }
  }
  return best;
}

// ── Edge computation ─────────────────────────────────────────────────────────
// Ported from the reference: for each item, its top-2 most-similar siblings by
// shared-tag count. Dedupe i<->j; strength = number of shared tags. Indices
// reference positions in the (already permission-filtered) nodes array, so every
// edge is between two accessible nodes by construction.
function buildEdges(tagSets) {
  const edgeMap = new Map(); // "i:j" (i<j) -> strength
  for (let i = 0; i < tagSets.length; i++) {
    const sims = [];
    for (let j = 0; j < tagSets.length; j++) {
      if (i === j) continue;
      const s = overlap(tagSets[i], tagSets[j]);
      if (s > 0) sims.push([j, s]);
    }
    sims.sort((a, b) => b[1] - a[1]);
    for (const [j, s] of sims.slice(0, 2)) {
      const a = Math.min(i, j), b = Math.max(i, j);
      const key = a + ':' + b;
      if (!edgeMap.has(key) || edgeMap.get(key) < s) edgeMap.set(key, s);
    }
  }
  return [...edgeMap.entries()].map(([key, strength]) => {
    const [i, j] = key.split(':').map(Number);
    return { i, j, strength };
  });
}

function overlap(a, b) {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  const session = await requireAuth(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const db = getDB();

  try {
    // Resolve target workspace.
    const wsParam = (req.query?.workspace_id || '').trim?.() || req.query?.workspace_id;
    let workspace;
    if (wsParam) {
      workspace = await getWorkspaceById(db, wsParam);
      if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    } else {
      workspace = await getPersonalWorkspace(db, session.userId);
      if (!workspace) return res.status(404).json({ error: 'No personal workspace' });
    }

    // Resolve access + accessible items (enforces permission + tenant rules).
    const { access, items } = await resolveAccessibleItems(db, {
      requesterId: session.userId,
      workspace,
    });
    if (access === 'none') return res.status(403).json({ error: 'Forbidden' });

    const isOwner = workspace.owner_id === session.userId;

    // Owner identity for the card.
    const owner = await getOwnerIdentity(db, workspace.owner_id);
    const conceptCount = await countConceptPages(db, { workspace, isOwner });

    // Build nodes (deterministic order = created_at asc from the query).
    const tagSets = items.map(it => new Set((it.tags || []).map(t => String(t).toLowerCase())));
    const edges = buildEdges(tagSets);

    const degree = new Array(items.length).fill(0);
    for (const e of edges) { degree[e.i]++; degree[e.j]++; }

    const nodes = items.map((it, idx) => ({
      id:         it.id,
      title:      it.title || '(untitled)',
      type:       it.type,
      provenance: it.provenance,
      tags:       it.tags || [],
      degree:     degree[idx],
      created_at: it.created_at,
    }));

    // Domain block: domain -> { color, node_ids[] }. node_ids index into nodes.
    const domains = {};
    for (const d of DOMAIN_KEYS) domains[d] = { color: DOMAIN_COLOR[d], node_ids: [] };
    items.forEach((it, idx) => {
      const d = inferDomain(it.tags);
      domains[d].node_ids.push(idx);
    });

    // Empty-state placeholders: owner-only, near-empty workspace, not dismissed.
    // Stamp the palette colour so the client renders the ghost node in-cluster.
    const placeholderDefs = await getActivePlaceholders(db, {
      workspace, isOwner, itemCount: nodes.length,
    });
    const placeholders = placeholderDefs.map(p => ({
      ...p,
      color: DOMAIN_COLOR[p.domain] || DOMAIN_COLOR[DOMAIN_KEYS[0]],
    }));

    return res.status(200).json({
      workspace: {
        id:   workspace.id,
        type: workspace.type,
        owner: owner
          ? { id: owner.id, name: owner.name, email: owner.email }
          : null,
        member_since: isoDate(owner?.created_at),
        viewer_is_owner: isOwner,
        access,
        stats: { items: nodes.length, concept_pages: conceptCount },
      },
      nodes,
      edges,
      domains,
      placeholders,
    });
  } catch (err) {
    console.error('[profile/hypergraph] error:', err?.message);
    return res.status(500).json({ error: 'Could not load profile graph. Try again.' });
  }
}
