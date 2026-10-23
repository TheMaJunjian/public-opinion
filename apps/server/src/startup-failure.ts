import {createServer, type Server} from 'node:http';
import {conversionFailure, formatConversionFailure, type ConversionFailureReport} from '@gonglun/core';

const escapeHtml=(value:string)=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));

/** Remain reachable after a failed startup, without opening any business routes. */
export function startupFailureServer(report:ConversionFailureReport):Server {
  const message=formatConversionFailure(report);
  const html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>公论启动失败</title><style>body{margin:0;background:#111827;color:#e2e8f0;font:16px/1.8 system-ui}main{max-width:680px;margin:10vh auto;padding:24px}h1{color:#f87171;font-size:24px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}p{color:#94a3b8}</style></head><body><main role="alert"><h1>公论启动失败</h1><pre>${escapeHtml(message)}</pre><p>服务已停止业务访问。请保留此信息，修复原因后重新启动；刷新页面可再次查看。</p></main></body></html>`;
  return createServer((req,res)=>{
    const json=req.url?.startsWith('/api/')||!['GET','HEAD'].includes(req.method??'GET');
    res.writeHead(503,{'Content-Type':json?'application/json; charset=utf-8':'text/html; charset=utf-8',
      'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
      'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"});
    res.end(req.method==='HEAD'?undefined:json?JSON.stringify({ok:false,error:message,conversionFailure:report}):html);
  });
}

export function logStartupFailure(error:unknown):ConversionFailureReport{
  const failure=conversionFailure(error,'unconfirmed','启动未完成，无法确认数据库回滚结果；服务已停止业务访问，请检查数据库。');
  console.error(`公论启动失败\n${failure.message}\n${JSON.stringify({conversionFailure:failure.report})}`);
  return failure.report;
}

export async function showStartupFailure(error:unknown):Promise<Server>{
  const server=startupFailureServer(logStartupFailure(error));
  await new Promise<void>((resolve,reject)=>{
    server.once('error',reject);
    server.listen(Number(process.env.PORT??3000),process.env.HOST??'127.0.0.1',()=>{server.off('error',reject);resolve();});
  });
  for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{
    server.close(()=>process.exit(1));server.closeIdleConnections();
  });
  return server;
}
