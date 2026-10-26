import { z } from 'zod';
import { resolveReference, type BodyVersion, type Message, type Part, type Reference, type SendInput } from '@gonglun/core';
import { DomainError, Store } from './db.js';
import {bodyVersionSchema,referenceSchema} from './reference-schema.js';
import {preservedReferenceBasis} from './reference-bases.js';
export {bodyVersionSchema,referenceSchema} from './reference-schema.js';

const safe=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const identifier=z.string().min(1).max(100);
const reference=referenceSchema;
const binding=z.object({id:identifier,reference}).strict();
const part=z.discriminatedUnion('type',[
  z.object({id:identifier,type:z.literal('text'),text:z.string().max(30000)}).strict(),
  z.object({id:identifier,type:z.literal('web'),url:z.string().url().max(2000).refine(s=>/^https?:\/\//.test(s)),excerpt:z.string().max(30000)}).strict(),
  z.object({id:identifier,type:z.literal('code'),language:z.string().max(80),source:z.string().max(30000)}).strict(),
  z.object({id:identifier,type:z.literal('relation'),relation:z.string().min(1).max(80),reason:z.enum(['YES','NO']).optional(),roles:z.record(z.array(binding).max(100)).refine(r=>Object.keys(r).length<=20&&new Set(Object.values(r).flat().map(b=>b.id)).size===Object.values(r).flat().length,'关系成员 ID 必须唯一')}).strict(),
  z.object({id:identifier,type:z.literal('display'),relationPartId:identifier,layout:z.enum(['flow','columns','row','summary','relation']),target:reference.optional(),order:z.array(identifier).max(100).optional()}).strict(),
  z.object({id:identifier,type:z.literal('data'),value:z.unknown()}).strict(),
]);
export const partsSchema=z.array(part).min(1).max(64).superRefine((parts,ctx)=>{
  if(parts.some(part=>part.type==='relation'&&part.relation==='correct')&&parts.some(part=>part.type==='data'&&part.value&&typeof part.value==='object'&&!Array.isArray(part.value)&&(part.value as Record<string,unknown>).correctionKind==='MEANING'))ctx.addIssue({code:'custom',message:'修改原意请发送新消息'});
  if(new Set(parts.map(p=>p.id)).size!==parts.length) ctx.addIssue({code:'custom',message:'部件 ID 必须唯一'});
  for (const p of parts) if (p.type === 'relation') {
    if (['unfollow','unblock'].includes(p.relation)) ctx.addIssue({code:'custom',message:'请发送关注或拉黑标注，并明确选择是或否'});
    if (['follow','block'].includes(p.relation) && p.reason !== 'YES' && p.reason !== 'NO') ctx.addIssue({code:'custom',message:'关注和拉黑标注须选择是或否'});
  }
  for(const p of parts) if(p.type==='display'&&!p.target&&!parts.some(r=>r.id===p.relationPartId&&r.type==='relation')) ctx.addIssue({code:'custom',message:'显示部件必须指向关系部件'});
  for (const p of parts) if (p.type === 'data' && p.value && typeof p.value === 'object' && !Array.isArray(p.value)
    && 'correctionKind' in p.value && p.value.correctionKind === 'WIDTH') {
    const data = p.value as Record<string, unknown>;
    const correction = parts.find(part => part.type === 'relation' && part.relation === 'correct');
    const targets = correction?.type === 'relation' ? correction.roles.target ?? [] : [];
    if (!Number.isInteger(data.correctionWidth) || Number(data.correctionWidth) < 320 || Number(data.correctionWidth) > 2400
      || targets.length !== 1 || targets.some(({ reference: ref }) => ref.revision !== undefined || ref.partId || ref.memberId || ref.range || ref.path?.length)
      || correction?.type === 'relation' && (correction.roles.source?.length ?? 0) > 0)
      ctx.addIssue({ code: 'custom', message: '宽度调整需要一个当前完整消息目标，宽度须为 320–2400 的整数' });
  }
});
export const sendSchema=z.object({requestId:identifier,parts:partsSchema,recommendation:safe.optional(),wager:safe.optional(),selfStance:z.enum(['pro','con']).optional(),
  joinContribution:z.object({wager:safe,recommendation:safe}).strict().refine(value=>value.wager>0||value.recommendation>0,'加入消息的真假和价值至少一项须大于 0').optional()}).strict();
export function parseSend(input:unknown):SendInput {
  const parsed=sendSchema.parse(input);
  if(parsed.parts.some(part=>part.type==='relation'&&part.relation==='correct')&&parsed.parts.some(part=>part.type==='data'&&part.value&&typeof part.value==='object'&&!Array.isArray(part.value)&&(part.value as Record<string,unknown>).correctionKind==='MEANING'))throw new DomainError('修改原意请发送新消息');
  if(parsed.parts.some(part=>part.type==='relation'&&['read','unread'].includes(part.relation.toLowerCase())))
    throw new DomainError('已读是个人查看状态，请使用标记已读操作');
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
    referenceSchema.parse(ref);
    try {
    const context=ref.context,version=context&&'version' in context?context.version:undefined;
    if(version&&(version.messageId!==ref.messageId||ref.revision!==undefined&&version.revision!==ref.revision))throw new DomainError('正文版本与引用目标不一致');
    const loaded=new Map<string,Message>();
    const references=version?[{messageId:version.messageId,revision:version.revision},...version.corrections]:[ref];
    for(const item of references){const message=await store.message(item.messageId,item.revision);loaded.set(`${message.id}:${message.revision}`,message);if(item.revision===undefined)loaded.set(message.id,message);}
    if(context?.kind==='CORRECTION'){
      const target=[...loaded.values()][0],correction=target?.parts.find(part=>part.type==='relation'&&part.relation==='correct');
      if(!correction||ref.range||ref.memberId||ref.path?.length&&!(ref.path.length===1&&ref.path[0]==='relation')||ref.partId&&ref.partId!==correction.id)throw new DomainError('更正采用表态必须指向更正关系');
    }
    const value = resolveReference(ref, (id,revision)=>loaded.get(revision===undefined?id:`${id}:${revision}`));
    if (value === undefined)
        throw new DomainError('引用部件、路径或文本范围不存在');
    return value;
    }catch(error){const fixed=await preservedReferenceBasis(store,ref);if(fixed)return fixed.value;throw error;}
}
export async function validateBodyVersion(store:Store,version:BodyVersion){
  bodyVersionSchema.parse(version);
  return readReference(store,{messageId:version.messageId,revision:version.revision,context:{kind:'BODY',version}});
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
