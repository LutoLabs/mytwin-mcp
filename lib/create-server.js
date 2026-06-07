import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { addKnowledge, addFromUrl, addDocument, addVoiceNote, addReferenceRecord } from '../tools/storage.js';
import { getSchema, addSchemaType, updateSchemaType } from '../tools/schema-tools.js';
import { searchTwin, getByType, getByTag, synthesise, searchForCreation, getDocument } from '../tools/retrieval.js';
import { findPatternsInKnowledge, getSources } from '../tools/analysis.js';
import { listRecent, updateKnowledge, deleteKnowledge } from '../tools/management.js';
import { getWelcome, getTwinContext } from '../tools/welcome.js';
import { listWorkspaces, contributeItemsToWorkspace } from '../tools/workspaces.js';
import { logAudit } from './audit.js';
import { SYSTEM_PROMPT } from './system-prompt.js';

// ── Human error mapping ───────────────────────────────────────────────────────

function mapErrorToHuman(error) {
  const msg = (error.message || '') + (String(error.status || ''));
  if (/invalid api key|401|unauthorized|forbidden/i.test(msg))
    return 'Your API key was rejected. If the problem continues, go to myaitwin.lutolearn.com to reconnect.';
  if (/index not found|404/i.test(msg))
    return 'Could not find your Pinecone index. Try reconnecting at myaitwin.lutolearn.com.';
  if (/ECONNREFUSED|ENOTFOUND|network|fetch failed|getaddrinfo/i.test(msg))
    return 'Could not reach the database. Check your connection and try again.';
  if (/429|rate.?limit/i.test(msg))
    return 'Rate limited. Wait 30 seconds and try again.';
  if (/insufficient_quota|billing|credit/i.test(msg))
    return 'Your OpenAI account is out of credit. Go to platform.openai.com → Billing to add funds.';
  return 'Something went wrong. Try again, or go to myaitwin.lutolearn.com/help';
}

// ── Request context wrapper ───────────────────────────────────────────────────
// All tools take (ctx, input). `ctx` is the resolved request context — today
// just { userId }, but the shape is the contract for everything downstream
// (tenants, auth method, request_id). wrap() owns the ctx-injection and the
// error mapping so individual tools stay focused on their own logic.

