import { expect, test } from '@playwright/test';
import { creds, login } from './fixtures';

test.describe('fluxos principais no navegador', () => {
  test('login inválido mostra mensagem genérica; sem cadastro público', async ({ page }) => {
    await page.goto('/entrar');
    await page.getByLabel('E-mail').fill('ninguem@exemplo.invalid');
    await page.getByLabel('Senha').fill('senha-errada-123');
    await page.getByRole('button', { name: 'Entrar' }).click();
    await expect(page.getByRole('alert')).toHaveText('E-mail ou senha inválidos.');
    await expect(page.getByRole('link', { name: /cadastr/i })).toHaveCount(0);
    await expect(page.getByText('Tecnologia desenvolvida pela PMG Code')).toBeVisible();
    await expect(page).toHaveTitle('Entrar · Alpha Select');
  });

  test('administrador: painel com dados reais, processo, quadro e movimentação acessível', async ({ page }) => {
    const c = creds();
    await login(page, c.admin);
    await expect(page.getByText('Processos em andamento')).toBeVisible();
    await page.getByRole('link', { name: 'Processos seletivos' }).click();
    await page.getByLabel('Buscar por título').fill(`Analista Administrativo`);
    await page.getByRole('link', { name: 'Analista Administrativo (demo)' }).first().click();
    await expect(page.getByRole('heading', { name: '1. RH Externo' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '4. Aprovação' })).toBeVisible();

    // Movimentação por botão (alternativa ao arrastar e soltar)
    const card = page.locator('.column').first().locator('.kcard').first();
    const name = (await card.locator('.kcard-title').innerText()).trim();
    await card.getByRole('button', { name: /Avançar/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Mover candidato de etapa' });
    await expect(dialog.getByLabel('Nova etapa')).toHaveValue('2');
    await dialog.getByRole('button', { name: 'Confirmar movimentação' }).click();
    await expect(page.getByText('Etapa atualizada e registrada no histórico.')).toBeVisible();
    await expect(page.locator('.column').nth(1).getByRole('link', { name })).toBeVisible();

    // Histórico
    await page.locator('.column').nth(1).getByRole('link', { name }).click();
    await page.getByRole('tab', { name: 'Histórico' }).click();
    await expect(page.getByText(/Etapa: RH Externo → RH Interno/).first()).toBeVisible();
    await expect(page).toHaveTitle('Participação · Alpha Select'); // sem dado pessoal no título
  });

  test('cliente A não vê processo da empresa B, nem comentários internos', async ({ page }) => {
    const c = creds();
    // Descobre o ID do processo B com o admin (via API autenticada em outro contexto)
    const adminCtx = await page.context().browser()!.newContext({ baseURL: 'http://localhost:3000' });
    const ap = await adminCtx.newPage();
    await login(ap, c.admin);
    const list = await ap.evaluate(async () => (await fetch('/api/processes?q=Assistente%20Comercial&pageSize=50')).json());
    const beta = list.items.find((p: { companyName: string }) => p.companyName.endsWith(`Beta ${c.suffix}`)).id;
    await adminCtx.close();

    await login(page, c.rhAlfa);
    await page.getByRole('link', { name: 'Processos seletivos' }).click();
    await expect(page.getByRole('link', { name: 'Assistente Comercial (demo)' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Candidatos' })).toHaveCount(0);

    await page.goto(`/processos/${beta}`);
    await expect(page.getByRole('heading', { name: 'Conteúdo indisponível' })).toBeVisible();
    const api = await page.evaluate(async (id) => (await fetch(`/api/processes/${id}/board`)).status, beta);
    expect(api).toBe(404);
    await page.goto('/candidatos');
    await expect(page.getByRole('heading', { name: 'Página não encontrada' })).toBeVisible();

    // Comentários da participação: apenas os compartilhados
    await page.getByRole('link', { name: 'Processos seletivos' }).click();
    await page.getByRole('link', { name: 'Analista Administrativo (demo)' }).first().click();
    await page.locator('.kcard-title').first().click();
    await page.getByRole('tab', { name: 'Comentários' }).click();
    await expect(page.getByText('Comentário compartilhado fictício.')).toBeVisible();
    await expect(page.getByText('Comentário interno fictício.')).toHaveCount(0);
    await expect(page.getByRole('radio', { name: /Interno/ })).toHaveCount(0);
  });

  test('cadastro de candidato persiste após recarregar; comentário interno por padrão', async ({ page }) => {
    const c = creds();
    await login(page, c.staff);
    await page.getByRole('link', { name: 'Cadastrar candidato' }).first().click();
    const nome = `Candidata E2E ${Date.now()}`;
    await page.getByLabel('Nome completo').fill(nome);
    await page.getByLabel('E-mail').fill(`e2e.${Date.now()}@exemplo.invalid`);
    const tel = `(11) 9${String(Date.now()).slice(-8, -4)}-${String(Date.now()).slice(-4)}`;
    await page.getByLabel('Telefone').fill(tel);
    await page.getByLabel('Pretensão salarial (R$)').fill('4.500,00');
    await page.getByRole('button', { name: 'Cadastrar', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: nome })).toBeVisible();
    await page.reload();
    await page.getByRole('tab', { name: 'Dados' }).click();
    await expect(page.getByText(tel)).toBeVisible();
    await expect(page.getByText('R$ 4.500,00')).toBeVisible();

    // Upload real
    await page.getByRole('tab', { name: /Documentos/ }).click();
    await page.getByLabel('Arquivo').setInputFiles({
      name: 'curriculo-e2e.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'),
    });
    await page.getByRole('button', { name: 'Enviar' }).click();
    await expect(page.getByRole('cell', { name: 'curriculo-e2e.pdf' })).toBeVisible();
    // Upload inválido
    await page.getByLabel('Arquivo').setInputFiles({ name: 'x.html', mimeType: 'text/html', buffer: Buffer.from('<b>x</b>') });
    await page.getByRole('button', { name: 'Enviar' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Formato não permitido' })).toBeVisible();

    // Incluir em processo e comentar (padrão interno)
    await page.getByRole('tab', { name: /Processos/ }).click();
    await page.getByRole('button', { name: 'Incluir em processo' }).click();
    await page.getByLabel('Processo em andamento').selectOption({ index: 1 });
    await page.getByRole('button', { name: 'Incluir', exact: true }).click();
    await page.getByRole('tab', { name: 'Comentários' }).click();
    await expect(page.getByRole('radio', { name: /Interno da Alpha Select/ })).toBeChecked();
    await page.getByLabel('Novo comentário').fill('<script>alert(1)</script> texto');
    await page.getByRole('button', { name: 'Publicar comentário interno' }).click();
    await expect(page.getByText('<script>alert(1)</script> texto')).toBeVisible();
  });

  test('cadastro com telefone já existente mostra aviso de duplicidade sem bloquear', async ({ page }) => {
    const c = creds();
    await login(page, c.staff);
    await page.goto('/candidatos/novo');
    await page.getByLabel('Nome completo').fill('Outra Pessoa E2E');
    await page.getByLabel('Telefone').fill(`+55119000000${'00'}`);
    await page.getByRole('button', { name: 'Cadastrar', exact: true }).click();
    await expect(page.getByText('Possível duplicidade.')).toBeVisible();
    await page.getByRole('button', { name: 'Cadastrar mesmo assim (pessoa diferente)' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Outra Pessoa E2E' })).toBeVisible();
  });

  test('sessão expirada leva ao login com aviso', async ({ page, context }) => {
    const c = creds();
    await login(page, c.staff);
    await context.clearCookies();
    await page.getByRole('link', { name: 'Processos seletivos' }).click();
    await expect(page.getByText('Sua sessão expirou. Entre novamente para continuar.')).toBeVisible();
  });

  test('navegação por teclado: link de pular conteúdo, login e abas', async ({ page }) => {
    const c = creds();
    await page.goto('/entrar');
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('E-mail')).toBeFocused();
    await page.keyboard.type(c.admin.email);
    await page.keyboard.press('Tab');
    await page.keyboard.type(c.admin.senha);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Olá');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Pular para o conteúdo' })).toBeFocused();
    await page.goto('/processos');
    await page.getByRole('link', { name: 'Analista Administrativo (demo)' }).first().click();
    const tab = page.getByRole('tab', { name: 'Quadro' });
    await tab.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Participantes autorizados' })).toBeFocused();
    await expect(page.getByRole('tab', { name: 'Participantes autorizados' })).toHaveAttribute('aria-selected', 'true');
  });
});

test.describe('responsividade @mobile', () => {
  test('layout sem rolagem horizontal e menu acessível no celular @mobile', async ({ page }) => {
    const c = creds();
    await login(page, c.rhAlfa);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await page.getByRole('button', { name: 'Abrir menu' }).click();
    await page.getByRole('link', { name: 'Processos seletivos' }).click();
    await page.getByRole('link', { name: 'Analista Administrativo (demo)' }).first().click();
    await expect(page.getByRole('heading', { name: '1. RH Externo' })).toBeVisible();
    const overflow2 = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow2).toBeLessThanOrEqual(1);
    await page.screenshot({ path: 'test-results/mobile-quadro.png', fullPage: true });
  });
});
