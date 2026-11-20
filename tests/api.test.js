const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createService } = require('../src/service');
const { createApp } = require('../src/app');
const { normalizePhone, parseAmount } = require('../src/util');
const { signWebhook } = require('../src/payouts');
const http = require('http');

const ADMIN = '9900000';
let server, base, db, service;
const pushes = []; // notificações enviadas (falsas)
const USSD_KEY = 'ussd-de-teste';
// Parceiro de pagamentos falso (para testar o modo 'http'): regista as ordens recebidas.
const partner = { orders: [], fail: false, server: null, url: '' };
const WEBHOOK_SECRET = 'segredo-de-teste';
// Stripe falsa: guarda as sessões de pagamento criadas e responde às consultas.
const stripeMock = { sessions: {}, requests: [], server: null, url: '' };
const STRIPE_WHSEC = 'whsec_teste';

// Por omissão os testes usam SQLite em memória. Com TEST_DATABASE_URL correm
// contra PostgreSQL (a base de dados é APAGADA: use uma base só de testes).
const PG_URL = process.env.TEST_DATABASE_URL;

test.before(async () => {
  if (PG_URL) {
    const { Client } = require('pg');
    const c = new Client({ connectionString: PG_URL });
    await c.connect();
    await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await c.end();
  }
  partner.server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (partner.fail) { res.writeHead(500, { 'content-type': 'application/json' }); return res.end('{"error":"indisponível"}'); }
      partner.orders.push({ body: JSON.parse(raw), auth: req.headers.authorization, idem: req.headers['idempotency-key'] });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'PX-' + partner.orders.length }));
    });
  }).listen(0);
  await new Promise((r) => partner.server.once('listening', r));
  partner.url = `http://127.0.0.1:${partner.server.address().port}/payouts`;
  stripeMock.server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.method === 'POST' && req.url === '/v1/checkout/sessions') {
        const id = 'cs_test_' + (Object.keys(stripeMock.sessions).length + 1);
        stripeMock.requests.push({ body: new URLSearchParams(raw), auth: req.headers.authorization, idem: req.headers['idempotency-key'] });
        stripeMock.sessions[id] = { id, url: `https://checkout.stripe.com/c/pay/${id}`, payment_status: 'unpaid', status: 'open', payment_intent: null };
        return res.end(JSON.stringify(stripeMock.sessions[id]));
      }
      const m = /^\/v1\/checkout\/sessions\/(.+)$/.exec(req.url);
      if (req.method === 'GET' && m && stripeMock.sessions[m[1]]) return res.end(JSON.stringify(stripeMock.sessions[m[1]]));
      res.writeHead(404); res.end('{"error":{"message":"não existe"}}');
    });
  }).listen(0);
  await new Promise((r) => stripeMock.server.once('listening', r));
  stripeMock.url = `http://127.0.0.1:${stripeMock.server.address().port}`;
  db = await openDb(PG_URL ? { url: PG_URL } : { file: ':memory:' });
  service = createService(db, {
    adminPhone: ADMIN, sandboxDelayMs: 100, env: { PAYOUT_HTTP_URL: partner.url, PAYOUT_HTTP_TOKEN: 'token-parceiro', STRIPE_SECRET_KEY: 'sk_test_123', STRIPE_WEBHOOK_SECRET: STRIPE_WHSEC, STRIPE_API_BASE: stripeMock.url },
    pushSender: async (sub, payload, userId) => {
      if (sub.endpoint.includes('expirado')) throw Object.assign(new Error('gone'), { statusCode: 410 });
      pushes.push({ userId, endpoint: sub.endpoint, ...JSON.parse(payload) });
    },
  });
  server = createApp(service, { webhookSecret: WEBHOOK_SECRET, ussdSecret: USSD_KEY }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
test.after(async () => { server.close(); partner.server.close(); stripeMock.server.close(); await db.close(); });

async function call(method, path, body, token) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}
// Registo como na app: pede o código por SMS (em modo de teste vem na resposta) e cria a conta.
const register = async (phone, name, country = 'ST', pin = '2580') => {
  const otp = await call('POST', '/auth/otp', { phone, country, purpose: 'register' });
  assert.equal(otp.status, 200, JSON.stringify(otp.body));
  const r = await call('POST', '/auth/register', { phone, name, pin, country, code: otp.body.dev_code });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
const me = async (t) => (await call('GET', '/me', null, t)).body;
const bal = async (t, cur) => ((await me(t)).wallets.find((w) => w.currency === cur) || { balance: 0 }).balance;

let admin, agentST, agentES, ana, bruno, maria, joao;

test('utilitários: telefones de vários países e valores', () => {
  assert.equal(normalizePhone('991 2345'), '+2399912345');
  assert.equal(normalizePhone('+239 991 2345'), '+2399912345');
  assert.equal(normalizePhone('+244 923 456 789'), '+244923456789');
  assert.equal(normalizePhone('923456789', 'AO'), '+244923456789');
  assert.equal(normalizePhone('991 2345', 'CV'), '+2389912345');
  assert.equal(normalizePhone('00351 912 345 678'), '+351912345678');
  assert.equal(normalizePhone('612 345 678', 'ES'), '+34612345678');
  assert.equal(normalizePhone('12345'), null);
  assert.equal(normalizePhone('+1 555 123 4567'), null);
  assert.equal(parseAmount('150,50'), 15050);
  assert.equal(parseAmount('1 500'), 150000);
  assert.equal(parseAmount('0'), null);
  assert.equal(parseAmount('1.234'), null);
});

test('registo em vários países: cada um tem a carteira da sua moeda', async () => {
  admin = await register(ADMIN, 'Admin Geral');
  agentST = await register('9811111', 'Agente Trindade');
  agentES = await register('+34 699 000 111', 'Agente Madrid', 'ES');
  ana = await register('9912345', 'Ana Costa');
  bruno = await register('9923456', 'Bruno Neto');
  maria = await register('612345678', 'Maria Espanha', 'ES');
  joao = await register('923456789', 'João Luanda', 'AO');
  assert.equal(admin.user.role, 'admin');
  assert.deepEqual(ana.user.wallets, [{ currency: 'STN', balance: 0 }]);
  assert.equal(maria.user.receive_currency, 'EUR');
  assert.equal(joao.user.receive_currency, 'AOA');

  assert.equal((await call('POST', '/auth/register', { phone: '9912345', name: 'Outra Ana', pin: '2580', country: 'ST' })).status, 409);
  assert.equal((await call('POST', '/auth/register', { phone: '9934567', name: 'Fraco', pin: '1111', country: 'ST' })).status, 400);
  assert.equal((await call('POST', '/auth/register', { phone: '12', name: 'Sem País', pin: '2580', country: 'XX' })).status, 400);
  const ok = await call('POST', '/auth/login', { phone: '+34 612 345 678', pin: '2580' });
  assert.equal(ok.status, 200);
  assert.equal((await call('GET', '/me', null, 'token-falso')).status, 401);
});

test('admin promove agentes e emite float na moeda de cada agente', async () => {
  for (const a of [agentST, agentES]) assert.equal((await call('PATCH', `/admin/users/${a.user.id}`, { role: 'agent' }, admin.token)).body.role, 'agent');
  assert.equal((await call('POST', '/admin/float', { agent_phone: '9811111', amount: '1000', reference: 'x', pin: '2580' }, ana.token)).status, 403);
  const f = await call('POST', '/admin/float', { agent_phone: '9811111', amount: '500000', reference: 'BISTP 001', pin: '2580', idempotency_key: 'f1' }, admin.token);
  assert.equal(f.status, 200, JSON.stringify(f.body));
  assert.equal(f.body.transaction.currency, 'STN');
  const g = await call('POST', '/admin/float', { agent_phone: '+34699000111', amount: '5000', reference: 'SEPA 001', pin: '2580', idempotency_key: 'f2' }, admin.token);
  assert.equal(g.body.transaction.currency, 'EUR');
  assert.equal(await bal(agentES.token, 'EUR'), 500_000);
});

test('depósito local (cash-in) e transferência em Dobras, sem taxa e com idempotência', async () => {
  const c = await call('POST', '/agent/cash-in', { to: '9912345', amount: '10000', pin: '2580', idempotency_key: 'c1' }, agentST.token);
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.transaction.fee, 0);
  assert.equal(await bal(ana.token, 'STN'), 1_000_000);

  const body = { to: '9923456', amount: '1250,50', note: 'Almoço', pin: '2580', idempotency_key: 'k-1' };
  const r1 = await call('POST', '/transfers', body, ana.token);
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  const r2 = await call('POST', '/transfers', body, ana.token);
  assert.equal(r2.body.replayed, true);
  assert.equal(r2.body.transaction.id, r1.body.transaction.id);
  assert.equal(await bal(ana.token, 'STN'), 1_000_000 - 125_050);
  assert.equal(await bal(bruno.token, 'STN'), 125_050);
});

test('São Tomé → Espanha: Ana envia Dobras, Maria recebe Euros', async () => {
  // 2 450 STN = 100 € ao câmbio fixo (1 € = 24,5 STN). Margem 1% → 99 €. Taxa internacional 1% = 1 € = 24,50 STN.
  const q = await call('GET', '/quote/transfer?to=%2B34612345678&amount=2450&from_currency=STN', null, ana.token);
  assert.equal(q.status, 200, JSON.stringify(q.body));
  assert.equal(q.body.recipient.name, 'Maria Espanha');
  assert.equal(q.body.to_currency, 'EUR');
  assert.equal(q.body.to_amount, 9_900);
  assert.equal(q.body.fee, 2_450);

  const before = await bal(ana.token, 'STN');
  const r = await call('POST', '/transfers', { to: '+34 612 345 678', amount: '2450', from_currency: 'STN', pin: '2580',
    idempotency_key: 'intl-1', expected_to_amount: q.body.to_amount }, ana.token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await bal(ana.token, 'STN'), before - 245_000 - 2_450);
  assert.equal(await bal(maria.token, 'EUR'), 9_900);
  const hist = (await call('GET', '/transactions', null, maria.token)).body;
  assert.equal(hist[0].direction, 'in');
  assert.equal(hist[0].to_amount, 9_900);
  assert.equal(hist[0].currency, 'STN');
});

