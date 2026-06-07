// Shared Claude Sonnet 4.6 client for the web mini-interface (/twin).
//
// All chat + synthesise endpoints route through here so:
//   * the Luto system prompt is loaded from one place
//   * prompt caching is configured uniformly (5-min ephemeral on the system
//     block — the SYSTEM_PROMPT is large and stable, so reads should be ~0.1×
//     the base input price after the first miss)
//   * adaptive thinking is on by default — Claude self-regulates depth
//   * model + effort defaults live in one constant for easy tuning later

import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT } from './system-prompt.js';

if (!process.env.ANTHROPIC_API_KEY) {
  throw new Error('ANTHROPIC_API_KEY env var is required. Set it on Vercel (Production + Preview + Development).');
}

let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

export const TWIN_MODEL = 'claude-opus-4-8';
// Haiku for fast, cheap, structural classification — intent detection and
// proposal extraction. The voice rules don't apply here (it's emitting JSON,
// not user-facing prose), so this path skips the Luto system block entirely.
export const FAST_MODEL = 'claude-haiku-4-5';

/**
 * Fast structural call — Haiku, JSON output, no Luto voice block. Use for
 * classification, extraction, and other structural tasks where we want the
 * cheapest, fastest path. The caller supplies the system prompt directly.
 *
 * @param {object} opts
 * @param {Array}  opts.messages    Anthropic Messages shape.
 * @param {string} opts.system      System prompt (single string).
 * @param {object} opts.schema      JSON schema for structured output.
 * @param {number} [opts.maxTokens] Defaults to 1024.
 * @returns {Promise<any>} The parsed JSON object (first text block parsed).
 */
export async function callFastJson({ messages, system, schema, maxTokens = 1024 }) {
  const resp = await getClient().messages.create({
    model: FAST_MODEL,
    max_tokens: maxTokens,
    system,
    messages,
    output_config: {
      format: { type: 'json_schema', schema },
    },
  });
  // The response content's first text block is guaranteed-valid JSON when
  // output_config.format is set (the API enforces the schema). Parse it.
  const text = (resp.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');
  try {
    return { data: JSON.parse(text), usage: resp.usage };
  } catch (err) {
    const e = new Error(`Haiku returned non-JSON text: ${text.slice(0, 200)}`);
    e.cause = err;
    throw e;
  }
}

// Luto voice rules. Appended to the cached system block on every call so the
// model is briefed on the brand's hard rules in one place. Per luto-writing:
// em/en dashes are the single most common failure mode, and short sentences
// read better aloud. Keep this short so the cached prefix stays small.
const LUTO_VOICE_RULES = [
  '',
  '',
  'VOICE RULES (Luto brand):',
  '* Never use em dashes or en dashes. Use full stops or commas. If you cannot, rewrite the sentence.',
  '* Short sentences. Full stops are not decoration. Read it aloud. If you run out of breath, cut it.',
  '* Specific, not vague. Numbers, named deliverables, concrete situations beat abstractions.',
  '* Honest about limits. If retrieved knowledge does not actually answer the question, say so.',
  '* Banned words: unlock, master, transform, transformative, seamless, leverage, revolutionary, journey, comprehensive, empower, supercharge, holistic. If a phrase would fit on a generic 2023 AI landing page, rewrite it.',
].join('\n');

/**
 * Run a single-turn Claude call with the Luto system prompt pre-loaded and
 * cached. `messages` is the standard Anthropic Messages-API shape.
 *
 * Defaults:
 *   - model: claude-sonnet-4-6
 *   - max_tokens: 2048 (no streaming — keeps the endpoint synchronous; 2K is
 *     a safe non-streaming budget under Vercel's function timeout)
 *   - thinking: adaptive (Claude decides per-request)
 *   - effort: medium (good cost/quality balance for v1)
 *
 * Returns the SDK Message object — the caller pulls .content[].text out.
 */
export async function callTwin({ messages, maxTokens = 2048, effort = 'medium', extraSystem }) {
  const systemBlocks = [
    {
      type: 'text',
      text: SYSTEM_PROMPT + LUTO_VOICE_RULES,
      cache_control: { type: 'ephemeral' },
    },
  ];
  if (extraSystem) {
    // Append-only — keeps the prefix stable so the cache write on SYSTEM_PROMPT
    // is reused even when callers add a short, call-specific instruction.
    systemBlocks.push({ type: 'text', text: extraSystem });
  }

  return await getClient().messages.create({
    model: TWIN_MODEL,
    max_tokens: maxTokens,
    system: systemBlocks,
    thinking: { type: 'adaptive' },
    output_config: { effort },
    messages,
  });
}

/**
 * Extract the concatenated text from a Claude response. Ignores thinking
 * blocks — those are internal reasoning, not user-facing.
 */
export function responseText(message) {
  if (!message?.content) return '';
  return message.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');
}

/**
 * Stream a Sonnet response. The caller passes an `onText(delta)` callback
 * that receives each text delta as it arrives. Returns the final Message
 * object so the caller can read usage/stop_reason.
 *
 * Same system-prompt setup as callTwin (cached SYSTEM_PROMPT + Luto voice
 * rules + optional extraSystem). Streaming is the standard chat-app UX
 * pattern — see twin-behaviour-spec §A.3 and the brief on chat behaviour.
 */
export async function streamTwin({ messages, maxTokens = 2048, effort = 'medium', extraSystem, onText, signal }) {
  const systemBlocks = [
    {
      type: 'text',
      text: SYSTEM_PROMPT + LUTO_VOICE_RULES,
      cache_control: { type: 'ephemeral' },
    },
  ];
  if (extraSystem) {
    systemBlocks.push({ type: 'text', text: extraSystem });
  }

  const stream = getClient().messages.stream({
    model: TWIN_MODEL,
    max_tokens: maxTokens,
    system: systemBlocks,
    thinking: { type: 'adaptive' },
    output_config: { effort },
    messages,
  }, signal ? { signal } : undefined);

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      if (onText) onText(event.delta.text);
    }
  }
  return await stream.finalMessage();
}
