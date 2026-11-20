// Carregar a carteira com cartão (Visa, Mastercard, Apple Pay, Google Pay…)
// através da Stripe Checkout. A DobraPay nunca vê nem guarda o número do
// cartão: o cliente paga na página segura da Stripe e a Stripe confirma por
// webhook assinado (STRIPE_WEBHOOK_SECRET). Se o webhook atrasar, a app
// também confirma ao voltar da página de pagamento (consulta a Stripe).
//
// Configuração: STRIPE_SECRET_KEY (sk_test_… para testes, sk_live_… a sério)
// e STRIPE_WEBHOOK_SECRET (whsec_…). Sem chave, a opção não aparece.
const crypto = require('crypto');
const { ApiError } = require('../util');

const CURRENCIES = ['EUR']; // a conta Stripe da empresa recebe em euros

// "a[b][0][c]=x" — o formato que a API da Stripe espera.
function formEncode(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') formEncode(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out.join('&');
}

// Verifica o cabeçalho Stripe-Signature: "t=…,v1=…" (HMAC-SHA256 de "t.corpo").
function verifyStripeSignature(secret, rawBody, header, toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000)) {
  if (!secret || !rawBody || typeof header !== 'string') return false;
  let t = null; const v1 = [];
  for (const p of header.split(',')) {
    const [k, v] = p.split('=');
    if (k === 't') t = Number(v);
    if (k === 'v1' && v) v1.push(v);
  }
  if (!t || !v1.length || Math.abs(nowSec - t) > toleranceSec) return false;
  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex'));
  return v1.some((sig) => sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), expected));
}

