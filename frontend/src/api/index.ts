// API 统一入口：所有请求走真实后端 client。
// 工作台操作通过事务接口提交到消息后端。
import * as realApi from './client';

export const api = realApi;
export * from './client';
