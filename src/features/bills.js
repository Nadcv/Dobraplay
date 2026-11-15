// Recargas de telemóvel e pagamento de contas (luz, água).
// Fornecedores:
//  - sandbox: simula a empresa (recarga feita / código de energia gerado).
//             Uma referência terminada em 0000 simula uma recusa (para testar
//             a devolução do dinheiro);
//  - http:    modelo para um agregador ou para cada empresa (BILLS_HTTP_URL
//             + BILLS_HTTP_TOKEN): POST { biller, account_ref, amount,
//             currency, reference } → { status: "completed" | "failed",
//             token?, provider_ref?, reason? }.
const crypto = require('crypto');
const { ApiError, cleanText, normalizePhone } = require('../util');

const BILLERS = {
  cst_recarga:    { name: 'Recarga CST', group: 'Recargas', country: 'ST', currency: 'STN', ref: 'phone', min: 1000 },
  unitel_st:      { name: 'Recarga Unitel STP', group: 'Recargas', country: 'ST', currency: 'STN', ref: 'phone', min: 1000 },
  emae_energia:   { name: 'EMAE · Energia pré-paga', group: 'Contas', country: 'ST', currency: 'STN', ref: 'meter', min: 5000, token: true },
  emae_agua:      { name: 'EMAE · Fatura da água', group: 'Contas', country: 'ST', currency: 'STN', ref: 'invoice', min: 1000 },
  unitel_ao:      { name: 'Recarga Unitel Angola', group: 'Recargas', country: 'AO', currency: 'AOA', ref: 'phone', min: 50000 },
  cvmovel:        { name: 'Recarga CV Móvel', group: 'Recargas', country: 'CV', currency: 'CVE', ref: 'phone', min: 10000 },
};
const REF_LABELS = { phone: 'Número de telemóvel', meter: 'Número do contador', invoice: 'Referência da fatura' };

