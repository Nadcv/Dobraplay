// API HTTP (Express). Toda a lógica de dinheiro está em service.js.
const express = require('express');
const path = require('path');
const QRCode = require('qrcode');
const C = require('./config');
const { ApiError, parseAmount } = require('./util');
const { isCheckViolation, isUniqueViolation } = require('./db');
const { verifyWebhook } = require('./payouts');

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

function createApp(service, { webhookSecret = process.env.PAYOUT_WEBHOOK_SECRET, ussdSecret = process.env.USSD_SECRET } = {}) {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  // Guarda o corpo exato dos pedidos para verificar a assinatura dos webhooks dos parceiros.
  // As fotos da verificação de identidade podem ter até ~1 MB; o resto, 20 KB.
  const keepRaw = (req, res, buf) => { req.rawBody = buf; };
  const smallJson = express.json({ limit: '20kb', verify: keepRaw });
  const bigJson = express.json({ limit: '2mb', verify: keepRaw });
  app.use((req, res, next) => (req.path === '/api/me/kyc' || req.path === '/api/admin/statements' ? bigJson : smallJson)(req, res, next));
  // Os gateways USSD enviam formulários (application/x-www-form-urlencoded).
  app.use('/api/ussd', express.urlencoded({ extended: false, limit: '5kb' }));

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(self), geolocation=(self), publickey-credentials-get=(self), publickey-credentials-create=(self)',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; manifest-src 'self'; media-src 'self' blob:; frame-ancestors 'none'",
    });
    if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  });

  app.use(express.static(path.join(__dirname, '..', 'public')));
  // Biblioteca do Face ID / impressão digital (servida localmente: sem depender de outros sites).
  // (o pacote não "exporta" este ficheiro, por isso chega-se a ele a partir da entrada principal)
  const webauthnBundle = path.join(path.dirname(require.resolve('@simplewebauthn/browser')), '..', 'dist', 'bundle', 'index.umd.min.js');
  app.get('/vendor/webauthn.js', (req, res) => res.type('application/javascript').set('Cache-Control', 'public, max-age=86400').sendFile(webauthnBundle));

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
  // Endereço público da app (para os QR codes abrirem diretamente no telemóvel).
  const origin = (req) => process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;

  // Valor esperado do outro lado (o que o cliente viu na cotação), opcional.
  const expected = (v) => (v == null || v === '' ? undefined : Number.isSafeInteger(Number(v)) ? Number(v) : undefined);

  api.get('/config', (req, res) => res.json({
    app: C.APP_NAME,
    countries: Object.fromEntries(Object.entries(C.COUNTRIES).map(([k, c]) => [k, { name: c.name, dial: c.dial, currency: c.currency, flag: c.flag, example: c.example }])),
    currencies: Object.fromEntries(Object.entries(C.CURRENCIES).map(([k, c]) => [k, { name: c.name, symbol: c.symbol }])),
    fx_spread: C.FX_SPREAD,
    fees: { domestic: 'grátis', international: '1% (mín. 0,50 €, máx. 20 €)', cash_out: '1% (mín. 0,20 €, máx. 8 €)' },
    card_topup: service.cardTopupConfig(),
  }));
  // Para o alojamento saber se a app está viva (e a base de dados responde).
  api.get('/health', wrap(async () => { await service.listRates(); return { ok: true }; }));
  api.get('/rates', wrap(() => service.listRates()));

  // ----- Autenticação -----
  // Tentativas de entrada por número (o PIN também bloqueia após 5 erros) e um teto por IP.
  const authLimit = rateLimit({ windowMs: 15 * 60000, max: 20, key: byIpAndPhone });
  const ipLimit = rateLimit({ windowMs: 15 * 60000, max: 300, key: (req) => req.ip });
  api.post('/auth/register', ipLimit, authLimit, wrap((req) => service.register(body(req), req.ip)));
  api.post('/auth/otp', ipLimit, rateLimit({ windowMs: 15 * 60000, max: 5, key: byIpAndPhone }), wrap((req) => service.requestOtp(body(req), req.ip)));
  api.post('/auth/reset-pin', ipLimit, authLimit, wrap((req) => service.resetPin(body(req), req.ip)));
  api.post('/auth/passkey/options', ipLimit, wrap((req) => service.passkeyLoginOptions(origin(req))));
  api.post('/auth/passkey', ipLimit, rateLimit({ windowMs: 15 * 60000, max: 30, key: (r) => r.ip }), wrap((req) =>
    service.passkeyLogin({ challengeId: body(req).challenge_id, response: body(req).response }, origin(req), req.ip)));
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
      idempotencyKey: b.idempotency_key, expectedTo: expected(b.expected_to_amount), quoteId: b.quote_id }, req.ip);
  }));
  api.post('/exchange', auth, moneyLimit, wrap((req) => {
    const b = body(req);
    return service.exchange(req.user, { amount: amount(b.amount), fromCurrency: b.from_currency, toCurrency: b.to_currency, pin: b.pin,
      idempotencyKey: b.idempotency_key, expectedTo: expected(b.expected_to_amount), quoteId: b.quote_id }, req.ip);
  }));
  api.get('/transactions', auth, wrap((req) => service.history(req.user, req.query)));

  api.post('/requests', auth, moneyLimit, wrap((req) => {
    const b = body(req);
    return service.createRequest(req.user, { from: b.from, note: b.note, currency: b.currency, amount: amount(b.amount) });
  }));
  api.get('/requests', auth, wrap((req) => service.listRequests(req.user)));
  api.post('/requests/:id/pay', auth, moneyLimit, wrap((req) => {
    const b = body(req);
    return service.payRequest(req.user, req.params.id, { pin: b.pin, fromCurrency: b.from_currency, idempotencyKey: b.idempotency_key, quoteId: b.quote_id }, req.ip);
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
      // É um endereço web: a câmara do iPhone ou do Android abre logo a app com o destinatário preenchido.
      const params = new URLSearchParams({ enviar: req.user.phone });
      const a = req.query.amount ? parseAmount(String(req.query.amount)) : null;
      if (a) params.set('valor', (a / 100).toFixed(2));
      const svg = await QRCode.toString(`${origin(req)}/?${params}`, { type: 'svg', margin: 1, width: 260 });
      res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
    } catch (e) { next(e); }
  });

  // ----- Transferências bancárias (cliente) -----
  api.get('/bank/accounts', auth, wrap(() => service.listCompanyBankAccounts()));
  api.get('/bank/requests', auth, wrap((req) => service.listMyBankRequests(req.user)));
  api.post('/bank/deposits', auth, moneyLimit, wrap((req) => {
    const b = body(req);
    return service.createBankDeposit(req.user, { amount: amount(b.amount), currency: b.currency }, req.ip);
  }));
  api.get('/quote/bank-withdrawal', auth, wrap((req) => service.quoteBankWithdrawal(req.user,
    { amount: amount(req.query.amount), currency: req.query.currency, fromCurrency: req.query.from_currency })));
  api.post('/bank/withdrawals', auth, moneyLimit, wrap((req) => {
    const b = body(req);
    return service.createBankWithdrawal(req.user, { amount: amount(b.amount), currency: b.currency, fromCurrency: b.from_currency,
      iban: b.iban, holder: b.holder, beneficiaryPhone: b.beneficiary_phone, saveBeneficiary: b.save_beneficiary,
      pin: b.pin, idempotencyKey: b.idempotency_key, quoteId: b.quote_id }, req.ip);
  }));
  api.get('/bank/beneficiaries', auth, wrap((req) => service.listBeneficiaries(req.user)));
  api.delete('/bank/beneficiaries/:id', auth, wrap((req) => service.deleteBeneficiary(req.user, req.params.id)));
  api.get('/me/bank-account', auth, wrap(async (req) => ({ account: await service.getMyBankAccount(req.user) })));
  api.post('/me/bank-account', auth, wrap(async (req) => ({ account: await service.setMyBankAccount(req.user, body(req)) })));
  api.post('/bank/requests/:id/cancel', auth, wrap((req) => service.cancelBankRequest(req.user, req.params.id, req.ip)));

  // ----- Pagamentos em lojas -----
  api.post('/charges', auth, moneyLimit, wrap((req) => service.createCharge(req.user, { amount: amount(body(req).amount), description: body(req).description }, req.ip)));
  api.get('/charges', auth, wrap((req) => service.listMerchantCharges(req.user)));
  api.get('/charges/:id', auth, wrap((req) => service.merchantCharge(req.user, req.params.id)));
  api.post('/charges/:id/cancel', auth, wrap((req) => service.cancelCharge(req.user, req.params.id)));
  api.get('/charges/:id/qr.svg', auth, async (req, res, next) => {
    try {
      const c = await service.merchantCharge(req.user, req.params.id);
      const svg = await QRCode.toString(`${origin(req)}/?pagar=${c.code}`, { type: 'svg', margin: 1, width: 260 });
      res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
    } catch (e) { next(e); }
  });
  api.get('/pay/:code', auth, lookupLimit, wrap((req) => service.getCharge(req.user, req.params.code, { fromCurrency: req.query.from_currency })));
  api.post('/pay/:code', auth, moneyLimit, wrap((req) => {
    const b = body(req);
    return service.payCharge(req.user, req.params.code, { fromCurrency: b.from_currency, pin: b.pin, idempotencyKey: b.idempotency_key, quoteId: b.quote_id }, req.ip);
  }));

  // ----- Webhooks dos parceiros de pagamento -----
  // O parceiro confirma (ou recusa) um pagamento. Não usa sessão: tem de vir
  // assinado (cabeçalho X-DobraPay-Signature = HMAC-SHA256 do corpo com PAYOUT_WEBHOOK_SECRET).
  api.post('/webhooks/payouts/:provider', rateLimit({ windowMs: 60000, max: 120, key: (req) => req.ip }), wrap((req) => {
    if (!webhookSecret) throw new ApiError(503, 'webhooks_disabled', 'Webhooks desativados: falta PAYOUT_WEBHOOK_SECRET.');
    if (!verifyWebhook(webhookSecret, req.rawBody, req.get('x-dobrapay-signature'))) throw new ApiError(401, 'bad_signature', 'Assinatura inválida.');
    return service.handlePayoutEvent(String(req.params.provider), body(req));
  }));


  // ----- Carregar com cartão (Stripe) -----
  api.get('/quote/card-topup', auth, wrap((req) => service.quoteCardTopup(req.user, { amount: amount(req.query.amount), currency: req.query.currency || 'EUR' })));
  api.post('/card-topups', auth, moneyLimit, wrap((req) => service.createCardTopup(req.user,
    { amount: amount(body(req).amount), currency: body(req).currency || 'EUR' }, origin(req), req.ip)));
  api.get('/card-topups/:id', auth, wrap((req) => service.getCardTopup(req.user, req.params.id)));
  // A Stripe confirma os pagamentos aqui (assinado com STRIPE_WEBHOOK_SECRET).
  api.post('/webhooks/stripe', rateLimit({ windowMs: 60000, max: 300, key: (r) => r.ip }), wrap((req) =>
    service.handleStripeWebhook(req.rawBody ? req.rawBody.toString('utf8') : '', req.get('stripe-signature'))));

  // ----- Notificações -----
  api.get('/push/key', wrap(() => service.pushPublicKey()));
  api.post('/push/subscribe', auth, wrap((req) => service.pushSubscribe(req.user, body(req))));
  api.post('/push/unsubscribe', auth, wrap((req) => service.pushUnsubscribe(req.user, body(req).endpoint)));
  api.post('/push/test', auth, rateLimit({ windowMs: 60000, max: 5 }), wrap((req) => service.pushTest(req.user)));

  // ----- Verificação de identidade -----
  api.get('/me/kyc', auth, wrap((req) => service.myKyc(req.user)));
  api.post('/me/kyc', auth, rateLimit({ windowMs: 60 * 60000, max: 5 }), wrap((req) => {
    const b = body(req);
    return service.submitKyc(req.user, { fullName: b.full_name, docType: b.doc_type, docNumber: b.doc_number, birthDate: b.birth_date,
      docImage: b.doc_image, selfieImage: b.selfie_image }, req.ip);
  }));

  // ----- Face ID / impressão digital -----
  api.get('/passkeys', auth, wrap((req) => service.listPasskeys(req.user)));
  api.post('/passkeys/options', auth, wrap((req) => service.passkeyRegisterOptions(req.user, origin(req))));
  api.post('/passkeys', auth, wrap((req) => service.passkeyRegisterVerify(req.user,
    { challengeId: body(req).challenge_id, response: body(req).response, label: body(req).label }, origin(req), req.ip)));
  api.delete('/passkeys/:id', auth, wrap((req) => service.deletePasskey(req.user, req.params.id)));

  // ----- Comprovativos -----
  api.get('/transactions/:id', auth, wrap((req) => service.transactionDetail(req.user, req.params.id)));

  // ----- Envios automáticos -----
  api.get('/scheduled', auth, wrap((req) => service.listScheduled(req.user)));
  api.post('/scheduled', auth, moneyLimit, wrap((req) => {
    const b = body(req);
    return service.createScheduled(req.user, { to: b.to, amount: amount(b.amount), fromCurrency: b.from_currency, note: b.note, dayOfMonth: b.day_of_month, pin: b.pin }, req.ip);
  }));
  api.delete('/scheduled/:id', auth, wrap((req) => service.cancelScheduled(req.user, req.params.id)));

  // ----- Recargas e contas -----
  api.get('/bills/billers', auth, wrap(() => service.listBillers()));
  api.get('/bills', auth, wrap((req) => service.listBills(req.user)));
  api.get('/quote/bill', auth, wrap((req) => service.quoteBill(req.user, { billerId: req.query.biller, amount: amount(req.query.amount), fromCurrency: req.query.from_currency })));
  api.post('/bills', auth, moneyLimit, wrap((req) => {
    const b = body(req);
    return service.payBill(req.user, { billerId: b.biller, accountRef: b.account_ref, amount: amount(b.amount), fromCurrency: b.from_currency,
      pin: b.pin, idempotencyKey: b.idempotency_key }, req.ip);
  }));

  // ----- Agentes: mapa e comissões -----
  api.get('/agents/nearby', auth, lookupLimit, wrap((req) => service.nearbyAgents(req.user, req.query)));
  api.get('/agent/profile', auth, wrap(async (req) => ({ profile: await service.myAgentProfile(req.user) })));
  api.post('/agent/profile', auth, wrap(async (req) => {
    const b = body(req);
    return { profile: await service.setAgentProfile(req.user, { business: b.business, address: b.address, hours: b.hours, lat: b.lat, lng: b.lng, cashAvailable: b.cash_available }, req.ip) };
  }));
  api.get('/agent/stats', auth, wrap((req) => service.agentStats(req.user)));

  // ----- USSD (*xxx#) -----
  // Chamado pelo gateway da operadora; autenticado com USSD_SECRET (?key=… ou cabeçalho X-USSD-Key).
  api.post('/ussd', rateLimit({ windowMs: 60000, max: 600, key: (r) => r.ip }), async (req, res, next) => {
    try {
      if (!ussdSecret) throw new ApiError(503, 'ussd_disabled', 'USSD desativado: falta USSD_SECRET.');
      const key = String(req.query.key || req.get('x-ussd-key') || '');
      if (key.length !== ussdSecret.length || !require('crypto').timingSafeEqual(Buffer.from(key), Buffer.from(ussdSecret))) {
        throw new ApiError(401, 'bad_key', 'Chave inválida.');
      }
      res.type('text/plain').send(await service.handleUssd(body(req)));
    } catch (e) { next(e); }
  });

  // ----- Agente -----
  api.get('/agent/quote', auth, lookupLimit, wrap((req) => service.quoteCashIn(req.user, { to: String(req.query.to || ''), amount: amount(req.query.amount) })));
  api.post('/agent/cash-in', auth, moneyLimit, wrap((req) => {
    const b = body(req);
    return service.cashIn(req.user, { to: b.to, pin: b.pin, amount: amount(b.amount), idempotencyKey: b.idempotency_key,
      expectedTo: expected(b.expected_to_amount), quoteId: b.quote_id }, req.ip);
  }));
  api.post('/agent/cash-out', auth, moneyLimit, wrap((req) => service.redeemCashout(req.user, body(req), req.ip)));

  // ----- Administração -----
  api.get('/admin/stats', auth, wrap((req) => service.stats(req.user)));
  api.get('/admin/users', auth, wrap((req) => service.listUsers(req.user, req.query)));
  api.patch('/admin/users/:id', auth, wrap((req) => {
    const b = body(req);
    return service.setRole(req.user, req.params.id, { role: b.role, tier: b.tier, status: b.status, merchantName: b.merchant_name }, req.ip);
  }));
  api.post('/admin/float', auth, wrap((req) => {
    const b = body(req);
    return service.issueFloat(req.user, { agentPhone: b.agent_phone, reference: b.reference, pin: b.pin, amount: amount(b.amount), idempotencyKey: b.idempotency_key }, req.ip);
  }));
  api.post('/admin/rates', auth, wrap((req) => {
    const b = body(req);
    return service.setRate(req.user, { currency: b.currency, perEur: b.per_eur, pin: b.pin }, req.ip);
  }));

  api.get('/admin/bank/requests', auth, wrap((req) => service.adminListBankRequests(req.user, { status: req.query.status })));
  api.post('/admin/bank/requests/:id/confirm', auth, wrap((req) => {
    const b = body(req);
    return service.confirmBankDeposit(req.user, req.params.id, { amount: b.amount == null || b.amount === '' ? undefined : amount(b.amount),
      bankReference: b.bank_reference, pin: b.pin }, req.ip);
  }));
  api.post('/admin/bank/requests/:id/paid', auth, wrap((req) => service.completeBankWithdrawal(req.user, req.params.id,
    { bankReference: body(req).bank_reference, pin: body(req).pin }, req.ip)));
  api.post('/admin/bank/requests/:id/reject', auth, wrap((req) => service.rejectBankRequest(req.user, req.params.id,
    { reason: body(req).reason, pin: body(req).pin }, req.ip)));
  api.post('/admin/bank/accounts', auth, wrap((req) => {
    const b = body(req);
    return service.setCompanyBankAccount(req.user, { currency: b.currency, bankName: b.bank_name, holder: b.holder, iban: b.iban, swift: b.swift, pin: b.pin }, req.ip);
  }));
  api.get('/admin/settlement', auth, wrap((req) => service.settlementView(req.user)));
  api.get('/admin/payout-providers', auth, wrap((req) => service.listPayoutProviders(req.user)));
  api.post('/admin/payout-providers', auth, wrap((req) => service.setPayoutProvider(req.user,
    { currency: body(req).currency, provider: body(req).provider, pin: body(req).pin }, req.ip)));
  api.post('/admin/liquidity', auth, wrap((req) => {
    const b = body(req);
    const empty = b.max_shortfall == null || String(b.max_shortfall).trim() === '';
    // "0" é válido (= só o que já está no banco); vazio = sem limite.
    const v = empty ? null : (/^0+([.,]0{1,2})?$/.test(String(b.max_shortfall).trim()) ? 0 : amount(b.max_shortfall));
    return service.setLiquidityLimit(req.user, { currency: b.currency, maxShortfall: v, pin: b.pin }, req.ip);
  }));
  api.post('/admin/settlement', auth, wrap((req) => {
    const b = body(req);
    return service.recordSettlement(req.user, { fromCurrency: b.from_currency, toCurrency: b.to_currency, amount: amount(b.amount),
      toAmount: amount(b.to_amount), reference: b.reference, pin: b.pin }, req.ip);
  }));

  api.get('/admin/kyc', auth, wrap((req) => service.adminListKyc(req.user, req.query)));
  api.post('/admin/kyc/:id', auth, wrap((req) => service.reviewKyc(req.user, req.params.id,
    { approve: body(req).approve === true, note: body(req).note, pin: body(req).pin }, req.ip)));
  api.get('/admin/alerts', auth, wrap((req) => service.adminListAlerts(req.user, req.query)));
  api.post('/admin/alerts/:id/close', auth, wrap((req) => service.closeAlert(req.user, req.params.id,
    { note: body(req).note, blockUser: body(req).block_user === true, pin: body(req).pin }, req.ip)));
  api.get('/admin/export.csv', auth, async (req, res, next) => {
    try {
      const csv = await service.exportTransactionsCsv(req.user, req.query);
      res.type('text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="dobrapay-movimentos-${new Date().toISOString().slice(0, 10)}.csv"`).send(csv);
    } catch (e) { next(e); }
  });
  // Extratos bancários e pagamentos em lote (ligação ao banco por ficheiros).
  api.post('/admin/statements', auth, wrap((req) => service.previewStatement(req.user,
    { currency: body(req).currency, content: body(req).content, filename: body(req).filename }, req.ip)));
  api.post('/admin/statements/:id/confirm', auth, wrap((req) => service.confirmStatement(req.user, req.params.id,
    { lineIds: body(req).line_ids, pin: body(req).pin }, req.ip)));
  api.get('/admin/payout-batches', auth, wrap((req) => service.listPayoutBatches(req.user)));
  api.get('/admin/payout-batches/preview', auth, wrap((req) => service.payoutBatchPreview(req.user, { currency: req.query.currency })));
  api.post('/admin/payout-batches', auth, wrap((req) => service.exportPayoutBatch(req.user,
    { currency: body(req).currency, format: body(req).format, pin: body(req).pin }, req.ip)));
  api.post('/admin/payout-batches/:id/paid', auth, wrap((req) => service.markBatchPaid(req.user, req.params.id,
    { bankReference: body(req).bank_reference, pin: body(req).pin }, req.ip)));
  api.post('/admin/payout-batches/:id/cancel', auth, wrap((req) => service.cancelBatch(req.user, req.params.id, { pin: body(req).pin }, req.ip)));
  // Simulador USSD (para mostrar o menu a parceiros sem operadora).
  api.post('/admin/ussd/simulate', auth, wrap(async (req) => {
    if (req.user.role !== 'admin') throw new ApiError(403, 'forbidden', 'Sem permissão para esta operação.');
    const b = body(req);
    return { response: await service.handleUssd({ sessionId: 'sim-' + req.user.id + '-' + (b.session || ''), phoneNumber: b.phone, text: b.text || '' }) };
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
