import {execFile} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

/** Keep historical conversion in a separate executable, outside the server bundle. */
export async function upgradeDatabase(databaseUrl:string,schema?:string):Promise<string>{
  const source=import.meta.url.endsWith('.ts');
  const entry=fileURLToPath(new URL(`../../migrate/${source?'src/startup-cli.ts':'dist/startup-cli.js'}`,import.meta.url));
  const args=source?[createRequire(import.meta.url).resolve('tsx/cli'),entry]:[entry];
  try{
    const {stdout}=await promisify(execFile)(process.execPath,args,{env:{...process.env,DATABASE_URL:databaseUrl,DATABASE_SCHEMA:schema??'public'},maxBuffer:1024*1024});
    const result=JSON.parse(stdout);
    if(typeof result.schema!=='string'||!/^[a-z_][a-z0-9_]{0,62}$/.test(result.schema))throw new Error('迁移程序未返回有效数据库结构');
    return result.schema;
  }catch(error){
    const failure=error as Error&{stderr?:string};
    throw new Error(`数据库自动转换失败：${(failure.stderr||failure.message).replace(/postgres(?:ql)?:\/\/\S+/g,'[数据库地址已隐藏]')}`);
  }
}
