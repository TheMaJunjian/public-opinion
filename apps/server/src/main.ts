import express from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from './app.js';

const app=createApp();
const web=resolve('apps/web/dist');
if(existsSync(web)){app.use(express.static(web));app.get('*',(_req,res)=>res.sendFile(resolve(web,'index.html')));}
const port=Number(process.env.PORT??3000);
const server=app.listen(port,process.env.HOST??'127.0.0.1',()=>console.log(`公论 http://localhost:${port}`));
let closing=false;
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{if(closing)return;closing=true;app.close();server.close(()=>process.exit(0));});
