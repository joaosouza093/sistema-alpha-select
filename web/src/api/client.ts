export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly fields: Record<string, string> = {},
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

let csrfToken: string | null = null;
let onUnauthorized: (() => void) | null = null;

export function setCsrfToken(token: string | null) {
  csrfToken = token;
}

export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

async function request<T>(method: string, url: string, body?: unknown, extra?: Record<string, string>): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...extra };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;

  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin', cache: 'no-store' });
  } catch {
    throw new ApiError(0, 'network', 'Não foi possível conectar ao servidor. Verifique sua conexão.');
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = data?.error ?? {};
    if (res.status === 401 && !extra && !url.startsWith('/api/auth/login') && onUnauthorized) onUnauthorized();
    throw new ApiError(
      res.status,
      err.code ?? 'error',
      err.message ?? 'Não foi possível concluir a operação.',
      err.fields ?? {},
      err.details,
    );
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body: unknown = {}) => request<T>('POST', url, body),
  put: <T>(url: string, body: unknown = {}) => request<T>('PUT', url, body),
  patch: <T>(url: string, body: unknown = {}) => request<T>('PATCH', url, body),
  delete: <T>(url: string) => request<T>('DELETE', url),
};

/** Área do candidato: autenticação pelo token do link de e-mail (cabeçalho, sem cookie). */
export function candidateApi(token: string) {
  const h = { 'X-Candidate-Token': token };
  return {
    get: <T>(url: string) => request<T>('GET', url, undefined, h),
    post: <T>(url: string, body: unknown = {}) => request<T>('POST', url, body, h),
    patch: <T>(url: string, body: unknown = {}) => request<T>('PATCH', url, body, h),
    /** Baixa um arquivo (resposta não-JSON). */
    download: async (url: string, filename: string) => {
      const res = await fetch(url, { headers: h, cache: 'no-store' });
      if (!res.ok) throw new ApiError(res.status, 'error', 'Não foi possível baixar o arquivo.');
      const blobUrl = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    },
  };
}

export function qs(params: Record<string, string | number | undefined | null>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}
