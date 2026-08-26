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

  // 已知业务错误 → 映射到合适的 HTTP 状态码和与会者可理解的提示
  if (err instanceof Error) {
    // 402 Payment Required — 余额/点数不足
    if (err.message.startsWith('贡献点余额不足')) {
      res.status(402).json({
        error: '贡献点余额不足',
        detail: err.message,
      });
      return;
    }
    if (err.message.includes('可用贡献点不足')) {
      res.status(402).json({
        error: '可用贡献点不足',
        detail: err.message,
      });
      return;
    }

    // 403 Forbidden — 账户冻结 / 权限不足
    if (err.message.includes('负债冻结') || err.message.includes('frozen due to negative')) {
      res.status(403).json({
        error: '账户因负债被冻结',
        detail: '你的账户余额为负数，已被自动冻结。在冻结期间，你无法：发起结算、投票、押注或发送需自押的消息。请通过参与其他结算赚回贡献点，还清负债后将自动解冻。你可以在侧边栏的态度历史中查看当前余额和负债状态。',
      });
      return;
    }

    // 404 Not Found
    if (err.message === '目标消息不存在') {
      res.status(404).json({
        error: '目标消息不存在',
        detail: '该消息可能已被删除、替换或结算关闭。请刷新页面后重试。',
      });
      return;
    }
    if (err.message === 'Account not found') {
      res.status(404).json({
        error: '账户不存在',
        detail: '未找到你的贡献点账户。如果你是新注册与会者，请稍等片刻后重试。',
      });
      return;
    }

    // 409 Conflict — 并发冲突
    if (err.message.includes('已有进行中的结算轮次')) {
      res.status(409).json({
        error: '已有进行中的结算轮次',
        detail: '该消息已经有一个正在进行中的结算轮次，请等待当前轮次关闭后再发起新的结算。',
      });
      return;
    }
  }

  console.error('[未处理错误]', err);
  res.status(500).json({ error: '服务器内部错误，请联系管理员或稍后重试' });
}