test('depósito em Dobras num agente de São Tomé, a pessoa em Espanha recebe em Euros', async () => {
  const q = await call('GET', '/agent/quote?to=%2B34612345678&amount=2450', null, agentST.token);
  assert.equal(q.body.to_amount, 9_900);
  assert.equal(q.body.total, 247_450); // o agente cobra ao cliente 2 474,50 STN em dinheiro vivo
  const r = await call('POST', '/agent/cash-in', { to: '+34612345678', amount: '2450', pin: '2580', idempotency_key: 'c-intl' }, agentST.token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await bal(maria.token, 'EUR'), 19_800);
});

test('Maria escolhe receber em Dólares e troca Euros por Dólares (câmbio)', async () => {
  const m = await call('POST', '/me/receive-currency', { currency: 'USD' }, maria.token);
  assert.equal(m.body.receive_currency, 'USD');
  // 50 € × 1,16 × 0,99 = 57,42 USD
  const q = await call('GET', '/quote/exchange?amount=50&from_currency=EUR&to_currency=USD', null, maria.token);
  assert.equal(q.body.to_amount, 5_742);
  const r = await call('POST', '/exchange', { amount: '50', from_currency: 'EUR', to_currency: 'USD', pin: '2580', idempotency_key: 'x1' }, maria.token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.transaction.direction, 'self');
  assert.equal(await bal(maria.token, 'EUR'), 14_800);
  assert.equal(await bal(maria.token, 'USD'), 5_742);
  // Agora o que lhe enviarem chega em USD.
  const t = await call('GET', '/quote/transfer?to=%2B34612345678&amount=245', null, ana.token);
  assert.equal(t.body.to_currency, 'USD');
});

test('pedido em Euros pago em Dobras: Maria recebe o valor exato', async () => {
  const req = await call('POST', '/requests', { from: '+2399912345', amount: '10', currency: 'EUR', note: 'Livros' }, maria.token);
  assert.equal(req.status, 200, JSON.stringify(req.body));
  const q = await call('GET', `/requests/${req.body.id}/quote?from_currency=STN`, null, ana.token);
  assert.equal(q.body.to_amount, 1_000);
  assert.equal(q.body.amount, Math.ceil(1_000 * 24.5 / 0.99)); // 247,48 STN
  const before = await bal(ana.token, 'STN');
  const pay = await call('POST', `/requests/${req.body.id}/pay`, { pin: '2580', from_currency: 'STN' }, ana.token);
  assert.equal(pay.status, 200, JSON.stringify(pay.body));
  assert.equal(await bal(ana.token, 'STN'), before - q.body.total);
  assert.equal(await bal(maria.token, 'EUR'), 14_800 + 1_000);
  assert.equal((await call('POST', `/requests/${req.body.id}/pay`, { pin: '2580' }, ana.token)).status, 409);
});

test('levantamento com código: só um agente da mesma moeda o pode pagar', async () => {
  const c = await call('POST', '/cashout-codes', { amount: '1000', currency: 'STN', pin: '2580' }, ana.token);
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.match(c.body.code, /^\d{6}$/);
  // Agente de Espanha (paga em EUR) não pode pagar um levantamento em Dobras.
  const wrong = await call('POST', '/agent/cash-out', { phone: '+2399912345', code: c.body.code, pin: '2580' }, agentES.token);
  assert.equal(wrong.body.error, 'wrong_currency');
  const bad = c.body.code === '000000' ? '111111' : '000000';
  assert.equal((await call('POST', '/agent/cash-out', { phone: '9912345', code: bad, pin: '2580' }, agentST.token)).status, 401);
  const before = await bal(ana.token, 'STN');
  const r = await call('POST', '/agent/cash-out', { phone: '9912345', code: c.body.code, pin: '2580' }, agentST.token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.pay_cash, 100_000);
  assert.equal(await bal(ana.token, 'STN'), before - c.body.total);
  assert.equal((await call('POST', '/agent/cash-out', { phone: '9912345', code: c.body.code, pin: '2580' }, agentST.token)).status, 404);

  // Maria levanta Euros em Madrid a partir da carteira em Dólares (com conversão).
  const m = await call('POST', '/cashout-codes', { amount: '20', currency: 'EUR', from_currency: 'USD', pin: '2580' }, maria.token);
  assert.equal(m.status, 200, JSON.stringify(m.body));
  const usd = await bal(maria.token, 'USD');
  const r2 = await call('POST', '/agent/cash-out', { phone: '+34612345678', code: m.body.code, pin: '2580' }, agentES.token);
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  assert.equal(await bal(maria.token, 'USD'), usd - m.body.total);
});

test('limites, saldo insuficiente e erros', async () => {
  // Limite nível 1: 400 € por operação = 9 800 STN.
  assert.equal((await call('POST', '/transfers', { to: '9923456', amount: '9850', pin: '2580' }, ana.token)).body.error, 'limit_tx');
  assert.equal((await call('POST', '/transfers', { to: '9912345', amount: '5000', pin: '2580' }, bruno.token)).body.error, 'insufficient_funds');
  assert.equal((await call('POST', '/transfers', { to: '9912345', amount: '10', from_currency: 'EUR', pin: '2580' }, bruno.token)).body.error, 'insufficient_funds');
  assert.equal((await call('POST', '/transfers', { to: '9912345', amount: '10', from_currency: 'XYZ', pin: '2580' }, bruno.token)).body.error, 'bad_currency');
  assert.equal((await call('POST', '/transfers', { to: '9923456', amount: '10', pin: '2580' }, bruno.token)).body.error, 'same_account');
  assert.equal((await call('POST', '/transfers', { to: '9977777', amount: '10', pin: '2580' }, bruno.token)).status, 404);
  assert.equal((await call('POST', '/transfers', { to: '9912345', amount: '0,01', pin: '2580' }, bruno.token)).body.error, 'bad_amount');
});

test('câmbio: admin atualiza o Kwanza e a app protege contra mudança de câmbio', async () => {
  const q = await call('GET', '/quote/transfer?to=923456789%20&amount=245&from_currency=STN', null, ana.token);
  // Ana está em STP: número angolano sem indicativo não é reconhecido.
  assert.equal(q.status, 400);
  const q2 = await call('GET', '/quote/transfer?to=%2B244923456789&amount=245&from_currency=STN', null, ana.token);
  assert.equal(q2.body.to_currency, 'AOA');
  assert.equal(q2.body.to_amount, Math.floor(24_500 * 1060 * 0.99 / 24.5)); // 10 494,00 Kz

  assert.equal((await call('POST', '/admin/rates', { currency: 'AOA', per_eur: 10600, pin: '2580' }, admin.token)).body.error, 'rate_jump');
  assert.equal((await call('POST', '/admin/rates', { currency: 'EUR', per_eur: 2, pin: '2580' }, admin.token)).status, 400);
  assert.equal((await call('POST', '/admin/rates', { currency: 'AOA', per_eur: 1000, pin: '2580' }, ana.token)).status, 403);
  const s = await call('POST', '/admin/rates', { currency: 'AOA', per_eur: 1000, pin: '2580' }, admin.token);
  assert.equal(s.status, 200, JSON.stringify(s.body));

  // A Ana viu a cotação antiga (mais Kwanzas): a transferência é recusada em vez de enviar menos.
  const r = await call('POST', '/transfers', { to: '+244923456789', amount: '245', pin: '2580', expected_to_amount: q2.body.to_amount }, ana.token);
  assert.equal(r.body.error, 'rate_changed');
  const ok = await call('POST', '/transfers', { to: '+244923456789', amount: '245', pin: '2580' }, ana.token);
  assert.equal(ok.status, 200);
  assert.equal(await bal(joao.token, 'AOA'), Math.floor(24_500 * 1000 * 0.99 / 24.5));
});

test('PIN errado bloqueia a conta após 5 tentativas', async () => {
  const carla = await register('9945678', 'Carla Lima', 'ST', '8264');
  for (let i = 0; i < 4; i++) {
    assert.equal((await call('POST', '/transfers', { to: '9912345', amount: '1', pin: '0000' }, carla.token)).body.error, 'wrong_pin');
  }
  assert.equal((await call('POST', '/transfers', { to: '9912345', amount: '1', pin: '0000' }, carla.token)).status, 423);
  assert.equal((await call('POST', '/auth/login', { phone: '9945678', pin: '8264' })).status, 423);
});

test('pedidos simultâneos: nunca gasta mais do que tem nem paga duas vezes', async () => {
  const rita = await register('9956789', 'Rita Pires');
  await call('POST', '/agent/cash-in', { to: '9956789', amount: '1000', pin: '2580', idempotency_key: 'rita-in' }, agentST.token);
  // 10 envios de 300 STN ao mesmo tempo com só 1 000 STN: no máximo 3 podem passar.
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    call('POST', '/transfers', { to: '9923456', amount: '300', pin: '2580', idempotency_key: 'par-' + i }, rita.token)));
  const ok = results.filter((r) => r.status === 200).length;
  assert.equal(ok, 3, JSON.stringify(results.map((r) => r.body.error || 'ok')));
  assert.ok(results.filter((r) => r.status !== 200).every((r) => r.body.error === 'insufficient_funds'), JSON.stringify(results.map((r) => r.body.error || 'ok')));
  assert.equal(await bal(rita.token, 'STN'), 10_000);
  // O mesmo pedido enviado 5 vezes ao mesmo tempo (rede fraca) só paga uma vez.
  await call('POST', '/agent/cash-in', { to: '9956789', amount: '500', pin: '2580', idempotency_key: 'rita-in2' }, agentST.token);
  const dup = await Promise.all(Array.from({ length: 5 }, () =>
    call('POST', '/transfers', { to: '9923456', amount: '100', pin: '2580', idempotency_key: 'same-key' }, rita.token)));
  assert.ok(dup.every((r) => r.status === 200), JSON.stringify(dup.map((r) => r.body)));
  assert.equal(new Set(dup.map((r) => r.body.transaction.id)).size, 1);
  assert.equal(await bal(rita.token, 'STN'), 50_000 + 10_000 - 10_000);
});