function wrap(ctx, fn) {
  return async (input) => {
    const toolName = fn.name || 'unknown';
    try {
      const result = await fn(ctx, input || {});
      // Capture an item identifier if the tool returned one — never the content
      const itemId = result && typeof result === 'object' && typeof result.id === 'string' ? result.id : null;
      logAudit({
        userId:    ctx.userId,
        tenantId:  ctx.tenantId,
        eventType: 'tool_call',
        toolName,
        itemId,
        success:   true,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      console.error(`[mytwin] tool error — userId=${ctx.userId} fn=${toolName}`, {
        message:  error.message,
        code:     error.code,
        details:  error.details,
        hint:     error.hint,
        status:   error.status,
        stack:    error.stack?.split('\n').slice(0, 4).join(' | '),
      });
      logAudit({
        userId:    ctx.userId,
        tenantId:  ctx.tenantId,
        eventType: 'tool_call',
        toolName,
        success:   false,
        errorType: error?.name || (error?.userFacing ? 'UserError' : 'InternalError'),
        errorMsg:  error?.message,
      });
      // UserError messages are pre-vetted as safe to surface verbatim. Trim
      // any stack-trace-shaped messages so Anthropic's frugality + safety bars
      // are met (one clear sentence, no internals).
      const raw  = error?.userFacing ? error.message : mapErrorToHuman(error);
      const text = String(raw || '').split('\n')[0].slice(0, 300);
      return { content: [{ type: 'text', text }] };
    }
  };
}

// ── Server factory ────────────────────────────────────────────────────────────

export function createServer(ctx) {
  // Fail-closed contract: every tool downstream assumes both userId AND
  // tenantId are set. Refuse to construct a server without them — this is
  // cheaper than risking an unscoped query reaching the DB.
  if (!ctx || !ctx.userId || !ctx.tenantId) {
    throw new Error('createServer: ctx must include userId and tenantId');
  }

  const server = new McpServer({
    name: 'myaitwin',
    version: '2.0.0',
    description: 'MyAITwin MCP: personal knowledge twin. RULE: When get_welcome returns a message, output it to the user word for word. Do not rewrite, summarise, or add commentary. Present it exactly as returned.',
  });

  // ── Storage ─────────────────────────────────────────────────────────────────

  server.tool(
    'add_knowledge',
    'Store a piece of knowledge or a skill in your twin. Automatically tagged and embedded for search. The twin stores two fundamentally different things: knowledge (what the user knows: transcripts, decisions, ideas, observations) and skills (how they express things: their LinkedIn voice, email style, proposal structure, feedback frameworks). Treat skills as a significant moment; they codify craft.',
    {
      type: z.string().describe(
        'Type for this item. Common types:\n' +
        ' • skill: how you express something. Your LinkedIn voice, your email style, your proposal structure. The craft layer that shapes knowledge into output.\n' +
        ' • principle: repeating values, rules, guidelines you apply consistently.\n' +
        ' • knowledge: expertise areas, domain knowledge, what you know deeply.\n' +
        ' • idea: concepts, hypotheses, things you\'re exploring.\n' +
        ' • voice: writing style, tone, how you communicate.\n' +
        ' • brand: visual preferences, aesthetic principles, brand rules.\n' +
        ' • template: reusable structures, formats, scaffolding.\n' +
        ' • resource: links, documents, references you trust.\n' +
        ' • reference-record: created via add_reference_record after a creation task. Do not store directly.\n' +
        ' • meta-principle: surfaced by find_patterns after enough reference records exist.\n' +
        'Or any custom type already in the user\'s schema.'
      ),
      content:     z.string().describe('The actual content. Write it clearly, in the user\'s voice.'),
      title:       z.string().optional().describe('Short label for this item (optional)'),
      tags:        z.array(z.string()).optional().describe('Manual tags to add on top of auto-generated ones'),
      source_ref:  z.string().optional().describe('Where this came from (document name, URL, etc.)'),
      provenance:  z.enum(['personal', 'organisational', 'employer', 'client', 'external']).optional().describe(
        'Where this content originates. personal = the user\'s own thinking. employer = from the user\'s own company/employer (team docs, internal materials, colleagues). client = from or about a specific client (their voice, their deliverables, their brief). external = from outside (articles, reports, third-party authors). organisational is a legacy value being split into employer/client; prefer the more specific value. Default: personal.'
      ),
    },
    { title: 'Add Knowledge', readOnlyHint: false, destructiveHint: false },
    // tags → manual_tags: a thin adapter that fits the public API to the
    // tool function's parameter shape. Wrap still calls (ctx, input).
    wrap(ctx, (c, input) => addKnowledge(c, { ...input, manual_tags: input.tags }))
  );

  server.tool(
    'add_reference_record',
    'Record a creation event after the user has produced something with the twin\'s help: pairs knowledge used + skill applied + output produced + the nuance of this specific case. The system prompt instructs you to offer this after significant creation tasks; call it once the user confirms.',
    {
      title:          z.string().optional().describe('Short description of what was created (e.g. "LinkedIn post about Q3 outlook")'),
      knowledge_ids:  z.array(z.string()).optional().describe('IDs of knowledge items used (from search_for_creation results)'),
      skill_id:       z.string().optional().describe('ID of the skill applied (from search_for_creation skills bucket)'),
      output_summary: z.string().describe('One-paragraph summary of the output that was produced'),
      nuance:         z.string().optional().describe('What was different or adapted in THIS specific case. The lesson worth keeping.'),
      tags:           z.array(z.string()).optional().describe('Tags: inherit from the knowledge and skill plus any case-specific tags.'),
    },
    { title: 'Add Reference Record', readOnlyHint: false, destructiveHint: false },
    wrap(ctx, addReferenceRecord)
  );

  server.tool(
    'add_from_url',
    'Fetch a URL, extract what\'s worth knowing, and store it. The twin analyses the page against your existing schema and reports what it found before confirming what was stored.',
    {
      url:   z.string().url().describe('The URL to fetch and analyse'),
      notes: z.string().optional().describe('Why you\'re ingesting this. Adds context to what gets stored.'),
    },
    { title: 'Add From URL', readOnlyHint: false, destructiveHint: false },
    wrap(ctx, addFromUrl)
  );

  server.tool(
    'add_document',
    'Ingest a document by providing its text content. Chunks and stores with source tracking. Good for PDFs, notes, reports.',
    {
      filename: z.string().describe('Document name (used as source reference in all future results)'),
      content:  z.string().describe('The full text content of the document'),
      notes:    z.string().optional().describe('Context about this document'),
    },
    { title: 'Add Document', readOnlyHint: false, destructiveHint: false },
    wrap(ctx, addDocument)
  );

  server.tool(
    'add_voice_note',
    'Ingest a voice note transcript. The twin extracts principles, decisions, and ideas, identifying what you said that\'s worth keeping, in your language. Source is tracked as voice note + date.',
    {
      transcript: z.string().describe('The full transcript text from Otter or similar'),
      date:       z.string().optional().describe('Date of the voice note, e.g. "2026-05-16"'),
      notes:      z.string().optional().describe('What this voice note was about'),
    },
    { title: 'Add Voice Note', readOnlyHint: false, destructiveHint: false },
    wrap(ctx, addVoiceNote)
  );

  // ── Schema ──────────────────────────────────────────────────────────────────

  server.tool(
    'get_schema',
    'Show what knowledge types exist in your twin, how many items of each type are stored, and the total knowledge base size.',
    {},
    { title: 'Get Schema', readOnlyHint: true, destructiveHint: false },
    wrap(ctx, getSchema)
  );

  server.tool(
    'add_schema_type',
    'Add a new knowledge type. Do this from Claude chat, no database access needed. The type is immediately available for storing knowledge.',
    {
      name:        z.string().describe('Type name. Lowercase and short, e.g. "case-study" or "objection".'),
      description: z.string().describe('What this type stores. One clear sentence.'),
    },
    { title: 'Add Schema Type', readOnlyHint: false, destructiveHint: false },
    wrap(ctx, addSchemaType)
  );

  server.tool(
    'update_schema_type',
    'Update the description of an existing knowledge type.',
    {
      name:        z.string().describe('The type name to update'),
      description: z.string().describe('New description'),
    },
    { title: 'Update Schema Type', readOnlyHint: false, destructiveHint: false },
    wrap(ctx, updateSchemaType)
  );

  // ── Retrieval ────────────────────────────────────────────────────────────────

  server.tool(
    'search_twin',
    'Semantically search everything in your twin. Returns the most relevant items ranked by relevance, each with its source cited.',
    {
      query: z.string().describe('What you\'re looking for. Natural language.'),
      top_k: z.number().optional().describe('How many results to return (default 10, capped at 10)'),
      type:  z.string().optional().describe('Filter to a specific knowledge type'),
    },
    { title: 'Search Twin', readOnlyHint: true, destructiveHint: false },
    wrap(ctx, searchTwin)
  );

  server.tool(
    'get_by_type',
    'Retrieve all knowledge of a specific type, newest first.',
    {
      type:  z.string().describe('Knowledge type to retrieve'),
      limit: z.number().optional().describe('Max items to return (default 20)'),
    },
    { title: 'Get By Type', readOnlyHint: true, destructiveHint: false },
    wrap(ctx, getByType)
  );

  server.tool(
    'get_by_tag',
    'Retrieve all knowledge with a specific tag.',
    {
      tag:   z.string().describe('Tag to filter by'),
      limit: z.number().optional().describe('Max items to return (default 20)'),
    },
    { title: 'Get By Tag', readOnlyHint: true, destructiveHint: false },
    wrap(ctx, getByTag)
  );

  server.tool(
    'get_document',
    'Expand a whole document by its document_id (returned on search_twin results that carry one). Returns the document summary plus every part in order and the reassembled full text. Use when the user asks to summarise, read, or pull back a complete document rather than a single matching passage.',
    {
      document_id: z.string().describe('The document_id from a search_twin result (the source/parent id).'),
    },
    { title: 'Get Document', readOnlyHint: true, destructiveHint: false },
    wrap(ctx, getDocument)
  );

  server.tool(
    'search_for_creation',
    'Use this BEFORE any creation task ("help me write X", "I\'m working on Y"). Runs two parallel searches and returns them separately: a SKILLS bucket (skill/voice/template, the craft layer) and a KNOWLEDGE bucket (knowledge/principle/brand/idea/resource, the material). Bring both into context before producing output. If the skills bucket is empty and `output_type` is set, this also increments a skill-gap counter; when count reaches 3 the response includes `skill_gap.skill_gap_threshold_reached: true` so you can prompt the user to codify a skill.',
    {
      query:       z.string().describe('What you\'re looking for. Natural language, the task or topic at hand.'),
      output_type: z.string().optional().describe('What kind of output the user is creating (e.g. "linkedin-post", "client-proposal", "follow-up-email"). Used to track the skill gap if no matching skill exists.'),
    },
    { title: 'Search For Creation', readOnlyHint: true, destructiveHint: false },
    wrap(ctx, searchForCreation)
  );

  server.tool(
    'synthesise',
    'Pull everything relevant on a topic and return structured, usable output, ready to turn into a brief, a slide, or a team handoff. Every source cited.',
    {
      topic: z.string().describe('The topic or question to synthesise on'),
      top_k: z.number().optional().describe('How many knowledge items to draw from (default 10, capped at 10)'),
      type:  z.string().optional().describe('Focus synthesis on a specific knowledge type'),
    },
    { title: 'Synthesise', readOnlyHint: true, destructiveHint: false },
    wrap(ctx, synthesise)
  );

  // ── Analysis ─────────────────────────────────────────────────────────────────

  server.tool(
    'find_patterns',
    'Analyse your stored knowledge and surface recurring themes: principles you repeat without naming, patterns in how you think. Especially powerful after adding several voice notes.',
    {
      focus: z.string().optional().describe('Focus analysis on a specific type, e.g. "principle" or "voice-note"'),
    },
    { title: 'Find Patterns', readOnlyHint: true, destructiveHint: false },
    wrap(ctx, findPatternsInKnowledge)
  );

  server.tool(
    'get_sources',
    'Show all documents, URLs, and voice notes that have been ingested, with what was extracted from each.',
    {
      source_type: z.enum(['document', 'url', 'voice-note']).optional().describe('Filter by source type'),
    },
    { title: 'Get Sources', readOnlyHint: true, destructiveHint: false },
    wrap(ctx, getSources)
  );

  // ── Management ───────────────────────────────────────────────────────────────

  server.tool(
    'list_recent',
    'Show the most recently added knowledge items.',
    {
      limit: z.number().optional().describe('How many to show (default 10)'),
      type:  z.string().optional().describe('Filter to a specific type'),
    },
    { title: 'List Recent', readOnlyHint: true, destructiveHint: false },
    wrap(ctx, listRecent)
  );

  server.tool(
    'update_knowledge',
    'Edit a stored knowledge item. Provide the item ID and the fields to change.',
    {
      id:         z.string().describe('The knowledge item ID (from search_twin or list_recent)'),
      content:    z.string().optional().describe('New content (will be re-embedded)'),
      title:      z.string().optional().describe('New title'),
      tags:       z.array(z.string()).optional().describe('Replace tags'),
      type:       z.string().optional().describe('Change the type'),
      provenance: z.enum(['personal', 'organisational', 'employer', 'client', 'external']).optional().describe('Update provenance: personal / employer / client / external (organisational is legacy)'),
    },
    { title: 'Update Knowledge', readOnlyHint: false, destructiveHint: false },
    wrap(ctx, updateKnowledge)
  );

  server.tool(
    'delete_knowledge',
    'Remove a knowledge item from your twin. This is irreversible.',
    {
      id: z.string().describe('The knowledge item ID to delete'),
    },
    { title: 'Delete Knowledge', readOnlyHint: false, destructiveHint: true },
    wrap(ctx, deleteKnowledge)
  );

  // ── Workspaces ───────────────────────────────────────────────────────────────

  server.tool(
    'list_workspaces',
    'List the organisation workspaces you belong to, with your role in each (owner, admin, member, or guest). Call this to discover workspace IDs before using contribute_to_workspace.',
    {},
    { title: 'List Workspaces', readOnlyHint: true, destructiveHint: false },
    wrap(ctx, listWorkspaces)
  );

  server.tool(
    'contribute_to_workspace',
    'Copy one or more of your personal knowledge items into an organisation workspace. ' +
    'The originals stay in your personal twin unchanged — this creates copies in the workspace so all members can retrieve them. ' +
    'IMPORTANT: This is a sharing action. Always confirm the items and target workspace with the user before calling this with multiple items. ' +
    'Items you do not own, or that are already in the workspace, are reported as failed per-item rather than aborting the whole batch. ' +
    'If you belong to exactly one workspace you can omit workspace_id; otherwise call list_workspaces first to get the ID.',
    {
      item_ids:     z.array(z.string()).min(1).describe('IDs of the personal knowledge items to contribute (from search_twin, list_recent, etc.)'),
      workspace_id: z.string().uuid().optional().describe('Target workspace ID. Omit only if you belong to exactly one organisation workspace; otherwise look up IDs with list_workspaces.'),
    },
    { title: 'Contribute to Workspace', readOnlyHint: false, destructiveHint: false },
    wrap(ctx, contributeItemsToWorkspace)
  );

  // ── Welcome ──────────────────────────────────────────────────────────────────

  server.tool(
    'get_welcome',
    'Returns the user\'s personalised session opener: a short message that surfaces twin state, recent activity, and current focus. Call this on the user\'s first message each session, before responding to anything else.',
    {},
    { title: 'Get Welcome', readOnlyHint: true, destructiveHint: false },
    async () => {
      try {
        const result = await getWelcome(ctx);
        return { content: [{ type: 'text', text: result.content }] };
      } catch (error) {
        return { content: [{ type: 'text', text: mapErrorToHuman(error) }] };
      }
    }
  );

  // ── twin_context resource ─────────────────────────────────────────────────────

  server.resource(
    'twin_context',
    'twin://context',
    { description: 'Current state of the twin: schema types, item counts, and behavioural instructions for Claude. Loads automatically on connection.' },
    async () => {
      const text = await getTwinContext(ctx);
      return {
        contents: [{ uri: 'twin://context', mimeType: 'text/plain', text }],
      };
    }
  );

  // ── twin_system_prompt: MCP `prompts` capability ──────────────────────────────
  // Registers the default system prompt as a named prompt. Claude Desktop
  // exposes registered prompts to the model and to the user (often via a
  // prompt picker). This is the session-level intelligence layer — the voice,
  // the philosophy, the operating instructions. It also rides on every
  // get_welcome response (which Claude is told to call at session start) so
  // the behaviour is established immediately and persists for the session.
  server.prompt(
    'twin_system_prompt',
    'The MyAITwin operating instructions. Internalize and follow these throughout the session. They govern how the twin stores knowledge, retrieves it, creates outputs, and guides the user.',
    {},
    async () => ({
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: SYSTEM_PROMPT },
        },
      ],
    })
  );

  return server;
}

