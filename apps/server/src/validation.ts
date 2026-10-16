import { z } from 'zod';
import { resolveReference, type Part, type Reference, type SendInput } from '@gonglun/core';
import { DomainError, Store } from './db.js';

const safe=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const identifier=z.string().min(1).max(100);
const reference=z.object({messageId:identifier,revision:safe.min(1).optional(),partId:identifier.optional(),memberId:identifier.optional(),path:z.array(z.union([z.string().max(100),safe.max(10000)])).max(12).optional(),range:z.object({start:safe,end:safe}).strict().optional()}).strict();
const binding=z.object({id:identifier,reference}).strict();
const part=z.discriminatedUnion('type',[
  z.object({id:identifier,type:z.literal('text'),text:z.string().max(30000)}).strict(),
  z.object({id:identifier,type:z.literal('web'),url:z.string().url().max(2000).refine(s=>/^https?:\/\//.test(s)),excerpt:z.string().max(30000)}).strict(),
  z.object({id:identifier,type:z.literal('code'),language:z.string().max(80),source:z.string().max(30000)}).strict(),
  z.object({id:identifier,type:z.literal('relation'),relation:z.string().min(1).max(80),roles:z.record(z.array(binding).max(100)).refine(r=>Object.keys(r).length<=20&&new Set(Object.values(r).flat().map(b=>b.id)).size===Object.values(r).flat().length,'关系成员 ID 必须唯一')}).strict(),
  z.object({id:identifier,type:z.literal('display'),relationPartId:identifier,layout:z.enum(['flow','columns','row','summary']),target:reference.optional(),order:z.array(identifier).max(100).optional()}).strict(),
  z.object({id:identifier,type:z.literal('data'),value:z.unknown()}).strict(),
]);
export const partsSchema=z.array(part).min(1).max(64).superRefine((parts,ctx)=>{
  if(new Set(parts.map(p=>p.id)).size!==parts.length) ctx.addIssue({code:'custom',message:'部件 ID 必须唯一'});
  for(const p of parts) if(p.type==='display'&&!p.target&&!parts.some(r=>r.id===p.relationPartId&&r.type==='relation')) ctx.addIssue({code:'custom',message:'显示部件必须指向关系部件'});
});
export const sendSchema=z.object({requestId:identifier,parts:partsSchema,recommendation:safe.optional(),wager:safe.optional(),selfStance:z.enum(['pro','con']).optional()}).strict();
export function parseSend(input:unknown):SendInput {
  const parsed=sendSchema.parse(input);
  if (parsed.parts.some(part => ['membership-history', 'organization-memberships'].includes(part.id)))
    throw new DomainError('归属执行记录由服务器生成');
  if(JSON.stringify(parsed).length>100000) throw new DomainError('消息过大');
  validateJson(parsed); return parsed as SendInput;
}
export function validateJson(value:unknown,depth=0):void {
  if(depth>24) throw new DomainError('数据嵌套过深');
  if(typeof value==='number'&&(!Number.isFinite(value)||Math.abs(value)>Number.MAX_SAFE_INTEGER)) throw new DomainError('数值超出安全范围');
  if(value&&typeof value==='object') for(const [key,child] of Object.entries(value)) {
    if(['__proto__','prototype','constructor'].includes(key)) throw new DomainError('不允许的字段');
    validateJson(child,depth+1);
  }
}
export async function readReference(store: Store, ref: Reference): Promise<unknown> {
    const message = await store.message(ref.messageId, ref.revision);
    const value = resolveReference(ref, () => message);
    if (value === undefined)
        throw new DomainError('引用部件、路径或文本范围不存在');
    return value;
}
export async function validateReferences(store: Store, parts: Part[]): Promise<void> {
    for (const part of parts) {
        if (part.type === 'relation')
            for (const bindings of Object.values(part.roles))
                for (const binding of bindings)
                    await readReference(store, binding.reference);
        if (part.type === 'display' && part.target)
            await readReference(store, part.target);
    }
}
export const rulesSchema=z.object({version:safe.min(1),protocolFee:safe.min(1),initialGrant:safe,operatingReserve:safe,lowQualityPenalty:safe,settlementDelayMs:safe.max(30*86400000),contributionWeights:z.object({content:safe,relation:safe,agreement:safe,evidence:safe,duplicate:safe,earlyBonus:safe,earlyWindow:safe,unrecognizedAuthorCap:safe}).strict()}).strict();
