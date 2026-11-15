const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createService } = require('../src/service');
const { createApp } = require('../src/app');
const { normalizePhone, parseAmount } = require('../src/util');

const ADMIN = '9900000';
let server, base, db;

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
  db = await openDb(PG_URL ? { url: PG_URL } : { file: ':memory:' });
  const service = createService(db, { adminPhone: ADMIN });
  server = createApp(service).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
test.after(async () => { server.close(); await db.close(); });

async function call(method, path, body, token) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}
const register = async (phone, name, country = 'ST', pin = '2580') => {
  const r = await call('POST', '/auth/register', { phone, name, pin, country });
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

test('livro-razão: em cada moeda a soma de todos os saldos é zero', async () => {
  const s = (await call('GET', '/admin/stats', null, admin.token)).body;
  assert.equal(s.ledger.ok, true, JSON.stringify(s.ledger));
  const stn = s.by_currency.find((c) => c.currency === 'STN');
  assert.equal(stn.emoney, 50_000_000);
  assert.ok(stn.fees > 0);
  assert.ok(s.totals_eur.fx_result > 0, 'a margem de câmbio deve dar lucro');
  assert.equal((await call('GET', '/admin/stats', null, ana.token)).status, 403);
});

test('QR code para receber', async () => {
  const res = await fetch(base + '/me/qr.svg?amount=50', { headers: { authorization: 'Bearer ' + ana.token } });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /^<svg/);
});
