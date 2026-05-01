import { z } from 'zod';

export const HandoffPacketSchema = z.object({
  version: z.literal('1'),
  createdAt: z.string(),
  fromModel: z.string(),
  toModel: z.string(),
  cwd: z.string(),
  gitBranch: z.string().optional(),
  summary: z.object({
    ultimateGoal: z.string(),
    completedWork: z.string(),
    nextStep: z.string(),
    keyDecisions: z.array(z.string()),
    blockers: z.array(z.string()),
    filesModified: z.array(z.string()),
  }),
  handoffPrompt: z.string(),
});

export type HandoffPacket = z.infer<typeof HandoffPacketSchema>;
