// Alertas automáticos contra fraude e branqueamento de capitais (AML).
// Depois de cada envio, verifica regras simples e abre um alerta para o
// admin rever. Não bloqueia sozinho: quem decide é uma pessoa (pode bloquear
// a conta no painel). Inclui exportação CSV para contabilidade / banco central.
const { ApiError, cleanText } = require('../util');

const RULES = {
  large_tx: 'Operação de valor elevado',
  velocity: 'Muitos envios numa hora',
  structuring: 'Envios repetidos perto do limite (possível fracionamento)',
  new_account: 'Conta nova a enviar valores altos',
  fan_in: 'Muitas pessoas diferentes a enviar para a mesma conta',
};

module.exports = function aml(kit) {
  const { db, C, rates, toEur, fmt, now, afterCommitHooks, requireRole, audit, OUTGOING } = kit;
  const A = C.AML;

  // Não repete o mesmo alerta para a mesma pessoa no mesmo dia.
  async function raise(userId, rule, detail, txId) {
    const dup = await db.get("SELECT 1 AS x FROM aml_alerts WHERE user_id = ? AND rule = ? AND status = 'open' AND created_at > ?", userId, rule, now() - 86_400_000);
    if (dup) return;
    await db.run('INSERT INTO aml_alerts (user_id, rule, detail, tx_id, created_at) VALUES (?, ?, ?, ?, ?)', userId, rule, detail, txId, now());
  }

  afterCommitHooks.push(async (txId) => {
    const t = await db.get('SELECT * FROM transactions WHERE id = ?', txId);
    if (!t || !OUTGOING.includes(t.type)) return;
    const fromAcc = await kit.accountById(t.from_account);
    const toAcc = await kit.accountById(t.to_account);
    if (!fromAcc.user_id) return;
    const user = await kit.userById(fromAcc.user_id);
    if (user.role !== 'user') return; // agentes e admin têm regras próprias
    const r = await rates();
    const eur = toEur(t.amount, t.currency, r);
    const day = now() - 86_400_000;

    if (eur >= A.largeTxEur) await raise(user.id, 'large_tx', `${fmt(t.amount, t.currency)} (≈ ${fmt(eur, 'EUR')}) numa só operação`, txId);

    const sent = await db.all(`SELECT t.amount, t.currency, t.created_at FROM transactions t JOIN accounts a ON a.id = t.from_account
                               WHERE a.user_id = ? AND t.type IN (${OUTGOING.map(() => '?').join(',')}) AND t.created_at > ?`, user.id, ...OUTGOING, day);
    const lastHour = sent.filter((x) => x.created_at > now() - 3_600_000).length;
    if (lastHour > A.velocityCount) await raise(user.id, 'velocity', `${lastHour} envios na última hora`, txId);

    const perTx = kit.limitsFor(user).perTx;
    const nearLimit = sent.filter((x) => toEur(x.amount, x.currency, r) >= perTx * A.structuringRatio).length;
    if (nearLimit >= 3) await raise(user.id, 'structuring', `${nearLimit} envios de 90–100% do limite (${fmt(perTx, 'EUR')}) em 24 h`, txId);

    const total = sent.reduce((s, x) => s + toEur(x.amount, x.currency, r), 0);
    if (user.created_at > now() - A.newAccountDays * 86_400_000 && total > A.newAccountEur) {
      await raise(user.id, 'new_account', `Conta com ${Math.floor((now() - user.created_at) / 86_400_000)} dias enviou ≈ ${fmt(total, 'EUR')} em 24 h`, txId);
    }

    if (toAcc.user_id) {
      const { n } = await db.get(`SELECT COUNT(DISTINCT a.user_id) AS n FROM transactions t JOIN accounts a ON a.id = t.from_account
                                  JOIN accounts b ON b.id = t.to_account WHERE b.user_id = ? AND t.type IN ('p2p','request') AND t.created_at > ?`, toAcc.user_id, day);
      if (n >= A.fanInSenders) await raise(toAcc.user_id, 'fan_in', `${n} pessoas diferentes enviaram-lhe dinheiro em 24 h`, txId);
    }
  });

  async function adminListAlerts(admin, { status = 'open' } = {}) {
    requireRole(admin, 'admin');
    const rows = await db.all('SELECT * FROM aml_alerts WHERE status = ? ORDER BY created_at DESC LIMIT 100', status === 'closed' ? 'closed' : 'open');
    return Promise.all(rows.map(async (a) => {
      const u = await kit.userById(a.user_id);
      return { id: a.id, rule: a.rule, rule_label: RULES[a.rule] || a.rule, detail: a.detail, status: a.status, note: a.note, created_at: a.created_at,
        user: { id: u.id, name: u.name, phone: u.phone, country: u.country, status: u.status, tier: u.tier } };
    }));
  }

  async function closeAlert(admin, id, { note, blockUser, pin }, ip) {
    requireRole(admin, 'admin');
    const why = cleanText(note, 200);
    if (!why) throw new ApiError(400, 'bad_reason', 'Escreva a conclusão da análise (fica registada).');
    await kit.checkPin(admin, pin, ip);
    const a = await db.get('SELECT * FROM aml_alerts WHERE id = ?', Number(id) || 0);
    if (!a) throw new ApiError(404, 'not_found', 'Alerta não encontrado.');
    if (a.status !== 'open') throw new ApiError(409, 'not_open', 'Este alerta já foi fechado.');
    await db.run("UPDATE aml_alerts SET status = 'closed', note = ?, reviewed_by = ? WHERE id = ?", why, admin.id, a.id);
    if (blockUser) {
      await db.run("UPDATE users SET status = 'blocked' WHERE id = ? AND role = 'user'", a.user_id);
      await db.run('DELETE FROM sessions WHERE user_id = ?', a.user_id);
    }
    await audit(admin.id, 'aml_alert_closed', { id: a.id, user: a.user_id, blockUser: !!blockUser, why }, ip);
    return adminListAlerts(admin);
  }

  // Exportação de movimentos (CSV, separador ";" como o Excel em português).
  async function exportTransactionsCsv(admin, { from, to } = {}) {
    requireRole(admin, 'admin');
    const start = Date.parse(from || '') || now() - 30 * 86_400_000;
    const end = (Date.parse(to || '') || now()) + 86_399_999;
    const rows = await db.all('SELECT * FROM transactions WHERE created_at BETWEEN ? AND ? ORDER BY created_at, seq LIMIT 50000', start, end);
    const party = async (accId) => {
      const acc = await kit.accountById(accId);
      if (!acc.user_id) return [`[${acc.kind}]`, ''];
      const u = await kit.userById(acc.user_id);
      return [u.name, u.phone];
    };
    const esc = (v) => { const s = String(v ?? ''); return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const dec = (c) => (c / 100).toFixed(2).replace('.', ',');
    const lines = [['data', 'id', 'tipo', 'de', 'telefone_de', 'para', 'telefone_para', 'valor', 'moeda', 'taxa', 'valor_recebido', 'moeda_recebida', 'cambio', 'nota'].join(';')];
    for (const t of rows) {
      const [fn, fp] = await party(t.from_account), [tn, tp] = await party(t.to_account);
      lines.push([new Date(t.created_at).toISOString(), t.id, t.type, fn, fp, tn, tp, dec(t.amount), t.currency, dec(t.fee),
        dec(t.to_amount), t.to_currency, String(t.rate).replace('.', ','), t.note].map(esc).join(';'));
    }
    await audit(admin.id, 'export_csv', { from: start, to: end, rows: rows.length });
    return '﻿' + lines.join('\r\n') + '\r\n'; // BOM para o Excel ler os acentos
  }

  return { adminListAlerts, closeAlert, exportTransactionsCsv, AML_RULES: RULES };
};
