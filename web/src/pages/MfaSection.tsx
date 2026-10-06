import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { api } from '../api/client';
import { Alert, Button, Loading, TextField, fieldErrors, useToast } from '../components/ui';
import { fmtDateTime } from '../lib/format';

interface MfaStatus { enabled: boolean; enabledAt: string | null; recoveryCodesLeft: number }

/** Verificação em duas etapas (aplicativo autenticador) em Minha conta. */
export function MfaSection() {
  const qc = useQueryClient();
  const toast = useToast();
  const status = useQuery({ queryKey: ['mfa'], queryFn: () => api.get<MfaStatus>('/api/auth/mfa') });
  const [step, setStep] = useState<'idle' | 'password' | 'scan' | 'disable' | 'regen'>('idle');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!setup) return setQr(null);
    QRCode.toDataURL(setup.otpauthUrl, { margin: 1, width: 360 }).then(setQr, () => setQr(null));
  }, [setup]);

  const reset = () => { setStep('idle'); setPassword(''); setCode(''); setSetup(null); setErrors({}); };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErrors({});
    try {
      await fn();
    } catch (err) {
      setErrors(fieldErrors(err));
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  const startSetup = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      setSetup(await api.post('/api/auth/mfa/setup', { password }));
      setPassword('');
      setStep('scan');
    });
  };

  const confirm = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await api.post<{ recoveryCodes: string[] }>('/api/auth/mfa/confirm', { code });
      setCodes(r.recoveryCodes);
      reset();
      toast.success('Verificação em duas etapas ativada. Outras sessões abertas foram encerradas.');
      await qc.invalidateQueries({ queryKey: ['mfa'] });
    });
  };

  const disable = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api.post('/api/auth/mfa/disable', { password, code });
      reset();
      setCodes(null);
      toast.success('Verificação em duas etapas desligada.');
      await qc.invalidateQueries({ queryKey: ['mfa'] });
    });
  };

  const regen = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await api.post<{ recoveryCodes: string[] }>('/api/auth/mfa/recovery-codes', { code });
      setCodes(r.recoveryCodes);
      reset();
      await qc.invalidateQueries({ queryKey: ['mfa'] });
    });
  };

  const downloadCodes = () => {
    if (!codes) return;
    const text = `Códigos de recuperação — Alpha Select\nCada código funciona uma única vez.\n\n${codes.join('\n')}\n`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'alpha-select-codigos-de-recuperacao.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const s = status.data;
  const codeField = (
    <TextField label="Código do aplicativo (ou de recuperação)" autoComplete="one-time-code" value={code}
      onChange={(e) => setCode(e.target.value.toUpperCase())} error={errors.code} maxLength={12} required />
  );

  return (
    <section className="card">
      <div className="card-header">
        <h2>Verificação em duas etapas</h2>
        {s && <span className={`badge ${s.enabled ? 'badge-success' : ''}`}>{s.enabled ? 'Ativada' : 'Desativada'}</span>}
      </div>
      <div className="card-body stack">
        {status.isLoading ? <Loading /> : !s ? null : (
          <>
            {codes && (
              <Alert kind="warning">
                <strong>Guarde estes códigos de recuperação agora.</strong> Eles não serão mostrados de novo. Cada um permite
                entrar uma vez se você perder o celular.
                <ul className="recovery-codes" style={{ marginTop: 8 }}>{codes.map((c) => <li key={c}>{c}</li>)}</ul>
                <div className="row" style={{ marginTop: 8 }}>
                  <Button size="sm" onClick={downloadCodes}>Baixar em arquivo</Button>
                  <Button size="sm" onClick={() => setCodes(null)}>Já guardei</Button>
                </div>
              </Alert>
            )}

            {!s.enabled && step === 'idle' && (
              <>
                <p className="muted" style={{ margin: 0 }}>
                  Além da senha, o login pede um código do aplicativo autenticador do seu celular (Google Authenticator,
                  Microsoft Authenticator ou similar). Mesmo que alguém descubra sua senha, não consegue entrar.
                </p>
                <div><Button variant="primary" onClick={() => setStep('password')}>Ativar</Button></div>
              </>
            )}

            {step === 'password' && (
              <form className="stack" onSubmit={startSetup} noValidate>
                <TextField label="Confirme sua senha" type="password" autoComplete="current-password" value={password}
                  onChange={(e) => setPassword(e.target.value)} error={errors.password} required />
                <div className="form-actions">
                  <Button onClick={reset}>Cancelar</Button>
                  <Button type="submit" variant="primary" loading={busy} disabled={!password}>Continuar</Button>
                </div>
              </form>
            )}

            {step === 'scan' && setup && (
              <form className="stack" onSubmit={confirm} noValidate>
                <ol style={{ margin: 0, paddingLeft: 18 }}>
                  <li>Instale um aplicativo autenticador no celular.</li>
                  <li>No aplicativo, adicione uma conta lendo o QR code abaixo.</li>
                  <li>Digite o código de 6 dígitos que aparecer.</li>
                </ol>
                <div className="qr-box">
                  {qr ? <img src={qr} alt="QR code para o aplicativo autenticador" /> : <Loading label="Gerando QR code…" />}
                  <div className="stack" style={{ minWidth: 0, flex: 1 }}>
                    <span className="muted small">Não consegue ler? Digite esta chave no aplicativo:</span>
                    <span className="secret-code">{setup.secret.match(/.{1,4}/g)!.join(' ')}</span>
                  </div>
                </div>
                <TextField label="Código de 6 dígitos" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} error={errors.code} required />
                <div className="form-actions">
                  <Button onClick={reset}>Cancelar</Button>
                  <Button type="submit" variant="primary" loading={busy} disabled={code.length !== 6}>Ativar</Button>
                </div>
              </form>
            )}

            {s.enabled && step === 'idle' && (
              <>
                <p className="muted" style={{ margin: 0 }}>
                  Ativada em {fmtDateTime(s.enabledAt)}. Códigos de recuperação restantes: <strong>{s.recoveryCodesLeft}</strong>.
                </p>
                {s.recoveryCodesLeft <= 3 && <Alert kind="warning">Restam poucos códigos de recuperação. Gere novos.</Alert>}
                <div className="row">
                  <Button onClick={() => setStep('regen')}>Gerar novos códigos de recuperação</Button>
                  <Button variant="danger" onClick={() => setStep('disable')}>Desligar</Button>
                </div>
              </>
            )}

            {step === 'regen' && (
              <form className="stack" onSubmit={regen} noValidate>
                <p className="muted small" style={{ margin: 0 }}>Os códigos antigos deixam de funcionar.</p>
                {codeField}
                <div className="form-actions">
                  <Button onClick={reset}>Cancelar</Button>
                  <Button type="submit" variant="primary" loading={busy} disabled={code.length < 6}>Gerar</Button>
                </div>
              </form>
            )}

            {step === 'disable' && (
              <form className="stack" onSubmit={disable} noValidate>
                <TextField label="Sua senha" type="password" autoComplete="current-password" value={password}
                  onChange={(e) => setPassword(e.target.value)} error={errors.password} required />
                {codeField}
                <div className="form-actions">
                  <Button onClick={reset}>Cancelar</Button>
                  <Button type="submit" variant="danger" loading={busy} disabled={!password || code.length < 6}>Desligar</Button>
                </div>
              </form>
            )}
          </>
        )}
      </div>
    </section>
  );
}
