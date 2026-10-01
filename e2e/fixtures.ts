import { readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';

interface Creds {
  suffix: string;
  creds: { perfil: string; email: string; senha: string }[];
}

export function creds() {
  const data = JSON.parse(readFileSync('e2e/.auth/creds.json', 'utf8')) as Creds;
  const by = (prefix: string) => data.creds.find((c) => c.email.startsWith(prefix))!;
  return {
    suffix: data.suffix,
    admin: by('admin.'),
    staff: by('equipe.'),
    rhAlfa: by('rh.alfa.'),
    gestorAlfa: by('gestor.alfa.'),
    rhBeta: by('rh.beta.'),
  };
}

export async function login(page: Page, c: { email: string; senha: string }) {
  await page.goto('/entrar');
  await page.getByLabel('E-mail').fill(c.email);
  await page.getByLabel('Senha').fill(c.senha);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Olá');
}
