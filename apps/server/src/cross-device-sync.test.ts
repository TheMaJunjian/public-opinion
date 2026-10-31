import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import type { Session, WorkbenchSnapshot } from '@gonglun/core';
import { cleanupTestDatabases, createTestApp } from './test-database.js';

afterEach(cleanupTestDatabases);

it('notifies two independently signed sessions of the same user after preview confirmation and ordinary sends',async()=>{
  const app=await createTestApp(),server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),8000);
  const device=async(deviceId:string,register=false)=>{
    const keys=generateKeyPairSync('ed25519');
    const response=await fetch(`${origin}/api/${register?'register':'login'}`,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({name:'two-device-user',password:'test-password',deviceId,publicKey:JSON.stringify(keys.publicKey.export({format:'jwk'}))})});
    expect(response.status).toBe(register?201:200);
    const session=await response.json() as Session,cookie=response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
    return {session,
      async post(path:string,body:unknown){
        const requestId=(body as {requestId?:string}).requestId??randomUUID(),raw=JSON.stringify(body),payload=JSON.stringify({method:'POST',path:`/api/ui${path}`,bodyHash:createHash('sha256').update(raw).digest('hex'),requestId});
        const result=await fetch(`${origin}/api/ui${path}`,{method:'POST',body:raw,headers:{'Content-Type':'application/json',Cookie:cookie,
          'x-csrf-token':session.csrf,'x-device-id':deviceId,'x-request-id':requestId,'x-signed-payload':Buffer.from(payload).toString('base64'),
          'x-signature':sign(null,Buffer.from(payload),keys.privateKey).toString('base64')}});
        const data=await result.json();expect(result.status,JSON.stringify(data)).toBe(path==='/commands/preview'?200:201);return data;
      },
      async snapshot(after:number){
        const result=await fetch(`${origin}/api/ui/snapshot?parent=root&after=${after}&mode=window`,{headers:{Cookie:cookie,'x-device-id':deviceId}});
        expect(result.status).toBe(200);return result.json() as Promise<WorkbenchSnapshot>;
      },
    };
  };
  const listen=async(after:number,lastEventId=false)=>{
    const response=await fetch(`${origin}/api/events?after=${lastEventId?0:after}&mode=cursor`,{signal:controller.signal,
      headers:lastEventId?{'Last-Event-ID':String(after)}:{}});
    expect(response.status).toBe(200);const reader=response.body!.getReader();let buffer='';
    return {reader,async through(sequence:number){
      while(true){
        const frames=buffer.split('\n\n');buffer=frames.pop()!;
        for(const frame of frames){const line=frame.split('\n').find(value=>value.startsWith('data: '));if(line&&JSON.parse(line.slice(6)).sequence>=sequence)return;}
        const chunk=await reader.read();if(chunk.done)throw new Error('同步流提前结束');buffer+=new TextDecoder().decode(chunk.value);
      }
    }};
  };
  try{
    const desktop=await device('desktop',true),phone=await device('phone');expect(phone.session.user.id).toBe(desktop.session.user.id);
    const before=await app.store.latestSequence(),desktopStream=await listen(before),phoneStream=await listen(before);
    const envelope=(content:string)=>({requestId:randomUUID(),commands:[{id:randomUUID(),method:'POST',path:'/messages',body:{content,parentMessageId:'root',recommendation:1}}]});
    const prepared=envelope('从桌面预览后发送');await desktop.post('/commands/preview',{batch:prepared});
    expect(await app.store.latestSequence()).toBe(before);expect((await phone.snapshot(before)).messages).toHaveLength(0);
    const committed=await desktop.post('/commands',prepared);
    await Promise.all([desktopStream.through(committed.sequence),phoneStream.through(committed.sequence)]);
    expect((await phone.snapshot(before)).messages.some(message=>message.id===prepared.commands[0].id)).toBe(true);
    const ordinary=envelope('从手机直接发送'),second=await phone.post('/commands',ordinary);
    await Promise.all([desktopStream.through(second.sequence),phoneStream.through(second.sequence)]);
    expect((await desktop.snapshot(committed.sequence)).messages.some(message=>message.id===ordinary.commands[0].id)).toBe(true);
    await phoneStream.reader.cancel();
    const resumed=await listen(committed.sequence,true);await resumed.through(second.sequence);await resumed.reader.cancel();
    await desktopStream.reader.cancel();
  }finally{clearTimeout(timeout);controller.abort();server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
