// Menu USSD (*xxx#) para telemóveis sem internet.
// Formato compatível com os gateways USSD (ex.: Africa's Talking): a operadora
// envia { sessionId, serviceCode, phoneNumber, text } e a resposta começa por
// "CON " (continua o menu) ou "END " (termina). "text" traz todas as escolhas
// da sessão separadas por "*", por exemplo "2*9923456*100*2580".
// O número vem da própria operadora; o PIN confirma cada operação.
const { formatAmount, normalizePhone, parseAmount, ApiError } = require('../util');

module.exports = function ussd(kit) {
  const { C, fmt } = kit;

  async function handleUssd({ sessionId, phoneNumber, text = '' }) {
    const phone = normalizePhone(String(phoneNumber || ''));
    const user = phone && await kit.userByPhone(phone);
    if (!user) return `END ${C.APP_NAME}: este número ainda não tem conta. Instale a app em ${kit.env.PUBLIC_URL || 'dobrapay.onrender.com'}.`;
    if (user.status !== 'active') return 'END Conta bloqueada. Contacte o apoio ao cliente.';
    const parts = String(text).split('*').filter((x, i, a) => !(x === '' && a.length === 1));
    const cur = user.receive_currency;
    const pinStep = async (pin, fn) => {
      try { await kit.checkPin(user, pin); return await fn(); }
      catch (err) { return 'END ' + (err instanceof ApiError ? err.message : 'Erro. Tente mais tarde.'); }
    };

    if (parts.length === 0) {
      return `CON ${C.APP_NAME}\n1. Ver saldo\n2. Enviar dinheiro\n3. Levantar num agente\n4. Últimos movimentos`;
    }
    const [choice, a, b, c] = parts;

    if (choice === '1') {
      if (!a) return 'CON Introduza o seu PIN:';
      return pinStep(a, async () => {
        const w = (await kit.publicUser(user)).wallets;
        return 'END Saldo:\n' + (w.map((x) => formatAmount(x.balance, x.currency)).join('\n') || formatAmount(0, cur));
      });
    }

    if (choice === '2') {
      if (!a) return 'CON Número de quem recebe:';
      let to;
      try { to = await kit.findRecipient(user, a); } catch (err) { return 'END ' + err.message; }
      if (to.id === user.id) return 'END Não pode enviar para si próprio.';
      if (!b) return `CON Para ${to.name}\nValor a enviar (${cur}):`;
      const amount = parseAmount(b);
      if (!amount) return 'END Valor inválido.';
      if (!c) {
        let q;
        try {
          q = await kit.buildQuote({ amount, from: cur, to: to.receive_currency,
            feeKind: cur !== to.receive_currency || user.country !== to.country ? 'international' : 'domestic' });
        } catch (err) { return 'END ' + err.message; }
        return `CON Enviar ${fmt(q.total, cur)} a ${to.name}?\nRecebe: ${fmt(q.to_amount, q.to_currency)}\nPIN para confirmar:`;
      }
      try {
        const r = await kit.transfer(user, { to: to.phone, amount, fromCurrency: cur, pin: c, idempotencyKey: `ussd-${sessionId}`, note: 'USSD' });
        return `END Enviado! ${to.name} recebeu ${fmt(r.transaction.to_amount, r.transaction.to_currency)}.`;
      } catch (err) { return 'END ' + err.message; }
    }

    if (choice === '3') {
      if (!a) return `CON Valor a levantar (${kit.homeCurrency(user)}):`;
      const amount = parseAmount(a);
      if (!amount) return 'END Valor inválido.';
      if (!b) return 'CON Introduza o seu PIN:';
      try {
        const r = await kit.createCashoutCode(user, { amount, currency: kit.homeCurrency(user), pin: b });
        return `END Código de levantamento: ${r.code}\nMostre-o ao agente. Valor: ${fmt(r.amount, r.currency)}. Válido ${C.CASHOUT_CODE_MINUTES} min.`;
      } catch (err) { return 'END ' + err.message; }
    }

    if (choice === '4') {
      if (!a) return 'CON Introduza o seu PIN:';
      return pinStep(a, async () => {
        const txs = await kit.history(user, { limit: 3 });
        if (!txs.length) return 'END Ainda sem movimentos.';
        return 'END ' + txs.map((t) => {
          const out = t.direction === 'out';
          const other = out ? t.to.name : t.from.name;
          return `${out ? '-' : '+'}${fmt(out ? t.amount + t.fee : t.to_amount, out ? t.currency : t.to_currency)} ${other}`.slice(0, 50);
        }).join('\n');
      });
    }
    return 'END Opção inválida.';
  }

  return { handleUssd };
};
