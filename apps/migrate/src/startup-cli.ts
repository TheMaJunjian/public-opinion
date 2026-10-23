import {prepareStartupDatabase} from './startup.js';

try{
  if(!process.env.DATABASE_URL)throw new Error('请配置 DATABASE_URL');
  const result=await prepareStartupDatabase(process.env.DATABASE_URL,process.env.DATABASE_SCHEMA,
    {plan:process.argv.includes('--plan'),founderId:process.env.GONGLUN_LEGACY_FOUNDER_ID||undefined});
  console.log(JSON.stringify(result));
}catch(error){
  console.error(String((error as Error).message).replace(/postgres(?:ql)?:\/\/\S+/g,'[数据库地址已隐藏]'));
  process.exitCode=1;
}
