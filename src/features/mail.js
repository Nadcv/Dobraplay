// Envio de e-mails (códigos de verificação), grátis:
//  1. Resend (RESEND_API_KEY) — plano grátis com limite diário/mensal.
//  2. Brevo  (BREVO_API_KEY)  — usado automaticamente se a Resend falhar ou
//     chegar ao limite (quando a Resend responde 429 por quota, fica de parte
//     até ao dia seguinte e tudo segue pela Brevo).
// Sem nenhuma chave: modo de teste (não envia; o código aparece no ecrã).
//
// Remetentes:
//  RESEND_FROM  ex.: "DobraPay <codigos@o-seu-dominio.com>". Sem domínio
//               verificado na Resend só se pode enviar para o e-mail do dono
//               da conta Resend — os outros pedidos passam para a Brevo.
//  BREVO_FROM   e-mail de remetente verificado na Brevo (ex.: o seu Gmail).
//  MAIL_FROM_NAME nome mostrado (por omissão "DobraPay").

const DAY = 86_400_000;

class MailError extends Error {
  constructor(message, status, body) { super(message); this.status = status; this.body = body; }
}

async function postJson(url, headers, payload) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new MailError('sem ligação: ' + err.message, 0, null);
  }
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    const msg = (body && (body.message || body.error || body.code)) || res.status;
    throw new MailError(`respondeu ${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`, res.status, body);
  }
  return body;
}

function resendProvider(env) {
  const base = env.RESEND_API_BASE || 'https://api.resend.com';
  const from = env.RESEND_FROM || `${env.MAIL_FROM_NAME || 'DobraPay'} <onboarding@resend.dev>`;
  return {
    name: 'resend',
    async send({ to, subject, text, html }) {
      const r = await postJson(base + '/emails', { authorization: 'Bearer ' + env.RESEND_API_KEY }, { from, to: [to], subject, text, html });
      return r && r.id;
    },
  };
}

function brevoProvider(env) {
  const base = env.BREVO_API_BASE || 'https://api.brevo.com';
  if (!env.BREVO_FROM) throw new Error('BREVO_API_KEY precisa de BREVO_FROM (e-mail de remetente verificado na Brevo)');
  return {
    name: 'brevo',
    async send({ to, subject, text, html }) {
      const r = await postJson(base + '/v3/smtp/email', { 'api-key': env.BREVO_API_KEY }, {
        sender: { name: env.MAIL_FROM_NAME || 'DobraPay', email: env.BREVO_FROM },
        to: [{ email: to }], subject, textContent: text, htmlContent: html,
      });
      return r && r.messageId;
    },
  };
}

// Quanto tempo um fornecedor fica de parte depois de um erro.
function cooldownFor(err, now) {
  const body = JSON.stringify(err.body || '').toLowerCase();
  if (err.status === 429 && body.includes('quota')) return Math.ceil((now + 1) / DAY) * DAY - now; // até à meia-noite (UTC)
  if (err.status === 429) return 60_000;                       // demasiados pedidos por segundo
  if (err.status === 401 || err.status === 403) return 10 * 60_000; // chave errada / remetente não autorizado
  return 0;                                                    // falha passageira: tenta de novo no próximo
}

function createMailSender(env = process.env, { now = Date.now, log = console } = {}) {
  const providers = [];
  if (env.RESEND_API_KEY) providers.push(resendProvider(env));
  if (env.BREVO_API_KEY) providers.push(brevoProvider(env));
  if (!providers.length) {
    return { name: 'sandbox', sandbox: true, providers: [], status: () => [], async send() { return { provider: 'sandbox' }; } };
  }
  const pausedUntil = {};
  return {
    name: providers.map((p) => p.name).join('+'),
    sandbox: false,
    providers: providers.map((p) => p.name),
    status: () => providers.map((p) => ({ provider: p.name, paused_until: pausedUntil[p.name] > now() ? pausedUntil[p.name] : null })),
    async send(msg) {
      const t = now();
      // Os que estão de parte só são usados se não houver mais nenhum.
      const order = [...providers.filter((p) => !(pausedUntil[p.name] > t)), ...providers.filter((p) => pausedUntil[p.name] > t)];
      const errors = [];
      for (const p of order) {
        try {
          const id = await p.send(msg);
          return { provider: p.name, id };
        } catch (err) {
          const cd = cooldownFor(err, now());
          if (cd) pausedUntil[p.name] = now() + cd;
          errors.push(`${p.name} ${err.message}`);
          log.warn(`E-mail: ${p.name} falhou (${err.message})${order.length > 1 ? ' — a tentar o seguinte' : ''}`);
        }
      }
      throw new Error('Não foi possível enviar o e-mail: ' + errors.join('; '));
    },
  };
}

module.exports = { createMailSender };