// ---------------- Transferências bancárias ----------------
const IBAN_CGD = 'PT50 0002 0123 1234 5678 9015 4';
const IBAN_BISTP = 'ST09 0001 0000 0012 3456 7890 1';
const IBAN_MARIA = 'ES91 2100 0418 4502 0005 1332';

test('admin configura as contas bancárias da empresa (CGD em EUR, BISTP em STN)', async () => {
  assert.equal((await call('POST', '/admin/bank/accounts', { currency: 'EUR', bank_name: 'CGD', holder: 'DobraPay', iban: 'PT50000201231234567890155', pin: '2580' }, admin.token)).body.error, 'bad_iban');
  assert.equal((await call('POST', '/admin/bank/accounts', { currency: 'EUR', bank_name: 'CGD', holder: 'X', iban: IBAN_CGD, pin: '2580' }, ana.token)).status, 403);
  const r = await call('POST', '/admin/bank/accounts', { currency: 'EUR', bank_name: 'Caixa Geral de Depósitos', holder: 'DobraPay Lda', iban: IBAN_CGD, swift: 'CGDIPTPL', pin: '2580' }, admin.token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await call('POST', '/admin/bank/accounts', { currency: 'STN', bank_name: 'BISTP', holder: 'DobraPay STP', iban: IBAN_BISTP, pin: '2580' }, admin.token);
  const list = (await call('GET', '/bank/accounts', null, maria.token)).body;
  assert.deepEqual(list.map((b) => b.currency), ['EUR', 'STN']);
  assert.equal(list[0].iban, 'PT50 0002 0123 1234 5678 9015 4');
});

test('carregar por transferência: pedido com referência, admin confirma o valor recebido', async () => {
  assert.equal((await call('POST', '/bank/deposits', { amount: '50', currency: 'USD' }, maria.token)).body.error, 'no_bank');
  const d = await call('POST', '/bank/deposits', { amount: '100', currency: 'EUR' }, maria.token);
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.match(d.body.reference, /^DP[A-Z2-9]{6}$/);
  assert.equal(d.body.pay_to.bank_name, 'Caixa Geral de Depósitos');
  const pending = (await call('GET', '/admin/bank/requests', null, admin.token)).body;
  assert.ok(pending.some((x) => x.reference === d.body.reference && x.user.name === 'Maria Espanha'));
  assert.equal((await call('POST', `/admin/bank/requests/${d.body.id}/confirm`, { pin: '2580' }, ana.token)).status, 403);
  const before = await bal(maria.token, 'EUR');
  // A Maria transferiu 99,50 € (o banco dela cobrou 0,50 €): credita-se o que chegou.
  const c = await call('POST', `/admin/bank/requests/${d.body.id}/confirm`, { amount: '99,50', bank_reference: 'MOV-123', pin: '2580' }, admin.token);
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.status, 'completed');
  assert.equal(await bal(maria.token, 'EUR'), before + 9_950);
  assert.equal((await call('POST', `/admin/bank/requests/${d.body.id}/confirm`, { pin: '2580' }, admin.token)).status, 409);
  const hist = (await call('GET', '/transactions', null, maria.token)).body;
  assert.equal(hist[0].type, 'bank_in');
});

test('levantar para o banco: sai logo da carteira; admin paga ou recusa (devolve tudo)', async () => {
  assert.equal((await call('POST', '/bank/withdrawals', { amount: '10', currency: 'EUR', iban: 'ES00 1234', pin: '2580' }, maria.token)).body.error, 'bad_iban');
  const q = await call('GET', '/quote/bank-withdrawal?amount=50&currency=EUR', null, maria.token);
  assert.equal(q.body.fee, 50); // 1% de 50 € = 0,50 € (mínimo)
  const before = await bal(maria.token, 'EUR');
  const w = await call('POST', '/bank/withdrawals', { amount: '50', currency: 'EUR', iban: IBAN_MARIA, holder: 'Maria Espanha', pin: '2580', idempotency_key: 'w1' }, maria.token);
  assert.equal(w.status, 200, JSON.stringify(w.body));
  assert.equal(w.body.request.iban, 'ES91 2100 0418 4502 0005 1332');
  assert.equal(await bal(maria.token, 'EUR'), before - 5_050);
  // Repetido (rede fraca): não cria segundo levantamento.
  const again = await call('POST', '/bank/withdrawals', { amount: '50', currency: 'EUR', iban: IBAN_MARIA, pin: '2580', idempotency_key: 'w1' }, maria.token);
  assert.equal(again.body.request.id, w.body.request.id);
  assert.equal(await bal(maria.token, 'EUR'), before - 5_050);
  assert.equal((await call('POST', `/admin/bank/requests/${w.body.request.id}/paid`, { pin: '2580' }, admin.token)).body.error, 'bad_reference');
  const paid = await call('POST', `/admin/bank/requests/${w.body.request.id}/paid`, { bank_reference: 'SEPA-777', pin: '2580' }, admin.token);
  assert.equal(paid.body.status, 'completed');

  // Recusado pelo admin: devolve valor + taxa.
  const w2 = await call('POST', '/bank/withdrawals', { amount: '20', currency: 'EUR', iban: IBAN_MARIA, pin: '2580' }, maria.token);
  const mid = await bal(maria.token, 'EUR');
  const rej = await call('POST', `/admin/bank/requests/${w2.body.request.id}/reject`, { reason: 'Titular não corresponde', pin: '2580' }, admin.token);
  assert.equal(rej.body.status, 'rejected');
  assert.equal(await bal(maria.token, 'EUR'), mid + 2_000 + w2.body.request.fee);

  // Cancelado pela própria cliente: também devolve tudo.
  const w3 = await call('POST', '/bank/withdrawals', { amount: '20', currency: 'EUR', iban: IBAN_MARIA, pin: '2580' }, maria.token);
  const mid2 = await bal(maria.token, 'EUR');
  const can = await call('POST', `/bank/requests/${w3.body.request.id}/cancel`, null, maria.token);
  assert.equal(can.body.status, 'cancelled');
  assert.equal(await bal(maria.token, 'EUR'), mid2 + 2_000 + w3.body.request.fee);
  assert.equal((await call('POST', `/bank/requests/${w3.body.request.id}/cancel`, null, maria.token)).status, 409);
  const mine = (await call('GET', '/bank/requests', null, maria.token)).body;
  assert.deepEqual(mine.slice(0, 3).map((x) => x.status), ['cancelled', 'rejected', 'completed']);
});

