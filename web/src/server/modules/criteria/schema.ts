import { z } from 'zod';

export const ruleCardSchema = z.object({
  id: z.string(),
  kind: z.literal('rule'),
  criterion: z.enum(['deadline', 'experience', 'region', 'employment']),
  label: z.string().min(1).max(80),
  required: z.boolean().default(true),
  params: z.object({
    minYears: z.number().min(0).max(50).optional(),
    maxYears: z.number().min(0).max(50).optional(),
    allowedRegions: z.array(z.string()).optional(),
    allowRemote: z.boolean().optional(),
    employmentTypes: z.array(z.enum(['정규직', '계약직', '인턴', '프리랜서'])).optional(),
    notPast: z.boolean().optional(),
    myYears: z.number().optional(),
  }).default({}),
});

export const semanticCardSchema = z.object({
  id: z.string(),
  kind: z.literal('semantic'),
  text: z.string().min(1).max(300),
  required: z.boolean().default(true),
});

export const draftSchema = z.object({
  ruleCards: z.array(ruleCardSchema).max(10),
  semanticCards: z.array(semanticCardSchema).max(10),
});
export type RuleCard = z.infer<typeof ruleCardSchema>;
export type SemanticCard = z.infer<typeof semanticCardSchema>;

export const draftRequestSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  criteriaSetId: z.string().regex(/^[\w-]{1,64}$/).optional(),
  careerYears: z.number().min(0).max(60).optional(),
});

export const saveRequestSchema = z.object({
  ruleCards: z.array(ruleCardSchema).max(10),
  semanticCards: z.array(semanticCardSchema).max(10),
});
