import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** Servidor que imita a API REST do Supabase Storage (apenas o que o driver usa). */
export async function startFakeSupabase(key: string) {
  const objects = new Map<string, Buffer>();
  const srv = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${key}` || req.headers.apikey !== key) {
      res.writeHead(401);
      return res.end();
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const p = new URL(req.url!, 'http://x').pathname;
    let m: RegExpMatchArray | null;
    if (req.method === 'POST' && (m = p.match(/^\/storage\/v1\/object\/list\/[^/]+$/))) {
      const { prefix } = JSON.parse(body.toString()) as { prefix: string };
      const dirs = new Set<string>();
      const out: { name: string; id: string | null }[] = [];
      for (const k of objects.keys()) {
        if (!k.startsWith(prefix)) continue;
        const [first, ...rest] = k.slice(prefix.length).split('/');
        if (rest.length) {
          if (!dirs.has(first!)) dirs.add(first!), out.push({ name: first!, id: null });
        } else out.push({ name: first!, id: 'obj' });
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(out));
    }
    if (req.method === 'POST' && (m = p.match(/^\/storage\/v1\/object\/[^/]+\/(.+)$/))) {
      objects.set(m[1]!, body);
      res.writeHead(200);
      return res.end('{}');
    }
    if (req.method === 'GET' && (m = p.match(/^\/storage\/v1\/object\/authenticated\/[^/]+\/(.+)$/))) {
      const b = objects.get(m[1]!);
      res.writeHead(b ? 200 : 400);
      return res.end(b ?? '{"error":"not_found"}');
    }
    if (req.method === 'DELETE' && p.match(/^\/storage\/v1\/object\/[^/]+$/)) {
      for (const k of (JSON.parse(body.toString()) as { prefixes: string[] }).prefixes) objects.delete(k);
      res.writeHead(200);
      return res.end('[]');
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return { url, objects, close: () => new Promise<void>((r) => srv.close(() => r())) };
}
