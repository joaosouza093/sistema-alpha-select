import nodemailer from 'nodemailer';
import type { Config } from '../config.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}

/**
 * Caixa de saída em memória para desenvolvimento e testes.
 * Nunca é usada em homologação/produção (SMTP_URL é obrigatório lá).
 */
export class MemoryMailer implements Mailer {
  readonly outbox: MailMessage[] = [];
  async send(msg: MailMessage) {
    this.outbox.push(msg);
    if (process.env.APP_ENV === 'development') {
      // Somente em desenvolvimento: exibe no terminal para permitir testar convites localmente.
      // eslint-disable-next-line no-console
      console.info(`\n[dev-mail] Para: ${msg.to}\nAssunto: ${msg.subject}\n${msg.text}\n`);
    }
  }
}

export class SmtpMailer implements Mailer {
  private transport;
  constructor(url: string, private readonly from: string) {
    this.transport = nodemailer.createTransport(url);
  }
  async send(msg: MailMessage) {
    await this.transport.sendMail({ from: this.from, to: msg.to, subject: msg.subject, text: msg.text });
  }
}

export function createMailer(config: Config): Mailer {
  if (config.SMTP_URL) return new SmtpMailer(config.SMTP_URL, config.MAIL_FROM);
  return new MemoryMailer();
}
