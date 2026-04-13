import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';

// 全局错误处理中间件
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  // Zod 校验错误 → 400
  if (err instanceof ZodError) {
    res.status(400).json({
      error: '请求参数校验失败',
      details: err.errors.map((e) => ({
        field: e.path.join('.'),
        message: e.message,
      })),
    });
    return;
  }

  // Prisma 已知请求错误
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      res.status(409).json({ error: '该资源已存在，请检查唯一字段' });
      return;
    }
    if (err.code === 'P2025') {
      res.status(404).json({ error: '资源不存在' });
      return;
    }
    res.status(400).json({ error: `数据库错误: ${err.code}` });
    return;
  }

  // 通用错误 → 500
  console.error('[未处理错误]', err);
  res.status(500).json({ error: '服务器内部错误' });
}
