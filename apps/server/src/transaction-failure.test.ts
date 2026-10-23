import {afterEach,expect,it,vi} from 'vitest';
const {query,release}=vi.hoisted(()=>({query:vi.fn(),release:vi.fn()}));
vi.mock('pg',()=>({Pool:class {
  on(){}
  async connect(){return {query,release};}
  async end(){}
},types:{}}));
import {Postgres,RollbackUnconfirmedError} from './postgres.js';

afterEach(()=>{vi.resetAllMocks();});

it('does not claim a successful rollback when PostgreSQL cannot confirm it',async()=>{
  query.mockImplementation(async(sql:string)=>{if(sql==='ROLLBACK')throw new Error('连接中断');return {rows:[]};});
  const db=new Postgres('postgresql://unused/test');
  try{
    const error=await db.transaction(()=>{throw new Error('转换失败');}).catch(error=>error);
    expect(error).toBeInstanceOf(RollbackUnconfirmedError);
    expect(error.message).toContain('转换失败');
    expect(error.message).toContain('数据库未确认回滚');
    expect(release).toHaveBeenCalledWith(expect.any(Error));
  }finally{await db.close();}
});

it('does not claim a successful rollback after an ambiguous COMMIT response',async()=>{
  query.mockImplementation(async(sql:string)=>{if(sql==='COMMIT')throw new Error('连接中断');return {rows:[]};});
  const db=new Postgres('postgresql://unused/test');
  try{
    await expect(db.transaction(()=>undefined)).rejects.toThrow('提交结果未确认');
    expect(query.mock.calls.map(args=>args[0])).toContain('ROLLBACK');
  }finally{await db.close();}
});
