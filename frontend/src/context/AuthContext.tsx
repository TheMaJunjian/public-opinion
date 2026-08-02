import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import type { User } from '../types';
import { api } from '../api';
import { getPrivateKeyForCurrentUser } from '../api/client';

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
    if (storedToken && storedUser) {
      setToken(storedToken);
      setUser(JSON.parse(storedUser));
    }
    setLoading(false);
  }, []);

  async function login(username: string, password: string) {
    const res = await api.login({ username, password });
    localStorage.setItem('token', res.token);
    localStorage.setItem('user', JSON.stringify(res.user));
    setToken(res.token);
    setUser(res.user);
    const storedPrivateKey = localStorage.getItem(`privateKey:${res.user.username}`);
    if (storedPrivateKey) {
      localStorage.setItem('privateKey', storedPrivateKey);
    }
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
      const keyData = JSON.parse(rawKey);
      const privateKey = await crypto.subtle.importKey(
        'jwk', keyData, { name: 'Ed25519' }, false, ['sign'],
      );
      const encoded = new TextEncoder().encode(payload);
      const sig = await crypto.subtle.sign('Ed25519', privateKey, encoded);
      return btoa(String.fromCharCode(...new Uint8Array(sig)));
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
