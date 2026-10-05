import { Link } from 'react-router-dom';
import { Empty, usePageTitle } from '../components/ui';

export function NotFoundPage() {
  usePageTitle('Página não encontrada');
  return (
    <Empty title="Página não encontrada">
      <p>O endereço não existe ou você não tem acesso a este conteúdo.</p>
      <Link to="/" className="btn">
        Voltar ao painel
      </Link>
    </Empty>
  );
}
