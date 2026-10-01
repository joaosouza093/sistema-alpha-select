import { describe, expect, it } from 'vitest';
import { candidateUrls, parseDbUrl, resolveDbUrl, type Probe } from '../src/lib/db-resolve.js';
import { validCa } from '../src/lib/db.js';

const SUPA = 'https://nobrlidvvbbkgjqztesd.supabase.co';
const opts = { supabaseUrl: SUPA, region: 'sa-east-1', caProvided: true };
const err = (code: string, message = code) => Object.assign(new Error(message), { code });

describe('descoberta automática do endereço do banco (Supabase)', () => {
  it('marcador >>> <<< não substituído: usa os poolers com usuário e senha informados', () => {
    const urls = candidateUrls('postgres://alpha_app.nobrlidvvbbkgjqztesd:S3nh4@>>>HOST_DO_POOLER<<<:6543/postgres', SUPA, 'sa-east-1');
    expect(urls).toEqual([
      'postgres://alpha_app.nobrlidvvbbkgjqztesd:S3nh4@aws-0-sa-east-1.pooler.supabase.com:6543/postgres',
      'postgres://alpha_app.nobrlidvvbbkgjqztesd:S3nh4@aws-1-sa-east-1.pooler.supabase.com:6543/postgres',
    ]);
  });

  it('usuário sem o sufixo do projeto recebe o sufixo nos poolers', () => {
    const urls = candidateUrls('postgres://alpha_owner:x@db.nobrlidvvbbkgjqztesd.supabase.co:5432/postgres', SUPA, 'sa-east-1');
    expect(urls[0]).toContain('@db.nobrlidvvbbkgjqztesd.supabase.co');
    expect(urls[1]).toMatch(/^postgres:\/\/alpha_owner\.nobrlidvvbbkgjqztesd:x@aws-0-sa-east-1/);
  });

  it('host só IPv6 (db.<ref>) falha; pooler errado dá "tenant not found"; o seguinte conecta', async () => {
    const tried: string[] = [];
    const probe: Probe = async (url) => {
      tried.push(new URL(url).host);
      if (url.includes('@db.')) throw err('ENETUNREACH');
      if (url.includes('aws-0')) throw err('XX000', 'Tenant or user not found');
    };
    const r = await resolveDbUrl('postgres://alpha_app.nobrlidvvbbkgjqztesd:pw@db.nobrlidvvbbkgjqztesd.supabase.co:6543/postgres', { rejectUnauthorized: true }, { ...opts, probe });
    expect(tried).toEqual(['db.nobrlidvvbbkgjqztesd.supabase.co:6543', 'aws-0-sa-east-1.pooler.supabase.com:6543', 'aws-1-sa-east-1.pooler.supabase.com:6543']);
    expect(r).toMatchObject({ auto: true, tlsUnverified: false });
    expect(r.url).toContain('aws-1-sa-east-1');
  });

  it('senha recusada interrompe a busca', async () => {
    const tried: string[] = [];
    const probe: Probe = async (url) => {
      tried.push(url);
      throw err('28P01', 'password authentication failed');
    };
    await expect(resolveDbUrl('postgres://a:b@aws-0-sa-east-1.pooler.supabase.com:6543/postgres', undefined, { ...opts, probe })).rejects.toMatchObject({ code: '28P01' });
    expect(tried).toHaveLength(1);
  });

  it('sem certificado válido: conecta criptografado sem verificação e sinaliza', async () => {
    const probe: Probe = async (_url, ssl) => {
      if (ssl && typeof ssl === 'object' && ssl.rejectUnauthorized) throw err('SELF_SIGNED_CERT_IN_CHAIN', 'self-signed certificate in certificate chain');
    };
    const r = await resolveDbUrl('postgres://a.nobrlidvvbbkgjqztesd:b@aws-0-sa-east-1.pooler.supabase.com:6543/postgres', { rejectUnauthorized: true }, { ...opts, caProvided: false, probe });
    expect(r).toMatchObject({ auto: false, tlsUnverified: true, ssl: { rejectUnauthorized: false } });
  });

  it('com certificado válido informado, NÃO desliga a verificação', async () => {
    const probe: Probe = async () => {
      throw err('SELF_SIGNED_CERT_IN_CHAIN', 'self-signed certificate in certificate chain');
    };
    await expect(resolveDbUrl('postgres://a:b@h.example:6543/postgres', { rejectUnauthorized: true }, { ...opts, probe })).rejects.toThrow(/certificate/);
  });

  it('endereço configurado funcionando é mantido', async () => {
    const r = await resolveDbUrl('postgres://a:b@h.example:6543/postgres', undefined, { ...opts, probe: async () => undefined });
    expect(r).toMatchObject({ url: 'postgres://a:b@h.example:6543/postgres', auto: false });
  });

  it('leitura tolerante e validação do certificado', () => {
    expect(parseDbUrl('postgres://u.r:p%40ss@>>>X<<<:6543/postgres')).toMatchObject({ user: 'u.r', password: 'p@ss', port: '6543' });
    expect(validCa('>>>COLE_AQUI<<<')).toBeUndefined();
    expect(validCa('-----BEGIN CERTIFICATE-----\\nMIIB\\n-----END CERTIFICATE-----')).toContain('\nMIIB\n');
  });
});
