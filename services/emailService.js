//  Email delivery for notifications.
//
//  SMTP delivery is used when BOTH are true:
//    1. nodemailer is installed
//    2. SMTP_HOST is set in the environment

let cachedTransport;          // undefined = not resolved yet, null = unavailable
let mode = 'LOGGED';

function resolveTransport() {
    if (cachedTransport !== undefined) return cachedTransport;

    if (!process.env.SMTP_HOST) {
        cachedTransport = null;
        return cachedTransport;
    }
    try {
        const nodemailer = require('nodemailer');
        cachedTransport = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: parseInt(process.env.SMTP_PORT) || 587,
            secure: process.env.SMTP_SECURE === 'true',
            auth: (process.env.SMTP_USER && process.env.SMTP_PASS)
                ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
                : undefined
        });
        mode = 'SMTP';
    } catch (e) {
        cachedTransport = null;
    }
    return cachedTransport;
}

function transportMode() {
    resolveTransport();
    return mode;
}

async function sendMail({ to, subject, text }) {
    if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
        return { status: 'FAILED', detail: 'No valid recipient address on file' };
    }

    const transport = resolveTransport();
    const from = process.env.MAIL_FROM || 'TeamUp <no-reply@teamup.local>';

    if (!transport) {
        console.log(
            '\n──────── TeamUp notification email ────────\n' +
            `To:      ${to}\n` +
            `From:    ${from}\n` +
            `Subject: ${subject}\n\n` +
            `${text}\n` +
            '───────────────────────────────────────────\n'
        );
        return { status: 'LOGGED', detail: 'Written to server console (no SMTP configured)' };
    }

    try {
        const info = await transport.sendMail({ from, to, subject, text });
        return { status: 'SENT', detail: info.messageId || 'delivered' };
    } catch (e) {
        console.error('[email] send failed:', e.message);
        return { status: 'FAILED', detail: e.message };
    }
}

module.exports = { sendMail, transportMode };
