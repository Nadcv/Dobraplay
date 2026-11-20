// Envios automáticos todos os meses (ex.: mesada para a família).
// O cliente autoriza uma vez com o PIN; no dia escolhido o servidor faz o
// envio. Se não houver saldo, tenta de novo nos dias seguintes (até 3 vezes)
// e avisa. Cada mês só pode ser enviado uma vez (chave de idempotência
// "sched-<id>-<AAAAMM>"), mesmo que dois servidores corram ao mesmo tempo.
const { ApiError, cleanText, normalizePhone } = require('../util');

const RUN_HOUR_UTC = 9; // 9h em São Tomé / 9–10h em Portugal

// Próxima data com aquele dia do mês, às 9h UTC, a partir de "from".
function nextRun(day, from = Date.now(), skipCurrent = false) {
  const d = new Date(from);
  let y = d.getUTCFullYear(), m = d.getUTCMonth();
  let t = Date.UTC(y, m, day, RUN_HOUR_UTC);
  if (skipCurrent || t <= from) { m += 1; t = Date.UTC(y, m, day, RUN_HOUR_UTC); }
  return t;
}
const periodOf = (t) => { const d = new Date(t); return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };

module.exports = function scheduled(kit) {
  const { db, now, fmt, audit } = kit;
  const notify = (...a) => (kit.notify ? kit.notify(...a).catch(() => {}) : null);

  async function view(s) {
    const to = await kit.userByPhone(s.to_phone);
    return { id: s.id, to_phone: s.to_phone, to_name: to ? to.name : null, amount: s.amount, from_currency: s.from_currency, note: s.note,
      day_of_month: s.day_of_month, next_run_at: s.next_run_at, active: !!s.active, last_status: s.last_status, last_run_at: s.last_run_at, failures: s.failures };
  }

  async function createScheduled(user, { to, amount, fromCurrency, note, dayOfMonth, pin }, ip) {
    const recipient = await kit.findRecipient(user, to);
    if (recipient.id === user.id) throw new ApiError(400, 'same_account', 'Não pode agendar envios para si próprio.');
    const day = Number(dayOfMonth);
    if (!Number.isInteger(day) || day < 1 || day > 28) throw new ApiError(400, 'bad_day', 'Escolha um dia entre 1 e 28.');
    const from = kit.needCurrency(fromCurrency || user.receive_currency);
    if (!Number.isSafeInteger(amount) || amount < 1) throw new ApiError(400, 'bad_amount', 'Valor inválido.');
    const r = await kit.rates();
    if (kit.toEur(amount, from, r) > kit.limitsFor(user).perTx) throw new ApiError(403, 'limit_tx', 'O valor ultrapassa o seu limite por operação.');
    const { n } = await db.get('SELECT COUNT(*) AS n FROM scheduled_transfers WHERE user_id = ? AND active = 1', user.id);
    if (n >= 10) throw new ApiError(429, 'too_many', 'Já tem 10 envios automáticos ativos.');
    await kit.checkPin(user, pin, ip);
    const { id } = await db.get(`INSERT INTO scheduled_transfers (user_id, to_phone, amount, from_currency, note, day_of_month, next_run_at, created_at)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`, user.id, recipient.phone, amount, from, cleanText(note, 140), day, nextRun(day), now());
    await audit(user.id, 'scheduled_created', { id, to: recipient.id, amount, from, day }, ip);
    return view(await db.get('SELECT * FROM scheduled_transfers WHERE id = ?', id));
  }

  async function listScheduled(user) {
    const rows = await db.all('SELECT * FROM scheduled_transfers WHERE user_id = ? AND active = 1 ORDER BY next_run_at', user.id);
    return Promise.all(rows.map(view));
  }

  async function cancelScheduled(user, id) {
    await db.run('UPDATE scheduled_transfers SET active = 0 WHERE id = ? AND user_id = ?', Number(id) || 0, user.id);
    return listScheduled(user);
  }

  // Executa os envios que já chegaram ao dia. Chamado de minuto a minuto.
  async function runDueScheduled() {
    const due = await db.all('SELECT * FROM scheduled_transfers WHERE active = 1 AND next_run_at <= ? ORDER BY next_run_at LIMIT 50', now());
    const results = [];
    for (const s of due) {
      const user = await kit.userById(s.user_id);
      const recipient = await kit.userByPhone(s.to_phone);
      if (!user || user.status !== 'active' || !recipient || recipient.status !== 'active') {
        await db.run("UPDATE scheduled_transfers SET active = 0, last_status = 'Desativado: conta inexistente ou bloqueada' WHERE id = ?", s.id);
        continue;
      }
      try {
        const res = await kit.idempotent(user, `sched-${s.id}-${periodOf(s.next_run_at)}`, async (key) => {
          const src = await kit.walletOf(user.id, s.from_currency);
          if (!src) throw new ApiError(402, 'insufficient_funds', `Não tem saldo em ${s.from_currency}.`);
          const toCur = recipient.receive_currency;
          const quote = await kit.buildQuote({ amount: s.amount, from: s.from_currency, to: toCur,
            feeKind: s.from_currency !== toCur || user.country !== recipient.country ? 'international' : 'domestic' });
          return kit.move({ type: 'p2p', fromAcc: src, toAcc: await kit.ensureWallet(recipient.id, toCur), quote,
            note: s.note ? `${s.note} (envio automático)` : 'Envio automático', createdBy: user.id, idemKey: key });
        });
        await db.run("UPDATE scheduled_transfers SET last_status = 'ok', failures = 0, last_run_at = ?, next_run_at = ? WHERE id = ?",
          now(), nextRun(s.day_of_month, s.next_run_at, true), s.id);
        if (!res.replayed) notify(user.id, { title: '🔁 Envio automático feito', body: `${fmt(s.amount, s.from_currency)} para ${recipient.name}` });
        results.push({ id: s.id, ok: true, tx: res.transaction.id });
      } catch (err) {
        const failures = s.failures + 1;
        const giveUp = failures >= 3;
        await db.run('UPDATE scheduled_transfers SET last_status = ?, failures = ?, last_run_at = ?, next_run_at = ? WHERE id = ?',
          cleanText('Falhou: ' + err.message, 140), giveUp ? 0 : failures, now(),
          giveUp ? nextRun(s.day_of_month, s.next_run_at, true) : now() + 86_400_000, s.id);
        notify(user.id, { title: '⚠️ Envio automático falhou', body: `${fmt(s.amount, s.from_currency)} para ${recipient.name}: ${err.message}${giveUp ? ' Fica para o próximo mês.' : ' Tentamos de novo amanhã.'}` });
        results.push({ id: s.id, ok: false, error: err.message });
      }
    }
    return results;
  }

  let timer = null;
  function startScheduler(everyMs = 60_000) {
    if (timer) return;
    const tick = () => runDueScheduled().catch((err) => console.error('Envios automáticos:', err.message));
    tick();
    timer = setInterval(tick, everyMs);
    if (timer.unref) timer.unref();
  }

  return { createScheduled, listScheduled, cancelScheduled, runDueScheduled, startScheduler, _nextRun: nextRun };
};

module.exports.nextRun = nextRun;
module.exports.normalizePhone = normalizePhone;
