import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { currentStep, totpAt, verifyTotp, base32Decode, base32Encode } from '../src/lib/totp.js';
import { Agent, PASSWORD, bootstrapAdmin, inviteUser, json, setupApp, type TestCtx } from './helpers.js';

let ctx: TestCtx;
let admin: Agent;
let adminId: string;

beforeAll(async () => {
  ctx = await setupApp();
  const a = await bootstrapAdmin(ctx);
  admin = a.agent;
  adminId = a.id;
});
afterAll(async () => {
  await ctx.close();
});

/** Usuário com verificação ativa; devolve o segredo e os códigos de recuperação. */
async function withMfa() {
  const u = await inviteUser(ctx, admin, 'alpha_staff');
  const s = await u.agent.post('/api/auth/mfa/setup', { password: PASSWORD });
  expect(s.statusCode).toBe(200);
  const { secret, otpauthUrl } = json(s);
  expect(otpauthUrl).toContain(`secret=${secret}`);
  // Código errado não ativa.
  expect((await u.agent.post('/api/auth/mfa/confirm', { code: '000000' === totpAt(secret, currentStep()) ? '111111' : '000000' })).statusCode).toBe(422);
  const c = await u.agent.post('/api/auth/mfa/confirm', { code: totpAt(secret, currentStep()) });
  expect(c.statusCode).toBe(200);
  const { recoveryCodes } = json(c);
  expect(recoveryCodes).toHaveLength(10);
  return { ...u, secret, recoveryCodes: recoveryCodes as string[] };
}

/** Desloca o último passo usado para permitir um novo código no mesmo intervalo de 30 s. */
const allowReuseWindow = (userId: string) =>
  ctx.owner.query('update user_mfa set last_step = last_step - 5 where user_id = $1', [userId]);

describe('TOTP', () => {
  it('confere o vetor da RFC 6238 (SHA-1) e base32', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
    // RFC 6238, T = 59 s → 94287082 (8 dígitos); os 6 últimos: 287082
    expect(totpAt(secret, 1)).toBe('287082');
    expect(totpAt(secret, Math.floor(1111111109 / 30))).toBe('081804');
    expect(verifyTotp(secret, '287082', null, 59_000)).toBe(1);
    expect(verifyTotp(secret, '287082', 1, 59_000)).toBeNull(); // reutilização recusada
    expect(verifyTotp(secret, 'abcdef', null, 59_000)).toBeNull();
  });
});

