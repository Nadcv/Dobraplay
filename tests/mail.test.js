// Códigos por e-mail: Resend primeiro, Brevo se a Resend falhar ou chegar ao limite.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { openDb } = require('../src/db');
const { createService } = require('../src/service');
const { createApp } = require('../src/app');
const { createMailSender } = require('../src/features/mail');

// Resend e Brevo falsas: guardam o que recebem e respondem como mandarmos.
function mock(name) {
  const m = { name, sent: [], reply: null, server: null, url: '', headers: [] };
  m.server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      m.headers.push(req.headers);
      const body = JSON.parse(b);
      const [status, out] = m.reply ? m.reply(body) : [200, { id: name + '-' + (m.sent.length + 1) }];
      if (status < 300) m.sent.push({ path: req.url, body });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  return m;
}
const resend = mock('resend'), brevo = mock('brevo');
const codeOf = (msg) => (msg.body.text || msg.body.textContent).match(/\b(\d{6})\b/)[1];
const lastTo = (m) => { const b = m.sent.at(-1).body; return b.to[0].email || b.to[0]; };

let db, server, base, clock = Date.now();
const env = () => ({ RESEND_API_KEY: 're_test', RESEND_API_BASE: resend.url, RESEND_FROM: 'DobraPay <codigos@exemplo.st>',
  BREVO_API_KEY: 'xkeysib-test', BREVO_API_BASE: brevo.url, BREVO_FROM: 'dobrapay@exemplo.com' });

