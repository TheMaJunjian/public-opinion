import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import type { User } from '../types';
import { api } from '../api';
import { getDeviceId, getPrivateKeyForCurrentUser, getPrivateKeyForUser, storePrivateKeyForUser } from '../api/client';
import { generateSigningKeyPair, privateKeyMatchesPublicKey, publicKeyFromPrivateKey, signPayloadWithPrivateJwk } from '../utils/signature';

interface AuthContextValue {
  user: User | null;
  token: string | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string, publicKey?: string | null, founderKey?: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Sign a payload with the stored private key, returns base64 signature or null */
  signPayload: (payload: string) => Promise<string | null>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    api.getSession().then(session => {
      if (!active) return;
      if (session) {
        localStorage.setItem('user', JSON.stringify(session.user));
        setUser(session.user);
        setToken('session');
      } else {
        localStorage.removeItem('user');
        localStorage.removeItem('token');
      }
    }).catch(() => {
      if (active) { setUser(null); setToken(null); }
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function login(username: string, password: string) {
    const storedPrivateKey = getPrivateKeyForUser(username);
    let privateJwk: JsonWebKey | null = null;
    let publicKey: string;
    if (storedPrivateKey) {
      try {
        publicKey = publicKeyFromPrivateKey(storedPrivateKey);
        privateJwk = JSON.parse(storedPrivateKey) as JsonWebKey;
      } catch {
        publicKey = '';
      }
    } else {
      publicKey = '';
    }
    if (!publicKey) {
      const keyPair = await generateSigningKeyPair();
      privateJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
      const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
      publicKey = JSON.stringify(publicJwk);
    }
    const res = await api.login({ username, password, publicKey });
    if (!privateJwk || !res.user.publicKey || !privateKeyMatchesPublicKey(JSON.stringify(privateJwk), res.user.publicKey)) {
      throw new Error('设备签名密钥绑定失败，请重新登录');
    }
    storePrivateKeyForUser(username, privateJwk);
    localStorage.setItem('token', res.token);
    localStorage.setItem('user', JSON.stringify(res.user));
    setToken(res.token);
    setUser(res.user);
  }

  async function register(username: string, password: string, publicKey?: string | null, founderKey?: string) {
    await api.register({ username, password, publicKey: publicKey ?? null, founderKey });
    await login(username, password);
  }

  async function logout() {
    await api.logout();
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    if (user) localStorage.removeItem(`privateKey:${getDeviceId()}:${user.username}`);
    setToken(null);
    setUser(null);
  }

  async function signPayload(payload: string): Promise<string | null> {
    try {
      const rawKey = getPrivateKeyForCurrentUser();
      if (!rawKey) return null;
      const keyData = JSON.parse(rawKey) as JsonWebKey;
      return await signPayloadWithPrivateJwk(payload, keyData);
    } catch {
      return null;
    }
  }

  return (
    <AuthContext.Provider value={{ user, token, loading, login, register, logout, signPayload }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export function useOptionalAuth() {
  return useContext(AuthContext);
}
