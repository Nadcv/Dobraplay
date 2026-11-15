// Regras de negócio: contas, PIN, carteiras multimoeda, câmbio, transferências,
// pedidos, depósitos e levantamentos em agentes, administração.
// Todas as operações de dinheiro correm dentro de db.tx() — atómicas — e
// bloqueiam as linhas que alteram (FOR UPDATE), para que dois pedidos ao mesmo
// tempo nunca gastem o mesmo dinheiro.
const crypto = require('crypto');
const C = require('./config');
const { isUniqueViolation } = require('./db');
const { createPayoutProviders } = require('./payouts');
const {
  ApiError, normalizePhone, countryOfPhone, isCurrency, hashPin, verifyPin, isValidPin, sha256, cleanText, formatAmount,
  normalizeIban, formatIban, randomCode,
} = require('./util');

const now = () => Date.now();
// O limite diário usa o dia UTC (São Tomé, Portugal no inverno, Cabo Verde ±1h).
const startOfDay = (t = now()) => t - (t % 86_400_000);
const OUTGOING = ['p2p', 'request', 'cash_out', 'bank_out', 'merchant'];
const fmt = formatAmount;

// Número crescente para ordenar o histórico quando duas operações têm o mesmo milissegundo.
let seqCounter = 0;
const nextSeq = () => now() * 1000 + (seqCounter++ % 1000);