module.exports = function cards(kit) {
  const { db, C, env, now, fmt, audit } = kit;
  const key = env.STRIPE_SECRET_KEY || '';
  const enabled = !!key;
  const testMode = key.startsWith('sk_test_');
  const apiBase = env.STRIPE_API_BASE || 'https://api.stripe.com';

  async function stripe(method, path, params, idempotencyKey) {
    const res = await fetch(apiBase + path, {
      method,
      headers: {
        authorization: 'Bearer ' + key,
        'content-type': 'application/x-www-form-urlencoded',
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      body: params ? formEncode(params) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(502, 'stripe_error', 'O serviço de pagamentos com cartão não respondeu: ' + ((data.error && data.error.message) || res.status));
    return data;
  }

  const view = (r) => ({ id: r.id, amount: r.amount, fee: r.fee, total: r.amount + r.fee, currency: r.currency, status: r.status, created_at: r.created_at });

  function cardTopupConfig() {
    return { enabled, test_mode: testMode, currencies: CURRENCIES, fee: '1,5% + 0,25 €' };
  }

  async function quoteCardTopup(user, { amount, currency = 'EUR' }) {
    if (!enabled) throw new ApiError(409, 'cards_disabled', 'Os carregamentos com cartão ainda não estão disponíveis.');
    if (!CURRENCIES.includes(currency)) throw new ApiError(400, 'bad_currency', 'Os carregamentos com cartão são em euros.');
    const r = await kit.rates();
    if (!Number.isSafeInteger(amount) || amount < 500) throw new ApiError(400, 'bad_amount', `Valor mínimo: ${fmt(500, 'EUR')}.`);
    const lim = kit.limitsFor(user);
    if (kit.toEur(amount, currency, r) > lim.perTx) throw new ApiError(403, 'limit_tx', `Limite por operação: ${fmt(lim.perTx, 'EUR')}.`);
    const total = (await kit.walletsOf(user.id)).reduce((s, w) => s + kit.toEur(w.balance, w.currency, r), 0);
    if (total + kit.toEur(amount, currency, r) > lim.maxBalance) throw new ApiError(403, 'limit_balance', 'Este carregamento ultrapassa o saldo máximo da sua conta. Verifique a identidade para subir os limites.');
    const fee = C.FEES.cardIn(kit.toEur(amount, currency, r));
    return { amount, fee, total: amount + fee, currency, test_mode: testMode };
  }

  // Cria o pagamento na Stripe e devolve o endereço da página segura.
  async function createCardTopup(user, { amount, currency = 'EUR' }, origin, ip) {
    const q = await quoteCardTopup(user, { amount, currency });
    const { n } = await db.get("SELECT COUNT(*) AS n FROM card_topups WHERE user_id = ? AND created_at > ?", user.id, now() - 3_600_000);
    if (n >= 10) throw new ApiError(429, 'too_many', 'Demasiadas tentativas de carregamento. Tente mais tarde.');
    const id = 'ct_' + crypto.randomBytes(9).toString('hex');
    await db.run('INSERT INTO card_topups (id, user_id, amount, fee, currency, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id, user.id, q.amount, q.fee, currency, now(), now());
    const session = await stripe('POST', '/v1/checkout/sessions', {
      mode: 'payment',
      client_reference_id: id,
      success_url: `${origin}/?cartao=ok&id=${id}`,
      cancel_url: `${origin}/?cartao=cancelado&id=${id}`,
      expires_at: Math.floor(now() / 1000) + 30 * 60,
      metadata: { topup_id: id, user_id: String(user.id) },
      payment_intent_data: { metadata: { topup_id: id }, description: `${C.APP_NAME} · carregamento ${id}` },
      line_items: [{ quantity: 1, price_data: { currency: currency.toLowerCase(), unit_amount: q.total,
        product_data: { name: `Carregamento ${C.APP_NAME}`, description: `${fmt(q.amount, currency)} para a carteira + taxa ${fmt(q.fee, currency)}` } } }],
    }, id);
    await db.run('UPDATE card_topups SET session_id = ?, updated_at = ? WHERE id = ?', session.id, now(), id);
    await audit(user.id, 'card_topup_created', { id, amount: q.amount, fee: q.fee }, ip);
    return { ...view(await db.get('SELECT * FROM card_topups WHERE id = ?', id)), url: session.url, test_mode: testMode };
  }

  // Credita a carteira (uma única vez): o dinheiro está na conta Stripe da empresa.
  async function completeTopup(id, paymentIntent) {
    const txId = await db.tx(async () => {
      const r = await db.get('SELECT * FROM card_topups WHERE id = ? FOR UPDATE', id);
      if (!r || r.status === 'completed') return null;
      const float = await kit.internal('system_float', r.currency);
      const fees = await kit.internal('fees', r.currency);
      const wallet = await kit.ensureWallet(r.user_id, r.currency);
      const credits = [[float.id, -(r.amount + r.fee)], [wallet.id, r.amount]];
      if (r.fee) credits.push([fees.id, r.fee]);
      const t = await kit.recordTx({ type: 'card_in', fromAcc: float, toAcc: wallet, amount: r.amount + r.fee, currency: r.currency,
        toAmount: r.amount, toCurrency: r.currency, fee: r.fee, note: 'Carregamento com cartão', createdBy: r.user_id, credits });
      await db.run("UPDATE card_topups SET status = 'completed', payment_intent = COALESCE(?, payment_intent), tx_id = ?, updated_at = ? WHERE id = ?",
        paymentIntent || null, t, now(), id);
      return t;
    });
    kit.afterCommit(txId);
    if (txId) await audit(null, 'card_topup_completed', { id, tx: txId });
    return txId;
  }

  async function markTopup(id, status) {
    await db.run("UPDATE card_topups SET status = ?, updated_at = ? WHERE id = ? AND status = 'pending'", status, now(), id);
  }

  // Notificações da Stripe (assinadas). Repetições são ignoradas.
  async function handleStripeWebhook(rawBody, signature) {
    if (!env.STRIPE_WEBHOOK_SECRET) throw new ApiError(503, 'webhooks_disabled', 'Falta STRIPE_WEBHOOK_SECRET.');
    if (!verifyStripeSignature(env.STRIPE_WEBHOOK_SECRET, rawBody, signature)) throw new ApiError(400, 'bad_signature', 'Assinatura inválida.');
    let event;
    try { event = JSON.parse(rawBody); } catch { throw new ApiError(400, 'bad_json', 'Evento inválido.'); }
    const obj = (event.data && event.data.object) || {};
    const topupId = obj.client_reference_id || (obj.metadata && obj.metadata.topup_id);
    switch (event.type) {
      case 'checkout.session.completed':
        if (topupId && obj.payment_status === 'paid') await completeTopup(topupId, obj.payment_intent);
        break; // pagamentos que demoram (ex.: transferência) chegam depois em async_payment_succeeded
      case 'checkout.session.async_payment_succeeded':
        if (topupId) await completeTopup(topupId, obj.payment_intent);
        break;
      case 'checkout.session.async_payment_failed':
        if (topupId) await markTopup(topupId, 'failed');
        break;
      case 'checkout.session.expired':
        if (topupId) await markTopup(topupId, 'expired');
        break;
      case 'charge.dispute.created': {
        // O titular do cartão contestou o pagamento: alerta para o admin rever.
        const r = await db.get('SELECT * FROM card_topups WHERE payment_intent = ?', String(obj.payment_intent || ''));
        if (r) {
          await db.run('INSERT INTO aml_alerts (user_id, rule, detail, tx_id, created_at) VALUES (?, ?, ?, ?, ?)', r.user_id, 'card_dispute',
            `Contestação de ${fmt(Number(obj.amount) || r.amount + r.fee, r.currency)} no carregamento ${r.id} (${obj.reason || 'sem motivo'})`, r.tx_id, now());
        }
        break;
      }
      default: break;
    }
    await audit(null, 'stripe_event', { type: event.type, id: event.id, topupId });
    return { received: true };
  }

  // Ao voltar da página de pagamento: estado atual (e confirma na Stripe se o webhook ainda não chegou).
  async function getCardTopup(user, id) {
    let r = await db.get('SELECT * FROM card_topups WHERE id = ? AND user_id = ?', String(id), user.id);
    if (!r) throw new ApiError(404, 'not_found', 'Carregamento não encontrado.');
    if (r.status === 'pending' && r.session_id && enabled) {
      try {
        const s = await stripe('GET', `/v1/checkout/sessions/${encodeURIComponent(r.session_id)}`);
        if (s.payment_status === 'paid') await completeTopup(r.id, s.payment_intent);
        else if (s.status === 'expired') await markTopup(r.id, 'expired');
      } catch (err) { /* a Stripe não respondeu: o webhook trata depois */ }
      r = await db.get('SELECT * FROM card_topups WHERE id = ?', r.id);
    }
    return view(r);
  }

  return { cardTopupConfig, quoteCardTopup, createCardTopup, handleStripeWebhook, getCardTopup };
};
module.exports.verifyStripeSignature = verifyStripeSignature;
module.exports.formEncode = formEncode;
