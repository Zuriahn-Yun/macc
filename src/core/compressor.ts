import { HandoffPacketSchema, type HandoffPacket } from '../models/handoff-packet.js';
import type { IModelBackend } from '../backends/base.js';
import type { ContextStore } from './context-store.js';

// Build a handoff packet from raw session text when all API backends are rate-limited.
// No AI — just packages the last 15 messages so the receiving agent has context.
function rawHandoffFallback(
  store: ContextStore,
  fromModel: string,
  toModel: string,
  cwd: string,
): HandoffPacket {
  const messages = store.getMessages().filter(m => m.role !== 'system');
  const recent = messages.slice(-30);
  const contextSnippet = recent
    .map(m => `${m.role.toUpperCase()}: ${m.content.slice(0, 1500)}`)
    .join('\n\n---\n\n');

  const handoffPrompt =
    'You are continuing a coding session. API rate limits prevented AI-assisted compression, ' +
    'so here is the raw recent context:\n\n' +
    contextSnippet +
    '\n\nContinue from where this left off.';

  return HandoffPacketSchema.parse({
    version: '1',
    createdAt: new Date().toISOString(),
    fromModel,
    toModel,
    cwd,
    summary: {
      ultimateGoal: 'Continue from previous session (rate-limited fallback)',
      completedWork: `${messages.length} messages exchanged`,
      nextStep: 'Review the context above and continue the task',
      keyDecisions: [],
      blockers: ['Compression rate-limited on all backends — using raw context'],
      filesModified: [],
    },
    handoffPrompt,
  });
}

const COMPRESSION_PROMPT = `You are compressing a coding session so it can continue in a new AI model with a fresh context window.

Extract from the conversation below and return ONLY valid JSON matching this exact structure:
{
  "version": "1",
  "createdAt": "<ISO timestamp>",
  "fromModel": "<from_model>",
  "toModel": "<to_model>",
  "cwd": "<cwd>",
  "summary": {
    "ultimateGoal": "<one sentence: what the user is ultimately trying to accomplish>",
    "completedWork": "<what has been finished so far>",
    "nextStep": "<the single most important next action to take>",
    "keyDecisions": ["<decision and why>", ...],
    "blockers": ["<open issue or warning>", ...],
    "filesModified": ["<file path>", ...]
  },
  "handoffPrompt": "<2000 words max: a thorough briefing for the incoming model. Include: the overall goal, all work completed so far, key decisions and why they were made, the exact next step to take, any blockers or open questions, and relevant code snippets or file paths the model will need immediately. Be specific — this is the only context the receiving model will have.>"
}`;

export async function compressContext(
  backend: IModelBackend,
  store: ContextStore,
  toModel: string,
  cwd: string,
  onProgress?: (charsGenerated: number) => void,
): Promise<HandoffPacket> {
  const messages = store.getMessages();
  const fromModel = backend.modelId;

  // Use native compression if the backend implements it
  if (backend.compress) {
    return backend.compress(messages, fromModel, toModel, cwd);
  }

  // Fallback: prompt the current backend with the structured extraction prompt
  const conversationText = messages
    .filter(m => m.role !== 'system')
    .map(m => `${m.role.toUpperCase()}: ${m.content}`)
    .join('\n\n');

  const prompt = `FROM MODEL: ${fromModel}\nTO MODEL: ${toModel}\nCWD: ${cwd}\n\nCONVERSATION:\n${conversationText}`;

  let fullResponse = '';
  await backend.stream(
    [{ role: 'user', content: prompt, timestamp: new Date() }],
    COMPRESSION_PROMPT,
    chunk => {
      if (!chunk.done) {
        fullResponse += chunk.text;
        onProgress?.(fullResponse.length);
      }
    }
  );

  const jsonMatch = fullResponse.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Model did not return valid JSON during compression');

  const parsed = JSON.parse(jsonMatch[0]);
  parsed.createdAt = new Date().toISOString();

  return HandoffPacketSchema.parse(parsed);
}

// Try each backend in order; skip rate-limited ones and continue to the next.
// Pass sourceProvider to deprioritise the same provider (likely rate-limited).
export async function compressWithFallback(
  backends: IModelBackend[],
  store: ContextStore,
  toModel: string,
  cwd: string,
  sourceProvider?: string,
  onProgress?: (charsGenerated: number) => void,
): Promise<HandoffPacket> {
  // Move same-provider backends to the end so we try alternatives first
  const ordered = sourceProvider
    ? [
        ...backends.filter(b => b.provider !== sourceProvider),
        ...backends.filter(b => b.provider === sourceProvider),
      ]
    : backends;

  if (ordered.length === 0) throw new Error('No AI backends available for compression.');

  for (const backend of ordered) {
    try {
      return await compressContext(backend, store, toModel, cwd, onProgress);
    } catch (err) {
      // Any failure (rate limit, schema error, network timeout) → try next backend
      continue;
    }
  }

  // All backends failed — build a best-effort raw handoff instead of crashing.
  const fromModel = ordered.length > 0 ? ordered[0].modelId : 'unknown';
  return rawHandoffFallback(store, fromModel, toModel, cwd);
}