describe('verificação em duas etapas', () => {
  it('login exige o código; sessão só nasce depois dele; código não pode ser reutilizado', async () => {
    const u = await withMfa();
    const a = new Agent(ctx);
    const r = await a.post('/api/auth/login', { email: u.email, password: PASSWORD });
    expect(r.statusCode).toBe(200);
    expect(json(r)).toEqual({ mfaRequired: true, mfaToken: expect.any(String) });
    expect(a.cookie).toBeNull();
    expect((await a.get('/api/auth/me')).statusCode).toBe(401);

    const { mfaToken } = json(r);
    expect((await a.post('/api/auth/login/mfa', { mfaToken, code: '12345' })).statusCode).toBe(422);
    await allowReuseWindow(u.id);
    const ok = await a.post('/api/auth/login/mfa', { mfaToken, code: totpAt(u.secret, currentStep()) });
    expect(ok.statusCode).toBe(200);
    a.csrf = json(ok).csrfToken;
    expect(json(await a.get('/api/auth/me')).user.email).toBe(u.email);
    // Desafio é de uso único.
    expect((await new Agent(ctx).post('/api/auth/login/mfa', { mfaToken, code: totpAt(u.secret, currentStep()) })).statusCode).toBe(401);

    // Mesmo código numa nova tentativa: recusado (já usado neste intervalo).
    const b = new Agent(ctx);
    const r2 = json(await b.post('/api/auth/login', { email: u.email, password: PASSWORD }));
    expect((await b.post('/api/auth/login/mfa', { mfaToken: r2.mfaToken, code: totpAt(u.secret, currentStep()) })).statusCode).toBe(422);
  });

  it('ativar encerra as outras sessões abertas', async () => {
    const u = await inviteUser(ctx, admin, 'alpha_staff');
    const other = new Agent(ctx);
    await other.login(u.email, PASSWORD);
    const { secret } = json(await u.agent.post('/api/auth/mfa/setup', { password: PASSWORD }));
    await u.agent.post('/api/auth/mfa/confirm', { code: totpAt(secret, currentStep()) });
    expect((await other.get('/api/auth/me')).statusCode).toBe(401);
    expect((await u.agent.get('/api/auth/me')).statusCode).toBe(200);
    expect(json(await u.agent.get('/api/auth/mfa'))).toMatchObject({ enabled: true, recoveryCodesLeft: 10 });
  });

  it('código de recuperação funciona uma única vez', async () => {
    const u = await withMfa();
    const code = u.recoveryCodes[0]!;
    const a = new Agent(ctx);
    const r = json(await a.post('/api/auth/login', { email: u.email, password: PASSWORD }));
    const rr = await a.post('/api/auth/login/mfa', { mfaToken: r.mfaToken, code: code.toLowerCase() }); if (rr.statusCode !== 200) throw new Error(rr.body);
    const b = new Agent(ctx);
    const r2 = json(await b.post('/api/auth/login', { email: u.email, password: PASSWORD }));
    expect((await b.post('/api/auth/login/mfa', { mfaToken: r2.mfaToken, code })).statusCode).toBe(422);
    expect(json(await u.agent.get('/api/auth/mfa')).recoveryCodesLeft).toBe(9);
  });

  it('5 códigos errados invalidam o desafio', async () => {
    const u = await withMfa();
    const a = new Agent(ctx);
    const { mfaToken } = json(await a.post('/api/auth/login', { email: u.email, password: PASSWORD }));
    for (let i = 0; i < 4; i++) expect((await a.post('/api/auth/login/mfa', { mfaToken, code: 'AAAA-AAAA' })).statusCode).toBe(422);
    expect((await a.post('/api/auth/login/mfa', { mfaToken, code: 'AAAA-AAAA' })).statusCode).toBe(401);
    await allowReuseWindow(u.id);
    expect((await a.post('/api/auth/login/mfa', { mfaToken, code: totpAt(u.secret, currentStep()) })).statusCode).toBe(401);
  });

  it('desligar exige senha e código; administrador pode desligar de outro usuário', async () => {
    const u = await withMfa();
    expect((await u.agent.post('/api/auth/mfa/disable', { password: 'errada-123456', code: u.recoveryCodes[0] })).statusCode).toBe(422);
    expect((await u.agent.post('/api/auth/mfa/disable', { password: PASSWORD, code: 'AAAA-AAAA' })).statusCode).toBe(422);
    expect((await u.agent.post('/api/auth/mfa/disable', { password: PASSWORD, code: u.recoveryCodes[1] })).statusCode).toBe(200);
    expect(json(await u.agent.get('/api/auth/mfa')).enabled).toBe(false);

    const v = await withMfa();
    const list = json(await admin.get('/api/users?pageSize=100'));
    expect(list.items.find((x: any) => x.id === v.id).mfaEnabled).toBe(true);
    expect((await v.agent.post(`/api/users/${u.id}/mfa-reset`)).statusCode).toBe(403);
    expect((await admin.post(`/api/users/${adminId}/mfa-reset`)).statusCode).toBe(409);
    expect((await admin.post(`/api/users/${v.id}/mfa-reset`)).statusCode).toBe(200);
    const a = new Agent(ctx);
    await a.login(v.email, PASSWORD); // login volta a ser só com senha
    const audit = await ctx.owner.query("select 1 from audit_events where action = 'user.mfa_reset' and entity_id = $1", [v.id]);
    expect(audit.rowCount).toBe(1);
  });

  it('segredo não fica acessível ao papel da aplicação', async () => {
    const u = await withMfa();
    const { withUser } = await import('../src/lib/db.js');
    await expect(withUser(ctx.deps.pools.app, adminId, (db) => db.query('select secret from user_mfa'))).rejects.toThrow();
    expect(u.secret).toMatch(/^[A-Z2-7]{32}$/);
  });
});
