// API HTTP (Express). Toda a lógica de dinheiro está em service.js.
const express = require('express');
const path = require('path');
const QRCode = require('qrcode');
const C = require('./config');
const { ApiError, parseAmount } = require('./util');
const { isCheckViolation, isUniqueViolation } = require('./db');

// Limitador simples em memória. Para vários servidores, usar Redis.
// A chave por omissão é o UTILIZADOR (ou o número de telefone no login), e não
// só o IP: as operadoras móveis põem muitos clientes atrás do mesmo IP, e um
// limite por IP bloquearia pessoas inocentes.
const byUser = (req) => (req.user ? 'u' + req.user.id : 'ip' + req.ip);
const byIpAndPhone = (req) => req.ip + '|' + String((req.body && req.body.phone) || '').replace(/\D/g, '').slice(-9);

function rateLimit({ windowMs, max, key = byUser }) {
  const hits = new Map();
  setInterval(() => { const t = Date.now(); for (const [k, v] of hits) if (v.reset < t) hits.delete(k); }, windowMs).unref();
  return (req, res, next) => {
    const k = key(req) + req.baseUrl + req.route.path;
    const t = Date.now();
    let h = hits.get(k);
    if (!h || h.reset < t) { h = { n: 0, reset: t + windowMs }; hits.set(k, h); }
    if (++h.n > max) return next(new ApiError(429, 'rate_limited', 'Demasiados pedidos. Aguarde um pouco.'));
    next();
  };
}

