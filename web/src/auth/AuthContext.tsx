import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
  /** Limite de upload informado pelo servidor (MB). */
  maxUploadMb: number;
  /** Devolve o desafio quando a conta usa verificação em duas etapas. */
  login: (email: string, password: string) => Promise<{ mfaToken: string } | null>;
  completeMfa: (mfaToken: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [expired, setExpired] = useState(false);
  const hadSession = useRef(false);
  const [maxUploadMb, setMaxUploadMb] = useState(10);

  const clear = useCallback(() => {
    setCsrfToken(null);
    setUser(null);
    qc.clear(); // nenhum dado de uma sessão permanece em cache para a próxima
  }, [qc]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      // Só trata como "sessão expirada" quem estava logado; visitantes de páginas públicas não.
      if (!hadSession.current) return;
      hadSession.current = false;
      setExpired(true);
      clear();
    });
    api
      .get<{ user: SessionUser; csrfToken: string; limits?: { maxUploadMb: number } }>('/api/auth/me')
      .then((r) => {
        if (r.limits) setMaxUploadMb(r.limits.maxUploadMb);
        setCsrfToken(r.csrfToken);
        hadSession.current = true;
        setUser(r.user);
      })
      .catch((e) => {
        if (!(e instanceof ApiError) || e.status !== 401) console.warn('Falha ao verificar sessão');
        setExpired(false);
      })
      .finally(() => setLoading(false));
  }, [clear]);

  type SessionResponse = { user: SessionUser; csrfToken: string; limits?: { maxUploadMb: number } };
  const start = useCallback(
    (r: SessionResponse) => {
      qc.clear();
      if (r.limits) setMaxUploadMb(r.limits.maxUploadMb);
      setCsrfToken(r.csrfToken);
      setExpired(false);
      hadSession.current = true;
      setUser(r.user);
    },
    [qc],
  );

  const login = useCallback(
    async (email: string, password: string) => {
      const r = await api.post<SessionResponse | { mfaRequired: true; mfaToken: string }>('/api/auth/login', { email, password });
      if ('mfaRequired' in r) return { mfaToken: r.mfaToken };
      start(r);
      return null;
    },
    [start],
  );

  const completeMfa = useCallback(
    async (mfaToken: string, code: string) => {
      start(await api.post<SessionResponse>('/api/auth/login/mfa', { mfaToken, code }));
    },
    [start],
  );

  const logout = useCallback(async () => {
    try {
      await api.post('/api/auth/logout');
    } finally {
      hadSession.current = false;
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
      maxUploadMb,
      login,
      completeMfa,
      logout,
    }),
    [user, loading, expired, maxUploadMb, login, completeMfa, logout],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('AuthProvider ausente');
  return v;
}
