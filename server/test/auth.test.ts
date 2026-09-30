import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Agent,
  PASSWORD,
  bootstrapAdmin,
  createCompany,
  inviteUser,
  json,
  setupApp,
  tokenFromMail,
  uniq,
  type TestCtx,
} from './helpers.js';

let ctx: TestCtx;
let admin: Agent;

beforeAll(async () => {
  ctx = await setupApp();
  admin = (await bootstrapAdmin(ctx)).agent;
});
afterAll(async () => {
  await ctx.close();
});

describe('login e sessão', () => {
  it('rejeita credenciais inválidas com mensagem genérica, igual para e-mail inexistente', async () => {
    const staff = await inviteUser(ctx, admin, 'alpha_staff');
    const a = new Agent(ctx);
    const wrong = await a.post('/api/auth/login', { email: staff.email, password: 'senha-errada-000' });
    const unknown = await a.post('/api/auth/login', { email: 'ninguem@example.test', password: 'senha-errada-000' });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(json(wrong).error.message).toBe(json(unknown).error.message);
  });

  it('login, /me e logout; após logout a sessão não vale mais', async () => {
    const staff = await inviteUser(ctx, admin, 'alpha_staff');
    const me = await staff.agent.get('/api/auth/me');
    expect(me.statusCode).toBe(200);
    expect(json(me).user.kind).toBe('alpha_staff');
    const oldCookie = staff.agent.cookie;
    expect((await staff.agent.post('/api/auth/logout')).statusCode).toBe(200);
    const replay = new Agent(ctx);
    replay.cookie = oldCookie;
    expect((await replay.get('/api/auth/me')).statusCode).toBe(401);
  });

  it('exige token CSRF em operações de escrita', async () => {
    const a = new Agent(ctx);
    a.cookie = admin.cookie;
    const r = await a.request('POST', '/api/companies', { name: uniq('Sem CSRF') });
    expect(r.statusCode).toBe(403);
    const r2 = await a.request('POST', '/api/companies', { name: uniq('CSRF errado') }, { 'x-csrf-token': 'x'.repeat(43) });
    expect(r2.statusCode).toBe(403);
  });

  it('recusa origem não autorizada', async () => {
    const r = await admin.request('GET', '/api/auth/me', undefined, { origin: 'https://site-malicioso.example' });
    expect(r.statusCode).toBe(403);
  });

  it('sessão ociosa expira', async () => {
    const staff = await inviteUser(ctx, admin, 'alpha_staff');
    await ctx.owner.query("update sessions set last_seen_at = now() - interval '1 day' where user_id = $1", [staff.id]);
    const r = await staff.agent.get('/api/auth/me');
    expect(r.statusCode).toBe(401);
  });

  it('limita tentativas de login (429) e bloqueia a conta temporariamente', async () => {
    const staff = await inviteUser(ctx, admin, 'alpha_staff');
    const a = new Agent(ctx);
    const codes: number[] = [];
    for (let i = 0; i < 10; i++) {
      codes.push((await a.post('/api/auth/login', { email: staff.email, password: 'errada-errada' })).statusCode);
    }
    expect(codes).toContain(429);
    // Mesmo com a senha correta, a conta segue bloqueada por alguns minutos.
    const b = new Agent(ctx);
    expect((await b.post('/api/auth/login', { email: staff.email, password: PASSWORD })).statusCode).toBe(429);
  });
});

describe('cadastro somente por convite', () => {
  it('não há cadastro público: criar usuário exige administrador autenticado', async () => {
    const anon = new Agent(ctx);
    expect((await anon.post('/api/users', { email: 'x@example.test', fullName: 'X', kind: 'alpha_admin' })).statusCode).toBe(401);
    const staff = await inviteUser(ctx, admin, 'alpha_staff');
    const r = await staff.agent.post('/api/users', { email: `${uniq('x')}@example.test`, fullName: 'X Y', kind: 'alpha_admin' });
    expect(r.statusCode).toBe(403);
  });

  it('convite é de uso único', async () => {
    const email = `${uniq('conv')}@example.test`;
    await admin.post('/api/users', { email, fullName: 'Convidado', kind: 'alpha_staff' });
    const token = tokenFromMail(ctx.mailer, email);
    const a = new Agent(ctx);
    expect((await a.post('/api/auth/invite/inspect', { token })).statusCode).toBe(200);
    expect((await a.post('/api/auth/invite/accept', { token, password: PASSWORD })).statusCode).toBe(200);
    const again = await a.post('/api/auth/invite/accept', { token, password: 'Outra-senha-456' });
    expect(again.statusCode).toBe(400);
    await a.login(email, PASSWORD);
  });

  it('convite expirado é recusado', async () => {
    const email = `${uniq('exp')}@example.test`;
    const r = await admin.post('/api/users', { email, fullName: 'Expirado', kind: 'alpha_staff' });
    const token = tokenFromMail(ctx.mailer, email);
    await ctx.owner.query("update invites set expires_at = now() - interval '1 minute' where user_id = $1", [r.json().id]);
    const res = await new Agent(ctx).post('/api/auth/invite/accept', { token, password: PASSWORD });
    expect(res.statusCode).toBe(400);
  });

  it('reenvio de convite invalida o convite anterior', async () => {
    const email = `${uniq('reenvio')}@example.test`;
    const r = await admin.post('/api/users', { email, fullName: 'Reenvio', kind: 'alpha_staff' });
    const first = tokenFromMail(ctx.mailer, email);
    expect((await admin.post(`/api/users/${r.json().id}/invite`)).statusCode).toBe(200);
    const second = tokenFromMail(ctx.mailer, email);
    expect(second).not.toBe(first);
    expect((await new Agent(ctx).post('/api/auth/invite/accept', { token: first, password: PASSWORD })).statusCode).toBe(400);
    expect((await new Agent(ctx).post('/api/auth/invite/accept', { token: second, password: PASSWORD })).statusCode).toBe(200);
  });

  it('perfil do convite é definido pelo servidor (campos extras são recusados)', async () => {
    const email = `${uniq('extra')}@example.test`;
    await admin.post('/api/users', { email, fullName: 'Extra', kind: 'alpha_staff' });
    const token = tokenFromMail(ctx.mailer, email);
    const r = await new Agent(ctx).post('/api/auth/invite/accept', { token, password: PASSWORD, kind: 'alpha_admin' });
    expect(r.statusCode).toBe(422);
  });
});

