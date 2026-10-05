import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, qs } from '../../api/client';
import type { CandidateRow, Page } from '../../api/types';
import { Button, Loading, Modal, TextField, useToast } from '../../components/ui';
import { fmtPhone } from '../../lib/format';

export function AddCandidateModal({ processId, onClose }: { processId: string; onClose: () => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const list = useQuery({
    queryKey: ['candidates-pick', q],
    queryFn: () => api.get<Page<CandidateRow>>(`/api/candidates${qs({ q, pageSize: 10 })}`),
    placeholderData: (p) => p,
  });

  const add = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ id: string }>('/api/applications', { candidateId: selected, processId });
      toast.success('Candidato incluído no processo (etapa RH Externo).');
      nav(`/participacoes/${r.id}`);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Incluir candidato no processo" onClose={onClose} size="lg"
      footer={<><Link to="/candidatos/novo" className="btn">Cadastrar novo candidato</Link><Button onClick={onClose}>Cancelar</Button><Button variant="primary" onClick={add} loading={busy} disabled={!selected}>Incluir</Button></>}>
      <div className="stack">
        <TextField label="Buscar candidato (nome, e-mail ou telefone)" type="search" value={q} onChange={(e) => setQ(e.target.value)} />
        {list.isLoading ? <Loading /> : (
          <fieldset style={{ border: 'none', padding: 0, margin: 0 }}>
            <legend className="sr-only">Selecione o candidato</legend>
            <div className="stack" style={{ gap: 6 }}>
              {list.data?.items.length === 0 && <p className="muted">Nenhum candidato encontrado.</p>}
              {list.data?.items.map((c) => (
                <label key={c.id} className="radio-card">
                  <input type="radio" name="cand" value={c.id} checked={selected === c.id} onChange={() => setSelected(c.id)} />
                  <span><strong>{c.fullName}</strong><span className="muted small" style={{ display: 'block' }}>{c.email ?? 'sem e-mail'} · {fmtPhone(c.phone)}</span></span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
      </div>
    </Modal>
  );
}
