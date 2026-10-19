import { build } from 'vite';
import { gzipSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import assert from 'node:assert/strict';

const output=process.argv[process.argv.indexOf('--output')+1];
if(!process.argv.includes('--output')||!output)throw new Error('Use --output <report.json>');
let report;
await build({root:resolve('frontend'),configFile:resolve('frontend/vite.config.ts'),plugins:[{
  name:'measure-architecture-bundles',
  writeBundle(_options,bundle) {
    const chunks=Object.values(bundle).filter(item=>item.type==='chunk');
    const closure=(entry)=>{const seen=new Set();const visit=file=>{if(seen.has(file))return;seen.add(file);for(const dep of bundle[file]?.imports??[])visit(dep);};visit(entry);return [...seen];};
    const route=chunks.find(chunk=>Object.keys(chunk.modules).some(id=>id.endsWith('/pages/MessageWorkbenchPage.tsx')));
    assert.ok(route,'Workbench route chunk is missing');
    const initial=closure(route.fileName);
    const graph=chunks.find(chunk=>Object.keys(chunk.modules).some(id=>id.endsWith('/components/GraphView.tsx')));
    const graphView=[...new Set([...initial,...(graph ? closure(graph.fileName) : [])])];
    report={createdAt:new Date().toISOString(),node:process.version,route:route.fileName,routeBytes:Buffer.byteLength(route.code),routeGzipBytes:gzipSync(route.code).length,
      staticClosureBytes:initial.reduce((n,file)=>n+Buffer.byteLength(bundle[file]?.code??''),0),
      staticClosureGzipBytes:initial.reduce((n,file)=>n+gzipSync(bundle[file]?.code??'').length,0),
      graphViewBytes:graphView.reduce((n,file)=>n+Buffer.byteLength(bundle[file]?.code??''),0),
      graphViewGzipBytes:graphView.reduce((n,file)=>n+gzipSync(bundle[file]?.code??'').length,0),
      chunks:chunks.map(chunk=>({file:chunk.fileName,bytes:Buffer.byteLength(chunk.code),gzipBytes:gzipSync(chunk.code).length,initial:initial.includes(chunk.fileName),imports:chunk.imports,dynamicImports:chunk.dynamicImports,
        modules:Object.entries(chunk.modules).map(([id,info])=>({path:relative(process.cwd(),id).replaceAll('\\','/'),bytes:info.renderedLength})).sort((a,b)=>b.bytes-a.bytes)})).sort((a,b)=>b.bytes-a.bytes)};
    if(process.argv.includes('--check')) {
      assert.ok(report.routeBytes<350000,`Workbench route exceeds 350 KB: ${report.routeBytes}`);
      assert.ok(report.chunks.every(chunk=>chunk.bytes<500000),'A JS chunk exceeds 500 KB');
      const eagerModules=report.chunks.filter(chunk=>chunk.initial).flatMap(chunk=>chunk.modules.map(m=>m.path));
      for(const optional of ['GraphView.tsx','LeaderboardModal.tsx','CorrectionComparisonPopup.tsx'])
        assert.ok(!eagerModules.some(path=>path.endsWith('/'+optional)),`${optional} is loaded eagerly`);
    }
  }
}]});
await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({routeBytes:report.routeBytes,routeGzipBytes:report.routeGzipBytes,staticClosureBytes:report.staticClosureBytes,staticClosureGzipBytes:report.staticClosureGzipBytes,graphViewBytes:report.graphViewBytes,graphViewGzipBytes:report.graphViewGzipBytes}));
