import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** Servidor que imita o envio de modelos da WhatsApp Cloud API. */
export async function startFakeWhatsApp(token: string) {
  const sent: { to: string; template: string; language: string; params: string[]; id: string }[] = [];
  let seq = 0;
  let failNext = 0;
  const srv = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: { message: 'Invalid OAuth access token', code: 190 } });
    if (req.method !== 'POST' || !/^\/v\d+\.\d+\/\d+\/messages$/.test(req.url!)) return send(404, { error: { message: 'unknown' } });
    if (failNext > 0) {
      failNext--;
      return send(400, { error: { message: 'Template name does not exist in the translation', code: 132001 } });
    }
    const b = JSON.parse(Buffer.concat(chunks).toString());
    const id = `wamid.${++seq}`;
    sent.push({
      to: b.to, template: b.template.name, language: b.template.language.code, id,
      params: (b.template.components[0]?.parameters ?? []).map((p: { text: string }) => p.text),
    });
    send(200, { messaging_product: 'whatsapp', contacts: [{ wa_id: b.to }], messages: [{ id }] });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v21.0`;
  return { url, sent, failNext: (n: number) => (failNext = n), close: () => new Promise<void>((r) => srv.close(() => r())) };
}
