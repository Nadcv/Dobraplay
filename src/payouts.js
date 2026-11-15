// Parceiros que fazem os pagamentos para contas bancárias (levantamentos e
// envios para IBAN). Cada moeda escolhe um, no ecrã Acertos:
//
//  - manual:  o admin faz a transferência no banco e marca como paga;
//  - sandbox: simulador para testes (confirma sozinho alguns segundos depois;
//             se o titular tiver a palavra "FALHA", simula uma recusa);
//  - http:    modelo para um parceiro real (banco, Routefusion, MoneyGram…).
//             Ativa-se com PAYOUT_HTTP_URL (+ PAYOUT_HTTP_TOKEN). A DobraPay
//             envia a ordem por POST e o parceiro confirma depois por webhook
//             em /api/webhooks/payouts/http, assinado com PAYOUT_WEBHOOK_SECRET.
//
// Para ligar um parceiro com outro formato, basta acrescentar aqui um objeto
// com { label, send(order) } que devolva { externalId }.
const crypto = require('crypto');

function createPayoutProviders({ onEvent, sandboxDelayMs = 3000, env = process.env } = {}) {
  const providers = {
    manual: { label: 'Manual (o admin transfere no banco)' },

    sandbox: {
      label: 'Simulador (testes, sem dinheiro real)',
      async send(order) {
        const externalId = 'SBX-' + crypto.randomBytes(5).toString('hex').toUpperCase();
        const failed = /FALHA/i.test(order.holder || '');
        const t = setTimeout(() => {
          onEvent('sandbox', {
            external_id: externalId,
            status: failed ? 'failed' : 'paid',
            reason: failed ? 'Simulação: o banco do beneficiário recusou a transferência' : undefined,
            bank_reference: failed ? undefined : 'SBX-' + order.reference,
          }).catch((err) => console.error('Simulador de pagamentos:', err.message));
        }, sandboxDelayMs);
        if (t.unref) t.unref();
        return { externalId };
      },
    },
  };

  if (env.PAYOUT_HTTP_URL) {
    providers.http = {
      label: `Parceiro por API (${new URL(env.PAYOUT_HTTP_URL).host})`,
      async send(order) {
        const res = await fetch(env.PAYOUT_HTTP_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(env.PAYOUT_HTTP_TOKEN ? { authorization: 'Bearer ' + env.PAYOUT_HTTP_TOKEN } : {}),
            'idempotency-key': order.reference, // o parceiro não paga duas vezes a mesma ordem
          },
          body: JSON.stringify({
            reference: order.reference,
            amount: (order.amount / 100).toFixed(2),
            currency: order.currency,
            beneficiary: { name: order.holder, iban: order.iban },
            description: `DobraPay ${order.reference}`,
          }),
          signal: AbortSignal.timeout(15_000),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.id) throw new Error(`o parceiro respondeu ${res.status}${data.error ? ': ' + data.error : ''}`);
        return { externalId: String(data.id) };
      },
    };
  }
  return providers;
}

// Assinatura dos webhooks: HMAC-SHA256 do corpo exato, em hexadecimal.
const signWebhook = (secret, rawBody) => crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
function verifyWebhook(secret, rawBody, signature) {
  if (!secret || !rawBody || typeof signature !== 'string') return false;
  const expected = Buffer.from(signWebhook(secret, rawBody));
  const got = Buffer.from(signature.replace(/^sha256=/, ''));
  return expected.length === got.length && crypto.timingSafeEqual(expected, got);
}

module.exports = { createPayoutProviders, signWebhook, verifyWebhook };
