import { z } from 'zod';

export const UsageSnapshotSchema = z.object({
  modelId: z.string(),
  contextWindowTokens: z.number(),
  inputTokensUsed: z.number(),
  outputTokensUsed: z.number(),
  usagePercent: z.number(),
  nearLimit: z.boolean(),
  overLimit: z.boolean(),
});

export type UsageSnapshot = z.infer<typeof UsageSnapshotSchema>;