describe('recuperação de senha', () => {
  it('resposta idêntica para e-mail existente e inexistente; fluxo completo revoga sessões', async () => {
    const staff = await inviteUser(ctx, admin, 'alpha_staff');
    const anon = new Agent(ctx);
    const r1 = await anon.post('/api/auth/password-reset/request', { email: staff.email });
    const r2 = await anon.post('/api/auth/password-reset/request', { email: 'nao-existe@example.test' });
    expect(r1.statusCode).toBe(200);
    expect(r1.body).toBe(r2.body);

    const token = tokenFromMail(ctx.mailer, staff.email);
    const nova = 'Nova-senha-segura-789';
    expect((await anon.post('/api/auth/password-reset/confirm', { token, password: nova })).statusCode).toBe(200);
    // Link não pode ser reutilizado.
    expect((await anon.post('/api/auth/password-reset/confirm', { token, password: nova })).statusCode).toBe(400);
    // Sessão anterior revogada.
    expect((await staff.agent.get('/api/auth/me')).statusCode).toBe(401);
    // Senha antiga não funciona; nova funciona.
    expect((await new Agent(ctx).post('/api/auth/login', { email: staff.email, password: PASSWORD })).statusCode).toBe(401);
    await new Agent(ctx).login(staff.email, nova);
  });

  it('troca de senha exige a senha atual', async () => {
    const staff = await inviteUser(ctx, admin, 'alpha_staff');
    const bad = await staff.agent.post('/api/auth/password/change', {
      currentPassword: 'incorreta-123',
      newPassword: 'Nova-senha-segura-000',
    });
    expect(bad.statusCode).toBe(422);
    const ok = await staff.agent.post('/api/auth/password/change', {
      currentPassword: PASSWORD,
      newPassword: 'Nova-senha-segura-000',
    });
    expect(ok.statusCode).toBe(200);
  });
});

describe('desativação e revogação de acesso', () => {
  it('usuário desativado perde acesso mesmo com sessão aberta e não consegue entrar', async () => {
    const staff = await inviteUser(ctx, admin, 'alpha_staff');
    const cookie = staff.agent.cookie;
    expect((await admin.patch(`/api/users/${staff.id}`, { isActive: false })).statusCode).toBe(200);
    const replay = new Agent(ctx);
    replay.cookie = cookie;
    expect((await replay.get('/api/dashboard')).statusCode).toBe(401);
    const login = await new Agent(ctx).post('/api/auth/login', { email: staff.email, password: PASSWORD });
    expect(login.statusCode).toBe(403);
  });

  it('desativar a empresa revoga o acesso dos seus usuários', async () => {
    const companyId = await createCompany(admin);
    const client = await inviteUser(ctx, admin, 'client_user', companyId);
    expect((await client.agent.get('/api/dashboard')).statusCode).toBe(200);
    await admin.patch(`/api/companies/${companyId}`, { isActive: false });
    expect((await client.agent.get('/api/dashboard')).statusCode).toBe(401);
  });

  it('mesmo sem a checagem de sessão, a RLS nega acesso a usuário desativado', async () => {
    const staff = await inviteUser(ctx, admin, 'alpha_staff');
    await admin.patch(`/api/users/${staff.id}`, { isActive: false });
    const c = await ctx.deps.pools.app.connect();
    try {
      await c.query('begin');
      await c.query("select set_config('app.user_id', $1, true)", [staff.id]);
      const r = await c.query('select count(*)::int as n from users');
      expect(r.rows[0].n).toBe(0);
      await c.query('rollback');
    } finally {
      c.release();
    }
  });

  it('não permite desativar o último administrador nem a si mesmo', async () => {
    const me = json(await admin.get('/api/auth/me')).user;
    const r = await admin.patch(`/api/users/${me.id}`, { isActive: false });
    expect(r.statusCode).toBe(403);
  });
});
