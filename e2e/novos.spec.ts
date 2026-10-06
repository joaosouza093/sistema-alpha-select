import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';
import { creds, login } from './fixtures';

/** URL do banco de desenvolvimento (server/.env), para criar o link de acesso do candidato sem e-mail real. */
function ownerUrl() {
  try {
    return readFileSync('server/.env', 'utf8').match(/^DATABASE_OWNER_URL=(.+)$/m)?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

/** Chamada à API na sessão da página (com o token CSRF), como a interface faz. */
async function apiCall<T>(page: Page, method: string, url: string, body?: unknown): Promise<T> {
  return page.evaluate(
    async ({ method, url, body }) => {
      const me = await (await fetch('/api/auth/me')).json();
      const r = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrfToken },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
      return r.json();
    },
    { method, url, body },
  ) as Promise<T>;
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function totp(secret: string) {
  let bits = 0, value = 0;
  const bytes: number[] = [];
  for (const ch of secret.replace(/\s/g, '')) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) bytes.push((value >>> (bits -= 8)) & 255);
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const h = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const o = h[h.length - 1]! & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

test.describe('telas novas', () => {
  test('relatórios: filtros, resumo e CSV; equipe não vê o financeiro', async ({ page }) => {
    const c = creds();
    await login(page, c.admin);
    await page.getByRole('link', { name: 'Relatórios' }).click();
    await page.getByRole('button', { name: 'Últimos 12 meses' }).click();
    await expect(page.getByText('Funil de candidatos')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Financeiro por empresa' })).toBeVisible();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Baixar tudo (CSV)' }).click();
    expect((await download).suggestedFilename()).toMatch(/^relatorio-completo-.*\.csv$/);

    await page.getByRole('button', { name: 'Sair' }).click();
    await login(page, c.staff);
    await page.goto('/relatorios');
    await expect(page.getByText('Funil de candidatos')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Financeiro por empresa' })).toHaveCount(0);
  });

  test('verificação em duas etapas: ativar com QR e entrar com o código', async ({ page }) => {
    const c = creds();
    await login(page, c.gestorAlfa);
    await page.goto('/conta');
    await page.getByRole('button', { name: 'Ativar' }).click();
    await page.getByLabel('Confirme sua senha').fill(c.gestorAlfa.senha);
    await page.getByRole('button', { name: 'Continuar' }).click();
    await expect(page.getByRole('img', { name: 'QR code para o aplicativo autenticador' })).toBeVisible();
    const secret = await page.locator('.secret-code').innerText();
    await page.getByLabel('Código de 6 dígitos').fill(totp(secret));
    await page.getByRole('button', { name: 'Ativar', exact: true }).click();
    await expect(page.locator('.recovery-codes li')).toHaveCount(10);
    const recovery = (await page.locator('.recovery-codes li').first().innerText()).trim();

    await page.getByRole('button', { name: 'Sair' }).click();
    await page.goto('/entrar');
    await page.getByLabel('E-mail').fill(c.gestorAlfa.email);
    await page.getByLabel('Senha').fill(c.gestorAlfa.senha);
    await page.getByRole('button', { name: 'Entrar' }).click();
    await expect(page.getByRole('heading', { name: 'Verificação em duas etapas' })).toBeVisible();
    await page.getByRole('button', { name: /código de recuperação/ }).click();
    await page.getByLabel('Código de recuperação').fill(recovery);
    await page.getByRole('button', { name: 'Confirmar' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Olá');
  });

  test('portal: candidatura com autorização de WhatsApp aparece para a equipe', async ({ page, browser }) => {
    const c = creds();
    await login(page, c.admin);
    const list = await apiCall<{ items: { id: string; title: string }[] }>(page, 'GET', '/api/processes?status=em_andamento');
    const processId = list.items[0]!.id;
    let job = await apiCall<{ version: number; publicSlug: string | null }>(page, 'GET', `/api/processes/${processId}/job`);
    await apiCall(page, 'PUT', `/api/processes/${processId}/job`, {
      expectedVersion: job.version, jobLocation: 'Remoto', workModel: 'remoto', employmentType: 'clt', requirements: null,
      benefits: null, salaryMinCents: null, salaryMaxCents: null, showCompany: false, screeningQuestions: [],
    });
    job = await apiCall(page, 'GET', `/api/processes/${processId}/job`);
    const pub = await apiCall<{ publicSlug: string }>(page, 'POST', `/api/processes/${processId}/publication`, {
      expectedVersion: job.version, publication: 'publicada',
    });

    const visitor = await browser.newPage();
    await visitor.goto(`/vagas/${pub.publicSlug}`);
    const email = `portal.${c.suffix}.${randomBytes(3).toString('hex')}@exemplo.invalid`;
    await visitor.getByLabel('Nome completo').fill('Pessoa Fictícia do Portal');
    await visitor.getByLabel('E-mail').fill(email);
    await visitor.getByLabel('Telefone / WhatsApp').fill('(11) 98765-4321');
    await visitor.getByLabel(/receber avisos sobre esta candidatura pelo WhatsApp/).check();
    await visitor.locator('#curriculo').setInputFiles({
      name: 'curriculo.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n'),
    });
    await visitor.getByLabel(/Li o aviso de privacidade/).check();
    await visitor.getByRole('button', { name: 'Enviar' }).click();
    await expect(visitor.getByText(/Recebid|Obrigad/i).first()).toBeVisible();
    await visitor.close();

    await page.goto('/candidatos');
    await page.getByLabel(/Buscar/).first().fill('Pessoa Fictícia do Portal');
    await page.getByRole('link', { name: 'Pessoa Fictícia do Portal' }).first().click();
    await expect(page.getByText(/aceita WhatsApp desde/)).toBeVisible();
  });

  test('Meus dados: candidato corrige os dados e liga o WhatsApp @mobile', async ({ page }) => {
    const url = ownerUrl();
    test.skip(!url, 'sem acesso ao banco de desenvolvimento');
    const c = creds();
    const email = `candidato1.${c.suffix}@exemplo.invalid`;
    const token = randomBytes(32).toString('base64url');
    const db = new pg.Client({ connectionString: url! });
    await db.connect();
    await db.query(
      `insert into candidate_access_tokens (token_hash, email, purpose, expires_at) values ($1, $2, 'acesso', now() + interval '1 hour')`,
      [createHash('sha256').update(token).digest(), email],
    );
    await db.end();

    await page.goto(`/meus-dados#token=${token}`);
    await expect(page.getByRole('heading', { name: 'Dados pessoais' })).toBeVisible();
    await page.getByLabel('Cidade').fill('Campinas');
    await page.getByRole('button', { name: 'Salvar' }).click();
    await expect(page.getByText('Dados atualizados.')).toBeVisible();
    await page.getByLabel(/Receber avisos pelo WhatsApp/).check();
    await expect(page.getByText(/receberá avisos pelo WhatsApp/)).toBeVisible();
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(scroll).toBeLessThanOrEqual(0);
  });

  test('privacidade: regra de retenção começa desligada e só o administrador acessa', async ({ page }) => {
    const c = creds();
    await login(page, c.admin);
    await page.getByRole('link', { name: 'Privacidade (LGPD)' }).click();
    await expect(page.getByLabel('Ativar exclusão automática')).not.toBeChecked();
    await page.getByRole('button', { name: 'Sair' }).click();
    await login(page, c.staff);
    await expect(page.getByRole('link', { name: 'Privacidade (LGPD)' })).toHaveCount(0);
    await page.goto('/privacidade');
    await expect(page.getByText(/não encontrad|indisponível/i).first()).toBeVisible();
  });
});
