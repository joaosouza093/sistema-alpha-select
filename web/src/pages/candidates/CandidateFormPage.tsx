import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import type { Candidate } from '../../api/types';
import { Alert, Button, ErrorState, Loading, PageHeader, TextArea, TextField, fieldErrors, usePageTitle, useToast } from '../../components/ui';

interface Dup {
  matches: { id: string; fullName: string; email: string | null; phone: string | null }[];
  hiddenCount: number;
}

export function CandidateFormPage() {
  const { id } = useParams<{ id: string }>();
  const editing = !!id;
  usePageTitle(editing ? 'Editar candidato' : 'Cadastrar candidato');
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const existing = useQuery({ queryKey: ['candidate', id], queryFn: () => api.get<Candidate>(`/api/candidates/${id}`), enabled: editing });

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [salary, setSalary] = useState('');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [dup, setDup] = useState<Dup | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const c = existing.data;
    if (!c) return;
    setFullName(c.fullName);
    setEmail(c.email ?? '');
    setPhone(c.phone ?? '');
    setSalary(c.salaryExpectation !== null ? String(c.salaryExpectation).replace('.', ',') : '');
    setNotes(c.notes ?? '');
  }, [existing.data]);

  // Verificação antecipada de duplicidade (não bloqueia o cadastro).
  const checkDup = async () => {
    if (!email && !phone) return setDup(null);
    try {
      const r = await api.post<Dup>('/api/candidates/check-duplicates', { email: email || null, phone: phone || null, excludeId: id ?? null });
      setDup(r.matches.length || r.hiddenCount ? r : null);
    } catch {
      /* validação completa ocorre ao salvar */
    }
  };

  const submit = async (e: FormEvent, confirmDuplicate = false) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    const payload = { fullName, email: email || null, phone: phone || null, salaryExpectation: salary || null, notes: notes || null };
    try {
      if (editing) {
        await api.patch(`/api/candidates/${id}`, { ...payload, expectedVersion: existing.data!.version });
        await qc.invalidateQueries({ queryKey: ['candidate', id] });
        toast.success('Cadastro atualizado.');
        nav(`/candidatos/${id}`);
      } else {
        const r = await api.post<{ id: string }>('/api/candidates', { ...payload, confirmDuplicate });
        toast.success('Candidato cadastrado.');
        nav(`/candidatos/${r.id}?aba=documentos`);
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === 'possible_duplicate') {
        setDup(err.details as Dup);
      } else {
        setErrors(fieldErrors(err));
        toast.error(err);
      }
    } finally {
      setBusy(false);
    }
  };

  if (editing && existing.isLoading) return <Loading />;
  if (editing && existing.isError) return <ErrorState error={existing.error} />;

  return (
    <>
      <PageHeader breadcrumb={<Link to="/candidatos">Candidatos</Link>} title={editing ? 'Editar candidato' : 'Cadastrar candidato'}
        subtitle="Colete apenas os dados necessários ao processo seletivo." />
      <form className="card" onSubmit={(e) => submit(e)} noValidate>
        <div className="card-body stack">
          <TextField label="Nome completo" value={fullName} onChange={(e) => setFullName(e.target.value)} error={errors.fullName} maxLength={160} required autoComplete="off" />
          <div className="grid grid-3">
            <TextField label="E-mail" type="email" value={email} onChange={(e) => setEmail(e.target.value)} onBlur={checkDup} error={errors.email} autoComplete="off" />
            <TextField label="Telefone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} onBlur={checkDup} error={errors.phone} hint="Ex.: (11) 91234-5678" autoComplete="off" />
            <TextField label="Pretensão salarial (R$)" inputMode="decimal" value={salary} onChange={(e) => setSalary(e.target.value)} error={errors.salaryExpectation} hint="Ex.: 7.500,00" autoComplete="off" />
          </div>
          <TextArea label="Observações internas" value={notes} onChange={(e) => setNotes(e.target.value)} error={errors.notes} maxLength={10000}
            hint="Visíveis somente à equipe da Alpha Select. Nunca são compartilhadas com clientes." />
          {dup && (
            <Alert kind="warning">
              <strong>Possível duplicidade.</strong>{' '}
              {dup.matches.length > 0 && (
                <>Cadastros com o mesmo e-mail ou telefone:{' '}
                  {dup.matches.map((m, i) => <span key={m.id}>{i > 0 && ', '}<Link to={`/candidatos/${m.id}`} target="_blank" rel="noopener">{m.fullName}</Link></span>)}.{' '}
                </>
              )}
              {dup.hiddenCount > 0 && <>Há {dup.hiddenCount} cadastro(s) semelhante(s) fora do seu acesso; consulte um administrador. </>}
              {!editing && (
                <div style={{ marginTop: 8 }}>
                  <Button size="sm" onClick={(e) => submit(e as unknown as FormEvent, true)} loading={busy}>Cadastrar mesmo assim (pessoa diferente)</Button>
                </div>
              )}
            </Alert>
          )}
        </div>
        <div className="modal-footer">
          <Link to={editing ? `/candidatos/${id}` : '/candidatos'} className="btn">Cancelar</Link>
          <Button type="submit" variant="primary" loading={busy} disabled={fullName.trim().length < 2}>{editing ? 'Salvar alterações' : 'Cadastrar'}</Button>
        </div>
      </form>
    </>
  );
}
