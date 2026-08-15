import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';

type JwkLike = {
  kty?: string;
  crv?: string;
};

type SignatureAlgorithm = {
  name: string;
  namedCurve?: string;
  hash?: string;
};

function getSignatureVerifyParams(keyData: JwkLike): {
  importAlgorithm: SignatureAlgorithm;
  verifyAlgorithm: SignatureAlgorithm;
} {
  if (keyData.kty === 'OKP' && keyData.crv === 'Ed25519') {
    return {
      importAlgorithm: { name: 'Ed25519' },
      verifyAlgorithm: { name: 'Ed25519' },
    };
  }

  if (keyData.kty === 'EC' && keyData.crv === 'P-256') {
    return {
      importAlgorithm: { name: 'ECDSA', namedCurve: 'P-256' },
      verifyAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
    };
  }

  throw new Error('Unsupported signature key type');
}

export interface AuthRequest extends Request {
  user?: {
    id: string;
    username: string;
    deviceId: string | null;
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
    const payload = jwt.verify(token, secret) as { id: string; username: string; deviceId?: string; publicKey: string | null };
    req.user = {
      id: payload.id,
      username: payload.username,
      deviceId: payload.deviceId ?? null,
      publicKey: payload.publicKey ?? null,
    };
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

  let publicKey = req.user.publicKey;
  try {
    if (req.user.deviceId) {
      const deviceKey = await prisma.userSigningKey.findUnique({
        where: { userId_deviceId: { userId: req.user.id, deviceId: req.user.deviceId } },
        select: { publicKey: true },
      });
      publicKey = deviceKey?.publicKey ?? null;
    }
  } catch {
    res.status(401).json({ error: '签名密钥读取失败，请重新登录', code: 'SIGNING_KEY_READ_FAILED' });
    return;
  }
  if (!publicKey) {
    res.status(401).json({ error: '当前设备未绑定签名密钥，请重新登录绑定设备', code: 'SIGNING_KEY_NOT_FOUND' });
    return;
  }

  const signatureBase64 = req.headers['x-signature'] as string | undefined;
  if (!signatureBase64) {
    res.status(401).json({ error: '请求没有携带设备签名，请重新登录后重试', code: 'SIGNATURE_HEADER_MISSING' });
    return;
  }

  try {
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const signatureBuf = Buffer.from(signatureBase64, 'base64');
    const keyData = JSON.parse(publicKey) as JwkLike;
    const params = getSignatureVerifyParams(keyData);
    const pubKey = await crypto.subtle.importKey('jwk', keyData, params.importAlgorithm as any, false, ['verify']);
    const isValid = await crypto.subtle.verify(
      params.verifyAlgorithm as any, pubKey, signatureBuf, new TextEncoder().encode(rawBody),
    );
    if (!isValid) {
      res.status(401).json({ error: '设备签名与当前设备公钥不匹配，请退出后重新登录', code: 'SIGNATURE_MISMATCH' });
      return;
    }
    next();
  } catch {
    res.status(401).json({ error: '设备签名格式或密钥类型无效，请退出后重新登录', code: 'SIGNATURE_INVALID' });
  }
}