test('acerto entre bancos: mostra o que falta em cada moeda e regista a transferência CGD → BISTP', async () => {
  const v = (await call('GET', '/admin/settlement', null, admin.token)).body;
  const stn = v.rows.find((r) => r.currency === 'STN');
  const eur = v.rows.find((r) => r.currency === 'EUR');
  assert.ok(eur.surplus < 0, 'pagaram-se euros que entraram como dobras: o banco em EUR tem de receber');
  assert.ok(stn.surplus > 0);
  const sug = v.suggestions.find((s) => s.from_currency === 'STN' && s.to_currency === 'EUR');
  assert.ok(sug);
  if (stn.surplus / 24.5 >= -eur.surplus) assert.equal(sug.to_amount, -eur.surplus); // cobre exatamente o que falta
  const r = await call('POST', '/admin/settlement', { from_currency: 'STN', to_currency: 'EUR', amount: '2450', to_amount: '100', reference: 'SWIFT BISTP→CGD 01', pin: '2580' }, admin.token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const eur2 = r.body.rows.find((x) => x.currency === 'EUR');
  assert.equal(eur2.surplus, eur.surplus + 10_000);
  assert.equal(eur2.owed_to_customers, eur.owed_to_customers); // os clientes não são afetados
});

test('limite de liquidez: pausa envios que deixariam o banco de uma moeda a dever demais', async () => {
  // A Maria recebe em USD (escolheu antes): testa-se o limite do banco em USD.
  const STN_PER_USD = 24.5 / (1.16 * 0.99); // Dobras necessárias para fazer chegar 1 USD
  const eur = (await call('GET', '/admin/settlement', null, admin.token)).body.rows.find((r) => r.currency === 'USD');
  assert.equal(eur.max_shortfall, null); // sem limite por omissão
  // O banco em USD pode dever no máximo mais 10 USD do que já deve.
  const limit = Math.max(0, -eur.surplus) + 1_000;
  assert.equal((await call('POST', '/admin/liquidity', { currency: 'USD', max_shortfall: String(limit / 100), pin: '2580' }, ana.token)).status, 403);
  const set = await call('POST', '/admin/liquidity', { currency: 'USD', max_shortfall: String(limit / 100), pin: '2580' }, admin.token);
  assert.equal(set.status, 200, JSON.stringify(set.body));
  const row = set.body.rows.find((r) => r.currency === 'USD');
  assert.equal(row.max_shortfall, limit);
  const available = row.available;
  assert.ok(available >= 1_000 && available <= 1_000 + Math.max(0, eur.surplus));

  // A cotação avisa e o envio é recusado (Ana em STN → Maria, que recebe em USD).
  const big = Math.ceil((available + 2_000) * STN_PER_USD / 100);
  const q = await call('GET', `/quote/transfer?to=%2B34612345678&amount=${big}&from_currency=STN`, null, ana.token);
  assert.ok(q.body.paused, JSON.stringify(q.body));
  const before = await bal(ana.token, 'STN');
  const r = await call('POST', '/transfers', { to: '+34612345678', amount: String(big), from_currency: 'STN', pin: '2580' }, ana.token);
  assert.equal(r.status, 503);
  assert.equal(r.body.error, 'liquidity_paused');
  assert.equal(await bal(ana.token, 'STN'), before); // nada saiu da carteira

  // Envios na mesma moeda não são afetados; um envio pequeno passa.
  assert.equal((await call('POST', '/transfers', { to: '9923456', amount: '10', pin: '2580' }, ana.token)).status, 200);
  assert.equal((await call('POST', '/transfers', { to: '+34612345678', amount: '50', from_currency: 'STN', pin: '2580' }, ana.token)).status, 200);

  // Vários envios ao mesmo tempo nunca ultrapassam o limite.
  const left = (await call('GET', '/admin/settlement', null, admin.token)).body.rows.find((x) => x.currency === 'USD').available;
  const each = Math.ceil((left / 3 + 50) * STN_PER_USD / 100); // cada um vale ~1/3 do disponível: só 2 podem passar
  const par = await Promise.all([0, 1, 2, 3].map((i) =>
    call('POST', '/transfers', { to: '+34612345678', amount: String(each), from_currency: 'STN', pin: '2580', idempotency_key: 'liq-' + i }, ana.token)));
  assert.equal(par.filter((x) => x.status === 200).length, 2, JSON.stringify(par.map((x) => x.body.error || 'ok')));
  const after = (await call('GET', '/admin/settlement', null, admin.token)).body.rows.find((x) => x.currency === 'USD');
  assert.ok(after.surplus >= -limit, 'nunca passa o limite');

  // Retirar o limite volta a permitir tudo.
  const off = await call('POST', '/admin/liquidity', { currency: 'USD', max_shortfall: '', pin: '2580' }, admin.token);
  assert.equal(off.body.rows.find((x) => x.currency === 'USD').max_shortfall, null);
  assert.equal((await call('GET', `/quote/transfer?to=%2B34612345678&amount=${big}&from_currency=STN`, null, ana.token)).body.paused, undefined);
});

// ---------------- Pagamentos em lojas ----------------
let charge;
test('loja cria cobrança; cliente paga noutra moeda; a loja recebe o valor exato', async () => {
  assert.equal((await call('POST', '/charges', { amount: '150' }, bruno.token)).body.error, 'not_merchant');
  const m = await call('PATCH', `/admin/users/${bruno.user.id}`, { merchant_name: 'Café do Bruno' }, admin.token);
  assert.equal(m.body.merchant_name, 'Café do Bruno');
  const c = await call('POST', '/charges', { amount: '150', description: '2 cafés e 1 bolo' }, bruno.token);
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.match(c.body.code, /^[A-Z2-9]{6}$/);
  assert.equal(c.body.currency, 'STN');
  charge = c.body;
  const qr = await fetch(base + `/charges/${charge.id}/qr.svg`, { headers: { authorization: 'Bearer ' + bruno.token } });
  assert.equal(qr.status, 200);

  // A Maria (Espanha) vê a cobrança pelo código (com minúsculas e espaços) e paga em euros.
  const v = await call('GET', `/pay/${charge.code.toLowerCase().slice(0, 3)}%20${charge.code.toLowerCase().slice(3)}?from_currency=EUR`, null, maria.token);
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal(v.body.merchant.name, 'Café do Bruno');
  assert.equal(v.body.quote.to_amount, 15_000);
  assert.equal(v.body.quote.fee, 0);
  const brunoBefore = await bal(bruno.token, 'STN');
  const p = await call('POST', `/pay/${charge.code}`, { from_currency: 'EUR', pin: '2580', idempotency_key: 'pay-1' }, maria.token);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(p.body.transaction.type, 'merchant');
  assert.equal(p.body.transaction.to.name, 'Café do Bruno');
  assert.equal(await bal(bruno.token, 'STN'), brunoBefore + 15_000);
  assert.equal((await call('POST', `/pay/${charge.code}`, { from_currency: 'EUR', pin: '2580' }, ana.token)).body.error, 'already_paid');
  const status = (await call('GET', `/charges/${charge.id}`, null, bruno.token)).body;
  assert.equal(status.status, 'paid');
  assert.equal(status.payer.name, 'Maria Espanha');
  assert.equal((await call('GET', `/charges/${charge.id}`, null, ana.token)).status, 404); // só a loja vê os detalhes
});

test('cobranças canceladas, expiradas ou inexistentes não se pagam', async () => {
  const c = (await call('POST', '/charges', { amount: '20' }, bruno.token)).body;
  await call('POST', `/charges/${c.id}/cancel`, null, bruno.token);
  assert.equal((await call('POST', `/pay/${c.code}`, { pin: '2580' }, ana.token)).body.error, 'cancelled');
  const e = (await call('POST', '/charges', { amount: '20' }, bruno.token)).body;
  await db.run('UPDATE charges SET expires_at = ? WHERE id = ?', Date.now() - 1000, e.id);
  assert.equal((await call('GET', `/pay/${e.code}`, null, ana.token)).body.status, 'expired');
  assert.equal((await call('POST', `/pay/${e.code}`, { pin: '2580' }, ana.token)).body.error, 'expired');
  assert.equal((await call('GET', '/pay/ZZZZZZ', null, ana.token)).status, 404);
  assert.equal((await call('POST', `/pay/${(await call('POST', '/charges', { amount: '5' }, bruno.token)).body.code}`, { pin: '2580' }, bruno.token)).body.error, 'same_account');
  const list = (await call('GET', '/charges', null, bruno.token)).body;
  assert.ok(list.length >= 4);
});

test('QR para receber é um endereço web (a câmara do iPhone abre a app)', async () => {
  const res = await fetch(base + '/me/qr.svg', { headers: { authorization: 'Bearer ' + ana.token } });
  assert.equal(res.status, 200);
});

// ---------------- Câmbio garantido ----------------
test('câmbio garantido: paga o valor que viu mesmo que o câmbio mude; cada cotação só serve uma vez', async () => {
  const q = (await call('GET', '/quote/transfer?to=%2B34612345678&amount=245&from_currency=STN', null, ana.token)).body;
  assert.ok(q.quote_id);
  assert.equal(q.locked_seconds, 60);
  assert.equal(q.to_currency, 'USD');
  // O câmbio do dólar muda depois de a Ana ver a cotação.
  assert.equal((await call('POST', '/admin/rates', { currency: 'USD', per_eur: 1.2, pin: '2580' }, admin.token)).status, 200);
  const before = await bal(maria.token, 'USD');
  const r = await call('POST', '/transfers', { to: '+34612345678', amount: '245', from_currency: 'STN', pin: '2580', quote_id: q.quote_id, idempotency_key: 'lock-1' }, ana.token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.transaction.to_amount, q.to_amount); // o valor garantido, não o novo
  assert.equal(await bal(maria.token, 'USD'), before + q.to_amount);
  // Sem cotação usa o câmbio novo (mais dólares).
  const fresh = (await call('GET', '/quote/transfer?to=%2B34612345678&amount=245&from_currency=STN', null, ana.token)).body;
  assert.ok(fresh.to_amount > q.to_amount);
  // A mesma cotação não pode ser usada outra vez.
  assert.equal((await call('POST', '/transfers', { to: '+34612345678', amount: '245', from_currency: 'STN', pin: '2580', quote_id: q.quote_id, idempotency_key: 'lock-2' }, ana.token)).body.error, 'quote_used');
  // Cotação de outro valor, de outra pessoa ou expirada: recusada.
  assert.equal((await call('POST', '/transfers', { to: '+34612345678', amount: '300', from_currency: 'STN', pin: '2580', quote_id: fresh.quote_id }, ana.token)).body.error, 'quote_invalid');
  assert.equal((await call('POST', '/transfers', { to: '+34612345678', amount: '245', from_currency: 'STN', pin: '2580', quote_id: fresh.quote_id }, bruno.token)).body.error, 'quote_invalid');
  await db.run('UPDATE quotes SET expires_at = ? WHERE id = ?', Date.now() - 1, fresh.quote_id);
  assert.equal((await call('POST', '/transfers', { to: '+34612345678', amount: '245', from_currency: 'STN', pin: '2580', quote_id: fresh.quote_id }, ana.token)).body.error, 'quote_expired');
  // Câmbio entre carteiras também fica garantido.
  const qe = (await call('GET', '/quote/exchange?amount=1&from_currency=USD&to_currency=EUR', null, maria.token)).body;
  const ex = await call('POST', '/exchange', { amount: '1', from_currency: 'USD', to_currency: 'EUR', pin: '2580', quote_id: qe.quote_id }, maria.token);
  assert.equal(ex.body.transaction.to_amount, qe.to_amount);
  await call('POST', '/admin/rates', { currency: 'USD', per_eur: 1.16, pin: '2580' }, admin.token);
});

// ---------------- Envio para o IBAN de quem não tem DobraPay ----------------
const IBAN_ROSA = 'ST03 0002 0000 0098 7654 3210 1';
test('enviar para o IBAN de outra pessoa noutra moeda; o simulador paga e confirma sozinho', async () => {
  const prov = await call('POST', '/admin/payout-providers', { currency: 'STN', provider: 'sandbox', pin: '2580' }, admin.token);
  assert.equal(prov.status, 200, JSON.stringify(prov.body));
  assert.equal(prov.body.currencies.find((c) => c.currency === 'STN').provider, 'sandbox');
  assert.ok(prov.body.available.some((p) => p.id === 'http'));
  assert.equal((await call('POST', '/admin/payout-providers', { currency: 'STN', provider: 'xpto', pin: '2580' }, admin.token)).body.error, 'bad_provider');

  // A Maria (Espanha, euros) envia 500 STN para a conta da avó Rosa no BISTP (a avó não tem DobraPay).
  assert.equal((await call('GET', '/lookup?phone=%2B2399977777', null, maria.token)).status, 404);
  const q = (await call('GET', '/quote/bank-withdrawal?amount=500&currency=STN&from_currency=EUR', null, maria.token)).body;
  assert.equal(q.to_amount, 50_000);
  assert.equal(q.currency, 'EUR');
  const before = await bal(maria.token, 'EUR');
  assert.equal((await call('POST', '/bank/withdrawals', { amount: '500', currency: 'STN', from_currency: 'EUR', iban: IBAN_ROSA, beneficiary_phone: '+2399977777', pin: '2580' }, maria.token)).body.error, 'bad_holder');
  const w = await call('POST', '/bank/withdrawals', { amount: '500', currency: 'STN', from_currency: 'EUR', iban: IBAN_ROSA, holder: 'Rosa Trindade',
    beneficiary_phone: '+2399977777', pin: '2580', quote_id: q.quote_id, idempotency_key: 'rosa-1' }, maria.token);
  assert.equal(w.status, 200, JSON.stringify(w.body));
  assert.equal(w.body.request.provider, 'sandbox');
  assert.equal(w.body.request.provider_status, 'submitted');
  assert.equal(w.body.request.third_party, true);
  assert.equal(await bal(maria.token, 'EUR'), before - q.total);
  // Já foi enviado ao parceiro: não pode ser cancelado.
  assert.equal((await call('POST', `/bank/requests/${w.body.request.id}/cancel`, null, maria.token)).body.error, 'already_sent');
  await new Promise((r) => setTimeout(r, 400));
  const mine = (await call('GET', '/bank/requests', null, maria.token)).body.find((x) => x.id === w.body.request.id);
  assert.equal(mine.status, 'completed');
  assert.match(mine.bank_reference, /^SBX-/);
  const ben = (await call('GET', '/bank/beneficiaries', null, maria.token)).body;
  assert.equal(ben[0].name, 'Rosa Trindade');
  assert.equal(ben[0].iban, IBAN_ROSA);
  assert.equal((await call('GET', '/bank/beneficiaries', null, ana.token)).body.length, 0); // privados

  // O banco do beneficiário recusa: tudo volta à carteira, ao mesmo câmbio.
  const mid = await bal(maria.token, 'EUR');
  const f = await call('POST', '/bank/withdrawals', { amount: '100', currency: 'STN', from_currency: 'EUR', iban: IBAN_ROSA, holder: 'Teste FALHA', pin: '2580' }, maria.token);
  assert.equal(f.status, 200, JSON.stringify(f.body));
  assert.equal(await bal(maria.token, 'EUR'), mid - f.body.request.from_amount - f.body.request.fee);
  await new Promise((r) => setTimeout(r, 400));
  const failed = (await call('GET', '/bank/requests', null, maria.token)).body.find((x) => x.id === f.body.request.id);
  assert.equal(failed.status, 'rejected');
  assert.equal(await bal(maria.token, 'EUR'), mid);
  const ledger = (await call('GET', '/admin/stats', null, admin.token)).body.ledger;
  assert.equal(ledger.ok, true, JSON.stringify(ledger));
});

test('parceiro por API: recebe a ordem, confirma por webhook assinado; se falhar fica manual', async () => {
  await call('POST', '/admin/payout-providers', { currency: 'EUR', provider: 'http', pin: '2580' }, admin.token);
  // O IBAN da Maria fica guardado no perfil: não precisa de escrever o titular.
  assert.equal((await call('POST', '/me/bank-account', { iban: 'ES00 1111' }, maria.token)).body.error, 'bad_iban');
  const acc = await call('POST', '/me/bank-account', { iban: IBAN_MARIA, holder: 'Maria Espanha' }, maria.token);
  assert.equal(acc.body.account.iban, IBAN_MARIA);
  const w = await call('POST', '/bank/withdrawals', { amount: '10', currency: 'EUR', iban: IBAN_MARIA, pin: '2580' }, maria.token);
  assert.equal(w.status, 200, JSON.stringify(w.body));
  assert.equal(w.body.request.holder, 'Maria Espanha');
  assert.equal(w.body.request.provider_status, 'submitted');
  const order = partner.orders.at(-1);
  assert.deepEqual(order.body.beneficiary, { name: 'Maria Espanha', iban: 'ES9121000418450200051332' });
  assert.equal(order.body.amount, '10.00');
  assert.equal(order.auth, 'Bearer token-parceiro');
  assert.equal(order.idem, w.body.request.reference); // o parceiro não paga duas vezes a mesma ordem
  const extId = 'PX-' + partner.orders.length;

  const hook = async (payload, sig) => {
    const raw = JSON.stringify(payload);
    const res = await fetch(base + '/webhooks/payouts/http', { method: 'POST', headers: { 'content-type': 'application/json', ...(sig !== undefined ? { 'x-dobrapay-signature': sig ?? signWebhook(WEBHOOK_SECRET, raw) } : {}) }, body: raw });
    return { status: res.status, body: await res.json() };
  };
  const event = { external_id: extId, status: 'paid', bank_reference: 'SEPA-XYZ' };
  assert.equal((await hook(event)).status, 401);                     // sem assinatura
  assert.equal((await hook(event, 'abc123')).status, 401);           // assinatura errada
  assert.equal((await hook({ ...event, status: 'paid' }, signWebhook('outro-segredo', JSON.stringify(event)))).status, 401);
  const ok = await hook(event, null);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.status, 'completed');
  assert.equal((await hook(event, null)).body.duplicate, true);      // repetição ignorada
  assert.equal((await hook({ external_id: 'PX-999', status: 'paid' }, null)).status, 404);
  const done = (await call('GET', '/bank/requests', null, maria.token)).body.find((x) => x.id === w.body.request.id);
  assert.equal(done.status, 'completed');
  assert.equal(done.bank_reference, 'SEPA-XYZ');

  // Parceiro em baixo: o pedido fica para pagamento manual, sem perder dinheiro.
  partner.fail = true;
  const w2 = await call('POST', '/bank/withdrawals', { amount: '5', currency: 'EUR', iban: IBAN_MARIA, pin: '2580' }, maria.token);
  partner.fail = false;
  assert.equal(w2.body.request.status, 'pending');
  assert.equal(w2.body.request.provider_status, 'error');
  assert.match(w2.body.request.note, /pagar manualmente/);
  const paid = await call('POST', `/admin/bank/requests/${w2.body.request.id}/paid`, { bank_reference: 'MANUAL-1', pin: '2580' }, admin.token);
  assert.equal(paid.body.status, 'completed');
  await call('POST', '/admin/payout-providers', { currency: 'EUR', provider: 'manual', pin: '2580' }, admin.token);
});

