// API 统一入口：所有请求走真实后端 client。
// Mock 模式已移除（公测使用真实后端 + PostgreSQL）。
import * as realApi from './client';

export const api = realApi;
export * from './client';
