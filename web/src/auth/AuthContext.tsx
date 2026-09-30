import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError, setCsrfToken, setUnauthorizedHandler } from '../api/client';
import type { SessionUser } from '../api/types';
import { isAlphaKind } from '../lib/format';

interface AuthState {
  user: SessionUser | null;
  loading: boolean;
  expired: boolean;
  isAdmin: boolean;
  isAlpha: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [expired, setExpired] = useState(false);

  const clear = useCallback(() => {
    setCsrfToken(null);
    setUser(null);
    qc.clear(); // nenhum dado de uma sessão permanece em cache para a próxima
  }, [qc]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setExpired(true);
      clear();
    });
    api
      .get<{ user: SessionUser; csrfToken: string }>('/api/auth/me')
      .then((r) => {
        setCsrfToken(r.csrfToken);
        setUser(r.user);
      })
      .catch((e) => {
        if (!(e instanceof ApiError) || e.status !== 401) console.warn('Falha ao verificar sessão');
        setExpired(false);
      })
      .finally(() => setLoading(false));
  }, [clear]);

  const login = useCallback(
    async (email: string, password: string) => {
      const r = await api.post<{ user: SessionUser; csrfToken: string }>('/api/auth/login', { email, password });
      qc.clear();
      setCsrfToken(r.csrfToken);
      setExpired(false);
      setUser(r.user);
    },
    [qc],
  );

  const logout = useCallback(async () => {
    try {
      await api.post('/api/auth/logout');
    } finally {
      setExpired(false);
      clear();
    }
  }, [clear]);

  const value = useMemo<AuthState>(
    () => ({
      user,
      loading,
      expired,
      isAdmin: user?.kind === 'alpha_admin',
      isAlpha: isAlphaKind(user?.kind),
      login,
      logout,
    }),
    [user, loading, expired, login, logout],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('AuthProvider ausente');
  return v;
}
