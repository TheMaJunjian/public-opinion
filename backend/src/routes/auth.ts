import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { createId } from '@paralleldrive/cuid2';
import { prisma } from '../lib/prisma';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { applyEvent } from '../lib/events';

const router = Router();

const registerSchema = z.object({
  username: z
    .string()
    .min(2, '用户名至少 2 个字符')
    .max(30, '用户名最多 30 个字符')
    .regex(/^[a-zA-Z0-9_\u4e00-\u9fa5]+$/, '用户名只能包含字母、数字、下划线或汉字'),
  password: z.string().min(6, '密码至少 6 个字符').max(100, '密码最多 100 个字符'),
  publicKey: z.string().nullable().optional(),
});

const loginSchema = z.object({
  username: z.string().min(1, '请输入用户名'),
  password: z.string().min(1, '请输入密码'),
  deviceId: z.string().min(1).max(200).optional(),
});

const signingKeySchema = z.object({
  password: z.string().min(1),
  publicKey: z.string().min(1),
  deviceId: z.string().min(1).max(200),
});

// POST /api/auth/register — 用户注册
router.post('/register', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { username, password, publicKey } = registerSchema.parse(req.body);
    const userId = createId();
    const hashedPassword = await bcrypt.hash(password, 10);
    const signature = (req.headers['x-signature'] as string) ?? null;

    const user = await applyEvent({
      type: 'USER_REGISTERED',
      actorId: userId,
      signature,
      payload: { username, passwordHash: hashedPassword, publicKey: publicKey ?? null },
    });

    res.status(201).json({ message: '注册成功', user });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/login — 用户登录，返回 JWT
router.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { username, password, deviceId: requestedDeviceId } = loginSchema.parse(req.body);
    const deviceId = requestedDeviceId ?? `legacy:${username}`;
    const user = await prisma.user.findUnique({ where: { username } });

    if (!user) {
      res.status(401).json({ error: '用户名或密码错误' });
      return;
    }

    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) {
      res.status(401).json({ error: '用户名或密码错误' });
      return;
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      res.status(500).json({ error: '服务器配置错误' });
      return;
    }

    let deviceKey = await prisma.userSigningKey.findUnique({
      where: { userId_deviceId: { userId: user.id, deviceId } },
    });
    if (!deviceKey && user.publicKey) {
      deviceKey = await prisma.userSigningKey.create({
        data: { userId: user.id, deviceId, publicKey: user.publicKey },
      });
    }
    const publicKey = deviceKey?.publicKey ?? null;
    const token = jwt.sign({ id: user.id, username: user.username, deviceId, publicKey }, secret, {
      expiresIn: '7d',
    });

    res.json({
      message: '登录成功',
      token,
      user: { id: user.id, username: user.username, publicKey },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/signing-key — bind a new device key after password authentication.
router.post('/signing-key', requireAuth, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { password, publicKey, deviceId } = signingKeySchema.parse(req.body);
    if (req.user!.deviceId && req.user!.deviceId !== deviceId) {
      res.status(401).json({ error: '设备令牌不匹配，无法更新签名密钥' });
      return;
    }
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      res.status(401).json({ error: '密码错误，无法绑定签名密钥' });
      return;
    }
    await prisma.userSigningKey.upsert({
      where: { userId_deviceId: { userId: user.id, deviceId } },
      create: { userId: user.id, deviceId, publicKey },
      update: { publicKey },
    });
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      res.status(500).json({ error: '服务器配置错误' });
      return;
    }
    const token = jwt.sign({ id: user.id, username: user.username, deviceId, publicKey }, secret, { expiresIn: '7d' });
    res.json({ message: '签名密钥已更新', token, user: { id: user.id, username: user.username, publicKey } });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/logout — 登出
router.post('/logout', requireAuth, (_req: AuthRequest, res: Response) => {
  res.json({ message: '已登出，请删除本地令牌' });
});

export default router;
