import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { PublicJobDetail } from '../../api/types';
import { ErrorState, Loading, usePageTitle } from '../../components/ui';
import { fmtSalaryRange } from '../../lib/format';
import { PublicLayout } from './PublicLayout';
import { ApplyForm } from './ApplyForm';
import { jobMeta } from './JobsPage';

export function JobPage() {
  const { slug } = useParams<{ slug: string }>();
  const q = useQuery({ queryKey: ['public-job', slug], queryFn: () => api.get<PublicJobDetail>(`/api/public/jobs/${slug}`), retry: false });
  usePageTitle(q.data?.title ?? 'Vaga');
  const j = q.data;
  return (
    <PublicLayout>
      {q.isLoading ? <Loading /> : q.isError ? (
        <div className="public-content stack">
          <ErrorState error={q.error} />
          <Link to="/vagas">Ver todas as vagas</Link>
        </div>
      ) : j && (
        <>
          <section className="public-hero">
            <Link to="/vagas" className="public-back">← Todas as vagas</Link>
            <h1>{j.title}</h1>
            <p>{[j.companyName ?? 'Empresa confidencial', jobMeta(j)].filter(Boolean).join(' · ')}</p>
          </section>
          <div className="public-content job-detail">
            <article className="card card-body stack">
              {j.description && <section><h2>Sobre a oportunidade</h2><p className="pre-wrap">{j.description}</p></section>}
              {j.requirements && <section><h2>Requisitos</h2><p className="pre-wrap">{j.requirements}</p></section>}
              {j.benefits && <section><h2>Benefícios</h2><p className="pre-wrap">{j.benefits}</p></section>}
              {fmtSalaryRange(j.salaryMinCents, j.salaryMaxCents) && (
                <section><h2>Remuneração</h2><p>{fmtSalaryRange(j.salaryMinCents, j.salaryMaxCents)}</p></section>
              )}
            </article>
            <aside className="card card-body" aria-labelledby="candidatar">
              <h2 id="candidatar">Candidate-se</h2>
              <ApplyForm endpoint={`/api/public/jobs/${j.slug}/apply`} questions={j.questions} title={`Candidatura para ${j.title}`} />
            </aside>
          </div>
        </>
      )}
    </PublicLayout>
  );
}
