import { GoogleGenAI } from '@google/genai';
import type { IModelBackend, StreamChunk } from './base.js';
import type { Message, TokenUsage } from '../models/message.js';
import { readGcloudAccessToken } from '../auth/credentials.js';

const CONTEXT_WINDOWS: Record<string, number> = {
  'gemini-2.5-pro':    1_048_576,
  'gemini-2.0-flash':  1_048_576,
};

// Vertex AI model IDs map for publisher model path format
const VERTEX_MODEL_IDS: Record<string, string> = {
  'gemini-2.5-pro':   'gemini-2.5-pro',
  'gemini-2.0-flash': 'gemini-2.0-flash',
};

export class GeminiBackend implements IModelBackend {
  readonly provider = 'google' as const;
  readonly contextWindowTokens: number;
  readonly displayName: string;

  constructor(readonly modelId: string) {
    this.contextWindowTokens = CONTEXT_WINDOWS[modelId] ?? 1_000_000;
    this.displayName = modelId;
  }

  private getClient(debug = false): { client: GoogleGenAI; vertexMode: boolean } {
    const project = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT;
    const location = process.env.GOOGLE_CLOUD_LOCATION ?? 'us-central1';

    if (project) {
      // Fetch a fresh ADC access token and inject it as a bearer header so
      // Vertex AI requests are authenticated even without GOOGLE_API_KEY.
      const accessToken = readGcloudAccessToken();
      if (debug) console.error(`[debug] gemini: vertexMode project=${project} hasToken=${!!accessToken}`);
      const httpOptions = accessToken
        ? { headers: { Authorization: `Bearer ${accessToken}` } }
        : undefined;
      return {
        client: new GoogleGenAI({ vertexai: true, project, location, httpOptions }),
        vertexMode: true,
      };
    }

    // Fallback: GOOGLE_API_KEY env var (AI Studio key)
    if (debug) console.error('[debug] gemini: using GOOGLE_API_KEY');
    return {
      client: new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY ?? '' }),
      vertexMode: false,
    };
  }

  async stream(
    messages: Message[],
    systemPrompt: string,
    onChunk: (chunk: StreamChunk) => void,
    debug = false
  ): Promise<TokenUsage> {
    const { client } = this.getClient(debug);
    if (debug) console.error(`[debug] gemini: streaming to model=${this.modelId} messages=${messages.length}`);

    const history = messages
      .filter(m => m.role !== 'system')
      .slice(0, -1)
      .map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

    const lastMessage = messages.filter(m => m.role !== 'system').at(-1);
    if (!lastMessage) return { inputTokens: 0, outputTokens: 0 };

    const chat = client.chats.create({
      model: this.modelId,
      history,
      config: { systemInstruction: systemPrompt },
    });

    let inputTokens = 0;
    let outputTokens = 0;

    const result = await chat.sendMessageStream({ message: lastMessage.content });

    for await (const chunk of result) {
      if (chunk.text) {
        onChunk({ text: chunk.text, done: false });
      }
      if (chunk.usageMetadata) {
        inputTokens = chunk.usageMetadata.promptTokenCount ?? 0;
        outputTokens = chunk.usageMetadata.candidatesTokenCount ?? 0;
      }
    }

    onChunk({ text: '', done: true, usage: { inputTokens, outputTokens } });
    return { inputTokens, outputTokens };
  }

  async isAvailable(): Promise<boolean> {
    if (process.env.GOOGLE_API_KEY) return true;
    if (process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT) return true;
    // Try gcloud ADC — if it returns a token, credentials are configured
    return !!(readGcloudAccessToken());
  }
}