module.exports = function bills(kit) {
  const { db, now, fmt, audit, env } = kit;

  const provider = env.BILLS_HTTP_URL
    ? {
      name: 'http',
      async pay(order) {
        const res = await fetch(env.BILLS_HTTP_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': order.reference, ...(env.BILLS_HTTP_TOKEN ? { authorization: 'Bearer ' + env.BILLS_HTTP_TOKEN } : {}) },
          body: JSON.stringify(order), signal: AbortSignal.timeout(20_000),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return { status: 'failed', reason: `o fornecedor respondeu ${res.status}` };
        return data;
      },
    }
    : {
      name: 'sandbox',
      async pay(order) {
        if (/0000$/.test(order.account_ref)) return { status: 'failed', reason: 'Simulação: a empresa recusou esta referência' };
        const token = BILLERS[order.biller].token ? Array.from({ length: 5 }, () => String(crypto.randomInt(0, 10000)).padStart(4, '0')).join('-') : null;
        return { status: 'completed', token, provider_ref: 'SBX-' + crypto.randomBytes(4).toString('hex').toUpperCase() };
      },
    };

  function checkRef(b, ref) {
    const raw = String(ref || '').trim();
    if (b.ref === 'phone') {
      const p = normalizePhone(raw, b.country);
      if (!p) throw new ApiError(400, 'bad_ref', 'Número de telemóvel inválido para esta operadora.');
      return p;
    }
    if (b.ref === 'meter' && /^\d{8,13}$/.test(raw.replace(/\s/g, ''))) return raw.replace(/\s/g, '');
    if (b.ref === 'invoice' && /^[A-Za-z0-9-]{5,20}$/.test(raw)) return raw.toUpperCase();
    throw new ApiError(400, 'bad_ref', `${REF_LABELS[b.ref]} inválido.`);
  }
  const biller = (id) => {
    const b = BILLERS[id];
    if (!b) throw new ApiError(400, 'bad_biller', 'Serviço desconhecido.');
    return b;
  };

  const view = (p) => ({
    id: p.id, biller: p.biller, biller_name: BILLERS[p.biller] ? BILLERS[p.biller].name : p.biller, account_ref: p.account_ref,
    amount: p.amount, currency: p.currency, from_amount: p.from_amount, from_currency: p.from_currency, status: p.status,
    token: p.token, provider_ref: p.provider_ref, note: p.note, created_at: p.created_at,
  });

  function listBillers() {
    return Object.entries(BILLERS).map(([id, b]) => ({ id, ...b, ref_label: REF_LABELS[b.ref], min: b.min, simulated: provider.name === 'sandbox' }));
  }

  async function quoteBill(user, { billerId, amount, fromCurrency }) {
    const b = biller(billerId);
    const from = kit.needCurrency(fromCurrency || user.receive_currency);
    return kit.buildQuote({ from, to: b.currency, exactTo: amount, feeKind: 'merchant' });
  }

  async function payBill(user, { billerId, accountRef, amount, fromCurrency, pin, idempotencyKey }, ip) {
    const b = biller(billerId);
    const ref = checkRef(b, accountRef);
    if (!Number.isSafeInteger(amount) || amount < b.min) throw new ApiError(400, 'bad_amount', `Valor mínimo: ${fmt(b.min, b.currency)}.`);
    const from = kit.needCurrency(fromCurrency || user.receive_currency);
    await kit.checkPin(user, pin, ip);
    const reference = 'CT' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const res = await kit.idempotent(user, idempotencyKey, async (key) => {
      const src = await kit.walletOf(user.id, from);
      if (!src) throw new ApiError(402, 'insufficient_funds', `Não tem saldo em ${from}.`);
      const quote = await kit.buildQuote({ from, to: b.currency, exactTo: amount, feeKind: 'merchant' });
      const txId = await kit.move({ type: 'bill', fromAcc: src, toAcc: await kit.internal('payout', b.currency), quote,
        note: `${b.name} · ${ref}`, createdBy: user.id, idemKey: key });
      await db.run(`INSERT INTO bill_payments (user_id, biller, account_ref, amount, currency, from_currency, from_amount, provider_ref, tx_id, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, user.id, billerId, ref, amount, b.currency, from, quote.amount, reference, txId, now(), now());
      return txId;
    });
    let p = await db.get('SELECT * FROM bill_payments WHERE tx_id = ?', res.transaction.id);
    if (res.replayed || p.status !== 'pending') return { ...res, payment: view(p) };

    // Paga à empresa. Se falhar, devolve tudo à carteira.
    let out;
    try { out = await provider.pay({ biller: billerId, account_ref: ref, amount: (amount / 100).toFixed(2), currency: b.currency, reference: p.provider_ref }); }
    catch (err) { out = { status: 'failed', reason: err.message }; }
    const finalTx = await db.tx(async () => {
      p = await db.get('SELECT * FROM bill_payments WHERE id = ? FOR UPDATE', p.id);
      if (p.status !== 'pending') return null;
      const payout = await kit.internal('payout', p.currency);
      if (out.status === 'completed') {
        const float = await kit.internal('system_float', p.currency);
        const t = await kit.recordTx({ type: 'bill', fromAcc: payout, toAcc: float, amount: p.amount, currency: p.currency, toAmount: p.amount,
          toCurrency: p.currency, note: `Pago a ${b.name}`, createdBy: user.id, credits: [[payout.id, -p.amount], [float.id, p.amount]] });
        await db.run("UPDATE bill_payments SET status = 'completed', token = ?, provider_ref = COALESCE(?, provider_ref), final_tx_id = ?, updated_at = ? WHERE id = ?",
          cleanText(out.token, 60), cleanText(out.provider_ref, 60), t, now(), p.id);
        return t;
      }
      const wallet = await kit.ensureWallet(user.id, p.from_currency);
      const credits = [[payout.id, -p.amount], [wallet.id, p.from_amount]];
      if (p.from_currency !== p.currency) credits.push([(await kit.internal('fx', p.currency)).id, p.amount], [(await kit.internal('fx', p.from_currency)).id, -p.from_amount]);
      const t = await kit.recordTx({ type: 'refund', fromAcc: payout, toAcc: wallet, amount: p.amount, currency: p.currency, toAmount: p.from_amount,
        toCurrency: p.from_currency, note: `Devolução: ${b.name} não foi paga`, createdBy: user.id, credits });
      await db.run("UPDATE bill_payments SET status = 'failed', note = ?, final_tx_id = ?, updated_at = ? WHERE id = ?",
        cleanText(out.reason || 'A empresa recusou o pagamento', 140), t, now(), p.id);
      return t;
    });
    kit.afterCommit(finalTx);
    await audit(user.id, 'bill_paid', { id: p.id, biller: billerId, status: out.status }, ip);
    return { ...res, payment: view(await db.get('SELECT * FROM bill_payments WHERE id = ?', p.id)) };
  }

  async function listBills(user) {
    return (await db.all('SELECT * FROM bill_payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 20', user.id)).map(view);
  }

  return { listBillers, quoteBill, payBill, listBills };
};
