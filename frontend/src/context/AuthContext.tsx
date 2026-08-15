import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import type { User } from '../types';
import { api } from '../api';
import { getPrivateKeyForCurrentUser, storePrivateKeyForUser } from '../api/client';
import { generateSigningKeyPair, privateKeyMatchesPublicKey, signPayloadWithPrivateJwk } from '../utils/signature';

interface AuthContextValue {
  user: User | null;
  token: string | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string, publicKey?: string | null) => Promise<void>;
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
    const storedToken = localStorage.getItem('token');
    const storedUser = localStorage.getItem('user');
    let tokenExpired = false;
    if (storedToken) {
      try {
        const tokenParts = storedToken.split('.');
        if (tokenParts.length !== 3) throw new Error('令牌格式无效');
        const base64Payload = tokenParts[1].replace(/-/g, '+').replace(/_/g, '/');
        const paddedPayload = base64Payload.padEnd(Math.ceil(base64Payload.length / 4) * 4, '=');
        const payload = JSON.parse(atob(paddedPayload)) as { exp?: number };
        tokenExpired = typeof payload.exp === 'number' && payload.exp * 1000 <= Date.now();
      } catch {
        tokenExpired = true;
      }
    }
    if (storedToken && storedUser && !tokenExpired) {
      try {
        setToken(storedToken);
        setUser(JSON.parse(storedUser));
      } catch {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        localStorage.removeItem('privateKey');
      }
    } else if (tokenExpired) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      localStorage.removeItem('privateKey');
    }
    setLoading(false);
  }, []);

  async function login(username: string, password: string) {
    const res = await api.login({ username, password });
    let token = res.token;
    let authenticatedUser = res.user;
    const storedPrivateKey = localStorage.getItem(`privateKey:${res.user.username}`);
    const keyMatches = storedPrivateKey && res.user.publicKey
      ? privateKeyMatchesPublicKey(storedPrivateKey, res.user.publicKey)
      : false;
    if (storedPrivateKey && keyMatches) {
      localStorage.setItem('privateKey', storedPrivateKey);
    } else {
      // A different production origin cannot read the old origin's private key.
      // Rebind a freshly generated device key after password authentication.
      const keyPair = await generateSigningKeyPair();
      const privateJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
      const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
      localStorage.setItem('token', res.token);
      localStorage.setItem('user', JSON.stringify(res.user));
      try {
        const rotated = await api.rotateSigningKey({ password, publicKey: JSON.stringify(publicJwk) });
        token = rotated.token;
        authenticatedUser = rotated.user;
        storePrivateKeyForUser(res.user.username, privateJwk);
      } catch (error) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        localStorage.removeItem('privateKey');
        throw error;
      }
    }
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(authenticatedUser));
    setToken(token);
    setUser(authenticatedUser);
  }

  async function register(username: string, password: string, publicKey?: string | null) {
    await api.register({ username, password, publicKey: publicKey ?? null });
    await login(username, password);
  }

  async function logout() {
    try { await api.logout(); } catch { /* ignore */ }
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    localStorage.removeItem('privateKey');
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
