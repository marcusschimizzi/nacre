import { z } from 'zod';

export const memoryCreateSchema = z.object({
  content: z.string().min(1).max(100_000),
  type: z
    .enum(['person', 'project', 'tool', 'concept', 'decision', 'event', 'lesson', 'place', 'tag'])
    .optional()
    .default('concept'),
  label: z.string().min(1).max(1024).optional(),
});

export const feedbackSchema = z.object({
  memoryId: z.string().min(1).max(1024),
  rating: z.number().min(-1).max(1),
});

export const consolidateSchema = z.object({
  inputs: z.array(z.string().min(1).max(1024)).min(1).max(100),
  outDir: z.string().min(1).max(1024).optional(),
});

export type MemoryCreateInput = z.infer<typeof memoryCreateSchema>;
export type FeedbackInput = z.infer<typeof feedbackSchema>;
export type ConsolidateInput = z.infer<typeof consolidateSchema>;
