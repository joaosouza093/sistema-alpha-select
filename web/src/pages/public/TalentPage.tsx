import { usePageTitle } from '../../components/ui';
import { PublicLayout } from './PublicLayout';
import { ApplyForm } from './ApplyForm';

/** Autocadastro no banco de talentos, sem vaga específica. */
export function TalentPage() {
  usePageTitle('Cadastrar currículo');
  return (
    <PublicLayout>
      <section className="public-hero">
        <h1>Cadastre seu currículo</h1>
        <p>Entre no banco de talentos da Alpha Select e seja lembrado em novas oportunidades.</p>
      </section>
      <div className="public-content narrow">
        <div className="card card-body">
          <ApplyForm endpoint="/api/public/talent" title="Cadastro no banco de talentos" />
        </div>
      </div>
    </PublicLayout>
  );
}
