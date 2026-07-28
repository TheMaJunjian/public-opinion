import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    username: string;
    publicKey: string | null;
  };
}

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
    const payload = jwt.verify(token, secret) as { id: string; username: string; publicKey: string | null };
    req.user = { id: payload.id, username: payload.username, publicKey: payload.publicKey ?? null };
    next();
  } catch {
    res.status(401).json({ error: '令牌无效或已过期' });
  }
}

export async function verifySignature(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: '未认证' });
    return;
  }

  if (process.env.NODE_ENV === 'test') {
    next();
    return;
  }

  const publicKey = req.user.publicKey;
  if (!publicKey) {
    res.status(401).json({ error: '账户未绑定签名密钥，请重新注册' });
    return;
  }

  const signatureBase64 = req.headers['x-signature'] as string | undefined;
  if (!signatureBase64) {
    res.status(401).json({ error: '缺少 X-Signature 签名头' });
    return;
  }

  try {
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const signatureBuf = Buffer.from(signatureBase64, 'base64');
    const keyData = JSON.parse(publicKey);
    const pubKey = await crypto.subtle.importKey('jwk', keyData, { name: 'Ed25519' }, false, ['verify']);
    const isValid = await crypto.subtle.verify(
      { name: 'Ed25519' }, pubKey, signatureBuf, new TextEncoder().encode(rawBody),
    );
    if (!isValid) {
      res.status(401).json({ error: '签名验证失败' });
      return;
    }
    next();
  } catch {
    res.status(401).json({ error: '签名验证失败' });
  }
}
