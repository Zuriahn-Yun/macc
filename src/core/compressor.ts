import { AnthropicBackend } from '../backends/anthropic.js';
import { HandoffPacketSchema, type HandoffPacket } from '../models/handoff-packet.js';
import type { ContextStore } from './context-store.js';

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
  "handoffPrompt": "<400 words max: a clear briefing for the incoming model covering goal, current state, next step, and any critical context>"
}`;

export async function compressContext(
  store: ContextStore,
  fromModel: string,
  toModel: string,
  cwd: string
): Promise<HandoffPacket> {
  const compressionModel = process.env.MACC_COMPRESSION_MODEL ?? 'claude-haiku-4-5';
  const backend = new AnthropicBackend(compressionModel);

  const conversationText = store
    .getMessages()
    .filter(m => m.role !== 'system')
    .map(m => `${m.role.toUpperCase()}: ${m.content}`)
    .join('\n\n');

  const prompt = `FROM MODEL: ${fromModel}\nTO MODEL: ${toModel}\nCWD: ${cwd}\n\nCONVERSATION:\n${conversationText}`;

  let fullResponse = '';
  await backend.stream(
    [{ role: 'user', content: prompt, timestamp: new Date() }],
    COMPRESSION_PROMPT,
    chunk => { if (!chunk.done) fullResponse += chunk.text; }
  );

  const jsonMatch = fullResponse.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Compression model did not return valid JSON');

  const parsed = JSON.parse(jsonMatch[0]);
  parsed.createdAt = new Date().toISOString();

  return HandoffPacketSchema.parse(parsed);
}
