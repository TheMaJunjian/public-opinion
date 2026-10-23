import {expect,it,vi} from 'vitest';
import request from 'supertest';
import {conversionFailure} from '@gonglun/core';
import {logStartupFailure,startupFailureServer} from './startup-failure.js';

it('shows one stable failure report on page reload and every API request, with unhealthy status and no business routes',async()=>{
  const failure=conversionFailure(new Error('数据库自动转换失败：引用不完整'),'completed','本次转换已回滚，原数据保持不变。');
  const server=startupFailureServer(failure.report);
  for(const path of ['/','/messages/old']){
    const response=await request(server).get(path);
    expect(response.status).toBe(503);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.text).toContain('失败时间：');
    expect(response.text).toContain('失败原因：数据库自动转换失败：引用不完整');
    expect(response.text).toContain('回滚结果：本次转换已回滚');
  }
  for(const method of ['get','post'] as const){
    const response=await request(server)[method]('/api/messages');
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ok:false,conversionFailure:failure.report});
  }
  const health=await request(server).get('/api/health');
  expect(health.status).toBe(503);
  expect(health.body.conversionFailure).toEqual(failure.report);
});

it('escapes error content, hides connection credentials and records the same time in logs',async()=>{
  const log=vi.spyOn(console,'error').mockImplementation(()=>{});
  try{
    const report=logStartupFailure(new Error('<script>alert(1)</script> postgresql://user:private@host/db'));
    const response=await request(startupFailureServer(report)).get('/');
    expect(response.text).not.toContain('<script>');
    expect(response.text).toContain('&lt;script&gt;');
    expect(response.text).not.toContain('private');
    expect(response.text).toContain('无法确认数据库回滚结果');
    expect(report.rollbackStatus).toBe('unconfirmed');
    expect(log.mock.calls[0][0]).toContain(report.failedAt);
    expect(log.mock.calls[0][0]).not.toContain('private');
  }finally{log.mockRestore();}
});
