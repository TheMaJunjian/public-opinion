import {z} from 'zod';
const safe=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),identifier=z.string().min(1).max(100);
export const bodyVersionSchema=z.object({format:z.literal(2),messageId:identifier,revision:safe.min(1),corrections:z.array(z.object({messageId:identifier,revision:safe.min(1),kind:z.enum(['TEXT','MEANING'])}).strict()).max(200)}).strict();
export const referenceContextSchema=z.union([
  z.object({kind:z.enum(['BODY','MEANING']),version:bodyVersionSchema,follow:z.literal(true).optional()}).strict(),
  z.object({kind:z.literal('MESSAGE'),version:bodyVersionSchema.optional()}).strict(),
  z.object({kind:z.enum(['CORRECTION','ROUND','UNKNOWN'])}).strict(),
]);
export const referenceSchema=z.object({messageId:identifier,revision:safe.min(1).optional(),context:referenceContextSchema.optional(),partId:identifier.optional(),memberId:identifier.optional(),path:z.array(z.union([z.string().max(100),safe.max(10000)])).max(12).optional(),range:z.object({start:safe,end:safe}).strict().optional()}).strict();
