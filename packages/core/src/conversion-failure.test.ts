import {expect,it} from 'vitest';
import {conversionFailure,readConversionFailure} from './conversion-failure.js';

it('keeps the failure time and verified rollback result across process and worker boundaries',()=>{
  const error=conversionFailure(new Error('引用不完整'),'completed','本次转换已回滚');
  const report=JSON.parse(JSON.stringify(error.report));
  for(const received of [{report},{stderr:`diagnostic\n${JSON.stringify({conversionFailure:report})}\n`}]){
    const restored=conversionFailure(received,'unconfirmed','结果未知');
    expect(restored.report).toEqual(report);
    expect(restored.message).toContain('失败时间：');
    expect(restored.message).toContain('失败原因：引用不完整');
    expect(restored.message).toContain('回滚结果：本次转换已回滚');
  }
});

it('redacts credentials and never treats malformed process output as a successful rollback',()=>{
  const error=conversionFailure({stderr:'connect postgresql://user:secret@host/private failed'},'unconfirmed','转换结果未确认');
  expect(error.message).toContain('[数据库地址已隐藏]');
  expect(error.message).not.toContain('secret');
  expect(error.report.rollbackStatus).toBe('unconfirmed');
  expect(readConversionFailure({...error.report,rollbackStatus:'success'})).toBeUndefined();
  expect(readConversionFailure({...error.report,failedAt:'invalid'})).toBeUndefined();
});