function createService(db, { adminPhone, sandboxDelayMs, env } = {}) {
  const adminPhoneNorm = adminPhone ? normalizePhone(adminPhone) : null;
  // Parceiros de pagamento; as confirmações chegam a handlePayoutEvent.
  const providers = createPayoutProviders({ onEvent: (...a) => handlePayoutEvent(...a), sandboxDelayMs, env });
  const like = db.dialect === 'postgres' ? 'ILIKE' : 'LIKE';

  const userById = (id) => db.get('SELECT * FROM users WHERE id = ?', id);
  const userByPhone = (phone) => db.get('SELECT * FROM users WHERE phone = ?', phone);
  const accountById = (id) => db.get('SELECT * FROM accounts WHERE id = ?', id);
  const internal = (kind, cur) => db.get('SELECT * FROM accounts WHERE kind = ? AND currency = ?', kind, cur);
  const homeCurrency = (u) => C.COUNTRIES[u.country].currency;

  const audit = (userId, action, detail, ip) => db.run(
    'INSERT INTO audit_log (user_id, action, detail, ip, at) VALUES (?, ?, ?, ?, ?)',
    userId ?? null, action, detail ? JSON.stringify(detail) : null, ip ?? null, now(),
  );

  // ---------- Câmbio ----------
  let ratesCache = null;
  async function rates() {
    if (!ratesCache || ratesCache.at < now() - 10_000) {
      const rows = await db.all('SELECT currency, per_eur FROM fx_rates');
      ratesCache = { at: now(), map: Object.fromEntries(rows.map((r) => [r.currency, r.per_eur])) };
    }
    return ratesCache.map;
  }
  const toEur = (cents, cur, r) => Math.round(cents / r[cur]);
  const fromEur = (eurCents, cur, r) => Math.round(eurCents * r[cur]);

  function needCurrency(cur, field = 'moeda') {
    if (!isCurrency(cur)) throw new ApiError(400, 'bad_currency', `${field} inválida. Moedas: ${Object.keys(C.CURRENCIES).join(', ')}.`);
    return cur;
  }

  // ---------- Carteiras ----------
  const walletOf = (userId, cur) => db.get("SELECT * FROM accounts WHERE kind = 'wallet' AND user_id = ? AND currency = ?", userId, cur);
  async function ensureWallet(userId, cur) {
    await db.run("INSERT INTO accounts (user_id, kind, currency, balance) VALUES (?, 'wallet', ?, 0) ON CONFLICT DO NOTHING", userId, cur);
    return walletOf(userId, cur);
  }
  const walletsOf = (userId) => db.all("SELECT * FROM accounts WHERE kind = 'wallet' AND user_id = ? ORDER BY id", userId);

  const limitsFor = (user) => (user.role === 'user' ? C.LIMITS[user.tier] || C.LIMITS[1] : C.AGENT_LIMITS);

  // Total enviado hoje (em cêntimos de euro), somando todas as carteiras.
  async function sentTodayEur(userId, r) {
    const rows = await db.all(`SELECT t.amount, t.fee, t.currency FROM transactions t JOIN accounts a ON a.id = t.from_account
                               WHERE a.user_id = ? AND t.type IN (${OUTGOING.map(() => '?').join(',')}) AND t.created_at >= ?`, userId, ...OUTGOING, startOfDay());
    return rows.reduce((s, t) => s + toEur(t.amount + t.fee, t.currency, r), 0);
  }
  const totalBalanceEur = async (userId, r) => (await walletsOf(userId)).reduce((s, w) => s + toEur(w.balance, w.currency, r), 0);

  async function publicUser(u) {
    const limits = limitsFor(u);
    const r = await rates();
    const wallets = (await walletsOf(u.id)).map((w) => ({ currency: w.currency, balance: w.balance }));
    return {
      id: u.id, phone: u.phone, name: u.name, role: u.role, tier: u.tier, merchant_name: u.merchant_name || null,
      country: u.country, home_currency: homeCurrency(u), receive_currency: u.receive_currency,
      wallets,
      total_eur: wallets.reduce((s, w) => s + toEur(w.balance, w.currency, r), 0),
      limits: { // em cêntimos de euro
        perTx: Number.isFinite(limits.perTx) ? limits.perTx : null,
        daily: Number.isFinite(limits.daily) ? limits.daily : null,
        dailyUsed: await sentTodayEur(u.id, r),
      },
    };
  }

  // ---------- PIN ----------
  async function checkPin(user, pin, ip) {
    if (user.status !== 'active') throw new ApiError(403, 'blocked', 'Conta bloqueada. Contacte o apoio ao cliente.');
    if (user.locked_until > now()) {
      const min = Math.ceil((user.locked_until - now()) / 60000);
      throw new ApiError(423, 'pin_locked', `Demasiadas tentativas. Tente de novo dentro de ${min} min.`);
    }
    if (typeof pin !== 'string' || !verifyPin(pin, user.pin_hash)) {
      // Incremento atómico: vários pedidos em paralelo não "ganham" tentativas extra.
      const { failed_pins: fails } = await db.get('UPDATE users SET failed_pins = failed_pins + 1 WHERE id = ? RETURNING failed_pins', user.id);
      await audit(user.id, 'pin_failed', { fails }, ip);
      if (fails >= C.PIN_MAX_FAILS) {
        await db.run('UPDATE users SET failed_pins = 0, locked_until = ? WHERE id = ?', now() + C.PIN_LOCK_MINUTES * 60000, user.id);
        throw new ApiError(423, 'pin_locked', `PIN errado. Conta bloqueada por ${C.PIN_LOCK_MINUTES} minutos.`);
      }
      throw new ApiError(401, 'wrong_pin', `PIN errado. Restam ${C.PIN_MAX_FAILS - fails} tentativas.`);
    }
    if (user.failed_pins) await db.run('UPDATE users SET failed_pins = 0 WHERE id = ?', user.id);
  }

  // ---------- Contas e sessões ----------
  async function register({ phone, name, pin, country }, ip) {
    const ctry = C.COUNTRIES[country] ? country : null;
    if (!ctry) throw new ApiError(400, 'bad_country', 'Escolha o seu país.');
    const p = normalizePhone(phone, ctry);
    if (!p) throw new ApiError(400, 'bad_phone', `Número inválido para ${C.COUNTRIES[ctry].name}. Exemplo: ${C.COUNTRIES[ctry].example}.`);
    const realCountry = countryOfPhone(p); // o número manda (ex.: escreveu +351 com país ST)
    const n = cleanText(name, 60);
    if (!n || n.length < 2) throw new ApiError(400, 'bad_name', 'Indique o seu nome completo.');
    if (!isValidPin(pin)) throw new ApiError(400, 'bad_pin', 'O PIN deve ter 4 a 6 dígitos e não pode ser óbvio (ex.: 1111, 1234).');
    const taken = new ApiError(409, 'phone_taken', 'Este número já tem conta. Entre com o seu PIN.');
    if (await userByPhone(p)) throw taken;
    const role = p === adminPhoneNorm ? 'admin' : 'user';
    const cur = C.COUNTRIES[realCountry].currency;
    let user;
    try {
      user = await db.tx(async () => {
        const { id } = await db.get(`INSERT INTO users (phone, country, name, pin_hash, receive_currency, role, created_at)
                                     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`, p, realCountry, n, hashPin(pin), cur, role, now());
        await ensureWallet(id, cur);
        return userById(id);
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw taken; // dois registos do mesmo número ao mesmo tempo
      throw err;
    }
    await audit(user.id, 'register', null, ip);
    return { token: await newSession(user.id), user: await publicUser(user) };
  }

  async function login({ phone, pin, country }, ip) {
    const p = normalizePhone(phone, C.COUNTRIES[country] ? country : 'ST');
    const user = p && await userByPhone(p);
    if (!user) throw new ApiError(401, 'bad_login', 'Número ou PIN errado.');
    await checkPin(user, pin, ip);
    if (user.phone === adminPhoneNorm && user.role !== 'admin') await db.run("UPDATE users SET role = 'admin' WHERE id = ?", user.id);
    await audit(user.id, 'login', null, ip);
    return { token: await newSession(user.id), user: await publicUser(await userById(user.id)) };
  }

  async function newSession(userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    await db.run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
      sha256(token), userId, now() + C.SESSION_DAYS * 86_400_000);
    return token;
  }

  async function userFromToken(token) {
    if (!token) return null;
    const s = await db.get('SELECT * FROM sessions WHERE token_hash = ?', sha256(token));
    if (!s || s.expires_at < now()) return null;
    const u = await userById(s.user_id);
    return u && u.status === 'active' ? u : null;
  }

  const logout = (token) => db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));

  async function changePin(user, { pin, newPin }, ip) {
    await checkPin(user, pin, ip);
    if (!isValidPin(newPin)) throw new ApiError(400, 'bad_pin', 'O novo PIN deve ter 4 a 6 dígitos e não pode ser óbvio.');
    await db.run('UPDATE users SET pin_hash = ? WHERE id = ?', hashPin(newPin), user.id);
    await audit(user.id, 'pin_changed', null, ip);
  }

  // Escolher em que moeda quer receber (cria a carteira se ainda não existir).
  async function setReceiveCurrency(user, currency) {
    needCurrency(currency);
    await db.tx(async () => {
      await ensureWallet(user.id, currency);
      await db.run('UPDATE users SET receive_currency = ? WHERE id = ?', currency, user.id);
    });
    return publicUser(await userById(user.id));
  }

  async function findRecipient(user, to) {
    const p = normalizePhone(to, user.country);
    if (!p) throw new ApiError(400, 'bad_phone', 'Número inválido. Para outro país, comece por + e o indicativo (ex.: +244, +351).');
    const u = await userByPhone(p);
    if (!u || u.status !== 'active') throw new ApiError(404, 'not_found', `Este número ainda não tem conta ${C.APP_NAME}.`);
    return u;
  }

  async function lookup(user, phone) {
    const u = await findRecipient(user, phone);
    return { phone: u.phone, name: u.name, role: u.role, country: u.country, receive_currency: u.receive_currency };
  }

  // ---------- Liquidez ----------
  // Em cada moeda: excedente = dinheiro no banco − dinheiro dos clientes,
  // que é exatamente o saldo da mesa de câmbio + taxas dessa moeda.
  // Negativo = o banco dessa moeda está a dever (à espera de um acerto).
  async function liquidity(cur, { lock = false } = {}) {
    const fx = await db.get(`SELECT balance FROM accounts WHERE kind = 'fx' AND currency = ?${lock ? ' FOR UPDATE' : ''}`, cur);
    const fees = await db.get("SELECT balance FROM accounts WHERE kind = 'fees' AND currency = ?", cur);
    const lim = await db.get('SELECT max_shortfall FROM liquidity_limits WHERE currency = ?', cur);
    const surplus = fx.balance + fees.balance;
    const maxShortfall = lim ? lim.max_shortfall : null;
    return { surplus, max_shortfall: maxShortfall, available: maxShortfall == null ? null : Math.max(0, surplus + maxShortfall) };
  }

  const liquidityError = (cur, available) => new ApiError(503, 'liquidity_paused', available > 0
    ? `Neste momento só é possível fazer chegar até ${fmt(available, cur)} em ${cur}. Envie um valor menor ou tente mais tarde.`
    : `Os envios que chegam em ${cur} estão temporariamente pausados enquanto reforçamos o dinheiro nesse país. Tente mais tarde.`);

  // ---------- Cotações ----------
  function feeFor(kind, amount, from, r) {
    return fromEur(C.FEES[kind](toEur(amount, from, r)), from, r);
  }
  // Quanto custa enviar `amount` (na moeda de origem) e quanto chega do outro lado.
  async function buildQuote({ amount, from, to, feeKind, exactTo }) {
    const r = await rates();
    // Contas numa só expressão + pequena tolerância, para que
    // 245 000 × 0,99 / 24,5 dê exatamente 9 900 e não 9 899,999…
    const k = (r[to] * (1 - C.FX_SPREAD)) / r[from];
    let src = amount;
    // Para pedidos/levantamentos sabemos quanto tem de CHEGAR: calcula a origem.
    if (exactTo != null) src = from === to ? exactTo : Math.ceil(exactTo / k - 1e-6);
    const toAmount = exactTo != null ? exactTo : (from === to ? src : Math.floor(src * k + 1e-6));
    const fee = feeFor(feeKind, src, from, r);
    let paused;
    if (from !== to) {
      const liq = await liquidity(to);
      if (liq.available != null && toAmount > liq.available) paused = { available: liq.available, message: liquidityError(to, liq.available).message };
    }
    return {
      ...(paused ? { paused } : {}),
      amount: src, currency: from, fee, total: src + fee,
      to_amount: toAmount, to_currency: to,
      rate: from === to ? 1 : Number(k.toPrecision(8)),
      mid_rate: from === to ? 1 : Number((r[to] / r[from]).toPrecision(8)),
    };
  }
  // ---------- Câmbio garantido ----------
  // Cada cotação mostrada ao cliente fica guardada durante C.QUOTE_SECONDS.
  // Se ele confirmar a tempo (com o quote_id), paga exatamente o que viu,
  // mesmo que o câmbio mude entretanto. Cada cotação só pode ser usada uma vez.
  async function issueQuote(user, kind, key, q) {
    const id = crypto.randomUUID();
    const expires = now() + C.QUOTE_SECONDS * 1000;
    if (Math.random() < 0.02) await db.run('DELETE FROM quotes WHERE expires_at < ?', now() - 86_400_000); // limpeza
    await db.run('INSERT INTO quotes (id, user_id, kind, qkey, data, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id, user.id, kind, key, JSON.stringify(q), expires, now());
    return { ...q, quote_id: id, expires_at: expires, locked_seconds: C.QUOTE_SECONDS };
  }

  // Tem de ser chamado DENTRO de db.tx().
  async function takeQuote(user, id, kind, key) {
    const row = await db.get('SELECT * FROM quotes WHERE id = ? FOR UPDATE', String(id));
    const invalid = () => new ApiError(409, 'quote_invalid', 'Esta cotação já não corresponde ao pedido. Veja a nova cotação e confirme de novo.');
    if (!row || row.user_id !== user.id || row.kind !== kind || row.qkey !== key) throw invalid();
    if (row.used_at) throw new ApiError(409, 'quote_used', 'Esta cotação já foi usada. Veja a nova cotação e confirme de novo.');
    if (row.expires_at < now()) throw new ApiError(409, 'quote_expired', `O câmbio garantido expirou (${C.QUOTE_SECONDS} s). Veja a nova cotação e confirme de novo.`);
    await db.run('UPDATE quotes SET used_at = ? WHERE id = ?', now(), row.id);
    const q = JSON.parse(row.data);
    delete q.paused; delete q.recipient;
    return q;
  }
  const quoteOr = (user, quoteId, kind, key, compute) => (quoteId ? takeQuote(user, quoteId, kind, key) : compute());

  const feeKindBetween = (a, b, fromCur, toCur) => (fromCur !== toCur || a.country !== b.country ? 'international' : 'domestic');

  async function quoteTransfer(user, { to, amount, fromCurrency }) {
    const recipient = await findRecipient(user, to);
    const from = needCurrency(fromCurrency || user.receive_currency);
    const toCur = recipient.receive_currency;
    return issueQuote(user, 'transfer', `${recipient.id}|${from}|${toCur}|${amount}`, {
      ...await buildQuote({ amount, from, to: toCur, feeKind: feeKindBetween(user, recipient, from, toCur) }),
      recipient: { name: recipient.name, phone: recipient.phone, country: recipient.country },
    });
  }

  async function quoteExchange(user, { amount, fromCurrency, toCurrency }) {
    const from = needCurrency(fromCurrency), to = needCurrency(toCurrency);
    return issueQuote(user, 'exchange', `${from}|${to}|${amount}`, await buildQuote({ amount, from, to, feeKind: 'exchange' }));
  }

  // ---------- Motor de movimentos (dupla entrada por moeda) ----------
  // Tem de ser chamado DENTRO de db.tx(). `quote` vem de buildQuote().
  async function move({ type, fromAcc, toAcc, quote, note, createdBy, idemKey, checkLimits = true, expectedTo }) {
    const r = await rates();
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

    // Bloqueia o remetente: os pedidos dele passam a correr um de cada vez,
    // por isso o saldo e o limite diário verificados abaixo não mudam até ao fim.
    if (fromAcc.user_id) await db.get('SELECT id FROM users WHERE id = ? FOR UPDATE', fromAcc.user_id);

    if (checkLimits && fromAcc.user_id && type !== 'exchange') {
      const lim = limitsFor(await userById(fromAcc.user_id));
      const eur = toEur(amount, currency, r);
      if (eur > lim.perTx) throw new ApiError(403, 'limit_tx', `Limite por operação: ${fmt(lim.perTx, 'EUR')} (equivalente).`);
      if (OUTGOING.includes(type) && (await sentTodayEur(fromAcc.user_id, r)) + toEur(amount + fee, currency, r) > lim.daily) {
        throw new ApiError(403, 'limit_daily', `Ultrapassa o limite diário de ${fmt(lim.daily, 'EUR')} (equivalente).`);
      }
    }
    if (checkLimits && toAcc.user_id && type !== 'exchange') {
      const lim = limitsFor(await userById(toAcc.user_id));
      if ((await totalBalanceEur(toAcc.user_id, r)) + toEur(toAmount, toCurrency, r) > lim.maxBalance) {
        throw new ApiError(403, 'limit_balance', 'O destinatário atingiu o saldo máximo permitido para a conta dele.');
      }
    }
    const cur = await accountById(fromAcc.id);
    if (cur.kind === 'wallet' && cur.balance < amount + fee) {
      throw new ApiError(402, 'insufficient_funds', `Saldo insuficiente. Disponível: ${fmt(cur.balance, currency)}.`);
    }

    // Limite de liquidez: com conversão, a mesa de câmbio paga na moeda de
    // destino; não deixa o banco dessa moeda dever mais do que o permitido.
    // Bloqueia a mesa dessa moeda para que dois envios ao mesmo tempo não passem o limite.
    if (currency !== toCurrency && await db.get('SELECT 1 AS x FROM liquidity_limits WHERE currency = ?', toCurrency)) {
      const liq = await liquidity(toCurrency, { lock: true });
      if (toAmount > liq.available) throw liquidityError(toCurrency, liq.available);
    }

    const id = crypto.randomUUID();
    await db.run(`INSERT INTO transactions (id, type, from_account, to_account, amount, currency, to_amount, to_currency, rate, fee, note, created_by, idempotency_key, created_at, seq)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, type, fromAcc.id, toAcc.id, amount, currency, toAmount, toCurrency, quote.rate, fee, note ?? null, createdBy, idemKey ?? null, now(), nextSeq());

    const credits = [[fromAcc.id, -(amount + fee)]];
    if (currency === toCurrency) {
      credits.push([toAcc.id, amount]);
    } else {
      // A mesa de câmbio recebe na moeda de origem e paga na moeda de destino.
      credits.push([(await internal('fx', currency)).id, amount], [(await internal('fx', toCurrency)).id, -toAmount], [toAcc.id, toAmount]);
    }
    if (fee) credits.push([(await internal('fees', currency)).id, fee]);
    await applyCredits(id, credits);
    return id;
  }

  // Grava os lançamentos de uma transação. Atualiza as contas sempre pela mesma
  // ordem (por id) para evitar impasses entre dois pedidos que tocam as mesmas
  // contas em sentidos opostos. A soma por moeda tem de ser zero.
  async function applyCredits(txId, credits) {
    const byCurrency = {};
    for (const [accountId, value] of credits) {
      const { currency } = await accountById(accountId);
      byCurrency[currency] = (byCurrency[currency] || 0) + value;
    }
    if (Object.values(byCurrency).some((v) => v !== 0)) throw new Error('lançamentos desequilibrados: ' + JSON.stringify(byCurrency));
    credits.sort((a, b) => a[0] - b[0]);
    for (const [accountId, value] of credits) {
      const { balance } = await db.get('UPDATE accounts SET balance = balance + ? WHERE id = ? RETURNING balance', value, accountId);
      await db.run('INSERT INTO entries (tx_id, account_id, amount, balance_after) VALUES (?, ?, ?, ?)', txId, accountId, value, balance);
    }
  }

  // Regista uma transação "especial" (sem passar por move) e os seus lançamentos.
  async function recordTx({ type, fromAcc, toAcc, amount, currency, toAmount, toCurrency, rate = 1, fee = 0, note, createdBy, credits }) {
    const id = crypto.randomUUID();
    await db.run(`INSERT INTO transactions (id, type, from_account, to_account, amount, currency, to_amount, to_currency, rate, fee, note, created_by, idempotency_key, created_at, seq)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    id, type, fromAcc.id, toAcc.id, amount, currency, toAmount, toCurrency, rate, fee, note ?? null, createdBy, now(), nextSeq());
    await applyCredits(id, credits);
    return id;
  }

  // Se o telemóvel repetir o pedido (rede fraca), devolve a mesma transação.
  async function idempotent(user, idemKey, fn) {
    const key = cleanText(idemKey, 64);
    const previous = async () => {
      if (!key) return null;
      const prev = await db.get('SELECT id FROM transactions WHERE created_by = ? AND idempotency_key = ?', user.id, key);
      return prev && { transaction: await txView(prev.id, user), replayed: true };
    };
    const before = await previous();
    if (before) return before;
    try {
      const id = await db.tx(() => fn(key));
      return { transaction: await txView(id, user), replayed: false };
    } catch (err) {
      // Dois pedidos iguais ao mesmo tempo: o segundo devolve o resultado do primeiro.
      if (key && isUniqueViolation(err)) { const p = await previous(); if (p) return p; }
      throw err;
    }
  }

  async function party(accountId) {
    const a = await accountById(accountId);
    if (!a.user_id) return { name: { fees: 'Taxas', payout: 'Transferência bancária', system_float: C.APP_NAME, fx: 'Câmbio' }[a.kind] || C.APP_NAME, phone: null, user_id: null };
    const u = await userById(a.user_id);
    return { name: u.merchant_name || u.name, phone: u.phone, country: u.country, user_id: u.id, merchant: !!u.merchant_name };
  }

  async function txView(id, viewer) {
    const t = await db.get('SELECT * FROM transactions WHERE id = ?', id);
    const from = await party(t.from_account), to = await party(t.to_account);
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
  async function transfer(user, { to, amount, fromCurrency, note, pin, idempotencyKey, expectedTo, quoteId }, ip) {
    const recipient = await findRecipient(user, to);
    if (recipient.id === user.id) throw new ApiError(400, 'same_account', 'Para mudar dinheiro entre as suas moedas use "Câmbio".');
    const from = needCurrency(fromCurrency || user.receive_currency);
    await checkPin(user, pin, ip);
    const res = await idempotent(user, idempotencyKey, async (key) => {
      const src = await walletOf(user.id, from);
      if (!src) throw new ApiError(402, 'insufficient_funds', `Não tem saldo em ${from}.`);
      const toCur = recipient.receive_currency;
      const quote = await quoteOr(user, quoteId, 'transfer', `${recipient.id}|${from}|${toCur}|${amount}`,
        () => buildQuote({ amount, from, to: toCur, feeKind: feeKindBetween(user, recipient, from, toCur) }));
      return move({ type: 'p2p', fromAcc: src, toAcc: await ensureWallet(recipient.id, toCur), quote,
        note: cleanText(note, 140), createdBy: user.id, idemKey: key, expectedTo });
    });
    if (!res.replayed) await audit(user.id, 'transfer', { tx: res.transaction.id, amount, currency: from }, ip);
    return res;
  }

  // Trocar dinheiro entre as próprias carteiras (ex.: Dobras → Euros).
  async function exchange(user, { amount, fromCurrency, toCurrency, pin, idempotencyKey, expectedTo, quoteId }, ip) {
    const from = needCurrency(fromCurrency), to = needCurrency(toCurrency);
    if (from === to) throw new ApiError(400, 'same_currency', 'Escolha duas moedas diferentes.');
    await checkPin(user, pin, ip);
    const res = await idempotent(user, idempotencyKey, async (key) => {
      const src = await walletOf(user.id, from);
      if (!src) throw new ApiError(402, 'insufficient_funds', `Não tem saldo em ${from}.`);
      return move({ type: 'exchange', fromAcc: src, toAcc: await ensureWallet(user.id, to),
        quote: await quoteOr(user, quoteId, 'exchange', `${from}|${to}|${amount}`, () => buildQuote({ amount, from, to, feeKind: 'exchange' })),
        note: `Câmbio ${from} → ${to}`,
        createdBy: user.id, idemKey: key, expectedTo });
    });
    if (!res.replayed) await audit(user.id, 'exchange', { tx: res.transaction.id, amount, from, to }, ip);
    return res;
  }

  async function history(user, { limit = 30, before } = {}) {
    const ids = (await walletsOf(user.id)).map((w) => w.id);
    if (!ids.length) return [];
    const lim = Math.min(Math.max(Number(limit) || 30, 1), 100);
    const marks = ids.map(() => '?').join(',');
    const rows = await db.all(`SELECT id FROM transactions WHERE (from_account IN (${marks}) OR to_account IN (${marks})) AND created_at < ?
                               ORDER BY created_at DESC, seq DESC LIMIT ?`, ...ids, ...ids, Number(before) || 8.64e15, lim);
    return Promise.all(rows.map((r) => txView(r.id, user)));
  }

  // ---------- Pedidos de dinheiro ----------
  async function createRequest(user, { from, amount, currency, note }) {
    const payer = await findRecipient(user, from);
    if (payer.id === user.id) throw new ApiError(400, 'same_account', 'Não pode pedir dinheiro a si próprio.');
    const cur = needCurrency(currency || user.receive_currency);
    if (!Number.isSafeInteger(amount) || toEur(amount, cur, await rates()) < C.MIN_AMOUNT_EUR) throw new ApiError(400, 'bad_amount', 'Valor inválido.');
    const { n } = await db.get("SELECT COUNT(*) AS n FROM money_requests WHERE requester_id = ? AND payer_id = ? AND status = 'pending'", user.id, payer.id);
    if (n >= 3) throw new ApiError(429, 'too_many_requests', 'Já tem 3 pedidos pendentes para esta pessoa.');
    const { id } = await db.get('INSERT INTO money_requests (requester_id, payer_id, amount, currency, note, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
      user.id, payer.id, amount, cur, cleanText(note, 140), now());
    return requestView(await db.get('SELECT * FROM money_requests WHERE id = ?', id));
  }

  async function requestView(r) {
    const a = await userById(r.requester_id), b = await userById(r.payer_id);
    return {
      id: r.id, amount: r.amount, currency: r.currency, note: r.note, status: r.status, created_at: r.created_at, tx_id: r.tx_id,
      requester: { name: a.name, phone: a.phone, country: a.country }, payer: { name: b.name, phone: b.phone, country: b.country },
    };
  }

  async function listRequests(user) {
    const rows = await db.all(`SELECT * FROM money_requests WHERE requester_id = ? OR payer_id = ?
                               ORDER BY (status = 'pending') DESC, created_at DESC LIMIT 50`, user.id, user.id);
    return Promise.all(rows.map(async (r) => ({ ...await requestView(r), incoming: r.payer_id === user.id })));
  }

  async function pendingRequestFor(user, id, forUpdate = false) {
    const r = await db.get(`SELECT * FROM money_requests WHERE id = ? AND payer_id = ?${forUpdate ? ' FOR UPDATE' : ''}`, Number(id) || 0, user.id);
    if (!r) throw new ApiError(404, 'not_found', 'Pedido não encontrado.');
    if (r.status !== 'pending') throw new ApiError(409, 'not_pending', 'Este pedido já foi tratado.');
    return r;
  }
  const requestQuote = async (user, r, from) =>
    buildQuote({ from, to: r.currency, exactTo: r.amount, feeKind: feeKindBetween(user, await userById(r.requester_id), from, r.currency) });

  async function quoteRequest(user, id, { fromCurrency }) {
    const r = await pendingRequestFor(user, id);
    const from = needCurrency(fromCurrency || user.receive_currency);
    return issueQuote(user, 'request', `${r.id}|${from}`, await requestQuote(user, r, from));
  }

  async function payRequest(user, id, { pin, fromCurrency, idempotencyKey, quoteId }, ip) {
    const r = await pendingRequestFor(user, id);
    const from = needCurrency(fromCurrency || user.receive_currency);
    await checkPin(user, pin, ip);
    const res = await idempotent(user, idempotencyKey, async (key) => {
      await pendingRequestFor(user, r.id, true); // bloqueia e re-verifica: nunca paga duas vezes
      const src = await walletOf(user.id, from);
      if (!src) throw new ApiError(402, 'insufficient_funds', `Não tem saldo em ${from}.`);
      const txId = await move({ type: 'request', fromAcc: src, toAcc: await ensureWallet(r.requester_id, r.currency),
        quote: await quoteOr(user, quoteId, 'request', `${r.id}|${from}`, () => requestQuote(user, r, from)), note: r.note, createdBy: user.id, idemKey: key });
      await db.run("UPDATE money_requests SET status = 'paid', tx_id = ? WHERE id = ?", txId, r.id);
      return txId;
    });
    await audit(user.id, 'request_paid', { request: r.id }, ip);
    return res;
  }

  async function closeRequest(user, id, action) {
    const col = action === 'decline' ? 'payer_id' : 'requester_id';
    const status = action === 'decline' ? 'declined' : 'cancelled';
    const done = await db.run(`UPDATE money_requests SET status = ? WHERE id = ? AND ${col} = ? AND status = 'pending'`, status, Number(id) || 0, user.id);
    const r = await db.get(`SELECT * FROM money_requests WHERE id = ? AND ${col} = ?`, Number(id) || 0, user.id);
    if (!r) throw new ApiError(404, 'not_found', 'Pedido não encontrado.');
    if (!done.changes) throw new ApiError(409, 'not_pending', 'Este pedido já foi tratado.');
    return requestView(r);
  }

  // ---------- Agentes: depósito (cash-in) e levantamento (cash-out) ----------
  const requireRole = (user, ...roles) => {
    if (!roles.includes(user.role)) throw new ApiError(403, 'forbidden', 'Sem permissão para esta operação.');
  };

  // O cliente entrega dinheiro vivo ao agente (na moeda do agente) e o valor
  // chega a QUALQUER cliente, em qualquer país, na moeda em que ele recebe.
  // Ex.: entrega Dobras em São Tomé → a filha em Espanha recebe Euros.
  async function quoteCashIn(agent, { to, amount }) {
    requireRole(agent, 'agent', 'admin');
    const customer = await findRecipient(agent, to);
    const from = homeCurrency(agent);
    return issueQuote(agent, 'cash_in', `${customer.id}|${customer.receive_currency}|${amount}`, {
      ...await buildQuote({ amount, from, to: customer.receive_currency, feeKind: feeKindBetween(agent, customer, from, customer.receive_currency) }),
      recipient: { name: customer.name, phone: customer.phone, country: customer.country },
    });
  }

  async function cashIn(agent, { to, amount, pin, idempotencyKey, expectedTo, quoteId }, ip) {
    requireRole(agent, 'agent', 'admin');
    const customer = await findRecipient(agent, to);
    if (customer.id === agent.id) throw new ApiError(400, 'same_account', 'Não pode depositar na sua própria conta.');
    await checkPin(agent, pin, ip);
    const from = homeCurrency(agent);
    const res = await idempotent(agent, idempotencyKey, async (key) => {
      const toCur = customer.receive_currency;
      return move({ type: 'cash_in', fromAcc: await ensureWallet(agent.id, from), toAcc: await ensureWallet(customer.id, toCur),
        quote: await quoteOr(agent, quoteId, 'cash_in', `${customer.id}|${toCur}|${amount}`,
          () => buildQuote({ amount, from, to: toCur, feeKind: feeKindBetween(agent, customer, from, toCur) })),
        note: 'Depósito no agente ' + agent.name, createdBy: agent.id, idemKey: key, expectedTo });
    });
    if (!res.replayed) await audit(agent.id, 'cash_in', { tx: res.transaction.id, customer: customer.id, amount }, ip);
    return res;
  }

  // Levantamento: o cliente escolhe a moeda do dinheiro vivo (a do país onde
  // vai levantar) e de que carteira sai o dinheiro.
  const cashoutQuote = (amount, currency, fromCurrency) =>
    buildQuote({ from: fromCurrency, to: currency, exactTo: amount, feeKind: 'cashOut' });

  async function quoteCashout(user, { amount, currency, fromCurrency }) {
    const cash = needCurrency(currency || homeCurrency(user));
    return cashoutQuote(amount, cash, needCurrency(fromCurrency || cash));
  }

  // Passo 1: o cliente gera um código (válido 30 min).
  async function createCashoutCode(user, { amount, currency, fromCurrency, pin }, ip) {
    const cash = needCurrency(currency || homeCurrency(user));
    const from = needCurrency(fromCurrency || cash);
    if (!Number.isSafeInteger(amount) || toEur(amount, cash, await rates()) < C.MIN_AMOUNT_EUR) throw new ApiError(400, 'bad_amount', 'Valor inválido.');
    const quote = await cashoutQuote(amount, cash, from);
    await checkPin(user, pin, ip);
    const w = await walletOf(user.id, from);
    if (!w || w.balance < quote.total) throw new ApiError(402, 'insufficient_funds', `Saldo insuficiente: precisa de ${fmt(quote.total, from)} (inclui taxa).`);
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const expires = now() + C.CASHOUT_CODE_MINUTES * 60000;
    await db.tx(async () => {
      await db.run("UPDATE cashout_codes SET status = 'cancelled' WHERE user_id = ? AND status = 'pending'", user.id);
      await db.run('INSERT INTO cashout_codes (user_id, amount, currency, from_currency, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        user.id, amount, cash, from, sha256(user.id + ':' + code), expires, now());
    });
    await audit(user.id, 'cashout_code', { amount, cash, from }, ip);
    return { code, amount, currency: cash, from_currency: from, fee: quote.fee, total: quote.total, expires_at: expires };
  }

  // Passo 2: o agente introduz telefone + código, entrega o dinheiro vivo e
  // recebe o valor eletrónico na sua carteira (a taxa vai para a empresa).
  async function redeemCashout(agent, { phone, code, pin }, ip) {
    requireRole(agent, 'agent', 'admin');
    const customer = await findRecipient(agent, phone);
    await checkPin(agent, pin, ip);
    const pending = "SELECT * FROM cashout_codes WHERE user_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1";
    const c = await db.get(pending, customer.id);
    if (!c || c.expires_at < now()) throw new ApiError(404, 'no_code', 'Não há código de levantamento válido para este cliente.');
    if (c.attempts >= C.CASHOUT_CODE_MAX_ATTEMPTS) throw new ApiError(423, 'code_locked', 'Código bloqueado. O cliente deve gerar outro.');
    const ok = typeof code === 'string' && crypto.timingSafeEqual(Buffer.from(sha256(customer.id + ':' + code)), Buffer.from(c.code_hash));
    if (!ok) {
      await db.run('UPDATE cashout_codes SET attempts = attempts + 1 WHERE id = ?', c.id);
      await audit(agent.id, 'cashout_bad_code', { customer: customer.id }, ip);
      throw new ApiError(401, 'bad_code', 'Código errado.');
    }
    if (c.currency !== homeCurrency(agent)) {
      throw new ApiError(409, 'wrong_currency', `Este levantamento é em ${c.currency}. Só um agente que paga em ${c.currency} o pode pagar.`);
    }
    const txId = await db.tx(async () => {
      const cur = await db.get('SELECT status FROM cashout_codes WHERE id = ? FOR UPDATE', c.id); // nunca paga o mesmo código duas vezes
      if (cur.status !== 'pending') throw new ApiError(409, 'code_used', 'Código já utilizado.');
      const src = await walletOf(customer.id, c.from_currency);
      if (!src) throw new ApiError(402, 'insufficient_funds', 'O cliente já não tem saldo suficiente.');
      const id = await move({ type: 'cash_out', fromAcc: src, toAcc: await ensureWallet(agent.id, c.currency),
        quote: await cashoutQuote(c.amount, c.currency, c.from_currency),
        note: 'Levantamento no agente ' + agent.name, createdBy: agent.id });
      await db.run("UPDATE cashout_codes SET status = 'used', agent_id = ?, tx_id = ? WHERE id = ?", agent.id, id, c.id);
      return id;
    });
    await audit(agent.id, 'cash_out', { tx: txId, customer: customer.id, amount: c.amount }, ip);
    return { transaction: await txView(txId, agent), pay_cash: c.amount, currency: c.currency, customer: { name: customer.name, phone: customer.phone } };
  }

  // ---------- Administração ----------
  // Emite dinheiro eletrónico para um agente (na moeda do país dele) depois de
  // ele depositar o equivalente em dinheiro real na conta bancária da empresa.
  async function issueFloat(admin, { agentPhone, amount, reference, pin, idempotencyKey }, ip) {
    requireRole(admin, 'admin');
    const p = normalizePhone(agentPhone, admin.country);
    const agent = p && await userByPhone(p);
    if (!agent || agent.role === 'user') throw new ApiError(404, 'not_found', 'Agente não encontrado (torne a conta "agente" primeiro).');
    const ref = cleanText(reference, 80);
    if (!ref) throw new ApiError(400, 'bad_reference', 'Indique a referência do depósito bancário.');
    await checkPin(admin, pin, ip);
    const cur = homeCurrency(agent);
    const res = await idempotent(admin, idempotencyKey, async (key) => move({
      type: 'issue', fromAcc: await internal('system_float', cur), toAcc: await ensureWallet(agent.id, cur),
      quote: await buildQuote({ amount, from: cur, to: cur, feeKind: 'exchange' }),
      note: 'Float: ' + ref, createdBy: admin.id, idemKey: key, checkLimits: false,
    }));
    if (!res.replayed) await audit(admin.id, 'issue_float', { tx: res.transaction.id, agent: agent.id, amount, cur, ref }, ip);
    return res;
  }

  async function listRates() {
    const rows = await db.all('SELECT currency, per_eur, updated_at FROM fx_rates ORDER BY currency');
    return rows.map((r) => ({ ...r, name: C.CURRENCIES[r.currency].name, fixed: C.CURRENCIES[r.currency].fixed }));
  }

  // Atualizar o câmbio (AOA e USD flutuam; STN e CVE têm paridade fixa ao euro).
  async function setRate(admin, { currency, perEur, pin }, ip) {
    requireRole(admin, 'admin');
    needCurrency(currency);
    if (currency === 'EUR') throw new ApiError(400, 'base_currency', 'O euro é a moeda de referência (vale sempre 1).');
    const v = Number(perEur);
    if (!Number.isFinite(v) || v <= 0) throw new ApiError(400, 'bad_rate', 'Câmbio inválido.');
    ratesCache = null;
    const old = (await rates())[currency];
    // Evita erros de digitação graves (ex.: um zero a mais).
    if (v > old * 1.5 || v < old / 1.5) throw new ApiError(400, 'rate_jump', `Variação demasiado grande face ao câmbio atual (${old}). Confirme o valor.`);
    await checkPin(admin, pin, ip);
    await db.run('UPDATE fx_rates SET per_eur = ?, updated_at = ?, updated_by = ? WHERE currency = ?', v, now(), admin.id, currency);
    ratesCache = null;
    await audit(admin.id, 'set_rate', { currency, from: old, to: v }, ip);
    return listRates();
  }

  async function setRole(admin, userId, { role, tier, status, merchantName }, ip) {
    requireRole(admin, 'admin');
    const u = await userById(Number(userId) || 0);
    if (!u) throw new ApiError(404, 'not_found', 'Utilizador não encontrado.');
    if (u.id === admin.id && ((role && role !== 'admin') || status === 'blocked')) throw new ApiError(400, 'self', 'Não pode retirar os seus próprios privilégios.');
    if (role && !['user', 'agent', 'admin'].includes(role)) throw new ApiError(400, 'bad_role', 'Papel inválido.');
    if (tier && !C.LIMITS[tier]) throw new ApiError(400, 'bad_tier', 'Nível inválido.');
    if (status && !['active', 'blocked'].includes(status)) throw new ApiError(400, 'bad_status', 'Estado inválido.');
    await db.run('UPDATE users SET role = COALESCE(?, role), tier = COALESCE(?, tier), status = COALESCE(?, status) WHERE id = ?',
      role ?? null, tier ? Number(tier) : null, status ?? null, u.id);
    // Conta de loja: nome comercial preenchido; texto vazio desliga.
    if (merchantName !== undefined) {
      await db.run('UPDATE users SET merchant_name = ? WHERE id = ?', cleanText(merchantName, 60), u.id);
    }
    if (status === 'blocked') await db.run('DELETE FROM sessions WHERE user_id = ?', u.id);
    await audit(admin.id, 'set_user', { user: u.id, role, tier, status, merchantName }, ip);
    return publicUser(await userById(u.id));
  }

  async function listUsers(admin, { search = '' } = {}) {
    requireRole(admin, 'admin');
    const pattern = `%${String(search).slice(0, 40)}%`;
    const users = await db.all(`SELECT id, phone, country, name, role, tier, status, merchant_name, created_at FROM users
                                WHERE phone ${like} ? OR name ${like} ? OR merchant_name ${like} ? ORDER BY created_at DESC LIMIT 100`, pattern, pattern, pattern);
    return Promise.all(users.map(async (u) => ({
      ...u, wallets: (await walletsOf(u.id)).map((w) => ({ currency: w.currency, balance: w.balance })),
    })));
  }

  // Em cada moeda a soma de todos os saldos tem de ser 0, e cada saldo tem de
  // bater com a soma dos seus lançamentos.
  async function ledgerCheck() {
    const sums = await db.all('SELECT currency, SUM(balance) AS s FROM accounts GROUP BY currency');
    const unbalanced = sums.filter((r) => Number(r.s) !== 0).map((r) => r.currency);
    const mismatched = (await db.all(`SELECT a.id FROM accounts a
      LEFT JOIN (SELECT account_id, SUM(amount) AS s FROM entries GROUP BY account_id) e ON e.account_id = a.id
      WHERE a.balance <> COALESCE(e.s, 0)`)).map((r) => r.id);
    return { ok: unbalanced.length === 0 && mismatched.length === 0, unbalanced_currencies: unbalanced, mismatched_accounts: mismatched };
  }

  async function stats(admin) {
    requireRole(admin, 'admin');
    const r = await rates();
    const byCurrency = [];
    for (const cur of Object.keys(C.CURRENCIES)) {
      byCurrency.push({
        currency: cur,
        emoney: -(await internal('system_float', cur)).balance, // dinheiro eletrónico emitido (= o que tem de estar no banco)
        fees: (await internal('fees', cur)).balance,
        fx_position: (await internal('fx', cur)).balance,       // positivo = a mesa de câmbio tem; negativo = deve
        payouts_pending: (await internal('payout', cur)).balance, // levantamentos bancários por pagar
      });
    }
    const eur = (k) => byCurrency.reduce((s, c) => s + toEur(c[k], c.currency, r), 0);
    return {
      users: (await db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'user'")).n,
      agents: (await db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'agent'")).n,
      by_currency: byCurrency,
      totals_eur: { emoney: eur('emoney'), fees: eur('fees'), fx_result: eur('fx_position') },
      today: await db.get('SELECT COUNT(*) AS n FROM transactions WHERE created_at >= ?', startOfDay()),
      pending_bank: await db.get("SELECT COUNT(*) AS n FROM bank_requests WHERE status = 'pending'"),
      ledger: await ledgerCheck(),
    };
  }

  // =====================================================================
  // TRANSFERÊNCIAS BANCÁRIAS
  // A empresa tem uma conta bancária por moeda (ex.: EUR na CGD, STN no
  // BISTP). O cliente carrega a carteira transferindo para essa conta com uma
  // referência única; o admin confirma quando o dinheiro aparece no extrato.
  // Para levantar, o dinheiro sai logo da carteira (fica "por pagar") e o
  // admin faz a transferência para o IBAN do cliente.
  // =====================================================================
  const bankAccountView = (b) => b && ({ currency: b.currency, bank_name: b.bank_name, holder: b.holder, iban: formatIban(b.iban), swift: b.swift, updated_at: b.updated_at });

  async function listCompanyBankAccounts() {
    return (await db.all('SELECT * FROM company_bank_accounts ORDER BY currency')).map(bankAccountView);
  }

  async function setCompanyBankAccount(admin, { currency, bankName, holder, iban, swift, pin }, ip) {
    requireRole(admin, 'admin');
    needCurrency(currency);
    const ib = normalizeIban(iban || '');
    if (!ib) throw new ApiError(400, 'bad_iban', 'IBAN inválido. Confirme os dígitos.');
    const bn = cleanText(bankName, 80), h = cleanText(holder, 80);
    if (!bn || !h) throw new ApiError(400, 'bad_bank', 'Indique o nome do banco e o titular da conta.');
    await checkPin(admin, pin, ip);
    await db.run(`INSERT INTO company_bank_accounts (currency, bank_name, holder, iban, swift, updated_at) VALUES (?, ?, ?, ?, ?, ?)
                  ON CONFLICT (currency) DO UPDATE SET bank_name = excluded.bank_name, holder = excluded.holder, iban = excluded.iban,
                  swift = excluded.swift, updated_at = excluded.updated_at`, currency, bn, h, ib, cleanText(swift, 11), now());
    await audit(admin.id, 'set_bank_account', { currency, bank: bn }, ip);
    return listCompanyBankAccounts();
  }

  async function bankRequestView(r, { forAdmin = false } = {}) {
    const company = r.kind === 'deposit' ? bankAccountView(await db.get('SELECT * FROM company_bank_accounts WHERE currency = ?', r.currency)) : null;
    const v = {
      id: r.id, kind: r.kind, amount: r.amount, currency: r.currency, fee: r.fee, reference: r.reference,
      status: r.status, note: r.note, bank_reference: r.bank_reference, created_at: r.created_at, updated_at: r.updated_at,
      iban: r.iban ? formatIban(r.iban) : null, holder: r.holder, pay_to: company,
      from_currency: r.from_currency || r.currency, from_amount: r.from_amount ?? r.amount,
      beneficiary_phone: r.beneficiary_phone || null, third_party: !!(r.beneficiary_phone || (r.kind === 'withdrawal' && r.from_currency)),
      provider: r.provider || 'manual', provider_status: r.provider_status || null,
    };
    if (forAdmin) {
      const u = await userById(r.user_id);
      v.user = { id: u.id, name: u.name, phone: u.phone, country: u.country };
    }
    return v;
  }

  async function uniqueReference(prefix) {
    for (let i = 0; i < 10; i++) {
      const ref = prefix + randomCode(6);
      if (!(await db.get('SELECT 1 AS x FROM bank_requests WHERE reference = ?', ref))) return ref;
    }
    throw new Error('não foi possível gerar referência');
  }

  // Carregar: cria o pedido e mostra para onde transferir.
  async function createBankDeposit(user, { amount, currency }, ip) {
    const cur = needCurrency(currency || user.receive_currency);
    const r = await rates();
    if (!Number.isSafeInteger(amount) || toEur(amount, cur, r) < 100) throw new ApiError(400, 'bad_amount', `Valor mínimo: ${fmt(fromEur(100, cur, r), cur)}.`);
    const company = await db.get('SELECT * FROM company_bank_accounts WHERE currency = ?', cur);
    if (!company) throw new ApiError(409, 'no_bank', `Ainda não é possível carregar em ${cur} por transferência. Use um agente.`);
    const { n } = await db.get("SELECT COUNT(*) AS n FROM bank_requests WHERE user_id = ? AND kind = 'deposit' AND status = 'pending'", user.id);
    if (n >= 3) throw new ApiError(429, 'too_many_pending', 'Já tem 3 carregamentos pendentes. Aguarde a confirmação ou cancele um.');
    const ref = await uniqueReference('DP');
    const { id } = await db.get(`INSERT INTO bank_requests (user_id, kind, amount, currency, reference, created_at, updated_at)
                                 VALUES (?, 'deposit', ?, ?, ?, ?, ?) RETURNING id`, user.id, amount, cur, ref, now(), now());
    await audit(user.id, 'bank_deposit_request', { id, amount, cur }, ip);
    return bankRequestView(await db.get('SELECT * FROM bank_requests WHERE id = ?', id));
  }

  // =====================================================================
  // PAGAMENTOS PARA CONTAS BANCÁRIAS (levantamentos e envios para IBAN)
  // O cliente pode levantar para o seu IBAN ou ENVIAR para o IBAN de outra
  // pessoa que ainda não tem DobraPay, noutra moeda (ex.: paga em EUR e chega
  // em STN a uma conta no BISTP). O dinheiro sai logo da carteira para a
  // conta interna "por pagar" da moeda de destino; quem paga é o admin
  // (manual) ou um parceiro por API, que confirma por webhook.
  // =====================================================================
  const payoutKey = (from, dest, amount) => `${from}|${dest}|${amount}`;

  async function quoteBankWithdrawal(user, { amount, currency, fromCurrency }) {
    const dest = needCurrency(currency || user.receive_currency);
    const from = needCurrency(fromCurrency || dest);
    const q = await buildQuote({ from, to: dest, exactTo: amount, feeKind: 'bankOut' });
    return issueQuote(user, 'payout', payoutKey(from, dest, amount), q);
  }

  async function createBankWithdrawal(user, { amount, currency, fromCurrency, iban, holder, beneficiaryPhone, saveBeneficiary,
    pin, idempotencyKey, quoteId }, ip) {
    const dest = needCurrency(currency || user.receive_currency);
    const from = needCurrency(fromCurrency || dest);
    const ib = normalizeIban(iban || '');
    if (!ib) throw new ApiError(400, 'bad_iban', 'IBAN inválido. Confirme os dígitos (ex.: PT50 0000 0000 0000 0000 0000 0).');
    if (!Number.isSafeInteger(amount) || amount < 1) throw new ApiError(400, 'bad_amount', 'Valor inválido.');
    let phone = null;
    if (beneficiaryPhone) {
      phone = normalizePhone(beneficiaryPhone, user.country);
      if (!phone) throw new ApiError(400, 'bad_phone', 'Número do beneficiário inválido.');
    }
    const own = await db.get('SELECT * FROM user_bank_accounts WHERE user_id = ?', user.id);
    const h = cleanText(holder, 80) || (own && own.iban === ib ? own.holder : null) || (phone ? null : user.name);
    if (!h) throw new ApiError(400, 'bad_holder', 'Indique o nome do titular da conta.');
    if (!(await db.get('SELECT 1 AS x FROM company_bank_accounts WHERE currency = ?', dest))) {
      throw new ApiError(409, 'no_bank', `Ainda não é possível pagar em ${dest} para contas bancárias. Use um agente.`);
    }
    await checkPin(user, pin, ip);
    const ref = await uniqueReference('LV');
    const res = await idempotent(user, idempotencyKey, async (key) => {
      const src = await walletOf(user.id, from);
      if (!src) throw new ApiError(402, 'insufficient_funds', `Não tem saldo em ${from}.`);
      const quote = quoteId
        ? await takeQuote(user, quoteId, 'payout', payoutKey(from, dest, amount))
        : await buildQuote({ from, to: dest, exactTo: amount, feeKind: 'bankOut' });
      const txId = await move({ type: 'bank_out', fromAcc: src, toAcc: await internal('payout', dest), quote,
        note: `${phone || h !== user.name ? 'Envio para ' + h : 'Levantamento'} · ${formatIban(ib)} (${ref})`, createdBy: user.id, idemKey: key });
      await db.run(`INSERT INTO bank_requests (user_id, kind, amount, currency, fee, reference, iban, holder, tx_id, from_currency, from_amount,
                    beneficiary_phone, created_at, updated_at) VALUES (?, 'withdrawal', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      user.id, amount, dest, quote.fee, ref, ib, h, txId, from === dest ? null : from, quote.amount, phone, now(), now());
      return txId;
    });
    let req = await db.get('SELECT * FROM bank_requests WHERE tx_id = ?', res.transaction.id);
    if (!res.replayed) {
      await audit(user.id, 'bank_withdrawal_request', { id: req.id, amount, dest, from, third_party: !!phone }, ip);
      // Guarda o beneficiário (só para este cliente) para a próxima vez.
      if (h !== user.name && saveBeneficiary !== false) {
        await db.run(`INSERT INTO beneficiaries (owner_id, name, iban, currency, phone, created_at, last_used) VALUES (?, ?, ?, ?, ?, ?, ?)
                      ON CONFLICT (owner_id, iban) DO UPDATE SET name = excluded.name, currency = excluded.currency, phone = excluded.phone, last_used = excluded.last_used`,
        user.id, h, ib, dest, phone, now(), now());
      }
      await dispatchPayout(req);
      req = await db.get('SELECT * FROM bank_requests WHERE id = ?', req.id);
    }
    return { ...res, request: await bankRequestView(req) };
  }

  async function listMyBankRequests(user) {
    const rows = await db.all('SELECT * FROM bank_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 20', user.id);
    return Promise.all(rows.map((r) => bankRequestView(r)));
  }

  // Devolve à carteira um pagamento que não vai ser feito (valor + taxa), na
  // moeda de origem e ao mesmo câmbio, por isso o cliente recebe tudo de volta.
  async function refundWithdrawal(r, actorId, why) {
    const from = r.from_currency || r.currency;
    const srcAmount = r.from_amount ?? r.amount;
    const wallet = await ensureWallet(r.user_id, from);
    const payout = await internal('payout', r.currency);
    const credits = [[payout.id, -r.amount], [wallet.id, srcAmount + r.fee]];
    if (from !== r.currency) credits.push([(await internal('fx', r.currency)).id, r.amount], [(await internal('fx', from)).id, -srcAmount]);
    if (r.fee) credits.push([(await internal('fees', from)).id, -r.fee]);
    return recordTx({ type: 'refund', fromAcc: payout, toAcc: wallet, amount: r.amount, currency: r.currency,
      toAmount: srcAmount + r.fee, toCurrency: from, note: why, createdBy: actorId, credits });
  }

  async function lockedRequest(id, extra = '') {
    const r = await db.get(`SELECT * FROM bank_requests WHERE id = ?${extra} FOR UPDATE`, Number(id) || 0);
    if (!r) throw new ApiError(404, 'not_found', 'Pedido não encontrado.');
    if (r.status !== 'pending') throw new ApiError(409, 'not_pending', 'Este pedido já foi tratado.');
    return r;
  }

  async function cancelBankRequest(user, id, ip) {
    const out = await db.tx(async () => {
      const r = await lockedRequest(id, ` AND user_id = ${Number(user.id)}`);
      if (r.provider_status === 'submitted') throw new ApiError(409, 'already_sent', 'Este pagamento já foi enviado ao banco e não pode ser cancelado.');
      let txId = null;
      if (r.kind === 'withdrawal') txId = await refundWithdrawal(r, user.id, `Pagamento cancelado (${r.reference})`);
      await db.run("UPDATE bank_requests SET status = 'cancelled', final_tx_id = ?, updated_at = ? WHERE id = ?", txId, now(), r.id);
      return r.id;
    });
    await audit(user.id, 'bank_request_cancelled', { id: out }, ip);
    return bankRequestView(await db.get('SELECT * FROM bank_requests WHERE id = ?', out));
  }

  async function adminListBankRequests(admin, { status = 'pending' } = {}) {
    requireRole(admin, 'admin');
    const rows = status === 'all'
      ? await db.all('SELECT * FROM bank_requests ORDER BY created_at DESC LIMIT 100')
      : await db.all('SELECT * FROM bank_requests WHERE status = ? ORDER BY created_at ASC LIMIT 100', status);
    return Promise.all(rows.map((r) => bankRequestView(r, { forAdmin: true })));
  }

  // O dinheiro chegou ao banco: credita a carteira com o valor RECEBIDO.
  async function confirmBankDeposit(admin, id, { amount, bankReference, pin }, ip) {
    requireRole(admin, 'admin');
    await checkPin(admin, pin, ip);
    const txId = await db.tx(async () => {
      const r = await lockedRequest(id, " AND kind = 'deposit'");
      const received = amount == null ? r.amount : amount;
      if (!Number.isSafeInteger(received) || received < 1) throw new ApiError(400, 'bad_amount', 'Valor recebido inválido.');
      const t = await move({ type: 'bank_in', fromAcc: await internal('system_float', r.currency), toAcc: await ensureWallet(r.user_id, r.currency),
        quote: await buildQuote({ amount: received, from: r.currency, to: r.currency, feeKind: 'bankIn' }),
        note: `Transferência bancária (${r.reference})`, createdBy: admin.id });
      await db.run("UPDATE bank_requests SET status = 'completed', amount = ?, bank_reference = ?, tx_id = ?, handled_by = ?, updated_at = ? WHERE id = ?",
        received, cleanText(bankReference, 80), t, admin.id, now(), r.id);
      return t;
    });
    await audit(admin.id, 'bank_deposit_confirmed', { id, tx: txId }, ip);
    return bankRequestView(await db.get('SELECT * FROM bank_requests WHERE tx_id = ?', txId), { forAdmin: true });
  }

  // O dinheiro real saiu do banco da empresa: fecha o pagamento.
  async function finishPayout(r, actorId, bankReference, handledBy) {
    const payout = await internal('payout', r.currency), float = await internal('system_float', r.currency);
    const t = await recordTx({ type: 'bank_out', fromAcc: payout, toAcc: float, amount: r.amount, currency: r.currency,
      toAmount: r.amount, toCurrency: r.currency, note: `Pago ao banco (${r.reference})`, createdBy: actorId,
      credits: [[payout.id, -r.amount], [float.id, r.amount]] });
    await db.run("UPDATE bank_requests SET status = 'completed', bank_reference = ?, final_tx_id = ?, handled_by = ?, updated_at = ? WHERE id = ?",
      bankReference, t, handledBy ?? null, now(), r.id);
  }

  async function rejectRequestCore(r, actorId, why, handledBy) {
    let txId = null;
    if (r.kind === 'withdrawal') txId = await refundWithdrawal(r, actorId, `Pagamento recusado: ${why}`);
    await db.run("UPDATE bank_requests SET status = 'rejected', note = ?, final_tx_id = ?, handled_by = ?, updated_at = ? WHERE id = ?",
      why, txId, handledBy ?? null, now(), r.id);
  }

  // O admin já fez a transferência para o IBAN.
  async function completeBankWithdrawal(admin, id, { bankReference, pin }, ip) {
    requireRole(admin, 'admin');
    const ref = cleanText(bankReference, 80);
    if (!ref) throw new ApiError(400, 'bad_reference', 'Indique a referência da transferência feita no banco.');
    await checkPin(admin, pin, ip);
    await db.tx(async () => finishPayout(await lockedRequest(id, " AND kind = 'withdrawal'"), admin.id, ref, admin.id));
    await audit(admin.id, 'bank_withdrawal_paid', { id }, ip);
    return bankRequestView(await db.get('SELECT * FROM bank_requests WHERE id = ?', Number(id)), { forAdmin: true });
  }

  async function rejectBankRequest(admin, id, { reason, pin }, ip) {
    requireRole(admin, 'admin');
    const why = cleanText(reason, 140);
    if (!why) throw new ApiError(400, 'bad_reason', 'Indique o motivo (o cliente vai vê-lo).');
    await checkPin(admin, pin, ip);
    await db.tx(async () => rejectRequestCore(await lockedRequest(id), admin.id, why, admin.id));
    await audit(admin.id, 'bank_request_rejected', { id, why }, ip);
    return bankRequestView(await db.get('SELECT * FROM bank_requests WHERE id = ?', Number(id)), { forAdmin: true });
  }

  // ---------- Parceiros de pagamento ----------
  async function providerFor(currency) {
    const row = await db.get('SELECT provider FROM payout_providers WHERE currency = ?', currency);
    const name = row ? row.provider : 'manual';
    return providers[name] && providers[name].send ? name : 'manual';
  }

  // Envia a ordem ao parceiro (se a moeda tiver um). Se o parceiro falhar,
  // o pedido fica para pagamento manual, sem perder dinheiro.
  async function dispatchPayout(r) {
    const name = await providerFor(r.currency);
    if (name === 'manual') return;
    try {
      const { externalId } = await providers[name].send({ reference: r.reference, amount: r.amount, currency: r.currency, iban: r.iban, holder: r.holder });
      await db.run("UPDATE bank_requests SET provider = ?, external_id = ?, provider_status = 'submitted', updated_at = ? WHERE id = ? AND status = 'pending'",
        name, externalId, now(), r.id);
      await audit(null, 'payout_submitted', { id: r.id, provider: name, externalId });
    } catch (err) {
      await db.run("UPDATE bank_requests SET provider = ?, provider_status = 'error', note = ?, updated_at = ? WHERE id = ?",
        name, cleanText('Falha ao enviar ao parceiro (pagar manualmente): ' + err.message, 140), now(), r.id);
      await audit(null, 'payout_dispatch_failed', { id: r.id, provider: name, error: err.message });
    }
  }

  // Confirmação do parceiro (webhook ou simulador). Repetições são ignoradas.
  async function handlePayoutEvent(provider, { external_id: externalId, status, reason, bank_reference: bankRef } = {}) {
    if (!externalId || !['paid', 'failed'].includes(status)) throw new ApiError(400, 'bad_event', 'Evento inválido: precisa de external_id e status (paid/failed).');
    const result = await db.tx(async () => {
      const r = await db.get('SELECT * FROM bank_requests WHERE provider = ? AND external_id = ? FOR UPDATE', provider, String(externalId));
      if (!r) throw new ApiError(404, 'not_found', 'Pagamento desconhecido.');
      if (r.status !== 'pending') return { id: r.id, status: r.status, duplicate: true };
      await db.run('UPDATE bank_requests SET provider_status = ? WHERE id = ?', status, r.id);
      if (status === 'paid') await finishPayout(r, r.user_id, cleanText(bankRef, 80) || String(externalId), null);
      else await rejectRequestCore(r, r.user_id, cleanText(reason, 120) || 'o banco recusou a transferência', null);
      return { id: r.id, status: status === 'paid' ? 'completed' : 'rejected' };
    });
    await audit(null, 'payout_event', { provider, externalId, status, result });
    return result;
  }

  async function listPayoutProviders(admin) {
    requireRole(admin, 'admin');
    const rows = Object.fromEntries((await db.all('SELECT currency, provider FROM payout_providers')).map((x) => [x.currency, x.provider]));
    return {
      available: Object.entries(providers).map(([id, p]) => ({ id, label: p.label })),
      currencies: Object.keys(C.CURRENCIES).map((cur) => ({ currency: cur, provider: rows[cur] && providers[rows[cur]] ? rows[cur] : 'manual' })),
    };
  }

  async function setPayoutProvider(admin, { currency, provider, pin }, ip) {
    requireRole(admin, 'admin');
    needCurrency(currency);
    if (!providers[provider]) throw new ApiError(400, 'bad_provider', 'Parceiro desconhecido.');
    await checkPin(admin, pin, ip);
    await db.run(`INSERT INTO payout_providers (currency, provider, updated_at, updated_by) VALUES (?, ?, ?, ?)
                  ON CONFLICT (currency) DO UPDATE SET provider = excluded.provider, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    currency, provider, now(), admin.id);
    await audit(admin.id, 'set_payout_provider', { currency, provider }, ip);
    return listPayoutProviders(admin);
  }

  // ---------- Beneficiários e IBAN próprio ----------
  async function listBeneficiaries(user) {
    const rows = await db.all('SELECT * FROM beneficiaries WHERE owner_id = ? ORDER BY last_used DESC LIMIT 50', user.id);
    return rows.map((b) => ({ id: b.id, name: b.name, iban: formatIban(b.iban), currency: b.currency, phone: b.phone }));
  }
  async function deleteBeneficiary(user, id) {
    await db.run('DELETE FROM beneficiaries WHERE id = ? AND owner_id = ?', Number(id) || 0, user.id);
    return listBeneficiaries(user);
  }
  async function getMyBankAccount(user) {
    const b = await db.get('SELECT * FROM user_bank_accounts WHERE user_id = ?', user.id);
    return b ? { iban: formatIban(b.iban), holder: b.holder } : null;
  }
  async function setMyBankAccount(user, { iban, holder }) {
    if (!iban) { await db.run('DELETE FROM user_bank_accounts WHERE user_id = ?', user.id); return null; }
    const ib = normalizeIban(iban);
    if (!ib) throw new ApiError(400, 'bad_iban', 'IBAN inválido. Confirme os dígitos.');
    await db.run(`INSERT INTO user_bank_accounts (user_id, iban, holder, updated_at) VALUES (?, ?, ?, ?)
                  ON CONFLICT (user_id) DO UPDATE SET iban = excluded.iban, holder = excluded.holder, updated_at = excluded.updated_at`,
    user.id, ib, cleanText(holder, 80) || user.name, now());
    return getMyBankAccount(user);
  }

  // ---------- Acerto entre bancos ----------
  // Em cada moeda, o banco da empresa tem de ter pelo menos o dinheiro dos
  // clientes (carteiras + levantamentos por pagar). A diferença vem das taxas
  // e da mesa de câmbio: se for negativa, essa moeda precisa de receber
  // dinheiro de outro banco da empresa (ex.: EUR da CGD → STN no BISTP).
  async function settlementView(admin) {
    requireRole(admin, 'admin');
    const r = await rates();
    const rows = [];
    for (const cur of Object.keys(C.CURRENCIES)) {
      const inBank = -(await internal('system_float', cur)).balance;
      const { s: wallets } = await db.get("SELECT COALESCE(SUM(balance), 0) AS s FROM accounts WHERE kind = 'wallet' AND currency = ?", cur);
      const payouts = (await internal('payout', cur)).balance;
      const owed = Number(wallets) + payouts;
      const surplus = inBank - owed; // = taxas + mesa de câmbio
      const liq = await liquidity(cur);
      rows.push({ currency: cur, in_bank: inBank, owed_to_customers: owed, surplus, surplus_eur: toEur(surplus, cur, r),
        max_shortfall: liq.max_shortfall, available: liq.available,
        bank: bankAccountView(await db.get('SELECT * FROM company_bank_accounts WHERE currency = ?', cur)) });
    }
    // Sugestões: das moedas com excedente para as moedas em falta. As contas
    // fazem-se em euros sem arredondar, e o valor a receber é o exato em falta.
    const give = rows.filter((x) => x.surplus > 0).map((x) => ({ cur: x.currency, eur: x.surplus / r[x.currency] })).sort((a, b) => b.eur - a.eur);
    const need = rows.filter((x) => x.surplus < 0).map((x) => ({ cur: x.currency, left: -x.surplus })).sort((a, b) => b.left / r[b.cur] - a.left / r[a.cur]);
    const suggestions = [];
    for (const n of need) {
      for (const g of give) {
        if (n.left <= 0) break;
        if (g.eur <= 1e-9) continue;
        const needEur = n.left / r[n.cur];
        const eur = Math.min(needEur, g.eur);
        const toAmount = eur === needEur ? n.left : Math.floor(eur * r[n.cur]);
        if (toAmount < 1) continue;
        suggestions.push({ from_currency: g.cur, to_currency: n.cur, amount: Math.ceil(eur * r[g.cur] - 1e-6), to_amount: toAmount, eur: Math.round(eur) });
        n.left -= toAmount; g.eur -= eur;
      }
    }
    return { rows, suggestions };
  }

  // Define (ou retira, com null) o limite de liquidez de uma moeda.
  async function setLiquidityLimit(admin, { currency, maxShortfall, pin }, ip) {
    requireRole(admin, 'admin');
    needCurrency(currency);
    if (maxShortfall != null && (!Number.isSafeInteger(maxShortfall) || maxShortfall < 0)) throw new ApiError(400, 'bad_amount', 'Valor inválido.');
    await checkPin(admin, pin, ip);
    if (maxShortfall == null) await db.run('DELETE FROM liquidity_limits WHERE currency = ?', currency);
    else {
      await db.run(`INSERT INTO liquidity_limits (currency, max_shortfall, updated_at, updated_by) VALUES (?, ?, ?, ?)
                    ON CONFLICT (currency) DO UPDATE SET max_shortfall = excluded.max_shortfall, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      currency, maxShortfall, now(), admin.id);
    }
    await audit(admin.id, 'set_liquidity_limit', { currency, maxShortfall }, ip);
    return settlementView(admin);
  }

  // Regista uma transferência feita entre dois bancos da empresa.
  async function recordSettlement(admin, { fromCurrency, toCurrency, amount, toAmount, reference, pin }, ip) {
    requireRole(admin, 'admin');
    const from = needCurrency(fromCurrency), to = needCurrency(toCurrency);
    if (from === to) throw new ApiError(400, 'same_currency', 'Escolha duas moedas diferentes.');
    if (!Number.isSafeInteger(amount) || amount < 1 || !Number.isSafeInteger(toAmount) || toAmount < 1) throw new ApiError(400, 'bad_amount', 'Valores inválidos.');
    const ref = cleanText(reference, 80);
    if (!ref) throw new ApiError(400, 'bad_reference', 'Indique a referência da transferência bancária.');
    await checkPin(admin, pin, ip);
    const txId = await db.tx(async () => {
      const fFloat = await internal('system_float', from), fFx = await internal('fx', from);
      const tFloat = await internal('system_float', to), tFx = await internal('fx', to);
      // Sai dinheiro real do banco "from" e entra no banco "to"; a mesa de câmbio acerta.
      return recordTx({ type: 'settlement', fromAcc: fFx, toAcc: tFx, amount, currency: from, toAmount, toCurrency: to,
        rate: Number((toAmount / amount).toPrecision(8)), note: `Acerto entre bancos: ${ref}`, createdBy: admin.id,
        credits: [[fFloat.id, amount], [fFx.id, -amount], [tFx.id, toAmount], [tFloat.id, -toAmount]] });
    });
    await audit(admin.id, 'settlement', { tx: txId, from, to, amount, toAmount, ref }, ip);
    return settlementView(admin);
  }

  // =====================================================================
  // PAGAMENTOS EM LOJAS (QR)
  // A loja cria uma cobrança (valor na moeda dela); o cliente lê o QR ou
  // escreve o código e paga com qualquer carteira. A loja recebe o valor exato.
  // =====================================================================
  const requireMerchant = (u) => {
    if (!u.merchant_name) throw new ApiError(403, 'not_merchant', 'Esta conta não é uma conta de loja. Peça ao administrador para a ativar.');
  };

  async function chargeView(c, viewer) {
    const m = await userById(c.merchant_id);
    const v = {
      id: c.id, code: c.code, amount: c.amount, currency: c.currency, description: c.description,
      status: c.status === 'pending' && c.expires_at < now() ? 'expired' : c.status,
      expires_at: c.expires_at, created_at: c.created_at,
      merchant: { name: m.merchant_name || m.name, country: m.country },
    };
    if (c.payer_id && viewer && viewer.id === c.merchant_id) {
      const p = await userById(c.payer_id);
      v.payer = { name: p.name, phone: p.phone };
    }
    return v;
  }

  async function createCharge(merchant, { amount, description }, ip) {
    requireMerchant(merchant);
    const cur = merchant.receive_currency;
    if (!Number.isSafeInteger(amount) || toEur(amount, cur, await rates()) < C.MIN_AMOUNT_EUR) throw new ApiError(400, 'bad_amount', 'Valor inválido.');
    for (let i = 0; i < 10; i++) {
      const code = randomCode(6);
      try {
        const id = crypto.randomUUID();
        await db.run(`INSERT INTO charges (id, code, merchant_id, amount, currency, description, expires_at, created_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, id, code, merchant.id, amount, cur, cleanText(description, 80),
        now() + C.CHARGE_MINUTES * 60000, now());
        await audit(merchant.id, 'charge_created', { id, amount, cur }, ip);
        return chargeView(await db.get('SELECT * FROM charges WHERE id = ?', id), merchant);
      } catch (err) { if (!isUniqueViolation(err)) throw err; }
    }
    throw new Error('não foi possível gerar código');
  }

  const findCharge = async (code) => {
    const c = await db.get('SELECT * FROM charges WHERE code = ?', String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6));
    if (!c) throw new ApiError(404, 'not_found', 'Código de pagamento não encontrado. Confirme as letras e números.');
    return c;
  };

  // O cliente vê a cobrança e quanto vai pagar com a carteira escolhida.
  async function getCharge(user, code, { fromCurrency } = {}) {
    const c = await findCharge(code);
    const view = await chargeView(c, user);
    if (view.status === 'pending' && user.id !== c.merchant_id) {
      const from = needCurrency(fromCurrency || user.receive_currency);
      view.quote = await issueQuote(user, 'charge', `${c.id}|${from}`, await buildQuote({ from, to: c.currency, exactTo: c.amount, feeKind: 'merchant' }));
    }
    return view;
  }

  async function payCharge(user, code, { fromCurrency, pin, idempotencyKey, quoteId }, ip) {
    const c0 = await findCharge(code);
    if (c0.merchant_id === user.id) throw new ApiError(400, 'same_account', 'Não pode pagar a sua própria cobrança.');
    const from = needCurrency(fromCurrency || user.receive_currency);
    await checkPin(user, pin, ip);
    const res = await idempotent(user, idempotencyKey, async (key) => {
      const c = await db.get('SELECT * FROM charges WHERE id = ? FOR UPDATE', c0.id); // nunca paga a mesma cobrança duas vezes
      if (c.status === 'paid') throw new ApiError(409, 'already_paid', 'Esta cobrança já foi paga.');
      if (c.status !== 'pending') throw new ApiError(409, 'cancelled', 'Esta cobrança foi cancelada pela loja.');
      if (c.expires_at < now()) throw new ApiError(410, 'expired', 'Esta cobrança expirou. Peça à loja um novo código.');
      const src = await walletOf(user.id, from);
      if (!src) throw new ApiError(402, 'insufficient_funds', `Não tem saldo em ${from}.`);
      const m = await userById(c.merchant_id);
      const txId = await move({ type: 'merchant', fromAcc: src, toAcc: await ensureWallet(c.merchant_id, c.currency),
        quote: await quoteOr(user, quoteId, 'charge', `${c.id}|${from}`, () => buildQuote({ from, to: c.currency, exactTo: c.amount, feeKind: 'merchant' })),
        note: c.description || `Pagamento em ${m.merchant_name}`, createdBy: user.id, idemKey: key });
      await db.run("UPDATE charges SET status = 'paid', payer_id = ?, tx_id = ? WHERE id = ?", user.id, txId, c.id);
      return txId;
    });
    if (!res.replayed) await audit(user.id, 'charge_paid', { charge: c0.id, tx: res.transaction.id }, ip);
    return res;
  }

  async function merchantCharge(merchant, id) {
    const c = await db.get('SELECT * FROM charges WHERE id = ? AND merchant_id = ?', String(id), merchant.id);
    if (!c) throw new ApiError(404, 'not_found', 'Cobrança não encontrada.');
    return chargeView(c, merchant);
  }

  async function listMerchantCharges(merchant) {
    requireMerchant(merchant);
    const rows = await db.all('SELECT * FROM charges WHERE merchant_id = ? ORDER BY created_at DESC LIMIT 30', merchant.id);
    return Promise.all(rows.map((c) => chargeView(c, merchant)));
  }

  async function cancelCharge(merchant, id) {
    const done = await db.run("UPDATE charges SET status = 'cancelled' WHERE id = ? AND merchant_id = ? AND status = 'pending'", String(id), merchant.id);
    if (!done.changes) throw new ApiError(409, 'not_pending', 'Esta cobrança já não pode ser cancelada.');
    return merchantCharge(merchant, id);
  }

  return {
    register, login, logout, userFromToken, publicUser, changePin, setReceiveCurrency, lookup,
    quoteTransfer, quoteExchange, quoteRequest, quoteCashIn, quoteCashout,
    transfer, exchange, history, createRequest, listRequests, payRequest, closeRequest,
    cashIn, createCashoutCode, redeemCashout, issueFloat, listRates, setRate, setRole, listUsers, stats, ledgerCheck,
    listCompanyBankAccounts, setCompanyBankAccount, createBankDeposit, quoteBankWithdrawal, createBankWithdrawal, listMyBankRequests,
    cancelBankRequest, adminListBankRequests, confirmBankDeposit, completeBankWithdrawal, rejectBankRequest, settlementView, recordSettlement, setLiquidityLimit,
    handlePayoutEvent, listPayoutProviders, setPayoutProvider, listBeneficiaries, deleteBeneficiary, getMyBankAccount, setMyBankAccount,
    createCharge, getCharge, payCharge, merchantCharge, listMerchantCharges, cancelCharge,
  };
}

module.exports = { createService };