async function call(method, path, body, token) {
  const res = await fetch(base + '/api' + path, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

test.before(async () => {
  for (const m of [resend, brevo]) {
    m.server.listen(0);
    await new Promise((r) => m.server.once('listening', r));
    m.url = `http://127.0.0.1:${m.server.address().port}`;
  }
  db = await openDb({ file: ':memory:' });
  const mailSender = createMailSender(env(), { now: () => clock, log: { warn() {} } });
  const service = createService(db, { adminPhone: '9900000', env: {}, mailSender });
  server = createApp(service, {}).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  for (const s of [server, resend.server, brevo.server]) s.close();
  await db.close?.();
});

test('configuração anuncia códigos por e-mail', async () => {
  assert.equal((await call('GET', '/config')).body.otp_channel, 'email');
});

let token;
test('registo: e-mail obrigatório, código vai pela Resend e fica ligado a esse e-mail', async () => {
  assert.equal((await call('POST', '/auth/otp', { phone: '9911111', country: 'ST', purpose: 'register' })).body.error, 'bad_email');
  const o = await call('POST', '/auth/otp', { phone: '9911111', country: 'ST', purpose: 'register', email: ' Maria@Exemplo.ST ' });
  assert.equal(o.status, 200, JSON.stringify(o.body));
  assert.equal(o.body.channel, 'email');
  assert.equal(o.body.dev_code, undefined); // nunca aparece no ecrã
  assert.equal(resend.sent.length, 1);
  assert.equal(resend.headers.at(-1).authorization, 'Bearer re_test');
  assert.equal(lastTo(resend), 'maria@exemplo.st');
  const code = codeOf(resend.sent[0]);
  // O mesmo código com outro e-mail não serve.
  const other = await call('POST', '/auth/register', { phone: '9911111', name: 'Maria Neves', pin: '2580', country: 'ST', code, email: 'outra@exemplo.st' });
  assert.equal(other.body.error, 'otp_wrong');
  const ok = await call('POST', '/auth/register', { phone: '9911111', name: 'Maria Neves', pin: '2580', country: 'ST', code, email: 'maria@exemplo.st' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.user.email, 'maria@exemplo.st');
  token = ok.body.token;
});

test('se a Resend chegar ao limite, segue pela Brevo (e a Resend fica de parte até ao dia seguinte)', async () => {
  resend.reply = () => [429, { name: 'daily_quota_exceeded', message: 'You have reached your daily email sending quota.' }];
  const o = await call('POST', '/auth/otp', { phone: '9922222', country: 'ST', purpose: 'register', email: 'joao@exemplo.st' });
  assert.equal(o.status, 200, JSON.stringify(o.body));
  assert.equal(brevo.sent.length, 1);
  assert.equal(brevo.sent[0].path, '/v3/smtp/email');
  assert.equal(brevo.headers.at(-1)['api-key'], 'xkeysib-test');
  assert.deepEqual(brevo.sent[0].body.sender, { name: 'DobraPay', email: 'dobrapay@exemplo.com' });
  assert.equal(lastTo(brevo), 'joao@exemplo.st');
  const ok = await call('POST', '/auth/register', { phone: '9922222', name: 'João Pina', pin: '2580', country: 'ST', code: codeOf(brevo.sent[0]), email: 'joao@exemplo.st' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  // A Resend já não é chamada enquanto estiver de parte, mesmo que volte a responder.
  resend.reply = null;
  const before = resend.headers.length;
  await call('POST', '/auth/otp', { phone: '9933333', country: 'ST', purpose: 'register', email: 'ines@exemplo.st' });
  assert.equal(resend.headers.length, before);
  assert.equal(brevo.sent.length, 2);
  const status = (await call('GET', '/admin/mail', null, token)).status;
  assert.equal(status, 403); // só para administradores
  // No dia seguinte volta à Resend.
  clock += 86_400_000;
  await call('POST', '/auth/otp', { phone: '9944444', country: 'ST', purpose: 'register', email: 'rui@exemplo.st' });
  assert.equal(lastTo(resend), 'rui@exemplo.st');
});

test('remetente sem domínio verificado (403) ou Resend em baixo também passam para a Brevo', async () => {
  resend.reply = () => [403, { message: 'You can only send testing emails to your own email address' }];
  await call('POST', '/auth/otp', { phone: '9955555', country: 'ST', purpose: 'register', email: 'ana@exemplo.st' });
  assert.equal(lastTo(brevo), 'ana@exemplo.st');
  clock += 11 * 60_000;
  resend.reply = () => [500, { message: 'erro interno' }];
  await call('POST', '/auth/otp', { phone: '9966666', country: 'ST', purpose: 'register', email: 'leo@exemplo.st' });
  assert.equal(lastTo(brevo), 'leo@exemplo.st');
  resend.reply = null;
});

test('se os dois falharem: erro claro e o código não fica válido', async () => {
  resend.reply = () => [500, { message: 'x' }];
  brevo.reply = () => [500, { message: 'y' }];
  const o = await call('POST', '/auth/otp', { phone: '9977777', country: 'ST', purpose: 'register', email: 'eva@exemplo.st' });
  assert.equal(o.status, 503);
  assert.equal(o.body.error, 'otp_send_failed');
  resend.reply = null; brevo.reply = null;
});

test('esqueci o PIN: código vai para o e-mail da conta; sem e-mail não envia (resposta igual)', async () => {
  const n = resend.sent.length;
  const r = await call('POST', '/auth/otp', { phone: '9911111', country: 'ST', purpose: 'reset_pin' });
  assert.equal(r.status, 200);
  assert.equal(r.body.email, undefined); // não revela o e-mail
  assert.equal(resend.sent.length, n + 1);
  assert.equal(lastTo(resend), 'maria@exemplo.st');
  assert.match(resend.sent.at(-1).body.text, /mudar o PIN/);
  const reset = await call('POST', '/auth/reset-pin', { phone: '9911111', country: 'ST', code: codeOf(resend.sent.at(-1)), newPin: '7391' });
  assert.equal(reset.status, 200, JSON.stringify(reset.body));
  token = reset.body.token;
  // Número sem conta: mesma resposta, nada enviado.
  const ghost = await call('POST', '/auth/otp', { phone: '9988888', country: 'ST', purpose: 'reset_pin' });
  assert.equal(ghost.body.sent, true);
  assert.equal(resend.sent.length, n + 1);
});

test('perfil: mudar o e-mail exige o código enviado para o e-mail novo', async () => {
  assert.equal((await call('POST', '/me/email/code', { email: 'nada' }, token)).body.error, 'bad_email');
  const o = await call('POST', '/me/email/code', { email: 'maria.nova@exemplo.st' }, token);
  assert.equal(o.status, 200, JSON.stringify(o.body));
  assert.equal(o.body.dev_code, undefined);
  assert.equal(lastTo(resend), 'maria.nova@exemplo.st');
  const code = codeOf(resend.sent.at(-1));
  assert.equal((await call('POST', '/me/email', { email: 'outro@exemplo.st', code }, token)).body.error, 'otp_wrong');
  const ok = await call('POST', '/me/email', { email: 'maria.nova@exemplo.st', code }, token);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.email, 'maria.nova@exemplo.st');
});

test('sem chaves: modo de teste (código no ecrã)', async () => {
  const m = createMailSender({});
  assert.equal(m.sandbox, true);
  assert.throws(() => createMailSender({ BREVO_API_KEY: 'x' }), /BREVO_FROM/);
});
