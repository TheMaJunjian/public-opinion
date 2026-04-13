import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

// 扩展 Express Request 类型，注入已认证用户信息
export interface AuthRequest extends Request {
  user?: {
    id: string;
    username: string;
  };
}

// JWT 认证中间件：验证 Bearer token，成功则在 req.user 中注入用户信息
export function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: '未提供认证令牌' });
    return;
  }

  const token = authHeader.slice(7);
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    res.status(500).json({ error: '服务器配置错误：缺少 JWT_SECRET' });
    return;
  }

  try {
    const payload = jwt.verify(token, secret) as { id: string; username: string };
    req.user = { id: payload.id, username: payload.username };
    next();
  } catch {
    res.status(401).json({ error: '令牌无效或已过期' });
  }
}
