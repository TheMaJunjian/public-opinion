import { readFileSync, writeFileSync } from 'node:fs';
import { migrateLegacy } from './migrate-legacy.js';

const args=process.argv.slice(2);
const allowed=new Set(['--apply','--accept-checkpoint','--founder-id','--rules','--report','--read-only-rehearsal','--preserve-active-state','--lock-available','--native-rehearsal']);
for(let index=0;index<args.length;index++) {
  if(!allowed.has(args[index])) throw new Error(`未知选项 ${args[index]}`);
  if(['--founder-id','--rules','--report'].includes(args[index])) {
    if(!args[index+1]||args[index+1].startsWith('--')) throw new Error(`${args[index]} 缺少参数`);
    index++;
  }
}
const value=(flag:string)=>{const index=args.indexOf(flag);return index<0?undefined:args[index+1];};
const apply=args.includes('--apply');
const readOnlyRehearsal=args.includes('--read-only-rehearsal');
if(apply&&!readOnlyRehearsal&&!args.includes('--accept-checkpoint')) throw new Error('应用前须确认报告中的余额检查点、规则及旧历史结算限制：--accept-checkpoint');
if(!process.env.LEGACY_DATABASE_URL) throw new Error('请配置 LEGACY_DATABASE_URL 指向备份恢复的演练库');
if(!value('--founder-id')) throw new Error('必须使用 --founder-id 指定旧用户 ID');
try {
  const report=await migrateLegacy({sourceUrl:process.env.LEGACY_DATABASE_URL,sourceSchema:process.env.LEGACY_DATABASE_SCHEMA,targetUrl:process.env.MIGRATION_TARGET_DATABASE_URL,targetSchema:process.env.MIGRATION_TARGET_SCHEMA,founderId:value('--founder-id')!,rules:value('--rules')?JSON.parse(readFileSync(value('--rules')!,'utf8')):undefined,apply,readOnlyRehearsal,preserveActiveState:args.includes('--preserve-active-state'),lockAvailable:args.includes('--lock-available'),nativeRehearsal:args.includes('--native-rehearsal')});
  const output=JSON.stringify(report,null,2)+'\n';
  if(value('--report')) writeFileSync(value('--report')!,output,{mode:0o600});
  console.log(value('--report')?JSON.stringify({report:value('--report'),applied:report.applied,mode:report.mode,blockers:report.blockers.length,sourceTables:report.sourceTables},null,2):output);
  if(report.blockers.length) process.exitCode=2;
} catch(error) {
  console.error('迁移失败：',(error as Error).message.replace(/postgres(?:ql)?:\/\/\S+/g,'[数据库地址已隐藏]'));
  process.exitCode=1;
}
