// =============================================================================
// Email transports.
//
// The notification pipeline is transport-agnostic: it queues a row in
// `email_outbox` and hands the message to whatever transport is configured.
// Every transport exposes the same `send({to, subject, body})` and resolves to
// `{ delivered, messageId, previewUrl }`.
//
//   console    (default) records and logs; nothing leaves the machine
//   ethereal   real SMTP to a disposable test inbox; no credentials required,
//              and every message gets a preview URL you can open
//   smtp       real delivery via SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS
//
// The recipient guard (MAIL_REDIRECT_TO / MAIL_ALLOWLIST) lives in
// NotificationService.dispatchEmails, so it protects every transport rather
// than just this one.
// =============================================================================

// Deliberately permissive: enough to catch the addresses that cannot possibly
// work (the `test` account's email is literally "test"), without pretending to
// implement RFC 5322.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isDeliverable(address) {
  return typeof address === 'string' && EMAIL_RE.test(address.trim());
}

const DEFAULT_FROM = 'TeamUp <no-reply@teamup.local>';

class ConsoleTransport {
  constructor({ log = console.log } = {}) {
    this.log = log;
    this.name = 'console';
    this.sent = [];          // in-process record, handy in tests
  }

  async send({ to, subject, body }) {
    this.sent.push({ to, subject, body });
    this.log(`[email:${this.name}] to=${to} subject=${subject}`);
    return { delivered: true };
  }
}

// Real SMTP, but to a throwaway inbox nodemailer provisions on demand. Useful
// for proving the delivery path end-to-end without credentials and without any
// risk of mailing a real person.
class EtherealTransport {
  constructor({ from = DEFAULT_FROM } = {}) {
    this.name = 'ethereal';
    this.from = from;
    this.transporter = null;
    this.account = null;
  }

  // Lazy: no network call happens unless a message is actually dispatched.
  async init() {
    if (this.transporter) return this.transporter;
    const nodemailer = require('nodemailer');
    this.account = await nodemailer.createTestAccount();
    this.transporter = nodemailer.createTransport({
      host: this.account.smtp.host,
      port: this.account.smtp.port,
      secure: this.account.smtp.secure,
      auth: { user: this.account.user, pass: this.account.pass }
    });
    return this.transporter;
  }

  async send({ to, subject, body }) {
    const nodemailer = require('nodemailer');
    const transporter = await this.init();
    const info = await transporter.sendMail({ from: this.from, to, subject, text: body });
    return {
      delivered: true,
      messageId: info.messageId,
      previewUrl: nodemailer.getTestMessageUrl(info) || null
    };
  }
}

class SmtpTransport {
  constructor(config = {}) {
    this.name = 'smtp';
    this.config = config;
    this.from = config.from || DEFAULT_FROM;
    this.transporter = null;
  }

  init() {
    if (this.transporter) return this.transporter;
    const { host, port, user, pass } = this.config;
    if (!host) throw new Error('SMTP_HOST is not set (MAIL_TRANSPORT=smtp requires it)');

    const nodemailer = require('nodemailer');
    const portNum = parseInt(port) || 587;
    this.transporter = nodemailer.createTransport({
      host,
      port: portNum,
      secure: portNum === 465,          // implicit TLS on 465, STARTTLS otherwise
      auth: user ? { user, pass } : undefined
    });
    return this.transporter;
  }

  async send({ to, subject, body }) {
    const info = await this.init().sendMail({ from: this.from, to, subject, text: body });
    return { delivered: true, messageId: info.messageId };
  }
}

function createTransport(env = process.env) {
  switch ((env.MAIL_TRANSPORT || 'console').toLowerCase()) {
    case 'smtp':
      return new SmtpTransport({
        host: env.SMTP_HOST, port: env.SMTP_PORT,
        user: env.SMTP_USER, pass: env.SMTP_PASS,
        from: env.MAIL_FROM
      });
    case 'ethereal':
      return new EtherealTransport({ from: env.MAIL_FROM });
    default:
      return new ConsoleTransport();
  }
}

module.exports = {
  ConsoleTransport, EtherealTransport, SmtpTransport,
  createTransport, isDeliverable
};
