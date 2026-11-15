// Regras de negócio: contas, PIN, carteiras multimoeda, câmbio, transferências,
// pedidos, depósitos e levantamentos em agentes, administração.
// Todas as operações de dinheiro correm dentro de tx() — atómicas.
const crypto = require('crypto');
const { tx } = require('./db');
const C = require('./config');
const {
  ApiError, normalizePhone, countryOfPhone, isCurrency, hashPin, verifyPin, isValidPin, sha256, cleanText, formatAmount,
} = require('./util');

const now = () => Date.now();
// O limite diário usa o dia UTC (São Tomé, Portugal no inverno, Cabo Verde ±1h).
const startOfDay = (t = now()) => t - (t % 86_400_000);
const OUTGOING = ['p2p', 'request', 'cash_out'];

function createService(db, { adminPhone } = {}) {
  const q = (sql) => db.prepare(sql);
  const adminPhoneNorm = adminPhone ? normalizePhone(adminPhone) : null;

  const userById = (id) => q('SELECT * FROM users WHERE id = ?').get(id);
  const userByPhone = (phone) => q('SELECT * FROM users WHERE phone = ?').get(phone);
  const accountById = (id) => q('SELECT * FROM accounts WHERE id = ?').get(id);
  const internal = (kind, cur) => q('SELECT * FROM accounts WHERE kind = ? AND currency = ?').get(kind, cur);
  const homeCurrency = (u) => C.COUNTRIES[u.country].currency;

  function audit(userId, action, detail, ip) {
    q('INSERT INTO audit_log (user_id, action, detail, ip, at) VALUES (?, ?, ?, ?, ?)')
      .run(userId ?? null, action, detail ? JSON.stringify(detail) : null, ip ?? null, now());
  }

  // ---------- Câmbio ----------
  const rates = () => Object.fromEntries(q('SELECT currency, per_eur FROM fx_rates').all().map((r) => [r.currency, r.per_eur]));
  const toEur = (cents, cur, r = rates()) => Math.round(cents / r[cur]);
  const fromEur = (eurCents, cur, r = rates()) => Math.round(eurCents * r[cur]);
  // Taxa aplicada: 1 unidade de "from" = rate unidades de "to" (já com a margem).
  function fxRate(from, to, r = rates()) {
    if (from === to) return 1;
    return (r[to] / r[from]) * (1 - C.FX_SPREAD);
  }
  const fmt = formatAmount;

  function needCurrency(cur, field = 'moeda') {
    if (!isCurrency(cur)) throw new ApiError(400, 'bad_currency', `${field} inválida. Moedas: ${Object.keys(C.CURRENCIES).join(', ')}.`);
    return cur;
  }

  // ---------- Carteiras ----------
  const walletOf = (userId, cur) => q("SELECT * FROM accounts WHERE kind = 'wallet' AND user_id = ? AND currency = ?").get(userId, cur);
  function ensureWallet(userId, cur) {
    const w = walletOf(userId, cur);
    if (w) return w;
    q("INSERT INTO accounts (user_id, kind, currency, balance) VALUES (?, 'wallet', ?, 0)").run(userId, cur);
    return walletOf(userId, cur);
  }
  const walletsOf = (userId) => q("SELECT * FROM accounts WHERE kind = 'wallet' AND user_id = ? ORDER BY id").all(userId);

  const limitsFor = (user) => (user.role === 'user' ? C.LIMITS[user.tier] || C.LIMITS[1] : C.AGENT_LIMITS);

  // Total enviado hoje (em cêntimos de euro), somando todas as carteiras.
  function sentTodayEur(userId, r = rates()) {
    const rows = q(`SELECT t.amount, t.fee, t.currency FROM transactions t JOIN accounts a ON a.id = t.from_account
                    WHERE a.user_id = ? AND t.type IN ('p2p','request','cash_out') AND t.created_at >= ?`).all(userId, startOfDay());
    return rows.reduce((s, t) => s + toEur(t.amount + t.fee, t.currency, r), 0);
  }
  const totalBalanceEur = (userId, r = rates()) => walletsOf(userId).reduce((s, w) => s + toEur(w.balance, w.currency, r), 0);

  function publicUser(u) {
    const limits = limitsFor(u);
    const r = rates();
    const wallets = walletsOf(u.id).map((w) => ({ currency: w.currency, balance: w.balance }));
    return {
      id: u.id, phone: u.phone, name: u.name, role: u.role, tier: u.tier,
      country: u.country, home_currency: homeCurrency(u), receive_currency: u.receive_currency,
      wallets,
      total_eur: wallets.reduce((s, w) => s + toEur(w.balance, w.currency, r), 0),
      limits: { // em cêntimos de euro
        perTx: Number.isFinite(limits.perTx) ? limits.perTx : null,
        daily: Number.isFinite(limits.daily) ? limits.daily : null,
        dailyUsed: sentTodayEur(u.id, r),
      },
    };
  }

  // ---------- PIN ----------
  function checkPin(user, pin, ip) {
    if (user.status !== 'active') throw new ApiError(403, 'blocked', 'Conta bloqueada. Contacte o apoio ao cliente.');
    if (user.locked_until > now()) {
      const min = Math.ceil((user.locked_until - now()) / 60000);
      throw new ApiError(423, 'pin_locked', `Demasiadas tentativas. Tente de novo dentro de ${min} min.`);
    }
    if (typeof pin !== 'string' || !verifyPin(pin, user.pin_hash)) {
      const fails = user.failed_pins + 1;
      const lock = fails >= C.PIN_MAX_FAILS ? now() + C.PIN_LOCK_MINUTES * 60000 : 0;
      q('UPDATE users SET failed_pins = ?, locked_until = ? WHERE id = ?').run(lock ? 0 : fails, lock, user.id);
      audit(user.id, 'pin_failed', { fails }, ip);
      if (lock) throw new ApiError(423, 'pin_locked', `PIN errado. Conta bloqueada por ${C.PIN_LOCK_MINUTES} minutos.`);
      throw new ApiError(401, 'wrong_pin', `PIN errado. Restam ${C.PIN_MAX_FAILS - fails} tentativas.`);
    }
    if (user.failed_pins) q('UPDATE users SET failed_pins = 0 WHERE id = ?').run(user.id);
  }

  // ---------- Contas e sessões ----------
  function register({ phone, name, pin, country }, ip) {
    const ctry = C.COUNTRIES[country] ? country : null;
    if (!ctry) throw new ApiError(400, 'bad_country', 'Escolha o seu país.');
    const p = normalizePhone(phone, ctry);
    if (!p) throw new ApiError(400, 'bad_phone', `Número inválido para ${C.COUNTRIES[ctry].name}. Exemplo: ${C.COUNTRIES[ctry].example}.`);
    const realCountry = countryOfPhone(p); // o número manda (ex.: escreveu +351 com país ST)
    const n = cleanText(name, 60);
    if (!n || n.length < 2) throw new ApiError(400, 'bad_name', 'Indique o seu nome completo.');
    if (!isValidPin(pin)) throw new ApiError(400, 'bad_pin', 'O PIN deve ter 4 a 6 dígitos e não pode ser óbvio (ex.: 1111, 1234).');
    if (userByPhone(p)) throw new ApiError(409, 'phone_taken', 'Este número já tem conta. Entre com o seu PIN.');
    const role = p === adminPhoneNorm ? 'admin' : 'user';
    const cur = C.COUNTRIES[realCountry].currency;
    const user = tx(db, () => {
      const { lastInsertRowid: id } = q(`INSERT INTO users (phone, country, name, pin_hash, receive_currency, role, created_at)
                                         VALUES (?, ?, ?, ?, ?, ?, ?)`).run(p, realCountry, n, hashPin(pin), cur, role, now());
      ensureWallet(id, cur);
      return userById(id);
    });
    audit(user.id, 'register', null, ip);
    return { token: newSession(user.id), user: publicUser(user) };
  }

  function login({ phone, pin, country }, ip) {
    const p = normalizePhone(phone, C.COUNTRIES[country] ? country : 'ST');
    const user = p && userByPhone(p);
    if (!user) throw new ApiError(401, 'bad_login', 'Número ou PIN errado.');
    checkPin(user, pin, ip);
    if (user.phone === adminPhoneNorm && user.role !== 'admin') q("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
    audit(user.id, 'login', null, ip);
    return { token: newSession(user.id), user: publicUser(userById(user.id)) };
  }

  function newSession(userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    q('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(sha256(token), userId, now() + C.SESSION_DAYS * 86_400_000);
    return token;
  }

  function userFromToken(token) {
    if (!token) return null;
    const s = q('SELECT * FROM sessions WHERE token_hash = ?').get(sha256(token));
    if (!s || s.expires_at < now()) return null;
    const u = userById(s.user_id);
    return u && u.status === 'active' ? u : null;
  }

  const logout = (token) => q('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));

  function changePin(user, { pin, newPin }, ip) {
    checkPin(user, pin, ip);
    if (!isValidPin(newPin)) throw new ApiError(400, 'bad_pin', 'O novo PIN deve ter 4 a 6 dígitos e não pode ser óbvio.');
    q('UPDATE users SET pin_hash = ? WHERE id = ?').run(hashPin(newPin), user.id);
    audit(user.id, 'pin_changed', null, ip);
  }

  // Escolher em que moeda quer receber (cria a carteira se ainda não existir).
  function setReceiveCurrency(user, currency) {
    needCurrency(currency);
    tx(db, () => {
      ensureWallet(user.id, currency);
      q('UPDATE users SET receive_currency = ? WHERE id = ?').run(currency, user.id);
    });
    return publicUser(userById(user.id));
  }

  function findRecipient(user, to) {
    const p = normalizePhone(to, user.country);
    if (!p) throw new ApiError(400, 'bad_phone', 'Número inválido. Para outro país, comece por + e o indicativo (ex.: +244, +351).');
    const u = userByPhone(p);
    if (!u || u.status !== 'active') throw new ApiError(404, 'not_found', `Este número ainda não tem conta ${C.APP_NAME}.`);
    return u;
  }

  function lookup(user, phone) {
    const u = findRecipient(user, phone);
    return { phone: u.phone, name: u.name, role: u.role, country: u.country, receive_currency: u.receive_currency };
  }

  // ---------- Cotações ----------
  // Quanto custa enviar `amount` (na moeda de origem) e quanto chega do outro lado.
  function feeFor(kind, amount, from, r) {
    const eur = toEur(amount, from, r);
    return fromEur(C.FEES[kind](eur), from, r);
  }
  function buildQuote({ amount, from, to, feeKind, exactTo }) {
    const r = rates();
    const rate = fxRate(from, to, r);
    // Contas feitas numa só expressão + pequena tolerância, para que
    // 245 000 × 0,99 / 24,5 dê exatamente 9 900 e não 9 899,999…
    const k = (r[to] * (1 - C.FX_SPREAD)) / r[from];
    let src = amount;
    // Para pedidos/levantamentos sabemos quanto tem de CHEGAR: calcula a origem.
    if (exactTo != null) src = from === to ? exactTo : Math.ceil(exactTo / k - 1e-6);
    const toAmount = exactTo != null ? exactTo : (from === to ? src : Math.floor(src * k + 1e-6));
    const fee = feeFor(feeKind, src, from, r);
    return {
      amount: src, currency: from, fee, total: src + fee,
      to_amount: toAmount, to_currency: to,
      rate: from === to ? 1 : Number(rate.toPrecision(8)),
      mid_rate: from === to ? 1 : Number((r[to] / r[from]).toPrecision(8)),
    };
  }
  const feeKindBetween = (a, b, fromCur, toCur) => (fromCur !== toCur || a.country !== b.country ? 'international' : 'domestic');

  function quoteTransfer(user, { to, amount, fromCurrency }) {
    const recipient = findRecipient(user, to);
    const from = needCurrency(fromCurrency || user.receive_currency);
    const toCur = recipient.receive_currency;
    return {
      ...buildQuote({ amount, from, to: toCur, feeKind: feeKindBetween(user, recipient, from, toCur) }),
      recipient: { name: recipient.name, phone: recipient.phone, country: recipient.country },
    };
  }

  function quoteExchange(user, { amount, fromCurrency, toCurrency }) {
    return buildQuote({ amount, from: needCurrency(fromCurrency), to: needCurrency(toCurrency), feeKind: 'exchange' });
  }

  // ---------- Motor de movimentos (dupla entrada por moeda) ----------
  function credit(accountId, amount, txId) {
    const { balance } = q('UPDATE accounts SET balance = balance + ? WHERE id = ? RETURNING balance').get(amount, accountId);
    q('INSERT INTO entries (tx_id, account_id, amount, balance_after) VALUES (?, ?, ?, ?)').run(txId, accountId, amount, balance);
  }

  // Tem de ser chamado DENTRO de tx(). `quote` vem de buildQuote().
  function move({ type, fromAcc, toAcc, quote, note, createdBy, idemKey, checkLimits = true, expectedTo }) {
    const r = rates();
    const { amount, fee, to_amount: toAmount, currency, to_currency: toCurrency } = quote;
    if (fromAcc.currency !== currency || toAcc.currency !== toCurrency) throw new Error('moeda da conta não corresponde à cotação');
    if (!Number.isSafeInteger(amount) || amount < 1 || toEur(amount, currency, r) < C.MIN_AMOUNT_EUR || toAmount < 1) {
      throw new ApiError(400, 'bad_amount', `Valor demasiado pequeno (mínimo ${fmt(fromEur(C.MIN_AMOUNT_EUR, currency, r), currency)}).`);
    }
    if (fromAcc.id === toAcc.id) throw new ApiError(400, 'same_account', 'Não pode enviar dinheiro para a mesma carteira.');
    // Proteção: se o câmbio mudou depois de o cliente ver a cotação, não envia menos do que ele viu.
    if (expectedTo != null && toAmount < expectedTo) {
      throw new ApiError(409, 'rate_changed', 'O câmbio mudou entretanto. Reveja o valor e confirme de novo.');
    }
    if (checkLimits && fromAcc.user_id && type !== 'exchange') {
      const lim = limitsFor(userById(fromAcc.user_id));
      const eur = toEur(amount, currency, r);
      if (eur > lim.perTx) throw new ApiError(403, 'limit_tx', `Limite por operação: ${fmt(lim.perTx, 'EUR')} (equivalente).`);
      if (OUTGOING.includes(type) && sentTodayEur(fromAcc.user_id, r) + toEur(amount + fee, currency, r) > lim.daily) {
        throw new ApiError(403, 'limit_daily', `Ultrapassa o limite diário de ${fmt(lim.daily, 'EUR')} (equivalente).`);
      }
    }
    if (checkLimits && toAcc.user_id && type !== 'exchange') {
      const lim = limitsFor(userById(toAcc.user_id));
      if (totalBalanceEur(toAcc.user_id, r) + toEur(toAmount, toCurrency, r) > lim.maxBalance) {
        throw new ApiError(403, 'limit_balance', 'O destinatário atingiu o saldo máximo permitido para a conta dele.');
      }
    }
    const cur = accountById(fromAcc.id);
    if (cur.kind === 'wallet' && cur.balance < amount + fee) {
      throw new ApiError(402, 'insufficient_funds', `Saldo insuficiente. Disponível: ${fmt(cur.balance, currency)}.`);
    }

    const id = crypto.randomUUID();
    q(`INSERT INTO transactions (id, type, from_account, to_account, amount, currency, to_amount, to_currency, rate, fee, note, created_by, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, type, fromAcc.id, toAcc.id, amount, currency, toAmount, toCurrency, quote.rate, fee, note ?? null, createdBy, idemKey ?? null, now());
    credit(fromAcc.id, -(amount + fee), id);
    if (currency === toCurrency) {
      credit(toAcc.id, amount, id);
    } else {
      // A mesa de câmbio recebe na moeda de origem e paga na moeda de destino.
      credit(internal('fx', currency).id, amount, id);
      credit(internal('fx', toCurrency).id, -toAmount, id);
      credit(toAcc.id, toAmount, id);
    }
    if (fee) credit(internal('fees', currency).id, fee, id);
    return id;
  }

  // Se o telemóvel repetir o pedido (rede fraca), devolve a mesma transação.
  function idempotent(user, idemKey, fn) {
    const key = cleanText(idemKey, 64);
    if (key) {
      const prev = q('SELECT id FROM transactions WHERE created_by = ? AND idempotency_key = ?').get(user.id, key);
      if (prev) return { transaction: txView(prev.id, user), replayed: true };
    }
    const id = tx(db, () => fn(key));
    return { transaction: txView(id, user), replayed: false };
  }

  function party(accountId) {
    const a = accountById(accountId);
    if (!a.user_id) return { name: a.kind === 'fees' ? 'Taxas' : C.APP_NAME, phone: null, user_id: null };
    const u = userById(a.user_id);
    return { name: u.name, phone: u.phone, country: u.country, user_id: u.id };
  }

  function txView(id, viewer) {
    const t = q('SELECT * FROM transactions WHERE id = ?').get(id);
    const from = party(t.from_account), to = party(t.to_account);
    let direction = null;
    if (viewer) direction = from.user_id === viewer.id && to.user_id === viewer.id ? 'self' : from.user_id === viewer.id ? 'out' : 'in';
    delete from.user_id; delete to.user_id;
    return {
      id: t.id, type: t.type, amount: t.amount, currency: t.currency, fee: t.fee,
      to_amount: t.to_amount, to_currency: t.to_currency, rate: t.rate,
      note: t.note, created_at: t.created_at, direction, from, to,
    };
  }

  // ---------- Operações do cliente ----------
  function transfer(user, { to, amount, fromCurrency, note, pin, idempotencyKey, expectedTo }, ip) {
    const recipient = findRecipient(user, to);
    if (recipient.id === user.id) throw new ApiError(400, 'same_account', 'Para mudar dinheiro entre as suas moedas use "Câmbio".');
    const from = needCurrency(fromCurrency || user.receive_currency);
    checkPin(user, pin, ip);
    const res = idempotent(user, idempotencyKey, (key) => {
      const src = walletOf(user.id, from);
      if (!src) throw new ApiError(402, 'insufficient_funds', `Não tem saldo em ${from}.`);
      const toCur = recipient.receive_currency;
      const quote = buildQuote({ amount, from, to: toCur, feeKind: feeKindBetween(user, recipient, from, toCur) });
      return move({ type: 'p2p', fromAcc: src, toAcc: ensureWallet(recipient.id, toCur), quote,
        note: cleanText(note, 140), createdBy: user.id, idemKey: key, expectedTo });
    });
    if (!res.replayed) audit(user.id, 'transfer', { tx: res.transaction.id, amount, currency: from }, ip);
    return res;
  }

  // Trocar dinheiro entre as próprias carteiras (ex.: Dobras → Euros).
  function exchange(user, { amount, fromCurrency, toCurrency, pin, idempotencyKey, expectedTo }, ip) {
    const from = needCurrency(fromCurrency), to = needCurrency(toCurrency);
    if (from === to) throw new ApiError(400, 'same_currency', 'Escolha duas moedas diferentes.');
    checkPin(user, pin, ip);
    const res = idempotent(user, idempotencyKey, (key) => {
      const src = walletOf(user.id, from);
      if (!src) throw new ApiError(402, 'insufficient_funds', `Não tem saldo em ${from}.`);
      return move({ type: 'exchange', fromAcc: src, toAcc: ensureWallet(user.id, to),
        quote: buildQuote({ amount, from, to, feeKind: 'exchange' }), note: `Câmbio ${from} → ${to}`,
        createdBy: user.id, idemKey: key, expectedTo });
    });
    if (!res.replayed) audit(user.id, 'exchange', { tx: res.transaction.id, amount, from, to }, ip);
    return res;
  }

  function history(user, { limit = 30, before } = {}) {
    const ids = walletsOf(user.id).map((w) => w.id);
    if (!ids.length) return [];
    const lim = Math.min(Math.max(Number(limit) || 30, 1), 100);
    const marks = ids.map(() => '?').join(',');
    const rows = q(`SELECT id FROM transactions WHERE (from_account IN (${marks}) OR to_account IN (${marks})) AND created_at < ?
                    ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(...ids, ...ids, Number(before) || 8.64e15, lim);
    return rows.map((r) => txView(r.id, user));
  }

  // ---------- Pedidos de dinheiro ----------
  function createRequest(user, { from, amount, currency, note }) {
    const payer = findRecipient(user, from);
    if (payer.id === user.id) throw new ApiError(400, 'same_account', 'Não pode pedir dinheiro a si próprio.');
    const cur = needCurrency(currency || user.receive_currency);
    if (!Number.isSafeInteger(amount) || toEur(amount, cur) < C.MIN_AMOUNT_EUR) throw new ApiError(400, 'bad_amount', 'Valor inválido.');
    const pending = q("SELECT COUNT(*) AS n FROM money_requests WHERE requester_id = ? AND payer_id = ? AND status = 'pending'").get(user.id, payer.id).n;
    if (pending >= 3) throw new ApiError(429, 'too_many_requests', 'Já tem 3 pedidos pendentes para esta pessoa.');
    const { lastInsertRowid } = q('INSERT INTO money_requests (requester_id, payer_id, amount, currency, note, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(user.id, payer.id, amount, cur, cleanText(note, 140), now());
    return requestView(q('SELECT * FROM money_requests WHERE id = ?').get(lastInsertRowid));
  }

  function requestView(r) {
    const a = userById(r.requester_id), b = userById(r.payer_id);
    return {
      id: r.id, amount: r.amount, currency: r.currency, note: r.note, status: r.status, created_at: r.created_at, tx_id: r.tx_id,
      requester: { name: a.name, phone: a.phone, country: a.country }, payer: { name: b.name, phone: b.phone, country: b.country },
    };
  }

  function listRequests(user) {
    const rows = q(`SELECT * FROM money_requests WHERE requester_id = ? OR payer_id = ?
                    ORDER BY (status = 'pending') DESC, created_at DESC LIMIT 50`).all(user.id, user.id);
    return rows.map((r) => ({ ...requestView(r), incoming: r.payer_id === user.id }));
  }

  function pendingRequestFor(user, id) {
    const r = q('SELECT * FROM money_requests WHERE id = ? AND payer_id = ?').get(Number(id), user.id);
    if (!r) throw new ApiError(404, 'not_found', 'Pedido não encontrado.');
    if (r.status !== 'pending') throw new ApiError(409, 'not_pending', 'Este pedido já foi tratado.');
    return r;
  }
  const requestQuote = (user, r, from) =>
    buildQuote({ from, to: r.currency, exactTo: r.amount, feeKind: feeKindBetween(user, userById(r.requester_id), from, r.currency) });

  function quoteRequest(user, id, { fromCurrency }) {
    const r = pendingRequestFor(user, id);
    return requestQuote(user, r, needCurrency(fromCurrency || user.receive_currency));
  }

  function payRequest(user, id, { pin, fromCurrency, idempotencyKey }, ip) {
    const r = pendingRequestFor(user, id);
    const from = needCurrency(fromCurrency || user.receive_currency);
    checkPin(user, pin, ip);
    const res = idempotent(user, idempotencyKey, (key) => {
      const cur = q('SELECT status FROM money_requests WHERE id = ?').get(r.id); // re-verifica dentro da transação
      if (cur.status !== 'pending') throw new ApiError(409, 'not_pending', 'Este pedido já foi tratado.');
      const src = walletOf(user.id, from);
      if (!src) throw new ApiError(402, 'insufficient_funds', `Não tem saldo em ${from}.`);
      const txId = move({ type: 'request', fromAcc: src, toAcc: ensureWallet(r.requester_id, r.currency),
        quote: requestQuote(user, r, from), note: r.note, createdBy: user.id, idemKey: key });
      q("UPDATE money_requests SET status = 'paid', tx_id = ? WHERE id = ?").run(txId, r.id);
      return txId;
    });
    audit(user.id, 'request_paid', { request: r.id }, ip);
    return res;
  }

  function closeRequest(user, id, action) {
    const col = action === 'decline' ? 'payer_id' : 'requester_id';
    const r = q(`SELECT * FROM money_requests WHERE id = ? AND ${col} = ?`).get(Number(id), user.id);
    if (!r) throw new ApiError(404, 'not_found', 'Pedido não encontrado.');
    if (r.status !== 'pending') throw new ApiError(409, 'not_pending', 'Este pedido já foi tratado.');
    q('UPDATE money_requests SET status = ? WHERE id = ?').run(action === 'decline' ? 'declined' : 'cancelled', r.id);
    return requestView(q('SELECT * FROM money_requests WHERE id = ?').get(r.id));
  }

  // ---------- Agentes: depósito (cash-in) e levantamento (cash-out) ----------
  const requireRole = (user, ...roles) => {
    if (!roles.includes(user.role)) throw new ApiError(403, 'forbidden', 'Sem permissão para esta operação.');
  };

  // O cliente entrega dinheiro vivo ao agente (na moeda do agente) e o valor
  // chega a QUALQUER cliente, em qualquer país, na moeda em que ele recebe.
  // Ex.: entrega Dobras em São Tomé → a filha em Espanha recebe Euros.
  function quoteCashIn(agent, { to, amount }) {
    requireRole(agent, 'agent', 'admin');
    const customer = findRecipient(agent, to);
    const from = homeCurrency(agent);
    return {
      ...buildQuote({ amount, from, to: customer.receive_currency, feeKind: feeKindBetween(agent, customer, from, customer.receive_currency) }),
      recipient: { name: customer.name, phone: customer.phone, country: customer.country },
    };
  }

  function cashIn(agent, { to, amount, pin, idempotencyKey, expectedTo }, ip) {
    requireRole(agent, 'agent', 'admin');
    const customer = findRecipient(agent, to);
    if (customer.id === agent.id) throw new ApiError(400, 'same_account', 'Não pode depositar na sua própria conta.');
    checkPin(agent, pin, ip);
    const from = homeCurrency(agent);
    const res = idempotent(agent, idempotencyKey, (key) => {
      const toCur = customer.receive_currency;
      return move({ type: 'cash_in', fromAcc: ensureWallet(agent.id, from), toAcc: ensureWallet(customer.id, toCur),
        quote: buildQuote({ amount, from, to: toCur, feeKind: feeKindBetween(agent, customer, from, toCur) }),
        note: 'Depósito no agente ' + agent.name, createdBy: agent.id, idemKey: key, expectedTo });
    });
    if (!res.replayed) audit(agent.id, 'cash_in', { tx: res.transaction.id, customer: customer.id, amount }, ip);
    return res;
  }

  // Passo 1: o cliente gera um código. Escolhe a moeda do dinheiro vivo (a do
  // país onde vai levantar) e de que carteira sai o dinheiro.
  function cashoutQuote(user, amount, currency, fromCurrency) {
    return buildQuote({ from: fromCurrency, to: currency, exactTo: amount, feeKind: 'cashOut' });
  }

  function quoteCashout(user, { amount, currency, fromCurrency }) {
    const cash = needCurrency(currency || homeCurrency(user));
    return cashoutQuote(user, amount, cash, needCurrency(fromCurrency || cash));
  }

  function createCashoutCode(user, { amount, currency, fromCurrency, pin }, ip) {
    const cash = needCurrency(currency || homeCurrency(user));
    const from = needCurrency(fromCurrency || cash);
    if (!Number.isSafeInteger(amount) || toEur(amount, cash) < C.MIN_AMOUNT_EUR) throw new ApiError(400, 'bad_amount', 'Valor inválido.');
    const quote = cashoutQuote(user, amount, cash, from);
    checkPin(user, pin, ip);
    const w = walletOf(user.id, from);
    if (!w || w.balance < quote.total) throw new ApiError(402, 'insufficient_funds', `Saldo insuficiente: precisa de ${fmt(quote.total, from)} (inclui taxa).`);
    q("UPDATE cashout_codes SET status = 'cancelled' WHERE user_id = ? AND status = 'pending'").run(user.id);
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const expires = now() + C.CASHOUT_CODE_MINUTES * 60000;
    q('INSERT INTO cashout_codes (user_id, amount, currency, from_currency, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(user.id, amount, cash, from, sha256(user.id + ':' + code), expires, now());
    audit(user.id, 'cashout_code', { amount, cash, from }, ip);
    return { code, amount, currency: cash, from_currency: from, fee: quote.fee, total: quote.total, expires_at: expires };
  }

  // Passo 2: o agente introduz telefone + código, entrega o dinheiro vivo e
  // recebe o valor eletrónico na sua carteira (a taxa vai para a empresa).
  function redeemCashout(agent, { phone, code, pin }, ip) {
    requireRole(agent, 'agent', 'admin');
    const customer = findRecipient(agent, phone);
    checkPin(agent, pin, ip);
    const c = q("SELECT * FROM cashout_codes WHERE user_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1").get(customer.id);
    if (!c || c.expires_at < now()) throw new ApiError(404, 'no_code', 'Não há código de levantamento válido para este cliente.');
    if (c.attempts >= C.CASHOUT_CODE_MAX_ATTEMPTS) throw new ApiError(423, 'code_locked', 'Código bloqueado. O cliente deve gerar outro.');
    const ok = typeof code === 'string' && crypto.timingSafeEqual(Buffer.from(sha256(customer.id + ':' + code)), Buffer.from(c.code_hash));
    if (!ok) {
      q('UPDATE cashout_codes SET attempts = attempts + 1 WHERE id = ?').run(c.id);
      audit(agent.id, 'cashout_bad_code', { customer: customer.id }, ip);
      throw new ApiError(401, 'bad_code', 'Código errado.');
    }
    if (c.currency !== homeCurrency(agent)) {
      throw new ApiError(409, 'wrong_currency', `Este levantamento é em ${c.currency}. Só um agente que paga em ${c.currency} o pode pagar.`);
    }
    const txId = tx(db, () => {
      const cur = q('SELECT status FROM cashout_codes WHERE id = ?').get(c.id);
      if (cur.status !== 'pending') throw new ApiError(409, 'code_used', 'Código já utilizado.');
      const src = walletOf(customer.id, c.from_currency);
      if (!src) throw new ApiError(402, 'insufficient_funds', 'O cliente já não tem saldo suficiente.');
      const id = move({ type: 'cash_out', fromAcc: src, toAcc: ensureWallet(agent.id, c.currency),
        quote: cashoutQuote(customer, c.amount, c.currency, c.from_currency),
        note: 'Levantamento no agente ' + agent.name, createdBy: agent.id });
      q("UPDATE cashout_codes SET status = 'used', agent_id = ?, tx_id = ? WHERE id = ?").run(agent.id, id, c.id);
      return id;
    });
    audit(agent.id, 'cash_out', { tx: txId, customer: customer.id, amount: c.amount }, ip);
    return { transaction: txView(txId, agent), pay_cash: c.amount, currency: c.currency, customer: { name: customer.name, phone: customer.phone } };
  }

  // ---------- Administração ----------
  // Emite dinheiro eletrónico para um agente (na moeda do país dele) depois de
  // ele depositar o equivalente em dinheiro real na conta bancária da empresa.
  function issueFloat(admin, { agentPhone, amount, reference, pin, idempotencyKey }, ip) {
    requireRole(admin, 'admin');
    const p = normalizePhone(agentPhone, admin.country);
    const agent = p && userByPhone(p);
    if (!agent || agent.role === 'user') throw new ApiError(404, 'not_found', 'Agente não encontrado (torne a conta "agente" primeiro).');
    const ref = cleanText(reference, 80);
    if (!ref) throw new ApiError(400, 'bad_reference', 'Indique a referência do depósito bancário.');
    checkPin(admin, pin, ip);
    const cur = homeCurrency(agent);
    const res = idempotent(admin, idempotencyKey, (key) => move({
      type: 'issue', fromAcc: internal('system_float', cur), toAcc: ensureWallet(agent.id, cur),
      quote: buildQuote({ amount, from: cur, to: cur, feeKind: 'exchange' }),
      note: 'Float: ' + ref, createdBy: admin.id, idemKey: key, checkLimits: false,
    }));
    if (!res.replayed) audit(admin.id, 'issue_float', { tx: res.transaction.id, agent: agent.id, amount, cur, ref }, ip);
    return res;
  }

  function listRates() {
    return q('SELECT currency, per_eur, updated_at FROM fx_rates').all().map((r) => ({
      ...r, name: C.CURRENCIES[r.currency].name, fixed: C.CURRENCIES[r.currency].fixed,
    }));
  }

  // Atualizar o câmbio (AOA e USD flutuam; STN e CVE têm paridade fixa ao euro).
  function setRate(admin, { currency, perEur, pin }, ip) {
    requireRole(admin, 'admin');
    needCurrency(currency);
    if (currency === 'EUR') throw new ApiError(400, 'base_currency', 'O euro é a moeda de referência (vale sempre 1).');
    const v = Number(perEur);
    if (!Number.isFinite(v) || v <= 0) throw new ApiError(400, 'bad_rate', 'Câmbio inválido.');
    const old = rates()[currency];
    // Evita erros de digitação graves (ex.: um zero a mais).
    if (v > old * 1.5 || v < old / 1.5) throw new ApiError(400, 'rate_jump', `Variação demasiado grande face ao câmbio atual (${old}). Confirme o valor.`);
    checkPin(admin, pin, ip);
    q('UPDATE fx_rates SET per_eur = ?, updated_at = ?, updated_by = ? WHERE currency = ?').run(v, now(), admin.id, currency);
    audit(admin.id, 'set_rate', { currency, from: old, to: v }, ip);
    return listRates();
  }

  function setRole(admin, userId, { role, tier, status }, ip) {
    requireRole(admin, 'admin');
    const u = userById(Number(userId));
    if (!u) throw new ApiError(404, 'not_found', 'Utilizador não encontrado.');
    if (u.id === admin.id && ((role && role !== 'admin') || status === 'blocked')) throw new ApiError(400, 'self', 'Não pode retirar os seus próprios privilégios.');
    if (role && !['user', 'agent', 'admin'].includes(role)) throw new ApiError(400, 'bad_role', 'Papel inválido.');
    if (tier && !C.LIMITS[tier]) throw new ApiError(400, 'bad_tier', 'Nível inválido.');
    if (status && !['active', 'blocked'].includes(status)) throw new ApiError(400, 'bad_status', 'Estado inválido.');
    q('UPDATE users SET role = COALESCE(?, role), tier = COALESCE(?, tier), status = COALESCE(?, status) WHERE id = ?')
      .run(role ?? null, tier ?? null, status ?? null, u.id);
    if (status === 'blocked') q('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    audit(admin.id, 'set_user', { user: u.id, role, tier, status }, ip);
    return publicUser(userById(u.id));
  }

  function listUsers(admin, { search = '' } = {}) {
    requireRole(admin, 'admin');
    const like = `%${String(search).slice(0, 40)}%`;
    const users = q(`SELECT id, phone, country, name, role, tier, status, created_at FROM users
                     WHERE phone LIKE ? OR name LIKE ? ORDER BY created_at DESC LIMIT 100`).all(like, like);
    return users.map((u) => ({ ...u, wallets: walletsOf(u.id).map((w) => ({ currency: w.currency, balance: w.balance })) }));
  }

  // Em cada moeda a soma de todos os saldos tem de ser 0, e cada saldo tem de
  // bater com a soma dos seus lançamentos.
  function ledgerCheck() {
    const sums = q('SELECT currency, SUM(balance) AS s FROM accounts GROUP BY currency').all();
    const unbalanced = sums.filter((r) => r.s !== 0).map((r) => r.currency);
    const mismatched = q(`SELECT a.id FROM accounts a
      LEFT JOIN (SELECT account_id, SUM(amount) AS s FROM entries GROUP BY account_id) e ON e.account_id = a.id
      WHERE a.balance <> COALESCE(e.s, 0)`).all().map((r) => r.id);
    return { ok: unbalanced.length === 0 && mismatched.length === 0, unbalanced_currencies: unbalanced, mismatched_accounts: mismatched };
  }

  function stats(admin) {
    requireRole(admin, 'admin');
    const r = rates();
    const byCurrency = Object.keys(C.CURRENCIES).map((cur) => ({
      currency: cur,
      emoney: -internal('system_float', cur).balance, // dinheiro eletrónico emitido (= o que tem de estar no banco)
      fees: internal('fees', cur).balance,
      fx_position: internal('fx', cur).balance,       // positivo = a mesa de câmbio tem; negativo = deve
    }));
    const eur = (k) => byCurrency.reduce((s, c) => s + toEur(c[k], c.currency, r), 0);
    return {
      users: q("SELECT COUNT(*) AS n FROM users WHERE role = 'user'").get().n,
      agents: q("SELECT COUNT(*) AS n FROM users WHERE role = 'agent'").get().n,
      by_currency: byCurrency,
      totals_eur: { emoney: eur('emoney'), fees: eur('fees'), fx_result: eur('fx_position') },
      today: q('SELECT COUNT(*) AS n FROM transactions WHERE created_at >= ?').get(startOfDay()),
      ledger: ledgerCheck(),
    };
  }

  return {
    register, login, logout, userFromToken, publicUser, changePin, setReceiveCurrency, lookup,
    quoteTransfer, quoteExchange, quoteRequest, quoteCashIn, quoteCashout,
    transfer, exchange, history, createRequest, listRequests, payRequest, closeRequest,
    cashIn, createCashoutCode, redeemCashout, issueFloat, listRates, setRate, setRole, listUsers, stats, ledgerCheck,
  };
}

module.exports = { createService };
