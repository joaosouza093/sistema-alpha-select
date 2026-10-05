import { execFileSync } from 'node:child_process';
import path from 'node:path';

/** Cria um conjunto novo de dados fictícios (banco de desenvolvimento) para esta execução. */
export default function globalSetup() {
  const out = path.resolve('e2e/.auth/creds.json');
  execFileSync('npm', ['run', 'db:seed-dev', '-w', 'server', '--', '--force', '--json', out], { stdio: 'inherit' });
}