// ======================= Funcionalidades v6 =======================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IMG = 'data:image/jpeg;base64,' + Buffer.from('foto de teste').toString('base64');

test('SMS: registo exige o código certo; "esqueci o PIN" com código termina as outras sessões', async () => {
  assert.equal((await call('POST', '/auth/register', { phone: '9960001', name: 'Rui Sem Código', pin: '2580', country: 'ST' })).body.error, 'otp_expired');
  const o = await call('POST', '/auth/otp', { phone: '9960001', country: 'ST', purpose: 'register' });
  assert.match(o.body.dev_code, /^\d{6}$/);
  const wrong = o.body.dev_code === '000000' ? '111111' : '000000';
  assert.equal((await call('POST', '/auth/register', { phone: '9960001', name: 'Rui Lopes', pin: '2580', country: 'ST', code: wrong })).body.error, 'otp_wrong');
  const ok = await call('POST', '/auth/register', { phone: '9960001', name: 'Rui Lopes', pin: '2580', country: 'ST', code: o.body.dev_code });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await call('POST', '/auth/otp', { phone: '9960001', country: 'ST', purpose: 'register' })).body.error, 'phone_taken');
  // Esqueci o PIN: para um número sem conta a resposta é igual mas sem código (não revela clientes).
  const ghost = await call('POST', '/auth/otp', { phone: '9960009', country: 'ST', purpose: 'reset_pin' });
  assert.equal(ghost.body.sent, true);
  assert.equal(ghost.body.dev_code, undefined);
  const r = await call('POST', '/auth/otp', { phone: '9960001', country: 'ST', purpose: 'reset_pin' });
  const reset = await call('POST', '/auth/reset-pin', { phone: '9960001', country: 'ST', code: r.body.dev_code, newPin: '7391' });
  assert.equal(reset.status, 200, JSON.stringify(reset.body));
  assert.equal((await call('GET', '/me', null, ok.body.token)).status, 401); // a sessão antiga terminou
  assert.equal((await call('POST', '/auth/login', { phone: '9960001', pin: '7391', country: 'ST' })).status, 200);
  assert.equal((await call('POST', '/auth/reset-pin', { phone: '9960001', country: 'ST', code: r.body.dev_code, newPin: '4826' })).body.error, 'otp_expired'); // código já usado
});

let kycUser;
test('identidade: documento + selfie, admin aprova e os limites sobem para o nível 2', async () => {
  kycUser = await register('699111222', 'Lúcia Fernandes', 'ES');
  const base = { full_name: 'Lúcia Fernandes Costa', doc_type: 'passaporte', doc_number: 'X1234567', birth_date: '1990-05-17', doc_image: IMG, selfie_image: IMG };
  assert.equal((await call('POST', '/me/kyc', { ...base, doc_image: 'não é imagem' }, kycUser.token)).body.error, 'bad_image');
  assert.equal((await call('POST', '/me/kyc', { ...base, birth_date: '2015-01-01' }, kycUser.token)).body.error, 'bad_birth');
  const k = await call('POST', '/me/kyc', base, kycUser.token);
  assert.equal(k.status, 200, JSON.stringify(k.body));
  assert.equal(k.body.status, 'pending');
  assert.equal((await call('POST', '/me/kyc', base, kycUser.token)).body.error, 'kyc_pending');
  const queue = (await call('GET', '/admin/kyc', null, admin.token)).body;
  const item = queue.find((x) => x.user.name === 'Lúcia Fernandes');
  assert.equal(item.doc_image, IMG);
  assert.equal((await call('GET', '/admin/kyc', null, kycUser.token)).status, 403);
  await call('POST', '/push/subscribe', { endpoint: 'https://push.exemplo/lucia', keys: { p256dh: 'p', auth: 'a' } }, kycUser.token);
  const ap = await call('POST', `/admin/kyc/${item.id}`, { approve: true, pin: '2580' }, admin.token);
  assert.equal(ap.body.status, 'approved');
  const me2 = await me(kycUser.token);
  assert.equal(me2.tier, 2);
  assert.equal(me2.limits.perTx, 200_000); // 2 000 €
  assert.ok(pushes.some((p) => p.userId === kycUser.user.id && /Identidade verificada/.test(p.title)));
  assert.equal((await call('GET', '/me/kyc', null, kycUser.token)).body.request.status, 'approved');
});

