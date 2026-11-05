import { z } from 'zod';

export const FIELD_KEYS = ['company', 'title', 'experience', 'location', 'employmentType', 'deadline', 'detailUrl'] as const;
export type FieldKey = (typeof FIELD_KEYS)[number];

export const fieldSchema = z.object({
  key: z.enum(FIELD_KEYS),
  selector: z.string().min(1).max(300),
  value: z.string().regex(/^(text|attr:[a-zA-Z-]+)$/),
  required: z.boolean(),
});

export const contractBodySchema = z.object({
  source: z.object({
    kind: z.enum(['demo', 'external']),
    startUrl: z.string().url().max(2000),
    allowedHosts: z.array(z.string().min(1)).min(1).max(5),
  }),
  container: z.string().min(1).max(300),
  item: z.string().min(1).max(300),
  fields: z.array(fieldSchema).min(1).max(12),
  limits: z.object({
    maxItems: z.number().int().min(1).max(20),
    maxDetails: z.number().int().min(0).max(10),
    timeoutSeconds: z.number().int().min(10).max(180),
  }),
  evidence: z.object({ screenshotBlob: z.string().optional(), sampleCount: z.number().int().min(0) }).optional(),
});
export type ContractBody = z.infer<typeof contractBodySchema>;

export interface ContractDoc extends ContractBody {
  id: string; type: 'contract'; workspaceId: string; version: number; status: 'active' | 'superseded';
  [k: string]: unknown;
}

export const saveRequestSchema = contractBodySchema.extend({ contractId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).optional() });

export const previewRequestSchema = z.object({
  source: contractBodySchema.shape.source,
  container: z.string().min(1).max(300),
  item: z.string().min(1).max(300).optional(),
  fields: z.array(fieldSchema).max(12).optional(),
  sampleCount: z.number().int().min(1).max(10).optional(),
});
