import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { PublicJob } from '../../api/types';
import { Empty, ErrorState, Loading, TextField, usePageTitle } from '../../components/ui';
import { employmentTypeLabel, fmtSalaryRange, workModelLabel } from '../../lib/format';
import { PublicLayout } from './PublicLayout';

export function jobMeta(j: PublicJob) {
  return [j.location, j.workModel && workModelLabel[j.workModel], j.employmentType && employmentTypeLabel[j.employmentType]]
    .filter(Boolean)
    .join(' · ');
}

export function JobsPage() {
  usePageTitle('Vagas abertas');
  const q = useQuery({ queryKey: ['public-jobs'], queryFn: () => api.get<{ items: PublicJob[] }>('/api/public/jobs') });
  const [search, setSearch] = useState('');
  const items = useMemo(() => {
    const s = search.trim().toLowerCase();
    const all = q.data?.items ?? [];
    return s ? all.filter((j) => `${j.title} ${j.location ?? ''} ${j.companyName ?? ''}`.toLowerCase().includes(s)) : all;
  }, [q.data, search]);

  return (
    <PublicLayout>
      <section className="public-hero">
        <h1>Vagas abertas</h1>
        <p>Oportunidades selecionadas pela Alpha Select Consultoria de Recursos Humanos.</p>
      </section>
      <div className="public-content stack">
        <TextField label="Buscar vaga" placeholder="Cargo, cidade ou empresa" value={search} onChange={(e) => setSearch(e.target.value)} />
        {q.isLoading ? <Loading /> : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : items.length === 0 ? (
          <Empty title={search ? 'Nenhuma vaga encontrada' : 'Nenhuma vaga aberta no momento'}>
            <p>Deixe seu currículo no nosso banco de talentos: <Link to="/trabalhe-conosco">cadastrar currículo</Link>.</p>
          </Empty>
        ) : (
          <ul className="job-list">
            {items.map((j) => (
              <li key={j.slug} className="card job-card">
                <div>
                  <h2><Link to={`/vagas/${j.slug}`}>{j.title}</Link></h2>
                  <p className="muted">{j.companyName ?? 'Empresa confidencial'}</p>
                  {jobMeta(j) && <p className="small">{jobMeta(j)}</p>}
                  {fmtSalaryRange(j.salaryMinCents, j.salaryMaxCents) && <p className="small">{fmtSalaryRange(j.salaryMinCents, j.salaryMaxCents)}</p>}
                </div>
                <Link to={`/vagas/${j.slug}`} className="btn btn-primary">Ver vaga</Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </PublicLayout>
  );
}