test('alertas antifraude: operação grande de conta nova abre alertas; admin analisa e bloqueia', async () => {
  await call('POST', '/agent/cash-in', { to: '+34699111222', amount: '1500', pin: '2580' }, agentES.token);
  const r = await call('POST', '/transfers', { to: '612345678', amount: '1000', pin: '2580', from_currency: 'EUR' }, kycUser.token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await sleep(150);
  const alerts = (await call('GET', '/admin/alerts', null, admin.token)).body.filter((a) => a.user.id === kycUser.user.id);
  assert.deepEqual(alerts.map((a) => a.rule).sort(), ['large_tx', 'new_account']);
  assert.equal((await call('GET', '/admin/alerts', null, ana.token)).status, 403);
  assert.equal((await call('POST', `/admin/alerts/${alerts[0].id}/close`, { pin: '2580' }, admin.token)).body.error, 'bad_reason');
  await call('POST', `/admin/alerts/${alerts[0].id}/close`, { note: 'Origem dos fundos por confirmar', block_user: true, pin: '2580' }, admin.token);
  assert.equal((await call('GET', '/me', null, kycUser.token)).status, 401); // bloqueada
  const closed = (await call('GET', '/admin/alerts?status=closed', null, admin.token)).body;
  assert.ok(closed.some((a) => a.note === 'Origem dos fundos por confirmar'));
});

test('notificações: quem recebe é avisado; pedidos avisam quem paga; subscrições expiradas são apagadas', async () => {
  assert.ok((await call('GET', '/push/key')).body.publicKey.length > 40);
  assert.equal((await call('POST', '/push/subscribe', { endpoint: 'http://inseguro', keys: { p256dh: 'x', auth: 'y' } }, bruno.token)).status, 400);
  await call('POST', '/push/subscribe', { endpoint: 'https://push.exemplo/bruno', keys: { p256dh: 'p', auth: 'a' } }, bruno.token);
  await call('POST', '/push/subscribe', { endpoint: 'https://push.exemplo/expirado', keys: { p256dh: 'p', auth: 'a' } }, bruno.token);
  pushes.length = 0;
  await call('POST', '/transfers', { to: '9923456', amount: '15', note: 'Pão', pin: '2580' }, ana.token);
  await sleep(100);
  const got = pushes.find((p) => p.userId === bruno.user.id);
  assert.match(got.title, /Recebeu dinheiro/);
  assert.match(got.body, /15,00 STN de Ana Costa · Pão/);
  assert.equal(await db.get("SELECT 1 AS x FROM push_subscriptions WHERE endpoint LIKE '%expirado'"), null);
  pushes.length = 0;
  await call('POST', '/requests', { from: '9923456', amount: '5', note: 'Táxi' }, ana.token);
  await sleep(50);
  assert.ok(pushes.some((p) => p.userId === bruno.user.id && /Pedido de dinheiro/.test(p.title)));
  await call('POST', '/push/unsubscribe', { endpoint: 'https://push.exemplo/bruno' }, bruno.token);
});

test('Face ID / impressão digital: pedidos de registo e entrada; credencial desconhecida é recusada', async () => {
  const o = await call('POST', '/passkeys/options', null, ana.token);
  assert.equal(o.status, 200, JSON.stringify(o.body));
  assert.ok(o.body.challenge_id && o.body.options.challenge);
  assert.equal(o.body.options.rp.id, '127.0.0.1');
  assert.equal((await call('POST', '/passkeys/options')).status, 401);
  const l = await call('POST', '/auth/passkey/options');
  assert.ok(l.body.options.challenge);
  const bad = await call('POST', '/auth/passkey', { challenge_id: l.body.challenge_id, response: { id: 'nao-existe', rawId: 'nao-existe', response: {}, type: 'public-key' } });
  assert.equal(bad.body.error, 'passkey_unknown');
  assert.equal((await call('POST', '/auth/passkey', { challenge_id: l.body.challenge_id, response: { id: 'x' } })).body.error, 'passkey_expired'); // desafio de uso único
  assert.deepEqual((await call('GET', '/passkeys', null, ana.token)).body, []);
  const lib = await fetch(base.replace('/api', '') + '/vendor/webauthn.js');
  assert.equal(lib.status, 200);
  assert.match(await lib.text(), /SimpleWebAuthnBrowser/);
});

test('comprovativos: detalhes do movimento só para quem participou', async () => {
  const tx = (await call('GET', '/transactions', null, ana.token)).body[0];
  const d = await call('GET', `/transactions/${tx.id}`, null, ana.token);
  assert.equal(d.status, 200);
  assert.equal(d.body.id, tx.id);
  assert.equal((await call('GET', `/transactions/${tx.id}`, null, maria.token)).status, 404);
});

test('envios automáticos: executa no dia, só uma vez por mês, tenta de novo se faltar saldo', async () => {
  assert.equal((await call('POST', '/scheduled', { to: '9923456', amount: '20', day_of_month: 31, pin: '2580' }, ana.token)).body.error, 'bad_day');
  const c = await call('POST', '/scheduled', { to: '9923456', amount: '20', note: 'Mesada', day_of_month: 5, pin: '2580' }, ana.token);
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.ok(c.body.next_run_at > Date.now());
  assert.equal(c.body.to_name, 'Bruno Neto');
  const due = Date.UTC(2026, 10, 5, 9);
  await db.run('UPDATE scheduled_transfers SET next_run_at = ? WHERE id = ?', due, c.body.id);
  const before = await bal(bruno.token, 'STN');
  const r1 = await service.runDueScheduled();
  assert.ok(r1.find((x) => x.id === c.body.id).ok);
  assert.equal(await bal(bruno.token, 'STN'), before + 2_000);
  const after = (await call('GET', '/scheduled', null, ana.token)).body.find((x) => x.id === c.body.id);
  assert.equal(after.last_status, 'ok');
  assert.equal(new Date(after.next_run_at).toISOString(), '2026-12-05T09:00:00.000Z');
  // Mesmo mês outra vez (ex.: dois servidores): não paga a dobrar.
  await db.run('UPDATE scheduled_transfers SET next_run_at = ? WHERE id = ?', due, c.body.id);
  await service.runDueScheduled();
  assert.equal(await bal(bruno.token, 'STN'), before + 2_000);
  // Sem saldo: falha, avisa e tenta amanhã.
  const big = await call('POST', '/scheduled', { to: '9912345', amount: '9000', day_of_month: 1, pin: '2580' }, bruno.token);
  await db.run('UPDATE scheduled_transfers SET next_run_at = ? WHERE id = ?', Date.now() - 1000, big.body.id);
  pushes.length = 0;
  await call('POST', '/push/subscribe', { endpoint: 'https://push.exemplo/bruno2', keys: { p256dh: 'p', auth: 'a' } }, bruno.token);
  const r2 = await service.runDueScheduled();
  assert.equal(r2.find((x) => x.id === big.body.id).ok, false);
  const s2 = (await call('GET', '/scheduled', null, bruno.token)).body.find((x) => x.id === big.body.id);
  assert.equal(s2.failures, 1);
  assert.ok(s2.next_run_at > Date.now() + 23 * 3600_000);
  await sleep(50);
  assert.ok(pushes.some((p) => /Envio automático falhou/.test(p.title)));
  await call('DELETE', `/scheduled/${big.body.id}`, null, bruno.token);
  await call('DELETE', `/scheduled/${c.body.id}`, null, ana.token);
  assert.equal((await call('GET', '/scheduled', null, ana.token)).body.length, 0);
});

test('recargas e contas: recarga CST, energia pré-paga com código; recusa devolve o dinheiro', async () => {
  const billers = (await call('GET', '/bills/billers', null, ana.token)).body;
  assert.ok(billers.some((b) => b.id === 'emae_energia' && b.simulated));
  const before = await bal(ana.token, 'STN');
  const r = await call('POST', '/bills', { biller: 'cst_recarga', account_ref: '991 2345', amount: '50', pin: '2580' }, ana.token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.payment.status, 'completed');
  assert.equal(await bal(ana.token, 'STN'), before - 5_000);
  const e = await call('POST', '/bills', { biller: 'emae_energia', account_ref: '12345678901', amount: '100', pin: '2580' }, ana.token);
  assert.match(e.body.payment.token, /^\d{4}(-\d{4}){4}$/);
  assert.equal((await call('POST', '/bills', { biller: 'emae_energia', account_ref: '12', amount: '100', pin: '2580' }, ana.token)).body.error, 'bad_ref');
  assert.equal((await call('POST', '/bills', { biller: 'cst_recarga', account_ref: '9912345', amount: '1', pin: '2580' }, ana.token)).body.error, 'bad_amount');
  const mid = await bal(ana.token, 'STN');
  const f = await call('POST', '/bills', { biller: 'emae_agua', account_ref: 'FAT-0000', amount: '30', pin: '2580' }, ana.token);
  assert.equal(f.body.payment.status, 'failed');
  assert.equal(await bal(ana.token, 'STN'), mid); // devolvido
  // Pagar contas de São Tomé a partir de euros (Maria em Espanha).
  const q = (await call('GET', '/quote/bill?biller=cst_recarga&amount=100&from_currency=EUR', null, maria.token)).body;
  assert.equal(q.to_amount, 10_000);
  const m = await call('POST', '/bills', { biller: 'cst_recarga', account_ref: '+2399923456', amount: '100', from_currency: 'EUR', pin: '2580' }, maria.token);
  assert.equal(m.body.payment.from_currency, 'EUR');
  assert.equal((await call('GET', '/bills', null, ana.token)).body.length, 3);
});

test('agentes: perfil com localização, agentes perto de mim e comissões automáticas', async () => {
  assert.equal((await call('POST', '/agent/profile', { business: 'Loja X', address: 'Rua 1', lat: 0, lng: 0 }, ana.token)).status, 403);
  const p = await call('POST', '/agent/profile', { business: 'Mercearia Trindade', address: 'Av. Marginal 12, São Tomé', hours: '8h–20h', lat: 0.3365, lng: 6.7273 }, agentST.token);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  await call('POST', '/agent/profile', { business: 'Locutorio Madrid', address: 'Calle Mayor 1, Madrid', lat: 40.4168, lng: -3.7038 }, agentES.token);
  const near = (await call('GET', '/agents/nearby?lat=0.30&lng=6.70', null, ana.token)).body;
  assert.equal(near[0].name, 'Mercearia Trindade');
  assert.ok(near[0].distance_km < 10);
  assert.match(near[0].maps_url, /google\.com\/maps/);
  assert.equal(near[0].currency, 'STN');
  const byCountry = (await call('GET', '/agents/nearby', null, maria.token)).body;
  assert.deepEqual(byCountry.map((a) => a.name), ['Locutorio Madrid']);
  // Comissão no depósito: 0,3% de 2 000 STN = 6 STN.
  const before = await bal(agentST.token, 'STN');
  await call('POST', '/agent/cash-in', { to: '9912345', amount: '2000', pin: '2580' }, agentST.token);
  assert.equal(await bal(agentST.token, 'STN'), before - 200_000 + 600);
  const st = (await call('GET', '/agent/stats', null, agentST.token)).body;
  assert.ok(st.commissions.find((c) => c.currency === 'STN').total >= 600);
  assert.ok(st.cash_in >= 1);
  const hist = (await call('GET', '/transactions', null, agentST.token)).body;
  assert.equal(hist[0].type, 'commission');
});

test('USSD: menu, saldo, enviar com PIN e levantar código, sem internet', async () => {
  const u = async (text, phone = '+2399912345', session = 's1', key = USSD_KEY) => {
    const res = await fetch(`${base}/ussd?key=${key}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ sessionId: session, serviceCode: '*239#', phoneNumber: phone, text }) });
    return { status: res.status, text: await res.text() };
  };
  assert.equal((await u('', '+2399912345', 's0', 'errada')).status, 401);
  assert.match((await u('')).text, /^CON DobraPay\n1\. Ver saldo/);
  assert.match((await u('1')).text, /^CON Introduza o seu PIN/);
  assert.match((await u('1*2580')).text, /^END Saldo:\n[\d ]+,\d{2} STN/);
  assert.match((await u('1*0000')).text, /^END PIN errado/);
  await call('POST', '/auth/login', { phone: '9912345', pin: '2580' }); // repõe as tentativas
  assert.match((await u('2')).text, /^CON Número de quem recebe/);
  assert.match((await u('2*9923456')).text, /^CON Para Bruno Neto/);
  assert.match((await u('2*9923456*10')).text, /^CON Enviar 10,00 STN a Bruno Neto\?/);
  const before = await bal(bruno.token, 'STN');
  assert.match((await u('2*9923456*10*2580', '+2399912345', 'ussd-envio')).text, /^END Enviado! Bruno Neto recebeu 10,00 STN/);
  assert.match((await u('2*9923456*10*2580', '+2399912345', 'ussd-envio')).text, /^END Enviado!/); // repetição: não paga duas vezes
  assert.equal(await bal(bruno.token, 'STN'), before + 1_000);
  assert.match((await u('3*100*2580')).text, /^END Código de levantamento: \d{6}/);
  assert.match((await u('4*2580')).text, /^END [+-]/);
  assert.match((await u('', '+2399000111')).text, /^END DobraPay: este número ainda não tem conta/);
  const sim = await call('POST', '/admin/ussd/simulate', { phone: '+2399912345', text: '' }, admin.token);
  assert.match(sim.body.response, /^CON DobraPay/);
  assert.equal((await call('POST', '/admin/ussd/simulate', { phone: '+2399912345', text: '' }, ana.token)).status, 403);
});

test('relatórios: exportação CSV dos movimentos só para o admin', async () => {
  const res = await fetch(base + '/admin/export.csv', { headers: { authorization: 'Bearer ' + admin.token } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]); // marca para o Excel ler os acentos
  const csv = bytes.subarray(3).toString('utf8');
  assert.ok(csv.startsWith('data;id;tipo;de;'));
  assert.ok(csv.split('\r\n').length > 20);
  assert.match(csv, /;commission;/);
  assert.equal((await fetch(base + '/admin/export.csv', { headers: { authorization: 'Bearer ' + ana.token } })).status, 403);
});

// ---------------- Carregar com cartão (Stripe) ----------------
test('cartão: pagamento na página da Stripe, confirmado por webhook assinado, credita uma única vez', async () => {
  const cfg = (await call('GET', '/config')).body.card_topup;
  assert.deepEqual([cfg.enabled, cfg.test_mode], [true, true]);
  const q = (await call('GET', '/quote/card-topup?amount=50', null, maria.token)).body;
  assert.deepEqual([q.amount, q.fee, q.total], [5_000, 100, 5_100]); // 1,5% + 0,25 € = 1,00 €
  assert.equal((await call('GET', '/quote/card-topup?amount=2', null, maria.token)).body.error, 'bad_amount');
  const c = await call('POST', '/card-topups', { amount: '50' }, maria.token);
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.match(c.body.url, /^https:\/\/checkout\.stripe\.com\//);
  assert.equal(c.body.status, 'pending');
  const sent = stripeMock.requests.at(-1);
  assert.equal(sent.auth, 'Bearer sk_test_123');
  assert.equal(sent.idem, c.body.id);
  assert.equal(sent.body.get('line_items[0][price_data][unit_amount]'), '5100');
  assert.equal(sent.body.get('line_items[0][price_data][currency]'), 'eur');
  assert.equal(sent.body.get('client_reference_id'), c.body.id);
  assert.match(sent.body.get('success_url'), new RegExp(`\\?cartao=ok&id=${c.body.id}$`));

  const sessionId = Object.keys(stripeMock.sessions).at(-1);
  const event = { id: 'evt_1', type: 'checkout.session.completed',
    data: { object: { id: sessionId, client_reference_id: c.body.id, payment_status: 'paid', payment_intent: 'pi_test_1', metadata: { topup_id: c.body.id } } } };
  const hook = async (payload, { secret = STRIPE_WHSEC, t = Math.floor(Date.now() / 1000), header } = {}) => {
    const raw = JSON.stringify(payload);
    const sig = header ?? `t=${t},v1=${require('crypto').createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`;
    const res = await fetch(base + '/webhooks/stripe', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sig }, body: raw });
    return { status: res.status, body: await res.json() };
  };
  assert.equal((await hook(event, { header: '' })).status, 400);                         // sem assinatura
  assert.equal((await hook(event, { secret: 'whsec_falso' })).status, 400);              // assinatura falsa
  assert.equal((await hook(event, { t: Math.floor(Date.now() / 1000) - 3600 })).status, 400); // repetição antiga
  const before = await bal(maria.token, 'EUR');
  pushes.length = 0;
  await call('POST', '/push/subscribe', { endpoint: 'https://push.exemplo/maria', keys: { p256dh: 'p', auth: 'a' } }, maria.token);
  assert.equal((await hook(event)).status, 200);
  assert.equal(await bal(maria.token, 'EUR'), before + 5_000);
  assert.equal((await hook(event)).status, 200);                                          // a Stripe repete: não credita outra vez
  assert.equal(await bal(maria.token, 'EUR'), before + 5_000);
  assert.equal((await call('GET', `/card-topups/${c.body.id}`, null, maria.token)).body.status, 'completed');
  assert.equal((await call('GET', `/card-topups/${c.body.id}`, null, ana.token)).status, 404);
  const hist = (await call('GET', '/transactions', null, maria.token)).body;
  assert.equal(hist[0].type, 'card_in');
  await sleep(50);
  assert.ok(pushes.some((p) => p.userId === maria.user.id && /cartão/.test(p.title)));

  // Contestação do cartão (chargeback) → alerta para o admin.
  await hook({ id: 'evt_2', type: 'charge.dispute.created', data: { object: { payment_intent: 'pi_test_1', amount: 5100, reason: 'fraudulent' } } });
  const alerts = (await call('GET', '/admin/alerts', null, admin.token)).body;
  assert.ok(alerts.some((a) => a.rule === 'card_dispute' && /fraudulent/.test(a.detail)));
});

test('cartão: se o webhook atrasar, a app confirma ao voltar da página de pagamento; expirados não creditam', async () => {
  const c = (await call('POST', '/card-topups', { amount: '20' }, maria.token)).body;
  const sessionId = Object.keys(stripeMock.sessions).at(-1);
  assert.equal((await call('GET', `/card-topups/${c.id}`, null, maria.token)).body.status, 'pending'); // ainda não pagou
  Object.assign(stripeMock.sessions[sessionId], { payment_status: 'paid', payment_intent: 'pi_test_2' });
  const before = await bal(maria.token, 'EUR');
  assert.equal((await call('GET', `/card-topups/${c.id}`, null, maria.token)).body.status, 'completed');
  assert.equal(await bal(maria.token, 'EUR'), before + 2_000);
  const e = (await call('POST', '/card-topups', { amount: '10' }, maria.token)).body;
  stripeMock.sessions[Object.keys(stripeMock.sessions).at(-1)].status = 'expired';
  assert.equal((await call('GET', `/card-topups/${e.id}`, null, maria.token)).body.status, 'expired');
  assert.equal(await bal(maria.token, 'EUR'), before + 2_000);
});

// ---------------- Extratos bancários e pagamentos em lote (BISTP / CGD) ----------------
test('extrato do BISTP (CSV): encontra as referências, confirma com o valor recebido e nunca usa a mesma linha duas vezes', async () => {
  const d1 = (await call('POST', '/bank/deposits', { amount: '500', currency: 'STN' }, ana.token)).body;
  const d2 = (await call('POST', '/bank/deposits', { amount: '300', currency: 'STN' }, bruno.token)).body;
  assert.match(d1.reference, /^DP/);
  const csv = [
    'BISTP - Banco Internacional de S. Tomé e Príncipe',
    'Extrato de conta;ST09 0001 0000 0012 3456 7890 1',
    '',
    'Data Mov.;Data Valor;Descritivo;Débito;Crédito;Saldo',
    `05/11/2026;05/11/2026;TRF DE ANA COSTA REF ${d1.reference};;500,00;12.500,00`,
    '06/11/2026;06/11/2026;TRF SEM REFERENCIA;;1.000,00;13.500,00',
    '06/11/2026;06/11/2026;COMISSAO MANUTENCAO;2,50;;13.497,50',
    `07/11/2026;07/11/2026;"TRF ${d2.reference.toLowerCase()} BRUNO; NETO";;290,00;13.787,50`,
  ].join('\r\n');
  assert.equal((await call('POST', '/admin/statements', { currency: 'STN', content: csv }, ana.token)).status, 403);
  const p = await call('POST', '/admin/statements', { currency: 'STN', content: csv, filename: 'extrato-bistp.csv' }, admin.token);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(p.body.format, 'csv');
  assert.equal(p.body.rows.length, 3); // a comissão (débito) é ignorada
  const byRef = (ref) => p.body.rows.find((r) => r.reference === ref);
  assert.equal(byRef(d1.reference).state, 'match');
  assert.equal(byRef(d1.reference).user.name, 'Ana Costa');
  assert.equal(byRef(d2.reference).state, 'amount_differs');
  assert.equal(byRef(d2.reference).amount, 29_000);
  assert.equal(p.body.rows.find((r) => !r.reference).state, 'unmatched');
  assert.deepEqual(p.body.summary, { credits: 3, match: 1, amount_differs: 1, already: 0, unmatched: 1 });

  const anaBefore = await bal(ana.token, 'STN'), brunoBefore = await bal(bruno.token, 'STN');
  const c = await call('POST', `/admin/statements/${p.body.import_id}/confirm`, { line_ids: [byRef(d1.reference).line_id, byRef(d2.reference).line_id], pin: '2580' }, admin.token);
  assert.equal(c.body.confirmed, 2, JSON.stringify(c.body));
  assert.equal(await bal(ana.token, 'STN'), anaBefore + 50_000);
  assert.equal(await bal(bruno.token, 'STN'), brunoBefore + 29_000); // o que realmente chegou
  // O mesmo extrato importado outra vez: as linhas já usadas aparecem como tratadas e não creditam de novo.
  const again = await call('POST', '/admin/statements', { currency: 'STN', content: csv }, admin.token);
  assert.equal(again.body.summary.already, 2);
  const c2 = await call('POST', `/admin/statements/${again.body.import_id}/confirm`, { line_ids: again.body.rows.map((r) => r.line_id), pin: '2580' }, admin.token);
  assert.equal(c2.body.confirmed, 0);
  assert.equal(await bal(ana.token, 'STN'), anaBefore + 50_000);
});

test('extratos MT940 e CAMT.053 (formatos bancários internacionais) também são lidos', async () => {
  const d = (await call('POST', '/bank/deposits', { amount: '75,50', currency: 'EUR' }, maria.token)).body;
  const mt940 = [':20:STMT2026111', ':25:PT50000201231234567890154', ':28C:00001/001', ':60F:C261110EUR1000,00',
    ':61:2611101110C75,50NTRFNONREF//1234', `:86:TRF SEPA DE MARIA ESPANHA ${d.reference}`,
    ':61:2611101110D10,00NMSCNONREF', ':86:COMISSAO', ':62F:C261110EUR1065,50', '-'].join('\r\n');
  const p = (await call('POST', '/admin/statements', { currency: 'EUR', content: mt940 }, admin.token)).body;
  assert.equal(p.format, 'mt940');
  assert.equal(p.rows.length, 1);
  assert.equal(p.rows[0].state, 'match');
  assert.equal(p.rows[0].date, '2026-11-10');
  const d2 = (await call('POST', '/bank/deposits', { amount: '20', currency: 'EUR' }, maria.token)).body;
  const camt = `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt>
    <Ntry><Amt Ccy="EUR">20.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><BookgDt><Dt>2026-11-12</Dt></BookgDt>
      <NtryDtls><TxDtls><RltdPties><Dbtr><Nm>Maria Espanha</Nm></Dbtr></RltdPties><RmtInf><Ustrd>Carregamento ${d2.reference}</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
    <Ntry><Amt Ccy="EUR">5.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>2026-11-12</Dt></BookgDt></Ntry>
  </Stmt></BkToCstmrStmt></Document>`;
  const q = (await call('POST', '/admin/statements', { currency: 'EUR', content: camt }, admin.token)).body;
  assert.equal(q.format, 'camt053');
  assert.equal(q.rows.length, 1);
  assert.equal(q.rows[0].state, 'match');
  assert.equal(q.rows[0].amount, 2_000);
  assert.equal((await call('POST', '/admin/statements', { currency: 'EUR', content: 'isto não é um extrato' }, admin.token)).body.error, 'bad_statement');
});

test('pagar em lote: ficheiro SEPA para a CGD, o cliente já não pode cancelar, marcar o lote como pago', async () => {
  await call('POST', '/admin/payout-providers', { currency: 'EUR', provider: 'manual', pin: '2580' }, admin.token);
  const w1 = (await call('POST', '/bank/withdrawals', { amount: '12,34', currency: 'EUR', iban: IBAN_MARIA, holder: 'María Espanha', pin: '2580' }, maria.token)).body.request;
  const w2 = (await call('POST', '/bank/withdrawals', { amount: '5', currency: 'EUR', iban: IBAN_MARIA, holder: 'Maria Espanha', pin: '2580' }, maria.token)).body.request;
  const prev = (await call('GET', '/admin/payout-batches/preview?currency=EUR', null, admin.token)).body;
  assert.ok(prev.count >= 2);
  assert.equal((await call('POST', '/admin/payout-batches', { currency: 'STN', format: 'sepa', pin: '2580' }, admin.token)).body.error, 'sepa_eur_only');
  const b = await call('POST', '/admin/payout-batches', { currency: 'EUR', format: 'sepa', pin: '2580' }, admin.token);
  assert.equal(b.status, 200, JSON.stringify(b.body));
  const xml = b.body.content;
  assert.match(xml, /urn:iso:std:iso:20022:tech:xsd:pain\.001\.001\.03/);
  assert.match(xml, new RegExp(`<NbOfTxs>${b.body.count}</NbOfTxs>`));
  assert.match(xml, new RegExp(`<CtrlSum>${(b.body.total / 100).toFixed(2)}</CtrlSum>`));
  assert.match(xml, /<IBAN>PT50000201231234567890154<\/IBAN>/); // conta da empresa (CGD)
  assert.match(xml, /<IBAN>ES9121000418450200051332<\/IBAN>/);
  assert.match(xml, /<Nm>Maria Espanha<\/Nm>/); // "María" sem acento (SEPA)
  assert.match(xml, new RegExp(`<EndToEndId>${w1.reference}</EndToEndId>`));
  assert.match(xml, /<InstdAmt Ccy="EUR">12\.34<\/InstdAmt>/);
  assert.equal((await call('POST', `/bank/requests/${w2.id}/cancel`, null, maria.token)).body.error, 'already_sent');
  assert.equal((await call('POST', '/admin/payout-batches', { currency: 'EUR', format: 'sepa', pin: '2580' }, admin.token)).body.error, 'nothing_pending');
  const paid = await call('POST', `/admin/payout-batches/${b.body.batch_id}/paid`, { bank_reference: 'CGD-LOTE-77', pin: '2580' }, admin.token);
  assert.equal(paid.body.paid, b.body.count);
  const mine = (await call('GET', '/bank/requests', null, maria.token)).body;
  assert.equal(mine.find((r) => r.id === w1.id).status, 'completed');
  assert.match(mine.find((r) => r.id === w1.id).bank_reference, /CGD-LOTE-77/);
  assert.equal((await call('GET', '/admin/payout-batches', null, admin.token)).body[0].status, 'paid');
});

test('pagar em lote em Dobras (CSV para o BISTP); cancelar o lote devolve os pedidos ao estado normal', async () => {
  await call('POST', '/admin/payout-providers', { currency: 'STN', provider: 'manual', pin: '2580' }, admin.token);
  const w = (await call('POST', '/bank/withdrawals', { amount: '100', currency: 'STN', iban: IBAN_ROSA, holder: 'Ana Costa', pin: '2580' }, ana.token)).body.request;
  const b = (await call('POST', '/admin/payout-batches', { currency: 'STN', format: 'csv', pin: '2580' }, admin.token)).body;
  assert.ok(b.content.startsWith('﻿IBAN;Titular;Valor;Moeda;Descritivo'));
  assert.match(b.content, new RegExp(`ST03000200000098765432101;Ana Costa;100,00;STN;DobraPay ${w.reference}`));
  const cancel = await call('POST', `/admin/payout-batches/${b.batch_id}/cancel`, { pin: '2580' }, admin.token);
  assert.equal(cancel.body.status, 'cancelled');
  const back = await call('POST', `/bank/requests/${w.id}/cancel`, null, ana.token); // o cliente já pode cancelar
  assert.equal(back.body.status, 'cancelled');
});

test('livro-razão: em cada moeda a soma de todos os saldos é zero', async () => {
  const s = (await call('GET', '/admin/stats', null, admin.token)).body;
  assert.equal(s.ledger.ok, true, JSON.stringify(s.ledger));
  const stn = s.by_currency.find((c) => c.currency === 'STN');
  assert.ok(stn.fees > 0);
  assert.ok(s.totals_eur.fx_result > 0, 'a margem de câmbio deve dar lucro');
  assert.equal((await call('GET', '/admin/stats', null, ana.token)).status, 403);
});

test('QR code para receber', async () => {
  const res = await fetch(base + '/me/qr.svg?amount=50', { headers: { authorization: 'Bearer ' + ana.token } });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /^<svg/);
});
