import http from 'node:http';
import type { AddressInfo } from 'node:net';

interface Payment {
  id: string; customer: string; value: number; dueDate: string; description: string; externalReference: string;
  status: string; billingType: string; invoiceUrl: string; paymentDate?: string; deleted?: boolean;
}

/** Servidor que imita a API v3 do Asaas (somente o que a integração usa). */
export async function startFakeAsaas(key: string) {
  const customers = new Map<string, { id: string; cpfCnpj: string; notificationDisabled?: boolean }>();
  const payments = new Map<string, Payment>();
  const calls: { method: string; path: string; body: any }[] = [];
  let seq = 0;
  let failNext = 0;
  const srv = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? JSON.parse(raw) : undefined;
    const url = new URL(req.url!, 'http://x');
    const p = url.pathname.replace(/^\/v3/, '');
    calls.push({ method: req.method!, path: p + url.search, body });
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (req.headers.access_token !== key) return send(401, { errors: [{ description: 'token inválido' }] });
    if (failNext > 0) {
      failNext--;
      return send(500, { errors: [{ description: 'instabilidade' }] });
    }
    let m: RegExpMatchArray | null;
    if (req.method === 'GET' && p === '/customers') {
      const doc = url.searchParams.get('cpfCnpj');
      return send(200, { data: [...customers.values()].filter((c) => c.cpfCnpj === doc) });
    }
    if (req.method === 'POST' && p === '/customers') {
      const c = { id: `cus_${++seq}`, ...body };
      customers.set(c.id, c);
      return send(200, c);
    }
    if (req.method === 'POST' && p === '/payments') {
      if (!customers.has(body.customer)) return send(400, { errors: [{ description: 'cliente inexistente' }] });
      const id = `pay_${++seq}`;
      const pay: Payment = { ...body, id, status: 'PENDING', invoiceUrl: `https://sandbox.asaas.com/i/${id}` };
      payments.set(id, pay);
      return send(200, pay);
    }
    if ((m = p.match(/^\/payments\/([\w]+)$/))) {
      const pay = payments.get(m[1]!);
      if (!pay) return send(404, { errors: [{ description: 'não encontrada' }] });
      if (req.method === 'GET') return send(200, pay);
      if (req.method === 'POST') return send(200, Object.assign(pay, body));
      if (req.method === 'DELETE') {
        pay.deleted = true;
        pay.status = 'DELETED';
        return send(200, { deleted: true, id: pay.id });
      }
    }
    if (req.method === 'POST' && (m = p.match(/^\/payments\/([\w]+)\/receiveInCash$/))) {
      const pay = payments.get(m[1]!);
      if (!pay) return send(404, {});
      pay.status = 'RECEIVED_IN_CASH';
      pay.paymentDate = body.paymentDate;
      return send(200, pay);
    }
    send(404, { errors: [{ description: 'rota inexistente' }] });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v3`;
  return {
    url, customers, payments, calls,
    failNext: (n: number) => (failNext = n),
    close: () => new Promise<void>((r) => srv.close(() => r())),
  };
}
