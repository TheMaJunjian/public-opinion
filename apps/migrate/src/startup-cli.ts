import {prepareStartupDatabase} from './startup.js';
import {conversionFailure} from '@gonglun/core';

try{
  if(!process.env.DATABASE_URL)throw new Error('请配置 DATABASE_URL');
  const result=await prepareStartupDatabase(process.env.DATABASE_URL,process.env.DATABASE_SCHEMA,
    {plan:process.argv.includes('--plan'),founderId:process.env.GONGLUN_LEGACY_FOUNDER_ID||undefined});
  console.log(JSON.stringify(result));
}catch(error){
  const planning=process.argv.includes('--plan');
  const failure=conversionFailure(error,planning?'unchanged':'unconfirmed',planning?'转换检查未通过，原数据库未修改。':'转换程序未完成，无法确认回滚结果；已停止业务访问，请检查数据库。');
  console.error(JSON.stringify({conversionFailure:failure.report}));
  process.exitCode=1;
}
