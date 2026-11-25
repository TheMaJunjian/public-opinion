import { createContext, useContext, useState, useEffect, useRef, ReactNode } from 'react';
import type { User } from '../types';
import { api } from '../api';
import { getDeviceId, getPrivateKeyForCurrentUser, getPrivateKeyForUser, storePrivateKeyForUser } from '../api/client';
import { generateSigningKeyPair, privateKeyMatchesPublicKey, publicKeyFromPrivateKey, signPayloadWithPrivateJwk } from '../utils/signature';
import { startEntryTiming } from '../utils/entryTiming';

interface AuthContextValue {
  user: User | null;
  token: string | null;
  loading: boolean;
  login: (username: string, password: string, acceptedAgreementVersion?: string) => Promise<void>;
  register: (username: string, password: string, acceptedAgreementVersion: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Sign a payload with the stored private key, returns base64 signature or null */
  signPayload: (payload: string) => Promise<string | null>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const authVersion = useRef(0);

  useEffect(() => {
    let active = true;
    const version = authVersion.current;
    const current = () => active && version === authVersion.current;
    const expired = () => {
      authVersion.current++;
      localStorage.removeItem('user');
      localStorage.removeItem('token');
      setUser(null);
      setToken(null);
      setLoading(false);
    };
    window.addEventListener('gonglun:session-expired', expired);
    const finishSessionTiming = startEntryTiming('session');
    api.getSession().then(session => {
      if (!current()) return;
      if (session) {
        localStorage.setItem('user', JSON.stringify(session.user));
        setUser(session.user);
        setToken('session');
      } else {
        localStorage.removeItem('user');
        localStorage.removeItem('token');
      }
    }).catch(() => {
      if (current()) { setUser(null); setToken(null); }
    }).finally(() => { finishSessionTiming(); if (current()) setLoading(false); });
    return () => { active = false; window.removeEventListener('gonglun:session-expired', expired); };
  }, []);

  async function authenticateDevice(username: string, startSession: (publicKey: string) => ReturnType<typeof api.login>) {
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
    const res = await startSession(publicKey);
    if (!privateJwk || !res.user.publicKey || !privateKeyMatchesPublicKey(JSON.stringify(privateJwk), res.user.publicKey)) {
      throw new Error('设备签名密钥绑定失败，请重新登录');
    }
    storePrivateKeyForUser(res.user.username, privateJwk);
    localStorage.setItem('token', res.token);
    localStorage.setItem('user', JSON.stringify(res.user));
    authVersion.current++;
    setToken(res.token);
    setUser(res.user);
    setLoading(false);
  }

  async function login(username: string, password: string, acceptedAgreementVersion?: string) {
    const finishLoginTiming = startEntryTiming('login');
    try {
      await authenticateDevice(username, publicKey => api.login({ username, password, publicKey, acceptedAgreementVersion }));
    } finally { finishLoginTiming(); }
  }

  async function register(username: string, password: string, acceptedAgreementVersion: string) {
    await authenticateDevice(username, publicKey => api.register({ username, password, publicKey, acceptedAgreementVersion }));
  }

  async function logout() {
    try { await api.logout(); }
    finally {
      authVersion.current++;
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      if (user) localStorage.removeItem(`privateKey:${getDeviceId()}:${user.username}`);
      setToken(null);
      setUser(null);
      setLoading(false);
    }
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
