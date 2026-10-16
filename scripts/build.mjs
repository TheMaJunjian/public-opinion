import {spawnSync} from 'node:child_process';
import {build} from 'esbuild';
// A test shell can retain NODE_ENV=test; release assets must always use React production.
const env={...process.env,NODE_ENV:'production'};
for(const args of [['run','typecheck'],['--workspace','frontend','run','build']]) {
  const npmCli=process.env.npm_execpath;
  const result=spawnSync(npmCli?process.execPath:'npm',npmCli?[npmCli,...args]:args,{stdio:'inherit',env});
  if(result.error)throw result.error;
  if(result.status!==0)process.exit(result.status??1);
}
await build({entryPoints:['apps/server/src/main.ts'],bundle:true,platform:'node',format:'esm',external:['express','zod','pg'],outfile:'apps/server/dist/main.js',logLevel:'info'});
