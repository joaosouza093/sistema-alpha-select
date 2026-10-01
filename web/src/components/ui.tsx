import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { ApiError } from '../api/client';
import type { Decision, ProcessStatus } from '../api/types';
import { decisionLabel, statusLabel } from '../lib/format';
import { appTitle } from '../brand';

// ----------------------------------------------------------------- Button

type BtnVariant = 'primary' | 'danger' | 'ghost' | 'default';
export function Button({
  variant = 'default',
  size,
  loading,
  children,
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: 'sm'; loading?: boolean }) {
  const cls = ['btn', variant !== 'default' && `btn-${variant}`, size === 'sm' && 'btn-sm', className].filter(Boolean).join(' ');
  return (
    <button type="button" className={cls} disabled={loading || rest.disabled} aria-busy={loading || undefined} {...rest}>
      {loading && <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} aria-hidden />}
      {children}
    </button>
  );
}

// ----------------------------------------------------------------- Fields

interface FieldProps {
  label: string;
  error?: string;
  hint?: string;
}

function useFieldIds(error?: string, hint?: string) {
  const id = useId();
  const describedBy = [error && `${id}-err`, hint && `${id}-hint`].filter(Boolean).join(' ') || undefined;
  return { id, describedBy };
}

function FieldWrap({ id, label, error, hint, children, required }: FieldProps & { id: string; children: ReactNode; required?: boolean }) {
  return (
    <div className="field">
      <label htmlFor={id}>
        {label}
        {required && <span aria-hidden> *</span>}
      </label>
      {children}
      {hint && (
        <span className="hint" id={`${id}-hint`}>
          {hint}
        </span>
      )}
      {error && (
        <span className="error" id={`${id}-err`} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

export function TextField({ label, error, hint, ...rest }: FieldProps & InputHTMLAttributes<HTMLInputElement>) {
  const { id, describedBy } = useFieldIds(error, hint);
  return (
    <FieldWrap id={id} label={label} error={error} hint={hint} required={rest.required}>
      <input id={id} className="input" aria-invalid={!!error} aria-describedby={describedBy} {...rest} />
    </FieldWrap>
  );
}

export function TextArea({ label, error, hint, ...rest }: FieldProps & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { id, describedBy } = useFieldIds(error, hint);
  return (
    <FieldWrap id={id} label={label} error={error} hint={hint} required={rest.required}>
      <textarea id={id} className="textarea" aria-invalid={!!error} aria-describedby={describedBy} {...rest} />
    </FieldWrap>
  );
}

export function SelectField({
  label,
  error,
  hint,
  children,
  ...rest
}: FieldProps & SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }) {
  const { id, describedBy } = useFieldIds(error, hint);
  return (
    <FieldWrap id={id} label={label} error={error} hint={hint} required={rest.required}>
      <select id={id} className="select" aria-invalid={!!error} aria-describedby={describedBy} {...rest}>
        {children}
      </select>
    </FieldWrap>
  );
}

export function Checkbox({ label, hint, ...rest }: { label: string; hint?: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="checkbox">
      <input type="checkbox" {...rest} />
      <span>
        {label}
        {hint && <span className="muted small" style={{ display: 'block' }}>{hint}</span>}
      </span>
    </label>
  );
}

// ----------------------------------------------------------------- States

export function Loading({ label = 'Carregando…' }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" aria-hidden />
      <span>{label}</span>
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const msg = error instanceof ApiError ? error.message : 'Não foi possível carregar os dados.';
  const notFound = error instanceof ApiError && (error.status === 404 || error.status === 403);
  return (
    <div className="empty" role="alert">
      <h3>{notFound ? 'Conteúdo indisponível' : 'Algo deu errado'}</h3>
      <p>{notFound ? 'O registro não existe ou você não tem acesso a ele.' : msg}</p>
      <div className="row" style={{ justifyContent: 'center' }}>
        {onRetry && !notFound && <Button onClick={onRetry}>Tentar novamente</Button>}
        <a href="/" className="btn">Voltar ao painel</a>
      </div>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export function Alert({ kind = 'error', children }: { kind?: 'error' | 'info' | 'warning' | 'success'; children: ReactNode }) {
  return (
    <div className={`alert alert-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
  breadcrumb,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  breadcrumb?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
        {breadcrumb && <nav className="breadcrumb" aria-label="Navegação estrutural">{breadcrumb}</nav>}
        <h1>{title}</h1>
        {subtitle && <div className="subtitle">{subtitle}</div>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

// ----------------------------------------------------------------- Badges

export function DecisionBadge({ decision }: { decision: Decision }) {
  const cls = { pendente: 'badge-info', aprovado: 'badge-success', reprovado: 'badge-danger', desistiu: 'badge-warning' }[decision];
  return <span className={`badge ${cls}`}>{decisionLabel[decision]}</span>;
}

export function StatusBadge({ status }: { status: ProcessStatus }) {
  const cls = { em_andamento: 'badge-success', concluido: 'badge-brand', arquivado: '' }[status];
  return <span className={`badge ${cls}`}>{statusLabel[status]}</span>;
}

// ----------------------------------------------------------------- Modal

export function Modal({
  title,
  onClose,
  children,
  footer,
  size,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'lg';
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const focusables = () =>
      Array.from(
        el?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, iframe, [tabindex]:not([tabindex="-1"])') ?? [],
      ).filter((x) => !x.hasAttribute('disabled'));
    (focusables().find((x) => x.tagName !== 'BUTTON') ?? focusables()[0])?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab') {
        const f = focusables();
        if (!f.length) return;
        const first = f[0]!;
        const last = f[f.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus();
    };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${size === 'lg' ? 'modal-lg' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref}>
        <div className="modal-header">
          <h2 id={titleId}>{title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Fechar">
            ✕
          </Button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Confirmar',
  danger,
  onConfirm,
  onCancel,
  loading,
  requireText,
}: {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  loading?: boolean;
  requireText?: string;
}) {
  const [typed, setTyped] = useState('');
  const blocked = !!requireText && typed.trim() !== requireText;
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>Cancelar</Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={loading} disabled={blocked}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div>{message}</div>
        {requireText && (
          <TextField
            label={`Para confirmar, digite: ${requireText}`}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
          />
        )}
      </div>
    </Modal>
  );
}

// ----------------------------------------------------------------- Tabs

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
  label: string;
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const onKey = (e: React.KeyboardEvent, idx: number) => {
    let next = idx;
    if (e.key === 'ArrowRight') next = (idx + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + tabs.length) % tabs.length;
    else return;
    e.preventDefault();
    const t = tabs[next]!;
    onChange(t.id);
    refs.current[t.id]?.focus();
  };
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((t, i) => (
        <button
          key={t.id}
          ref={(el) => {
            refs.current[t.id] = el;
          }}
          role="tab"
          className="tab"
          id={`tab-${t.id}`}
          aria-selected={value === t.id}
          aria-controls={`panel-${t.id}`}
          tabIndex={value === t.id ? 0 : -1}
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ----------------------------------------------------------------- Pagination

export function Pagination({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <nav className="pagination" aria-label="Paginação">
      <span className="muted small">
        {from}–{to} de {total}
      </span>
      <div className="row">
        <Button size="sm" onClick={() => onPage(page - 1)} disabled={page <= 1}>
          Anterior
        </Button>
        <span className="small">
          Página {page} de {pages}
        </span>
        <Button size="sm" onClick={() => onPage(page + 1)} disabled={page >= pages}>
          Próxima
        </Button>
      </div>
    </nav>
  );
}

// ----------------------------------------------------------------- Toast

interface ToastItem {
  id: number;
  kind: 'success' | 'error' | 'info';
  text: string;
}
const ToastCtx = createContext<(kind: ToastItem['kind'], text: string) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((kind: ToastItem['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs, { id, kind, text }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 5000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite" aria-atomic="false">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const push = useContext(ToastCtx);
  return {
    success: (t: string) => push('success', t),
    error: (e: unknown) => push('error', e instanceof ApiError ? e.message : typeof e === 'string' ? e : 'Não foi possível concluir a operação.'),
    info: (t: string) => push('info', t),
  };
}

export function fieldErrors(e: unknown): Record<string, string> {
  return e instanceof ApiError ? e.fields : {};
}

/** Define o título da aba sem dados pessoais. */
export function usePageTitle(title: string) {
  useEffect(() => {
    document.title = `${title} — ${appTitle}`;
  }, [title]);
}