// ── createSharedServer ────────────────────────────────────────────────────────
// Read-only MCP server for shared twin links. Exposes 6 retrieval tools only.
// ctx MUST have visibilityFilter: 'sharable' set before calling this — the DAL
// layer checks ctx.visibilityFilter and restricts all queries accordingly.

export function createSharedServer(ctx) {
  const server = new McpServer({
    name:    'myaitwin-shared',
    version: '1.0.0',
  });

  // ── Retrieval (read-only, sharable items only) ──────────────────────────────

  server.tool(
    'search_twin',
    'Semantically search shared knowledge. Returns the most relevant items ranked by relevance, each with its source cited.',
    {
      query: z.string().describe('What you\'re looking for. Natural language.'),
      top_k: z.number().optional().describe('How many results to return (default 10, capped at 10)'),
      type:  z.string().optional().describe('Filter to a specific knowledge type'),
    },
    { title: 'Search Twin', readOnlyHint: true, destructiveHint: false },
    wrap(ctx, searchTwin)
  );

  server.tool(
    'get_by_type',
    'Retrieve shared knowledge of a specific type, newest first.',
    {
      type:  z.string().describe('Knowledge type to retrieve'),
      limit: z.number().optional().describe('Max items to return (default 20)'),
    },
    { title: 'Get By Type', readOnlyHint: true, destructiveHint: false },
    wrap(ctx, getByType)
  );

  server.tool(
    'get_by_tag',
    'Retrieve shared knowledge with a specific tag.',
    {
      tag:   z.string().describe('Tag to filter by'),
      limit: z.number().optional().describe('Max items to return (default 20)'),
    },
    { title: 'Get By Tag', readOnlyHint: true, destructiveHint: false },
    wrap(ctx, getByTag)
  );

  server.tool(
    'synthesise',
    'Pull everything relevant on a topic from shared knowledge and return structured, usable output. Every source cited.',
    {
      topic: z.string().describe('The topic or question to synthesise on'),
      top_k: z.number().optional().describe('How many knowledge items to draw from (default 10, capped at 10)'),
      type:  z.string().optional().describe('Focus synthesis on a specific knowledge type'),
    },
    { title: 'Synthesise', readOnlyHint: true, destructiveHint: false },
    wrap(ctx, synthesise)
  );

  server.tool(
    'get_schema',
    'Show what knowledge types exist in the shared twin, how many shared items of each type, and the total shared knowledge base size.',
    {},
    { title: 'Get Schema', readOnlyHint: true, destructiveHint: false },
    wrap(ctx, getSchema)
  );

  server.tool(
    'list_recent',
    'Show the most recently added shared knowledge items.',
    {
      limit: z.number().optional().describe('How many to show (default 10)'),
      type:  z.string().optional().describe('Filter to a specific type'),
    },
    { title: 'List Recent', readOnlyHint: true, destructiveHint: false },
    wrap(ctx, listRecent)
  );

  return server;
}