function createApp(service) {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '20kb' }));

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(self), geolocation=()',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; manifest-src 'self'; media-src 'self' blob:; frame-ancestors 'none'",
    });
    if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  });

  app.use(express.static(path.join(__dirname, '..', 'public')));

  const api = express.Router();
  const wrap = (fn) => async (req, res, next) => { try { const out = await fn(req, res); if (out !== undefined) res.json(out); } catch (e) { next(e); } };
  const bearer = (req) => (req.get('authorization') || '').replace(/^Bearer\s+/i, '') || null;
  const auth = async (req, res, next) => {
    try {
      req.user = await service.userFromToken(bearer(req));
      if (!req.user) return next(new ApiError(401, 'unauthorized', 'Sessão expirada. Entre de novo.'));
      next();
    } catch (e) { next(e); }
  };
  const amount = (v) => {
    const a = parseAmount(v);
    if (a == null) throw new ApiError(400, 'bad_amount', 'Valor inválido. Exemplo: 250 ou 250,50');
    return a;
  };
  const body = (req) => req.body || {};

  // Valor esperado do outro lado (o que o cliente viu na cotação), opcional.
  const expected = (v) => (v == null || v === '' ? undefined : Number.isSafeInteger(Number(v)) ? Number(v) : undefined);

  api.get('/config', (req, res) => res.json({
    app: C.APP_NAME,
    countries: Object.fromEntries(Object.entries(C.COUNTRIES).map(([k, c]) => [k, { name: c.name, dial: c.dial, currency: c.currency, flag: c.flag, example: c.example }])),
    currencies: Object.fromEntries(Object.entries(C.CURRENCIES).map(([k, c]) => [k, { name: c.name, symbol: c.symbol }])),
    fx_spread: C.FX_SPREAD,
    fees: { domestic: 'grátis', international: '1% (mín. 0,50 €, máx. 20 €)', cash_out: '1% (mín. 0,20 €, máx. 8 €)' },
  }));
  // Para o alojamento saber se a app está viva (e a base de dados responde).
  api.get('/health', wrap(async () => { await service.listRates(); return { ok: true }; }));
  api.get('/rates', wrap(() => service.listRates()));

  // ----- Autenticação -----
  // Tentativas de entrada por número (o PIN também bloqueia após 5 erros) e um teto por IP.
  const authLimit = rateLimit({ windowMs: 15 * 60000, max: 20, key: byIpAndPhone });
  const ipLimit = rateLimit({ windowMs: 15 * 60000, max: 300, key: (req) => req.ip });
  api.post('/auth/register', ipLimit, authLimit, wrap((req) => service.register(body(req), req.ip)));
  api.post('/auth/login', ipLimit, authLimit, wrap((req) => service.login(body(req), req.ip)));
  api.post('/auth/logout', auth, wrap(async (req) => { await service.logout(bearer(req)); return { ok: true }; }));
  api.post('/me/pin', auth, rateLimit({ windowMs: 15 * 60000, max: 10 }), wrap(async (req) => { await service.changePin(req.user, body(req), req.ip); return { ok: true }; }));
  api.post('/me/receive-currency', auth, wrap((req) => service.setReceiveCurrency(req.user, body(req).currency)));

  // ----- Cliente -----
  api.get('/me', auth, wrap((req) => service.publicUser(req.user)));
  const lookupLimit = rateLimit({ windowMs: 60000, max: 40 });
  api.get('/lookup', auth, lookupLimit, wrap((req) => service.lookup(req.user, String(req.query.phone || ''))));

  // Cotações (pré-visualização: quanto paga, taxa, câmbio, quanto chega).
  api.get('/quote/transfer', auth, lookupLimit, wrap((req) => service.quoteTransfer(req.user,
    { to: String(req.query.to || ''), amount: amount(req.query.amount), fromCurrency: req.query.from_currency })));
  api.get('/quote/exchange', auth, wrap((req) => service.quoteExchange(req.user,
    { amount: amount(req.query.amount), fromCurrency: req.query.from_currency, toCurrency: req.query.to_currency })));
  api.get('/quote/cashout', auth, wrap((req) => service.quoteCashout(req.user,
    { amount: amount(req.query.amount), currency: req.query.currency, fromCurrency: req.query.from_currency })));
  api.get('/requests/:id/quote', auth, wrap((req) => service.quoteRequest(req.user, req.params.id, { fromCurrency: req.query.from_currency })));

  const moneyLimit = rateLimit({ windowMs: 60000, max: 20 });
  api.post('/transfers', auth, moneyLimit, wrap((req) => {
    const b = body(req);
    return service.transfer(req.user, { to: b.to, note: b.note, pin: b.pin, amount: amount(b.amount), fromCurrency: b.from_currency,
      idempotencyKey: b.idempotency_key, expectedTo: expected(b.expected_to_amount) }, req.ip);
  }));
  api.post('/exchange', auth, moneyLimit, wrap((req) => {
    const b = body(req);
    return service.exchange(req.user, { amount: amount(b.amount), fromCurrency: b.from_currency, toCurrency: b.to_currency, pin: b.pin,
      idempotencyKey: b.idempotency_key, expectedTo: expected(b.expected_to_amount) }, req.ip);
  }));
  api.get('/transactions', auth, wrap((req) => service.history(req.user, req.query)));

  api.post('/requests', auth, moneyLimit, wrap((req) => {
    const b = body(req);
    return service.createRequest(req.user, { from: b.from, note: b.note, currency: b.currency, amount: amount(b.amount) });
  }));
  api.get('/requests', auth, wrap((req) => service.listRequests(req.user)));
  api.post('/requests/:id/pay', auth, moneyLimit, wrap((req) => {
    const b = body(req);
    return service.payRequest(req.user, req.params.id, { pin: b.pin, fromCurrency: b.from_currency, idempotencyKey: b.idempotency_key }, req.ip);
  }));
  api.post('/requests/:id/decline', auth, wrap((req) => service.closeRequest(req.user, req.params.id, 'decline')));
  api.post('/requests/:id/cancel', auth, wrap((req) => service.closeRequest(req.user, req.params.id, 'cancel')));

  api.post('/cashout-codes', auth, moneyLimit, wrap((req) => {
    const b = body(req);
    return service.createCashoutCode(req.user, { amount: amount(b.amount), currency: b.currency, fromCurrency: b.from_currency, pin: b.pin }, req.ip);
  }));

  // QR code para receber: o pagador lê-o e a app preenche o destinatário (e o valor, se houver).
  api.get('/me/qr.svg', auth, async (req, res, next) => {
    try {
      const params = new URLSearchParams({ to: req.user.phone });
      const a = req.query.amount ? parseAmount(String(req.query.amount)) : null;
      if (a) params.set('amount', (a / 100).toFixed(2));
      const svg = await QRCode.toString(`dobrapay:pay?${params}`, { type: 'svg', margin: 1, width: 260 });
      res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
    } catch (e) { next(e); }
  });

  // ----- Agente -----
  api.get('/agent/quote', auth, lookupLimit, wrap((req) => service.quoteCashIn(req.user, { to: String(req.query.to || ''), amount: amount(req.query.amount) })));
  api.post('/agent/cash-in', auth, moneyLimit, wrap((req) => {
    const b = body(req);
    return service.cashIn(req.user, { to: b.to, pin: b.pin, amount: amount(b.amount), idempotencyKey: b.idempotency_key,
      expectedTo: expected(b.expected_to_amount) }, req.ip);
  }));
  api.post('/agent/cash-out', auth, moneyLimit, wrap((req) => service.redeemCashout(req.user, body(req), req.ip)));

  // ----- Administração -----
  api.get('/admin/stats', auth, wrap((req) => service.stats(req.user)));
  api.get('/admin/users', auth, wrap((req) => service.listUsers(req.user, req.query)));
  api.patch('/admin/users/:id', auth, wrap((req) => service.setRole(req.user, req.params.id, body(req), req.ip)));
  api.post('/admin/float', auth, wrap((req) => {
    const b = body(req);
    return service.issueFloat(req.user, { agentPhone: b.agent_phone, reference: b.reference, pin: b.pin, amount: amount(b.amount), idempotencyKey: b.idempotency_key }, req.ip);
  }));
  api.post('/admin/rates', auth, wrap((req) => {
    const b = body(req);
    return service.setRate(req.user, { currency: b.currency, perEur: b.per_eur, pin: b.pin }, req.ip);
  }));

  api.use((req, res, next) => next(new ApiError(404, 'not_found', 'Rota inexistente.')));
  app.use('/api', api);

  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (err instanceof ApiError) return res.status(err.status).json({ error: err.code, message: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'bad_json', message: 'Pedido inválido.' });
    if (isCheckViolation(err)) return res.status(402).json({ error: 'insufficient_funds', message: 'Saldo insuficiente.' });
    if (isUniqueViolation(err)) return res.status(409).json({ error: 'conflict', message: 'Pedido repetido. Atualize e tente de novo.' });
    console.error(err);
    res.status(500).json({ error: 'server_error', message: 'Erro interno. Tente de novo.' });
  });
  return app;
}

module.exports = { createApp };
