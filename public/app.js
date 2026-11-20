// DobraPay — app do cliente (JavaScript simples, sem frameworks).
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (cents, cur) => {
  const abs = Math.abs(cents);
  const int = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${cents < 0 ? '-' : ''}${int},${String(abs % 100).padStart(2, '0')} ${cur}`;
};
const prettyPhone = (p) => {
  if (!p) return '';
  const c = Object.values(CFG.countries).find((x) => p.startsWith('+' + x.dial));
  if (!c) return p;
  return `+${c.dial} ${p.slice(c.dial.length + 1).replace(/(\d{3})(?=\d{3,})/g, '$1 ')}`;
};
const flagOf = (country) => (CFG.countries[country] || {}).flag || '';
const when = (ts) => new Date(ts).toLocaleString(typeof LANG !== 'undefined' && LANG !== 'pt' ? LANG : 'pt-PT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
const debounce = (fn, ms = 350) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

let CFG = { countries: {}, currencies: {} };
const state = { token: localStorage.getItem('dp_token'), me: null, hideBalance: localStorage.getItem('dp_hide') === '1' };

// ---------------- API ----------------
async function api(method, path, body) {
  let res;
  try {
    res = await fetch('/api' + path, {
      method,
      headers: { 'content-type': 'application/json', ...(state.token ? { authorization: 'Bearer ' + state.token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Sem ligação à internet. Verifique a rede e tente de novo.');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.error === 'unauthorized') logoutLocal();
  if (!res.ok) throw Object.assign(new Error(data.message || 'Erro inesperado.'), { code: data.error });
  return data;
}

function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 4000);
}

// ---------------- Componentes de formulário ----------------
const countryOptions = (selected) => Object.entries(CFG.countries)
  .map(([k, c]) => `<option value="${k}" ${k === selected ? 'selected' : ''}>${c.flag} +${c.dial}</option>`).join('');
const currencyOptions = (selected, list = Object.keys(CFG.currencies)) => list
  .map((k) => `<option value="${k}" ${k === selected ? 'selected' : ''}>${k} · ${esc(CFG.currencies[k].name)}</option>`).join('');
// Carteiras do utilizador, com saldo, para escolher de onde sai o dinheiro.
const walletOptions = (selected) => state.me.wallets
  .map((w) => `<option value="${w.currency}" ${w.currency === selected ? 'selected' : ''}>${w.currency} · saldo ${esc(money(w.balance, w.currency))}</option>`).join('');

const pinField = '<label>O seu PIN<input name="pin" type="password" inputmode="numeric" maxlength="6" autocomplete="off" required></label>';
const phoneField = (name, label, value = '') => `<label>${label}
  <div class="phone"><select name="${name}_cc" aria-label="País">${countryOptions(state.me.country)}</select>
  <input name="${name}" inputmode="tel" placeholder="${esc(CFG.countries[state.me.country].example)}" value="${esc(value)}" required></div></label>
  <div class="who" data-who hidden></div>`;
const amountField = (label = 'Valor', value = '') => `<label>${label}<input name="amount" inputmode="decimal" placeholder="0,00" value="${esc(value)}" required></label>`;
const fromWalletField = (label = 'Pagar com') => `<label>${label}<select name="from_currency">${walletOptions(state.me.receive_currency)}</select></label>`;
const quoteBox = '<div class="quote" data-quote hidden></div>';

// Número completo a partir do país escolhido + número (aceita também "+244…").
function fullPhone(form, name) {
  const raw = (form.querySelector(`[name=${name}]`).value || '').replace(/[\s\-().]/g, '');
  if (!raw) return '';
  if (raw.startsWith('+') || raw.startsWith('00')) return raw;
  const cc = form.querySelector(`[name=${name}_cc]`).value;
  return '+' + CFG.countries[cc].dial + raw;
}

function renderQuote(box, q, { getLabel = 'Recebe', payLabel = 'Paga' } = {}) {
  const rows = [];
  if (q.recipient) rows.push(`<div><span>Para</span><strong>${flagOf(q.recipient.country)} ${esc(q.recipient.name)}</strong></div>`);
  rows.push(`<div><span>${payLabel}</span><span>${esc(money(q.amount, q.currency))}</span></div>`);
  if (q.fee) rows.push(`<div><span>Taxa</span><span>${esc(money(q.fee, q.currency))}</span></div>`);
  if (q.fee) rows.push(`<div><span>Total</span><strong>${esc(money(q.total, q.currency))}</strong></div>`);
  if (q.currency !== q.to_currency) rows.push(`<div><span>Câmbio</span><span>1 ${q.currency} = ${q.rate.toLocaleString('pt-PT', { maximumSignificantDigits: 6 })} ${q.to_currency}</span></div>`);
  rows.push(`<div class="get"><span>${getLabel}</span><span>${esc(money(q.to_amount, q.to_currency))}</span></div>`);
  if (q.paused) rows.push(`<div style="color:var(--red);font-weight:600">⚠️ ${esc(q.paused.message)}</div>`);
  else if (q.quote_id && q.currency !== q.to_currency) rows.push('<div class="lock"><span>🔒 Câmbio garantido</span><span data-countdown></span></div>');
  box.className = q.paused ? 'quote err' : 'quote';
  box.innerHTML = rows.join('');
  box.hidden = false;
}

// Mostra quantos segundos faltam no câmbio garantido; quando acaba, pede outra cotação.
function startCountdown(form, box, q, renew) {
  clearInterval(form._countdown);
  const el = $('[data-countdown]', box);
  if (!el || !q.expires_at) return;
  const tick = () => {
    if (!form.isConnected) { clearInterval(form._countdown); return; }
    const left = Math.round((q.expires_at - Date.now()) / 1000);
    if (left <= 0) { clearInterval(form._countdown); el.textContent = 'a atualizar…'; renew(); return; }
    el.textContent = `${left} s`;
  };
  tick();
  form._countdown = setInterval(tick, 1000);
}
const quoteOf = (form) => form.dataset.quoteId || undefined;

// Pede a cotação ao servidor sempre que o formulário muda.
function attachQuote(form, fetcher, opts) {
  const box = $('[data-quote]', form);
  const update = debounce(async () => {
    const f = new FormData(form);
    form.dataset.expected = '';
    form.dataset.quoteId = '';
    if (!f.get('amount')) { box.hidden = true; return; }
    try {
      const q = await fetcher(f);
      if (!q) { box.hidden = true; return; }
      renderQuote(box, q, opts);
      form.dataset.quoteId = q.quote_id || '';
      startCountdown(form, box, q, update);
      form.dataset.expected = q.to_amount;
      form.dataset.total = q.total;
      form.dataset.currency = q.currency;
    } catch (err) {
      box.className = 'quote err'; box.textContent = err.message; box.hidden = false;
    }
  });
  // O PIN e a mensagem não mudam a cotação: não volta a pedir ao servidor.
  const relevant = (e) => !['pin', 'note'].includes(e.target.name) && update();
  form.addEventListener('input', relevant);
  form.addEventListener('change', relevant);
  update();
}

// Mostra o nome do titular assim que o número está completo (evita enganos).
function attachLookup(form, field) {
  const who = form.querySelector('[data-who]');
  const check = debounce(async () => {
    const digits = (form.querySelector(`[name=${field}]`).value || '').replace(/\D/g, '');
    if (digits.length < 7) { who.hidden = true; return; }
    try {
      const u = await api('GET', '/lookup?phone=' + encodeURIComponent(fullPhone(form, field)));
      who.className = 'who';
      who.textContent = `✓ ${flagOf(u.country)} ${u.name}${u.role === 'agent' ? ' (agente)' : ''} · recebe em ${u.receive_currency}`;
    } catch (err) {
      who.className = 'who err'; who.textContent = err.message;
      // Ainda não tem DobraPay: oferece enviar para a conta bancária da pessoa.
      if (err.code === 'not_found' && field === 'to') {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'btn small'; b.style.marginTop = '8px'; b.textContent = '🏦 Enviar para a conta bancária desta pessoa';
        b.addEventListener('click', () => openSheet('sendBank', { phone: fullPhone(form, field) }));
        who.append(document.createElement('br'), b);
      }
    }
    who.hidden = false;
  }, 250);
  form.querySelector(`[name=${field}]`).addEventListener('input', check);
  form.querySelector(`[name=${field}_cc]`).addEventListener('change', check);
  if (form.querySelector(`[name=${field}]`).value) check();
}

// ---------------- Autenticação ----------------
// Modos: login, register (2 passos: código por e-mail/SMS e depois criar a conta) e reset (esqueci o PIN).
let authMode = 'login';
// Por onde chegam os códigos: 'email' (Resend/Brevo), 'sms' ou 'sandbox' (modo de teste).
const otpChannel = () => CFG.otp_channel || 'sandbox';
let codeSent = false;
function setAuthMode(mode) {
  authMode = mode; codeSent = false;
  const form = $('#authForm');
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x.dataset.tab === mode));
  $('.tabs').hidden = mode === 'reset';
  form.querySelectorAll('[data-only]').forEach((el) => {
    const only = el.dataset.only;
    el.hidden = only === 'register' ? mode !== 'register' : only === 'reset' ? mode !== 'reset' : only === 'code' ? true : only === 'pin' ? mode === 'reset' : el.hidden;
  });
  $('[data-devcode]', form).hidden = true;
  $('[data-pinlabel]', form).textContent = t(mode === 'reset' ? 'Novo PIN (4 a 6 dígitos)' : 'PIN (4 a 6 dígitos)');
  form.pin.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  form.querySelector('button[type=submit]').textContent = t(mode === 'login' ? 'Entrar' : { sms: 'Enviar código por SMS', email: 'Enviar código por e-mail' }[otpChannel()] || 'Enviar código');
  $('[data-codelabel]', form).textContent = t({ sms: 'Código recebido por SMS', email: 'Código recebido por e-mail' }[otpChannel()] || 'Código recebido');
  form.email.required = mode === 'register' && otpChannel() === 'email';
  $('[data-forgot]', form).hidden = mode !== 'login';
  $('[data-backlogin]', form).hidden = mode !== 'reset';
  $('[data-passkey-login]', form).hidden = mode !== 'login' || !window.PublicKeyCredential;
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => setAuthMode(b.dataset.tab)));
$('[data-forgot]').addEventListener('click', (e) => { e.preventDefault(); setAuthMode('reset'); });
$('[data-backlogin]').addEventListener('click', (e) => { e.preventDefault(); setAuthMode('login'); });

function setupAuthCountry() {
  const sel = $('#authCountry');
  const saved = localStorage.getItem('dp_country') || 'ST';
  sel.innerHTML = Object.entries(CFG.countries).map(([k, c]) => `<option value="${k}" ${k === saved ? 'selected' : ''}>${c.flag} ${esc(c.name)} (${c.currency})</option>`).join('');
  const sync = () => {
    const c = CFG.countries[sel.value];
    $('#authDial').textContent = '+' + c.dial;
    $('#authForm [name=phone]').placeholder = c.example;
  };
  sel.addEventListener('change', sync);
  sync();
}

function signedIn(r, country) {
  state.token = r.token;
  localStorage.setItem('dp_token', r.token);
  if (country) localStorage.setItem('dp_country', country);
  $('#authForm').reset();
  setAuthMode('login');
  state.me = r.user;
  showHome();
}

$('#authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const f = new FormData(form);
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    if (authMode === 'login') {
      const r = await api('POST', '/auth/login', { phone: f.get('phone'), pin: f.get('pin'), country: f.get('country') });
      return signedIn(r, f.get('country'));
    }
    if (!codeSent) {
      // Passo 1: pede o código (por e-mail ou SMS).
      if (authMode === 'register' && !f.get('name')) throw new Error(t('Indique o seu nome completo.'));
      if (authMode === 'register' && otpChannel() === 'email' && !f.get('email')) throw new Error(t('Indique o seu e-mail: é para lá que enviamos o código.'));
      const o = await api('POST', '/auth/otp', { phone: f.get('phone'), country: f.get('country'), purpose: authMode === 'register' ? 'register' : 'reset_pin', email: authMode === 'register' ? (f.get('email') || undefined) : undefined });
      codeSent = true;
      form.querySelector('[data-only=code]').hidden = false;
      form.querySelector('[data-only=pin]').hidden = false;
      const dev = $('[data-devcode]', form);
      dev.hidden = !o.dev_code;
      if (o.dev_code) dev.textContent = t('Modo de teste (sem e-mail nem SMS): o seu código é {code}', { code: o.dev_code });
      btn.textContent = t(authMode === 'register' ? 'Criar conta' : 'Guardar novo PIN');
      if (o.dev_code) { /* modo de teste: o código já está no ecrã */ }
      else if (o.channel === 'sms') toast(t('Enviámos um código por SMS para {phone}.', { phone: prettyPhone(o.phone) }));
      else if (authMode === 'register') toast(t('Enviámos um código para {email}. Veja também a pasta de spam.', { email: o.email }));
      else toast(t('Se este número tiver conta com e-mail, enviámos um código para o e-mail registado. Sem e-mail? Peça ajuda a um agente.'));
      form.code.focus();
      return;
    }
    // Passo 2: cria a conta / muda o PIN com o código.
    const r = authMode === 'register'
      ? await api('POST', '/auth/register', { phone: f.get('phone'), name: f.get('name'), email: f.get('email') || undefined, pin: f.get('pin'), country: f.get('country'), code: f.get('code') })
      : await api('POST', '/auth/reset-pin', { phone: f.get('phone'), country: f.get('country'), code: f.get('code'), newPin: f.get('pin') });
    if (authMode === 'reset') toast(t('PIN alterado. Já entrou na sua conta.'));
    signedIn(r, f.get('country'));
  } catch (err) { toast(errText(err), true); }
  finally { btn.disabled = false; }
});

// Face ID / impressão digital (passkeys). A biblioteca só é carregada quando é precisa.
function loadWebAuthn() {
  if (window.SimpleWebAuthnBrowser) return Promise.resolve(window.SimpleWebAuthnBrowser);
  return new Promise((resolve, reject) => {
    const sc = document.createElement('script');
    sc.src = '/vendor/webauthn.js';
    sc.onload = () => resolve(window.SimpleWebAuthnBrowser);
    sc.onerror = () => reject(new Error(t('Não foi possível carregar o Face ID. Verifique a ligação.')));
    document.head.append(sc);
  });
}
$('[data-passkey-login]').addEventListener('click', async () => {
  try {
    const wa = await loadWebAuthn();
    const o = await api('POST', '/auth/passkey/options');
    const response = await wa.startAuthentication({ optionsJSON: o.options });
    signedIn(await api('POST', '/auth/passkey', { challenge_id: o.challenge_id, response }));
  } catch (err) {
    if (err && err.name === 'NotAllowedError') return; // a pessoa cancelou
    toast(errText(err), true);
  }
});

function logoutLocal() {
  state.token = null; state.me = null;
  localStorage.removeItem('dp_token');
  closeSheet();
  $('#home').hidden = true;
  $('#auth').hidden = false;
  closeMenu();
}

// ---------------- Ecrã principal ----------------
async function showHome() {
  $('#auth').hidden = true;
  $('#home').hidden = false;
  await refresh();
  // Veio de um QR code lido com a câmara do telemóvel: abre logo o ecrã certo.
  const link = JSON.parse(sessionStorage.getItem('dp_link') || 'null');
  if (link && state.me) {
    sessionStorage.removeItem('dp_link');
    if (link.cartao) waitCardTopup(link.id, link.cartao);
    else if (link.pagar) openSheet('pay', { code: link.pagar });
    else if (link.enviar) openSheet('send', { to: link.enviar, amount: link.valor ? link.valor.replace('.', ',') : '' });
  }
}

async function refresh() {
  if (!state.token) return;
  try {
    const [me, txs, reqs, bank] = await Promise.all([api('GET', '/me'), api('GET', '/transactions?limit=30'), api('GET', '/requests'), api('GET', '/bank/requests')]);
    state.me = me;
    renderMe();
    renderHistory(txs);
    renderPending(reqs, bank);
    if (me.role === 'admin') {
      api('GET', '/admin/bank/requests').then((r) => { $('#bankBadge').textContent = r.length || ''; }).catch(() => {});
      api('GET', '/admin/kyc').then((r) => { $('#kycBadge').textContent = r.length || ''; }).catch(() => {});
      api('GET', '/admin/alerts').then((r) => { $('#alertBadge').textContent = r.length || ''; }).catch(() => {});
    }
  } catch (err) { if (state.token) toast(err.message, true); }
}

function renderMe() {
  const m = state.me;
  $('#hello').textContent = `${m.name.split(' ')[0]} ${flagOf(m.country)}`;
  const main = m.wallets.find((w) => w.currency === m.receive_currency) || { balance: 0, currency: m.receive_currency };
  const others = m.wallets.filter((w) => w !== main);
  $('#balance').textContent = state.hideBalance ? `••••• ${main.currency}` : money(main.balance, main.currency);
  $('#wallets').innerHTML = others.map((w) => `<span>${state.hideBalance ? '•••' : esc(money(w.balance, w.currency))}</span>`).join('')
    + (others.length && !state.hideBalance ? `<span>Total ≈ ${esc(money(m.total_eur, 'EUR'))}</span>` : '');
  $('#limits').textContent = m.limits.daily ? `Limite diário: ${money(m.limits.dailyUsed, 'EUR')} de ${money(m.limits.daily, 'EUR')} usados` : '';
  $('#agentBar').hidden = !['agent', 'admin'].includes(m.role);
  $('#adminBar').hidden = m.role !== 'admin';
  $('#menuBtn').hidden = !['agent', 'admin'].includes(m.role); // o menu ⋮ só aparece a agentes e admin
  $('#merchantBar').hidden = !m.merchant_name;
  if (m.merchant_name) $('#merchantName').textContent = '🏪 ' + m.merchant_name;
}

$('#balance').addEventListener('click', () => {
  state.hideBalance = !state.hideBalance;
  localStorage.setItem('dp_hide', state.hideBalance ? '1' : '0');
  renderMe();
});

const TX_LABEL = { p2p: 'Transferência', request: 'Pedido pago', cash_in: 'Depósito', cash_out: 'Levantamento', issue: 'Float emitido', exchange: 'Câmbio',
  bank_in: 'Carregamento por banco', card_in: 'Carregamento com cartão', bill: 'Recarga / conta', commission: 'Comissão', bank_out: 'Para conta bancária', merchant: 'Pagamento em loja', refund: 'Devolução', settlement: 'Acerto entre bancos' };
const TX_ICON = { p2p: '↗', request: '✋', cash_in: '⬇', cash_out: '💵', issue: '🏦', exchange: '⇄', bank_in: '🏦', card_in: '💳', bank_out: '🏦', bill: '💡', commission: '💰', merchant: '🛒', refund: '↩', settlement: '🏦' };

function renderHistory(txs) {
  const ul = $('#history');
  if (!txs.length) { ul.innerHTML = '<li class="empty">Ainda sem movimentos. Deposite dinheiro num agente para começar.</li>'; return; }
  ul.innerHTML = txs.map((t) => {
    let title, amt, cls = t.direction;
    if (t.direction === 'self') {
      title = `${t.currency} → ${t.to_currency}`;
      amt = `+${esc(money(t.to_amount, t.to_currency))}<br><small>-${esc(money(t.amount + t.fee, t.currency))}</small>`;
      cls = 'in';
    } else if (t.direction === 'out') {
      const toPerson = t.type === 'bank_out' && /^Envio para (.+?) · /.exec(t.note || '');
      title = toPerson ? toPerson[1] : `${flagOf(t.to.country)} ${t.to.name}`;
      amt = esc(`-${money(t.amount + t.fee, t.currency)}`);
    } else {
      title = t.type === 'bank_in' ? 'Transferência bancária' : t.type === 'card_in' ? window.t('Cartão') : `${flagOf(t.from.country)} ${t.from.name}`;
      amt = esc(`+${money(t.to_amount, t.to_currency)}`);
    }
    const conv = t.currency !== t.to_currency && t.direction !== 'self'
      ? ` · ${t.direction === 'out' ? 'recebeu ' + money(t.to_amount, t.to_currency) : 'enviou ' + money(t.amount, t.currency)}` : '';
    return `<li data-tx="${esc(t.id)}" style="cursor:pointer">
      <span class="tx-ico">${TX_ICON[t.type] || '•'}</span>
      <span class="tx-main"><strong>${esc(title)}</strong>
        <small>${esc(TX_LABEL[t.type])} · ${esc(when(t.created_at))}${esc(conv)}${t.note && t.note !== TX_LABEL[t.type] ? ' · ' + esc(t.note) : ''}</small></span>
      <span class="tx-amt ${cls}" style="text-align:right">${amt}</span>
    </li>`;
  }).join('');
  ul.querySelectorAll('[data-tx]').forEach((li) => li.addEventListener('click', () => openSheet('receipt', li.dataset.tx)));
}

function renderPending(reqs, bank = []) {
  const incoming = reqs.filter((r) => r.incoming && r.status === 'pending');
  const bankPending = bank.filter((b) => b.status === 'pending');
  $('#pending').innerHTML = bankPending.map((b) => `
    <div class="pending-card">
      <div>🏦 ${b.kind === 'deposit' ? 'Carregamento' : 'Levantamento'} de <strong>${esc(money(b.amount, b.currency))}</strong> · ref. <strong>${esc(b.reference)}</strong>
        <br><small>${b.kind === 'deposit' ? 'À espera da sua transferência bancária' : 'Em processamento pelo banco'}</small></div>
      <button type="button" class="btn small" data-bankreq="${b.id}">Ver</button>
    </div>`).join('') + incoming.map((r) => `
    <div class="pending-card">
      <div>${flagOf(r.requester.country)} <strong>${esc(r.requester.name)}</strong> pede <strong>${esc(money(r.amount, r.currency))}</strong>${r.note ? '<br><small>' + esc(r.note) + '</small>' : ''}</div>
      <button type="button" class="btn small" data-decline="${r.id}">Recusar</button>
      <button type="button" class="btn small primary" data-pay="${r.id}" style="width:auto">Pagar</button>
    </div>`).join('');
  $('#pending').querySelectorAll('[data-pay]').forEach((b) => b.addEventListener('click', () => {
    openSheet('payRequest', incoming.find((x) => String(x.id) === b.dataset.pay));
  }));
  $('#pending').querySelectorAll('[data-bankreq]').forEach((b) => b.addEventListener('click', () => {
    openSheet('bankRequest', bankPending.find((x) => String(x.id) === b.dataset.bankreq));
  }));
  $('#pending').querySelectorAll('[data-decline]').forEach((b) => b.addEventListener('click', async () => {
    try { await api('POST', `/requests/${b.dataset.decline}/decline`); toast('Pedido recusado.'); refresh(); }
    catch (err) { toast(err.message, true); }
  }));
}

// ---------------- Folhas (formulários) ----------------
const qs = (o) => new URLSearchParams(Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== ''))).toString();
const expectedOf = (form) => (form.dataset.expected ? Number(form.dataset.expected) : undefined);

const SHEETS = {
  send: (pre = {}) => ({
    title: 'Enviar dinheiro',
    html: `<form>
      <button type="button" class="choice" data-go="scheduled" style="padding:10px 14px"><span>🔁</span><div><strong>${t('Envio automático todos os meses')}</strong><small>${t('Ex.: mesada para a família')}</small></div></button>
      <button type="button" class="choice" data-go="sendBank" style="padding:10px 14px"><span>🏦</span><div><strong>Para uma conta bancária (IBAN)</strong><small>Para quem ainda não tem DobraPay</small></div></button>
      ${phoneField('to', 'Para (número)', pre.to)}
      ${'BarcodeDetector' in window ? '<button type="button" class="btn small" data-scan style="margin:-6px 0 14px">📷 Ler QR code</button>' : ''}
      ${fromWalletField('Enviar da carteira')}
      ${amountField('Valor a enviar', pre.amount)}
      ${quoteBox}
      <label>Mensagem (opcional)<input name="note" maxlength="140" placeholder="Ex.: renda de março"></label>
      ${pinField}
      <button class="btn primary">Enviar</button></form>`,
    lookup: 'to',
    quote: (f, form) => (fullPhone(form, 'to').replace(/\D/g, '').length >= 9
      ? api('GET', '/quote/transfer?' + qs({ to: fullPhone(form, 'to'), amount: f.get('amount'), from_currency: f.get('from_currency') }))
      : null),
    submit: async (f, key, form) => {
      const r = await api('POST', '/transfers', { to: fullPhone(form, 'to'), amount: f.get('amount'), from_currency: f.get('from_currency'),
        note: f.get('note'), pin: f.get('pin'), idempotency_key: key, expected_to_amount: expectedOf(form), quote_id: quoteOf(form) });
      done(`Enviado! ${r.transaction.to.name} recebeu ${money(r.transaction.to_amount, r.transaction.to_currency)}.`);
    },
  }),

  receive: () => ({
    title: 'Receber dinheiro',
    html: `<div class="center">
      <img class="qr" data-qr alt="QR code para receber">
      <p>Mostre este código ou partilhe o seu número:</p>
      <p class="big-code" style="font-size:1.5rem;letter-spacing:1px">${esc(prettyPhone(state.me.phone))}</p>
      <label style="text-align:left">Quero receber em
        <select data-recv>${currencyOptions(state.me.receive_currency)}</select></label>
      <p class="hint" style="text-align:left">Quem lhe envia pode pagar em qualquer moeda: a app converte e o dinheiro chega na moeda que escolher aqui.</p>
      <label style="text-align:left">Pedir um valor fixo no QR (opcional)<input data-qr-amount inputmode="decimal" placeholder="0,00"></label>
      ${navigator.share ? '<button type="button" class="btn primary" data-share>Partilhar o meu número</button>' : ''}
    </div>`,
    setup: (root) => {
      const img = $('[data-qr]', root);
      const load = async (amount) => {
        const res = await fetch('/api/me/qr.svg' + (amount ? '?amount=' + encodeURIComponent(amount) : ''), { headers: { authorization: 'Bearer ' + state.token } });
        if (res.ok) { if (img.src) URL.revokeObjectURL(img.src); img.src = URL.createObjectURL(await res.blob()); }
      };
      load();
      $('[data-qr-amount]', root).addEventListener('input', debounce((e) => load(e.target.value), 400));
      $('[data-recv]', root).addEventListener('change', async (e) => {
        try { state.me = await api('POST', '/me/receive-currency', { currency: e.target.value }); renderMe(); toast(`Agora recebe em ${e.target.value}.`); }
        catch (err) { toast(err.message, true); }
      });
      const share = $('[data-share]', root);
      if (share) share.addEventListener('click', () => navigator.share({ title: 'DobraPay', text: `Envie-me dinheiro pelo DobraPay para ${prettyPhone(state.me.phone)} (${state.me.name}).` }).catch(() => {}));
    },
  }),

  request: () => ({
    title: 'Pedir dinheiro',
    html: `<form>
      ${phoneField('from', 'A quem pede (número)')}
      <div class="row">${amountField()}<label>Moeda<select name="currency">${currencyOptions(state.me.receive_currency)}</select></label></div>
      <label>Motivo (opcional)<input name="note" maxlength="140" placeholder="Ex.: a tua parte do jantar"></label>
      <p class="hint">A pessoa paga na moeda dela; recebe exatamente o valor pedido.</p>
      <button class="btn primary">Enviar pedido</button></form>`,
    lookup: 'from',
    submit: async (f, key, form) => {
      const r = await api('POST', '/requests', { from: fullPhone(form, 'from'), amount: f.get('amount'), currency: f.get('currency'), note: f.get('note') });
      done(`Pedido de ${money(r.amount, r.currency)} enviado a ${r.payer.name}.`);
    },
  }),

  payRequest: (r) => ({
    title: 'Pagar pedido',
    html: `<form>
      <div class="summary"><div><span>Para</span><strong>${flagOf(r.requester.country)} ${esc(r.requester.name)}</strong></div>
        <div><span>Valor pedido</span><strong>${esc(money(r.amount, r.currency))}</strong></div>
        ${r.note ? `<div><span>Motivo</span><span>${esc(r.note)}</span></div>` : ''}</div>
      <input type="hidden" name="amount" value="1">
      ${fromWalletField()}${quoteBox}${pinField}<button class="btn primary">Pagar</button></form>`,
    quote: (f) => api('GET', `/requests/${r.id}/quote?` + qs({ from_currency: f.get('from_currency') })),
    quoteOpts: { getLabel: 'Ela/ele recebe' },
    submit: async (f, key, form) => {
      await api('POST', `/requests/${r.id}/pay`, { pin: f.get('pin'), from_currency: f.get('from_currency'), idempotency_key: key, quote_id: quoteOf(form) });
      done('Pedido pago.');
    },
  }),

  cashout: () => ({
    title: 'Levantar num agente',
    html: `<form>
      <p class="hint" style="margin:0 0 14px">Gere um código e mostre-o a um agente DobraPay no país onde está. O agente entrega-lhe o dinheiro vivo.</p>
      <div class="row">${amountField('Quero levantar')}<label>Em<select name="currency">${currencyOptions(state.me.home_currency, [...new Set(Object.values(CFG.countries).map((c) => c.currency))])}</select></label></div>
      ${fromWalletField('Sai da carteira')}${quoteBox}${pinField}
      <button class="btn primary">Gerar código</button></form>`,
    quote: (f) => api('GET', '/quote/cashout?' + qs({ amount: f.get('amount'), currency: f.get('currency'), from_currency: f.get('from_currency') })),
    quoteOpts: { payLabel: 'Sai da carteira', getLabel: 'Recebe em mão' },
    submit: async (f) => {
      const r = await api('POST', '/cashout-codes', { amount: f.get('amount'), currency: f.get('currency'), from_currency: f.get('from_currency'), pin: f.get('pin') });
      $('#sheetContent').innerHTML = `<div class="center">
        <p>Mostre este código ao agente:</p>
        <div class="big-code">${esc(r.code)}</div>
        <div class="summary"><div><span>Vai receber em mão</span><strong>${esc(money(r.amount, r.currency))}</strong></div>
          <div><span>Sai da carteira</span><span>${esc(money(r.total, r.from_currency))} (com taxa)</span></div>
          <div><span>Válido até</span><span>${esc(new Date(r.expires_at).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' }))}</span></div></div>
        <p class="hint">O agente precisa também do seu número. Nunca diga o seu PIN.</p>
        <button type="button" class="btn primary" data-close>Fechar</button></div>`;
      bindClose();
    },
  }),

  exchange: () => {
    const others = Object.keys(CFG.currencies).filter((c) => c !== state.me.receive_currency);
    return {
      title: 'Câmbio entre as minhas moedas',
      html: `<form>
        ${fromWalletField('De')}
        <label>Para<select name="to_currency">${currencyOptions(others.includes('EUR') ? 'EUR' : others[0])}</select></label>
        ${amountField('Valor a trocar')}${quoteBox}${pinField}
        <button class="btn primary">Trocar</button></form>`,
      quote: (f) => (f.get('from_currency') === f.get('to_currency') ? null
        : api('GET', '/quote/exchange?' + qs({ amount: f.get('amount'), from_currency: f.get('from_currency'), to_currency: f.get('to_currency') }))),
      quoteOpts: { payLabel: 'Troca', getLabel: 'Fica com' },
      submit: async (f, key, form) => {
        const r = await api('POST', '/exchange', { amount: f.get('amount'), from_currency: f.get('from_currency'), to_currency: f.get('to_currency'),
          pin: f.get('pin'), idempotency_key: key, expected_to_amount: expectedOf(form), quote_id: quoteOf(form) });
        done(`Trocado: +${money(r.transaction.to_amount, r.transaction.to_currency)}.`);
      },
    };
  },

  cashin: () => ({
    title: 'Depósito de cliente',
    html: `<form><p class="hint" style="margin:0 0 14px">O cliente entrega-lhe dinheiro vivo em ${esc(state.me.home_currency)}. O valor pode ir para qualquer pessoa, em qualquer país: chega na moeda em que ela recebe.</p>
      ${phoneField('to', 'Número de quem recebe')}${amountField(`Valor (${esc(state.me.home_currency)})`)}${quoteBox}${pinField}
      <button class="btn primary">Depositar</button></form>`,
    lookup: 'to',
    quote: (f, form) => (fullPhone(form, 'to').replace(/\D/g, '').length >= 9
      ? api('GET', '/agent/quote?' + qs({ to: fullPhone(form, 'to'), amount: f.get('amount') })) : null),
    quoteOpts: { payLabel: 'Depósito', getLabel: 'Chega' },
    submit: async (f, key, form) => {
      const r = await api('POST', '/agent/cash-in', { to: fullPhone(form, 'to'), amount: f.get('amount'), pin: f.get('pin'),
        idempotency_key: key, expected_to_amount: expectedOf(form), quote_id: quoteOf(form) });
      const t = r.transaction;
      done(`Feito. Cobre ao cliente ${money(t.amount + t.fee, t.currency)}. ${t.to.name} recebeu ${money(t.to_amount, t.to_currency)}.`);
    },
  }),

  redeem: () => ({
    title: 'Levantamento de cliente',
    html: `<form><p class="hint" style="margin:0 0 14px">Peça ao cliente o número e o código de 6 dígitos que aparece na app dele.</p>
      ${phoneField('phone', 'Número do cliente')}
      <label>Código do cliente<input name="code" inputmode="numeric" maxlength="6" required></label>
      ${pinField}<button class="btn primary">Confirmar levantamento</button></form>`,
    lookup: 'phone',
    submit: async (f, key, form) => {
      const r = await api('POST', '/agent/cash-out', { phone: fullPhone(form, 'phone'), code: f.get('code'), pin: f.get('pin') });
      $('#sheetContent').innerHTML = `<div class="center"><p>Confirmado. Entregue ao cliente:</p>
        <div class="big-code">${esc(money(r.pay_cash, r.currency))}</div><p>${esc(r.customer.name)} · ${esc(prettyPhone(r.customer.phone))}</p>
        <button type="button" class="btn primary" data-close>Fechar</button></div>`;
      bindClose();
      refresh();
    },
  }),

  float: () => ({
    title: 'Emitir float para agente',
    html: `<form><p class="hint" style="margin:0 0 14px">Só depois de confirmar que o agente depositou o valor equivalente na conta bancária da empresa. O float é emitido na moeda do país do agente.</p>
      ${phoneField('agent_phone', 'Número do agente')}${amountField('Valor (moeda do agente)')}
      <label>Referência do depósito bancário<input name="reference" maxlength="80" required></label>
      ${pinField}<button class="btn primary">Emitir</button></form>`,
    lookup: 'agent_phone',
    submit: async (f, key, form) => {
      const r = await api('POST', '/admin/float', { agent_phone: fullPhone(form, 'agent_phone'), amount: f.get('amount'),
        reference: f.get('reference'), pin: f.get('pin'), idempotency_key: key });
      done(`Emitido ${money(r.transaction.amount, r.transaction.currency)} para ${r.transaction.to.name}.`);
    },
  }),

  rates: () => ({
    title: 'Câmbios (1 EUR = …)',
    html: `<div data-rates></div><form>
      <div class="row"><label>Moeda<select name="currency"></select></label><label>1 EUR =<input name="per_eur" inputmode="decimal" required></label></div>
      ${pinField}<button class="btn primary">Atualizar câmbio</button></form>
      <p class="hint" style="margin-top:12px">STN e CVE têm paridade fixa com o euro. Atualize o AOA e o USD sempre que o câmbio oficial mudar. Margem aplicada: ${(CFG.fx_spread * 100).toFixed(1)}%.</p>`,
    setup: async (root) => {
      const rows = await api('GET', '/rates');
      $('[data-rates]', root).innerHTML = `<table class="cur"><tr><th>Moeda</th><th>1 EUR =</th><th>Atualizado</th></tr>${rows.map((r) =>
        `<tr><td>${r.currency}${r.fixed ? ' 🔒' : ''}</td><td>${r.per_eur}</td><td>${esc(when(r.updated_at))}</td></tr>`).join('')}</table>`;
      $('[name=currency]', root).innerHTML = rows.filter((r) => r.currency !== 'EUR')
        .sort((a, b) => a.fixed - b.fixed).map((r) => `<option value="${r.currency}">${r.currency}</option>`).join('');
    },
    submit: async (f) => {
      await api('POST', '/admin/rates', { currency: f.get('currency'), per_eur: Number(String(f.get('per_eur')).replace(',', '.')), pin: f.get('pin') });
      done('Câmbio atualizado.');
    },
  }),


  // ---------- Carregar / Levantar: escolher como ----------
  topup: () => ({
    title: 'Carregar a carteira',
    html: `${CFG.card_topup && CFG.card_topup.enabled ? `<button type="button" class="choice" data-go="cardTopup"><span>💳</span><div><strong>${t('Com cartão')}</strong><small>${t('Visa, Mastercard, Apple Pay ou Google Pay. O saldo entra na hora.')}</small></div></button>` : ''}
      <button type="button" class="choice" data-go="bankin"><span>🏦</span><div><strong>Por transferência bancária</strong><small>Do seu banco para a conta da DobraPay (ex.: MB Way/homebanking em Portugal, BISTP em São Tomé).</small></div></button>
      <button type="button" class="choice" data-go="agentsNear"><span>📍</span><div><strong>${t('Agentes perto de mim')}</strong><small>${t('Onde depositar ou levantar dinheiro')}</small></div></button>
      <button type="button" class="choice" data-go="agentInfo"><span>🧑🏾‍💼</span><div><strong>Em dinheiro, num agente</strong><small>Entregue o dinheiro a um agente DobraPay e ele carrega a sua carteira na hora.</small></div></button>`,
  }),
  withdraw: () => ({
    title: 'Levantar dinheiro',
    html: `<button type="button" class="choice" data-go="cashout"><span>💵</span><div><strong>Em dinheiro, num agente</strong><small>Gere um código e receba o dinheiro em mão.</small></div></button>
      <button type="button" class="choice" data-go="agentsNear"><span>📍</span><div><strong>${t('Agentes perto de mim')}</strong><small>${t('Onde depositar ou levantar dinheiro')}</small></div></button>
      <button type="button" class="choice" data-go="bankout"><span>🏦</span><div><strong>Para a minha conta bancária</strong><small>Transferência para o seu IBAN (Portugal, Espanha, São Tomé, Angola, Cabo Verde…).</small></div></button>`,
  }),
  agentInfo: () => ({
    title: 'Carregar num agente',
    html: `<div class="center"><p>Vá a um agente DobraPay e diga-lhe o seu número:</p>
      <p class="big-code" style="font-size:1.5rem;letter-spacing:1px">${esc(prettyPhone(state.me.phone))}</p>
      <p class="hint">Entregue o dinheiro e o saldo aparece na sua carteira em segundos. Confirme sempre na app antes de sair.</p>
      <button type="button" class="btn primary" data-close>Entendido</button></div>`,
  }),

  bankin: () => ({
    title: 'Carregar por transferência',
    html: `<form><div data-banks><p class="hint">A carregar…</p></div>
      <div class="row">${amountField('Valor a transferir')}<label>Moeda<select name="currency"></select></label></div>
      <p class="hint">Vamos dar-lhe os dados bancários e uma referência. O saldo entra quando a transferência chegar (normalmente no mesmo dia em Portugal/Espanha; 1 a 3 dias entre países).</p>
      <button class="btn primary">Obter dados para transferir</button></form>`,
    setup: async (root) => {
      const banks = await api('GET', '/bank/accounts');
      const sel = $('[name=currency]', root);
      if (!banks.length) { $('[data-banks]', root).innerHTML = '<p class="who err">Ainda não há contas bancárias disponíveis. Use um agente.</p>'; return; }
      $('[data-banks]', root).innerHTML = '';
      sel.innerHTML = currencyOptions(banks.some((b) => b.currency === state.me.receive_currency) ? state.me.receive_currency : banks[0].currency, banks.map((b) => b.currency));
    },
    submit: async (f) => {
      const r = await api('POST', '/bank/deposits', { amount: f.get('amount'), currency: f.get('currency') });
      refresh();
      openSheet('bankRequest', r);
    },
  }),

  bankRequest: (r) => ({
    title: r.kind === 'deposit' ? 'Dados para a transferência' : 'Levantamento para o banco',
    html: `${r.kind === 'deposit' && r.status === 'pending' ? `<p>Faça uma transferência a partir do <strong>seu</strong> banco com estes dados:</p>
      <div class="summary">
        ${copyRow('Banco', r.pay_to.bank_name)}${copyRow('Titular', r.pay_to.holder)}${copyRow('IBAN', r.pay_to.iban, r.pay_to.iban.replace(/\s/g, ''))}
        ${r.pay_to.swift ? copyRow('SWIFT/BIC', r.pay_to.swift) : ''}${copyRow('Valor', money(r.amount, r.currency), (r.amount / 100).toFixed(2).replace('.', ','))}
        ${copyRow('Descritivo / referência', r.reference)}
      </div>
      <p class="hint">⚠️ Escreva a referência <strong>${esc(r.reference)}</strong> no descritivo da transferência, senão não conseguimos saber que é sua. A conta tem de estar no seu nome.</p>`
    : `<div class="summary"><div><span>Valor</span><strong>${esc(money(r.amount, r.currency))}</strong></div>
        ${r.fee ? `<div><span>Taxa</span><span>${esc(money(r.fee, r.from_currency || r.currency))}</span></div>` : ''}
        ${r.from_currency !== r.currency ? `<div><span>Pago com</span><span>${esc(money(r.from_amount, r.from_currency))}</span></div>` : ''}
        ${r.holder && r.kind === 'withdrawal' ? `<div><span>Titular</span><span>${esc(r.holder)}</span></div>` : ''}
        ${r.iban ? `<div><span>Para</span><span>${esc(r.iban)}</span></div>` : ''}
        ${r.provider_status === 'submitted' && r.status === 'pending' ? '<div><span>Banco</span><span>Enviado, à espera de confirmação</span></div>' : ''}
        <div><span>Referência</span><span>${esc(r.reference)}</span></div>
        <div><span>Estado</span><span class="tag ${r.status}">${esc(STATUS[r.status] || r.status)}</span></div>
        ${r.note ? `<div><span>Motivo</span><span>${esc(r.note)}</span></div>` : ''}</div>`}
      ${r.status === 'pending' && r.provider_status !== 'submitted' ? '<button type="button" class="btn danger" data-cancel style="width:100%;margin-bottom:10px">Cancelar pedido</button>' : ''}
      <button type="button" class="btn primary" data-close>Fechar</button>`,
    setup: (root) => {
      bindCopy(root);
      const c = $('[data-cancel]', root);
      if (c) c.addEventListener('click', async () => {
        try { await api('POST', `/bank/requests/${r.id}/cancel`); done(r.kind === 'withdrawal' ? 'Levantamento cancelado. O dinheiro voltou à carteira.' : 'Pedido cancelado.'); }
        catch (err) { toast(err.message, true); }
      });
    },
  }),

  bankout: () => ({
    title: 'Levantar para o banco',
    html: `<form><div data-banks></div>
      <label>Da carteira<select name="currency"></select></label>
      ${amountField('Valor a receber no banco')}${quoteBox}
      <label>IBAN da sua conta<input name="iban" autocomplete="off" placeholder="PT50 0000 0000 0000 0000 0000 0" required style="text-transform:uppercase"></label>
      <label>Titular da conta<input name="holder" maxlength="80" value="${esc(state.me.name)}"></label>
      <label class="check"><input type="checkbox" name="remember" checked> Guardar este IBAN no meu perfil</label>
      ${pinField}<button class="btn primary">Pedir transferência</button></form>`,
    setup: async (root) => {
      const [banks, mine] = await Promise.all([api('GET', '/bank/accounts'), api('GET', '/me/bank-account')]);
      const curs = banks.map((b) => b.currency);
      const wallets = state.me.wallets.filter((w) => curs.includes(w.currency));
      if (!wallets.length) { $('[data-banks]', root).innerHTML = '<p class="who err">Ainda não é possível levantar para o banco nas suas moedas. Use um agente.</p>'; return; }
      $('[name=currency]', root).innerHTML = wallets.map((w) => `<option value="${w.currency}">${w.currency} · saldo ${esc(money(w.balance, w.currency))}</option>`).join('');
      if (mine.account) { $('[name=iban]', root).value = mine.account.iban; $('[name=holder]', root).value = mine.account.holder; }
      $('form', root).dispatchEvent(new Event('change'));
    },
    quote: (f) => (f.get('currency') ? api('GET', '/quote/bank-withdrawal?' + qs({ amount: f.get('amount'), currency: f.get('currency') })) : null),
    quoteOpts: { payLabel: 'Valor', getLabel: 'Recebe no banco' },
    submit: async (f, key, form) => {
      const r = await api('POST', '/bank/withdrawals', { amount: f.get('amount'), currency: f.get('currency'), iban: f.get('iban'),
        holder: f.get('holder'), pin: f.get('pin'), idempotency_key: key, quote_id: quoteOf(form) });
      if (f.get('remember')) api('POST', '/me/bank-account', { iban: f.get('iban'), holder: f.get('holder') }).catch(() => {});
      refresh();
      openSheet('bankRequest', r.request);
      toast('Pedido registado. O dinheiro já saiu da carteira e vai ser transferido para o seu banco.');
    },
  }),

  // ---------- Enviar para o IBAN de quem não tem DobraPay ----------
  sendBank: (pre = {}) => ({
    title: 'Enviar para uma conta bancária',
    html: `<form>
      <p class="hint" style="margin:0 0 12px">Para quem ainda não tem DobraPay: o dinheiro chega à conta bancária da pessoa (ex.: BISTP em São Tomé, qualquer banco em Portugal/Espanha).</p>
      <div data-bens></div>
      <label>Nome do titular da conta<input name="holder" maxlength="80" required value="${esc(pre.holder || '')}"></label>
      <label>IBAN<input name="iban" autocomplete="off" required style="text-transform:uppercase" placeholder="ST00 0000 0000 0000 0000 0000 0" value="${esc(pre.iban || '')}"></label>
      <label>Telemóvel da pessoa (opcional)<input name="beneficiary_phone" inputmode="tel" value="${esc(pre.phone || '')}" placeholder="+239 991 2345"></label>
      <div class="row"><label>Chega em<select name="currency"></select></label>${amountField('Valor a chegar')}</div>
      ${fromWalletField('Pagar com')}${quoteBox}${pinField}
      <button class="btn primary">Enviar</button></form>`,
    setup: async (root) => {
      const form = $('form', root);
      const [banks, bens] = await Promise.all([api('GET', '/bank/accounts'), api('GET', '/bank/beneficiaries')]);
      if (!banks.length) { $('[data-bens]', root).innerHTML = '<p class="who err">Ainda não é possível enviar para contas bancárias.</p>'; return; }
      const curs = banks.map((b) => b.currency);
      form.currency.innerHTML = currencyOptions(pre.currency && curs.includes(pre.currency) ? pre.currency : (curs.includes('STN') ? 'STN' : curs[0]), curs);
      if (bens.length) {
        $('[data-bens]', root).innerHTML = `<label>Beneficiários guardados<select data-ben><option value="">— novo beneficiário —</option>${bens.map((b) =>
          `<option value="${b.id}">${esc(b.name)} · ${esc(b.iban.slice(0, 4))} … ${esc(b.iban.slice(-4))} (${esc(b.currency)})</option>`).join('')}</select></label>`;
        $('[data-ben]', root).addEventListener('change', (e) => {
          const b = bens.find((x) => String(x.id) === e.target.value);
          form.holder.value = b ? b.name : ''; form.iban.value = b ? b.iban : ''; form.beneficiary_phone.value = b && b.phone ? b.phone : '';
          if (b && curs.includes(b.currency)) form.currency.value = b.currency;
          form.dispatchEvent(new Event('change'));
        });
      }
      form.dispatchEvent(new Event('change'));
    },
    quote: (f) => (f.get('currency') ? api('GET', '/quote/bank-withdrawal?' + qs({ amount: f.get('amount'), currency: f.get('currency'), from_currency: f.get('from_currency') })) : null),
    quoteOpts: { payLabel: 'Paga', getLabel: 'Chega à conta' },
    submit: async (f, key, form) => {
      const r = await api('POST', '/bank/withdrawals', { amount: f.get('amount'), currency: f.get('currency'), from_currency: f.get('from_currency'),
        iban: f.get('iban'), holder: f.get('holder'), beneficiary_phone: f.get('beneficiary_phone') || undefined,
        pin: f.get('pin'), idempotency_key: key, quote_id: quoteOf(form) });
      refresh();
      openSheet('bankRequest', r.request);
      toast(`Enviado para ${f.get('holder')}. Avisamos quando o banco confirmar.`);
    },
  }),


  // ---------- Carregar com cartão (Stripe) ----------
  cardTopup: () => ({
    title: t('Carregar com cartão'),
    html: `<form>${CFG.card_topup.test_mode ? `<p class="who">🧪 ${t('Modo de teste: use o cartão 4242 4242 4242 4242, qualquer data futura e qualquer código.')}</p>` : ''}
      ${amountField(t('Valor a carregar (EUR)'))}${quoteBox}
      <p class="hint">${t('Vai para a página segura da Stripe para pagar. A DobraPay nunca vê o número do seu cartão.')}</p>
      <button class="btn primary">💳 ${t('Pagar com cartão')}</button></form>`,
    quote: async (f) => {
      const q = await api('GET', '/quote/card-topup?' + qs({ amount: f.get('amount') }));
      return { ...q, currency: 'EUR', to_currency: 'EUR', to_amount: q.amount, rate: 1 };
    },
    quoteOpts: { payLabel: 'Carrega', getLabel: 'Entra na carteira' },
    submit: async (f) => {
      const r = await api('POST', '/card-topups', { amount: f.get('amount') });
      sessionStorage.setItem('dp_card', r.id);
      location.href = r.url; // página segura da Stripe
    },
  }),

  // ---------- Pagar numa loja ----------
  pay: (pre = {}) => ({
    title: 'Pagar numa loja',
    html: `<form>
      <label>Código mostrado pela loja<input name="code" class="code-input" maxlength="7" autocomplete="off" autocapitalize="characters" value="${esc(pre.code || '')}" placeholder="K7Q2P9" required></label>
      ${'BarcodeDetector' in window ? '<button type="button" class="btn small" data-scan style="margin:-6px 0 14px">📷 Ler QR code</button>' : '<p class="hint">Dica: também pode apontar a câmara do telemóvel ao QR code da loja.</p>'}
      <div data-charge></div>
      <div data-payfields hidden>${fromWalletField()}${quoteBox}${pinField}<button class="btn primary">Pagar</button></div>
      <input type="hidden" name="amount" value="1"></form>`,
    setup: (root) => {
      const form = $('form', root);
      const box = $('[data-charge]', root), fields = $('[data-payfields]', root);
      const load = debounce(async () => {
        const code = form.code.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
        form.dataset.charge = '';
        if (code.length !== 6) { box.innerHTML = ''; fields.hidden = true; return; }
        try {
          const c = await api('GET', `/pay/${code}?` + qs({ from_currency: form.from_currency.value }));
          box.innerHTML = `<div class="summary"><div><span>Loja</span><strong>${flagOf(c.merchant.country)} ${esc(c.merchant.name)}</strong></div>
            ${c.description ? `<div><span>Descrição</span><span>${esc(c.description)}</span></div>` : ''}
            <div><span>Valor</span><strong>${esc(money(c.amount, c.currency))}</strong></div>
            ${c.status !== 'pending' ? `<div><span>Estado</span><span class="tag ${c.status}">${esc(STATUS[c.status] || c.status)}</span></div>` : ''}</div>`;
          fields.hidden = c.status !== 'pending';
          if (c.status === 'pending') { form.dataset.charge = code; form.dispatchEvent(new Event('change')); } // atualiza a cotação
        } catch (err) { box.innerHTML = `<p class="who err">${esc(err.message)}</p>`; fields.hidden = true; }
      }, 300);
      form.code.addEventListener('input', load);
      load();
    },
    quote: (f, form) => (form.dataset.charge ? api('GET', `/pay/${form.dataset.charge}?` + qs({ from_currency: f.get('from_currency') })).then((c) => c.quote) : null),
    quoteOpts: { payLabel: 'Paga', getLabel: 'A loja recebe' },
    submit: async (f, key, form) => {
      if (!form.dataset.charge) throw new Error('Escreva o código de 6 letras e números da loja.');
      const r = await api('POST', `/pay/${form.dataset.charge}`, { from_currency: f.get('from_currency'), pin: f.get('pin'), idempotency_key: key, quote_id: quoteOf(form) });
      done(`Pago ✓ ${money(r.transaction.to_amount, r.transaction.to_currency)} a ${r.transaction.to.name}.`);
    },
  }),

  // ---------- Loja: cobrar ----------
  charge: () => ({
    title: 'Cobrar a um cliente',
    html: `<form>${amountField(`Valor (${esc(state.me.receive_currency)})`)}
      <label>Descrição (opcional)<input name="description" maxlength="80" placeholder="Ex.: 2 cafés"></label>
      <p class="hint">O cliente pode pagar com qualquer moeda; a loja recebe sempre o valor exato em ${esc(state.me.receive_currency)}.</p>
      <button class="btn primary">Gerar QR code</button></form>`,
    submit: async (f) => {
      const c = await api('POST', '/charges', { amount: f.get('amount'), description: f.get('description') });
      showCharge(c);
    },
  }),

  charges: () => ({
    title: 'Cobranças recentes',
    html: '<div data-list><p class="hint">A carregar…</p></div>',
    setup: async (root) => {
      const list = await api('GET', '/charges');
      $('[data-list]', root).innerHTML = list.map((c) => `<div class="req-card"><div class="copy-row"><div><strong>${esc(money(c.amount, c.currency))}</strong>
        <small>${esc(when(c.created_at))}${c.description ? ' · ' + esc(c.description) : ''}${c.payer ? ' · ' + esc(c.payer.name) : ''}</small></div>
        <span class="tag ${c.status}">${esc(STATUS[c.status] || c.status)}</span></div></div>`).join('') || '<p class="empty">Ainda sem cobranças.</p>';
    },
  }),

  // ---------- Admin: banco ----------
  bankAdmin: () => ({
    title: 'Transferências bancárias',
    html: `<div class="row" style="margin-bottom:12px"><button type="button" class="btn small" data-go="statementImport">📄 Importar extrato</button><button type="button" class="btn small" data-go="payoutBatch">📦 Pagar em lote</button><button type="button" class="btn small" data-go="bankSync">🔌 Ligações</button></div>
      <label>O seu PIN (para confirmar operações)<input data-adminpin type="password" inputmode="numeric" maxlength="6"></label>
      <div data-reqs><p class="hint">A carregar…</p></div>`,
    setup: async (root) => {
      const pin = () => $('[data-adminpin]', root).value;
      const load = async () => {
        const reqs = await api('GET', '/admin/bank/requests');
        $('#bankBadge').textContent = reqs.length || '';
        $('[data-reqs]', root).innerHTML = reqs.map((r) => `<div class="req-card" data-id="${r.id}">
          <div class="copy-row"><div><strong>${r.kind === 'deposit' ? '⬇ Carregamento' : '⬆ Levantamento'} · ${esc(money(r.amount, r.currency))}</strong>
            <small>${flagOf(r.user.country)} ${esc(r.user.name)} · ${esc(prettyPhone(r.user.phone))} · ${esc(when(r.created_at))}</small></div>
            <span class="tag">${esc(r.reference)}</span></div>
          ${r.kind === 'deposit'
            ? `<p class="hint" style="margin:6px 0">Confirme no extrato do banco (${esc(r.pay_to ? r.pay_to.bank_name : r.currency)}) uma transferência com a referência <strong>${esc(r.reference)}</strong>.</p>
               <div class="row"><input data-amount inputmode="decimal" placeholder="Valor recebido" value="${(r.amount / 100).toFixed(2).replace('.', ',')}"><input data-ref placeholder="Ref. do extrato"></div>`
            : `<p class="hint" style="margin:6px 0">${r.third_party ? `Envio de ${esc(r.user.name)} para <strong>${esc(r.holder)}</strong>. ` : ''}Transferir <strong>${esc(money(r.amount, r.currency))}</strong> para <strong>${esc(r.iban)}</strong> (${esc(r.holder)}) com o descritivo ${esc(r.reference)}.</p>
               ${r.provider_status === 'submitted' ? `<p class="who" style="margin:0 0 8px">⏳ Enviado ao parceiro (${esc(r.provider)}), à espera da confirmação automática.</p>` : ''}
               ${r.provider_status === 'error' ? `<p class="who err" style="margin:0 0 8px">${esc(r.note || 'Falha no parceiro')}</p>` : ''}
               <input data-ref placeholder="Referência da transferência feita">`}
          <div class="row"><button type="button" class="btn small primary" data-ok>${r.kind === 'deposit' ? 'Confirmar recebido' : 'Marcar como pago'}</button>
            <button type="button" class="btn small danger" data-no>Recusar</button></div></div>`).join('') || '<p class="empty">Não há pedidos pendentes. ✓</p>';
        root.querySelectorAll('.req-card').forEach((card) => {
          const r = reqs.find((x) => String(x.id) === card.dataset.id);
          const act = async (fn, msg) => { try { await fn(); toast(msg); load(); refresh(); } catch (err) { toast(err.message, true); } };
          $('[data-ok]', card).addEventListener('click', () => act(() => (r.kind === 'deposit'
            ? api('POST', `/admin/bank/requests/${r.id}/confirm`, { amount: $('[data-amount]', card).value, bank_reference: $('[data-ref]', card).value, pin: pin() })
            : api('POST', `/admin/bank/requests/${r.id}/paid`, { bank_reference: $('[data-ref]', card).value, pin: pin() })),
          r.kind === 'deposit' ? 'Carregamento confirmado.' : 'Levantamento marcado como pago.'));
          $('[data-no]', card).addEventListener('click', () => {
            const reason = prompt('Motivo da recusa (o cliente vai ver):');
            if (reason) act(() => api('POST', `/admin/bank/requests/${r.id}/reject`, { reason, pin: pin() }), 'Pedido recusado.');
          });
        });
      };
      await load();
    },
  }),

  settlement: () => ({
    title: 'Bancos da empresa e acertos',
    html: `<div data-view><p class="hint">A carregar…</p></div>
      <h3 style="font-size:1rem">Registar transferência entre bancos</h3>
      <form><div class="row"><label>De<select name="from_currency">${currencyOptions('STN')}</select></label><label>Valor enviado<input name="amount" inputmode="decimal" required></label></div>
      <div class="row"><label>Para<select name="to_currency">${currencyOptions('EUR')}</select></label><label>Valor recebido<input name="to_amount" inputmode="decimal" required></label></div>
      <label>Referência (SWIFT/extrato)<input name="reference" maxlength="80" required></label>${pinField}
      <button class="btn primary">Registar acerto</button></form>
      <h3 style="font-size:1rem;margin-top:20px">Pagamentos automáticos</h3>
      <form data-provform data-own><p class="hint" style="margin-top:0">Quem paga os levantamentos e envios para IBAN em cada moeda: o admin à mão, ou um parceiro por API (confirma sozinho por webhook). "Simulador" serve para testar sem dinheiro real.</p>
      <div data-provs></div>
      <div class="row"><label>Moeda<select name="currency">${currencyOptions('STN')}</select></label><label>Quem paga<select name="provider"></select></label></div>
      ${pinField}<button class="btn primary">Guardar</button></form>
      <h3 style="font-size:1rem;margin-top:20px">Limite de liquidez</h3>
      <form data-limitform data-own><p class="hint" style="margin-top:0">Quanto o banco de cada moeda pode ficar a dever aos clientes até ao próximo acerto. Se um envio com câmbio passar o limite, fica pausado com uma mensagem ao cliente. Vazio = sem limite; 0 = só com dinheiro já no banco.</p>
      <div class="row"><label>Moeda<select name="currency">${currencyOptions('STN')}</select></label><label>Falta máxima<input name="max_shortfall" inputmode="decimal" placeholder="sem limite"></label></div>
      ${pinField}<button class="btn primary">Guardar limite</button></form>
      <h3 style="font-size:1rem;margin-top:20px">Conta bancária da empresa</h3>
      <form data-bankform data-own><div class="row"><label>Moeda<select name="currency">${currencyOptions('EUR')}</select></label><label>Banco<input name="bank_name" placeholder="Ex.: CGD, BISTP" required></label></div>
      <label>Titular<input name="holder" required></label><label>IBAN<input name="iban" required style="text-transform:uppercase"></label>
      <label>SWIFT/BIC (opcional)<input name="swift" maxlength="11" style="text-transform:uppercase"></label>${pinField}
      <button class="btn primary">Guardar conta</button></form>`,
    setup: async (root) => {
      const render = (v) => {
        $('[data-view]', root).innerHTML = `<p class="hint">Em cada moeda, o banco da empresa tem de ter pelo menos o dinheiro dos clientes. "Excedente" negativo = esse banco precisa de receber dinheiro de outro banco da empresa.</p>
          <table class="cur"><tr><th>Moeda</th><th>Banco</th><th>Clientes</th><th>Excedente</th><th>Limite</th></tr>${v.rows.map((r) =>
            `<tr><td>${r.currency}<br><small>${esc(r.bank ? r.bank.bank_name : '—')}</small></td><td>${esc(money(r.in_bank, ''))}</td><td>${esc(money(r.owed_to_customers, ''))}</td>
             <td style="color:${r.surplus < 0 ? 'var(--red)' : 'inherit'}">${esc(money(r.surplus, ''))}</td>
             <td>${r.max_shortfall == null ? '—' : `${esc(money(r.max_shortfall, ''))}<br><small style="color:${r.available ? 'inherit' : 'var(--red)'}">${r.available ? 'livre ' + esc(money(r.available, '')) : '⏸ pausado'}</small>`}</td></tr>`).join('')}</table>
          ${v.suggestions.length ? `<div class="quote"><strong>Sugestão de acerto</strong>${v.suggestions.map((s) =>
            `<div><span>${esc(money(s.amount, s.from_currency))} → ${esc(money(s.to_amount, s.to_currency))}</span><span>≈ ${esc(money(s.eur, 'EUR'))}</span></div>`).join('')}</div>` : '<p class="who">Contas equilibradas: não é preciso transferir nada. ✓</p>'}`;
      };
      const bankForm = $('[data-bankform]', root);
      bankForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = new FormData(bankForm);
        const btn = bankForm.querySelector('button.primary');
        btn.disabled = true;
        try {
          await api('POST', '/admin/bank/accounts', Object.fromEntries(f));
          toast(`Conta bancária em ${f.get('currency')} guardada.`); bankForm.reset(); render(await api('GET', '/admin/settlement'));
        } catch (err) { toast(err.message, true); }
        finally { btn.disabled = false; }
      });
      const provForm = $('[data-provform]', root);
      const renderProv = (p) => {
        $('[data-provs]', root).innerHTML = `<div class="summary">${p.currencies.filter((c) => c.provider !== 'manual' || ['EUR', 'STN'].includes(c.currency)).map((c) =>
          `<div><span>${c.currency}</span><span>${esc((p.available.find((a) => a.id === c.provider) || {}).label || c.provider)}</span></div>`).join('')}</div>`;
        provForm.provider.innerHTML = p.available.map((a) => `<option value="${a.id}">${esc(a.label)}</option>`).join('');
      };
      provForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = new FormData(provForm);
        try { renderProv(await api('POST', '/admin/payout-providers', Object.fromEntries(f))); toast(`Pagamentos em ${f.get('currency')} atualizados.`); provForm.pin.value = ''; }
        catch (err) { toast(err.message, true); }
      });
      api('GET', '/admin/payout-providers').then(renderProv).catch((err) => toast(err.message, true));
      const limitForm = $('[data-limitform]', root);
      limitForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = new FormData(limitForm);
        try {
          render(await api('POST', '/admin/liquidity', Object.fromEntries(f)));
          toast(f.get('max_shortfall') ? `Limite de ${f.get('currency')} guardado.` : `Limite de ${f.get('currency')} retirado.`);
          limitForm.querySelector('[name=pin]').value = '';
        } catch (err) { toast(err.message, true); }
      });
      render(await api('GET', '/admin/settlement'));
    },
    submit: async (f) => {
      await api('POST', '/admin/settlement', Object.fromEntries(f));
      done('Acerto registado.');
    },
  }),


  // ---------- Comprovativo ----------
  receipt: (id) => ({
    title: t('Comprovativo'),
    html: `<div data-rc><p class="hint">${t('A carregar…')}</p></div>`,
    setup: async (root) => {
      const tx = await api('GET', `/transactions/${encodeURIComponent(id)}`);
      const canvas = drawReceipt(tx);
      const url = canvas.toDataURL('image/png');
      $('[data-rc]', root).innerHTML = `<img class="receipt-img" src="${url}" alt="${esc(t('Comprovativo'))}">
        <button type="button" class="btn primary" data-share>📤 ${t('Partilhar comprovativo')}</button>
        <a class="btn" style="display:block;text-align:center;margin-top:8px;text-decoration:none" download="comprovativo-${esc(tx.id.slice(0, 8))}.png" href="${url}">⬇ ${t('Guardar imagem')}</a>`;
      $('[data-share]', root).addEventListener('click', async () => {
        const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
        const file = new File([blob], `comprovativo-${tx.id.slice(0, 8)}.png`, { type: 'image/png' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          navigator.share({ files: [file], title: t('Comprovativo DobraPay') }).catch(() => {});
        } else { toast(t('Use "Guardar imagem" e envie pelo WhatsApp.')); }
      });
    },
  }),

  // ---------- Envios automáticos ----------
  scheduled: () => ({
    title: t('Envios automáticos'),
    html: `<div data-list></div>
      <form><h3 style="font-size:1rem">${t('Novo envio todos os meses')}</h3>
      ${phoneField('to', t('Para (número)'))}
      <div class="row">${amountField(t('Valor'))}<label>${t('Dia do mês')}<input name="day_of_month" type="number" min="1" max="28" value="1" required></label></div>
      ${fromWalletField(t('Da carteira'))}
      <label>${t('Mensagem (opcional)')}<input name="note" maxlength="140" placeholder="${esc(t('Ex.: mesada'))}"></label>
      <p class="hint">${t('Enviamos automaticamente nesse dia, às 9h. Se faltar saldo, tentamos nos dias seguintes e avisamos.')}</p>
      ${pinField}<button class="btn primary">${t('Agendar')}</button></form>`,
    lookup: 'to',
    setup: async (root) => {
      const render = (list) => {
        $('[data-list]', root).innerHTML = list.length ? list.map((x) => `<div class="req-card"><div class="copy-row"><div>
          <strong>${esc(money(x.amount, x.from_currency))} → ${esc(x.to_name || prettyPhone(x.to_phone))}</strong>
          <small>${t('Todos os meses, dia {d} · próximo: {date}', { d: x.day_of_month, date: new Date(x.next_run_at).toLocaleDateString(LANG) })}${x.last_status && x.last_status !== 'ok' ? ' · ⚠️ ' + esc(x.last_status) : ''}</small></div>
          <button type="button" class="btn small danger" data-del="${x.id}">${t('Parar')}</button></div></div>`).join('') : `<p class="hint">${t('Ainda não tem envios automáticos.')}</p>`;
        root.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => render(await api('DELETE', `/scheduled/${b.dataset.del}`))));
      };
      render(await api('GET', '/scheduled'));
    },
    submit: async (f, key, form) => {
      await api('POST', '/scheduled', { to: fullPhone(form, 'to'), amount: f.get('amount'), day_of_month: Number(f.get('day_of_month')),
        from_currency: f.get('from_currency'), note: f.get('note'), pin: f.get('pin') });
      toast(t('Envio automático agendado.'));
      openSheet('scheduled');
    },
  }),

  // ---------- Recargas e contas ----------
  bills: () => ({
    title: t('Recargas e contas'),
    html: `<form><label>${t('Serviço')}<select name="biller"></select></label>
      <label><span data-reflabel>${t('Referência')}</span><input name="account_ref" required></label>
      ${amountField(t('Valor'))}${fromWalletField(t('Pagar com'))}${quoteBox}${pinField}
      <p class="hint" data-sim hidden>${t('Modo de demonstração: os pagamentos são simulados até haver contrato com cada empresa.')}</p>
      <button class="btn primary">${t('Pagar')}</button></form><div data-history></div>`,
    setup: async (root) => {
      const form = $('form', root);
      const [billers, past] = await Promise.all([api('GET', '/bills/billers'), api('GET', '/bills')]);
      const mine = billers.filter((b) => b.country === state.me.country).concat(billers.filter((b) => b.country !== state.me.country));
      form.biller.innerHTML = mine.map((b) => `<option value="${b.id}">${esc(b.name)} (${b.currency})</option>`).join('');
      const sync = () => {
        const b = billers.find((x) => x.id === form.biller.value);
        $('[data-reflabel]', root).textContent = t(b.ref_label);
        form.account_ref.placeholder = b.ref === 'phone' ? CFG.countries[b.country].example : '';
        form.amount.placeholder = t('mínimo {v}', { v: money(b.min, b.currency) });
      };
      form.biller.addEventListener('change', sync); sync();
      $('[data-sim]', root).hidden = !billers.some((b) => b.simulated);
      $('[data-history]', root).innerHTML = past.length ? `<h3 style="font-size:1rem">${t('Últimos pagamentos')}</h3>` + past.map((p) => `<div class="req-card"><div class="copy-row"><div>
        <strong>${esc(p.biller_name)} · ${esc(money(p.amount, p.currency))}</strong><small>${esc(p.account_ref)} · ${esc(when(p.created_at))}${p.token ? ` · ${t('código')}: <b>${esc(p.token)}</b>` : ''}</small></div>
        <span class="tag ${p.status === 'failed' ? 'rejected' : p.status}">${esc(t(STATUS[p.status] || p.status))}</span></div></div>`).join('') : '';
    },
    quote: (f) => api('GET', '/quote/bill?' + qs({ biller: f.get('biller'), amount: f.get('amount'), from_currency: f.get('from_currency') })),
    quoteOpts: { payLabel: 'Paga', getLabel: 'A empresa recebe' },
    submit: async (f, key) => {
      const r = await api('POST', '/bills', { biller: f.get('biller'), account_ref: f.get('account_ref'), amount: f.get('amount'),
        from_currency: f.get('from_currency'), pin: f.get('pin'), idempotency_key: key });
      const p = r.payment;
      if (p.status === 'completed' && p.token) {
        $('#sheetContent').innerHTML = `<div class="center"><p>${t('Código de energia para introduzir no contador:')}</p><div class="big-code" style="font-size:1.6rem;letter-spacing:2px">${esc(p.token)}</div>
          <button type="button" class="btn primary" data-close>${t('Fechar')}</button></div>`;
        bindClose(); refresh(); return;
      }
      if (p.status === 'failed') { toast(t('Não foi possível pagar: {why}. O dinheiro voltou à carteira.', { why: p.note }), true); refresh(); return; }
      done(t('{name} paga ✓', { name: p.biller_name }));
    },
  }),

  // ---------- Agentes ----------
  agentsNear: () => ({
    title: t('Agentes perto de mim'),
    html: `<p class="hint" data-msg>${t('A procurar a sua localização…')}</p><div data-list></div>`,
    setup: async (root) => {
      const render = (list) => {
        $('[data-list]', root).innerHTML = list.length ? list.map((a) => `<div class="agent-card"><strong>${flagOf(a.country)} ${esc(a.name)}</strong>
          ${esc(a.address)}${a.hours ? ' · ' + esc(a.hours) : ''}<br>
          <small>${a.distance_km != null ? `📍 ${a.distance_km} km · ` : ''}${t('paga em')} ${esc(a.currency)} · ${esc(prettyPhone(a.phone))}${a.cash_available ? '' : ' · ⚠️ ' + t('sem dinheiro vivo agora')}</small>
          <div class="row" style="margin-top:8px"><a class="btn small" href="${esc(a.maps_url)}" target="_blank" rel="noopener">🗺 ${t('Ver no mapa')}</a><a class="btn small" href="tel:${esc(a.phone)}">📞 ${t('Ligar')}</a></div></div>`).join('')
          : `<p class="empty">${t('Ainda não há agentes registados aqui.')}</p>`;
      };
      const byCountry = async () => { $('[data-msg]', root).textContent = t('Agentes no seu país:'); render(await api('GET', '/agents/nearby')); };
      if (!navigator.geolocation) return byCountry();
      navigator.geolocation.getCurrentPosition(async (pos) => {
        $('[data-msg]', root).textContent = t('Do mais perto para o mais longe:');
        render(await api('GET', '/agents/nearby?' + qs({ lat: pos.coords.latitude, lng: pos.coords.longitude })));
      }, byCountry, { timeout: 8000, maximumAge: 300000 });
    },
  }),

  agentProfile: () => ({
    title: 'O meu ponto de atendimento',
    html: `<form><p class="hint" style="margin-top:0">Aparece aos clientes em "Agentes perto de mim".</p>
      <label>Nome do estabelecimento<input name="business" maxlength="60" required></label>
      <label>Morada<input name="address" maxlength="120" required></label>
      <label>Horário<input name="hours" maxlength="60" placeholder="Ex.: seg–sáb 8h–20h"></label>
      <div class="row"><label>Latitude<input name="lat" inputmode="decimal" required></label><label>Longitude<input name="lng" inputmode="decimal" required></label></div>
      <button type="button" class="btn small" data-geo style="margin:-6px 0 14px">📍 Usar a minha localização</button>
      <label class="check"><input type="checkbox" name="cash_available" checked> Tenho dinheiro vivo para levantamentos</label>
      <button class="btn primary">Guardar</button></form>`,
    setup: async (root) => {
      const form = $('form', root);
      $('[data-geo]', root).addEventListener('click', () => navigator.geolocation.getCurrentPosition(
        (p) => { form.lat.value = p.coords.latitude.toFixed(5); form.lng.value = p.coords.longitude.toFixed(5); },
        () => toast('Não foi possível obter a localização. Autorize o acesso ou escreva as coordenadas.', true), { timeout: 10000 }));
      const { profile } = await api('GET', '/agent/profile');
      if (profile) { for (const k of ['business', 'address', 'hours', 'lat', 'lng']) form[k].value = profile[k] ?? ''; form.cash_available.checked = profile.cash_available; }
    },
    submit: async (f) => {
      await api('POST', '/agent/profile', { business: f.get('business'), address: f.get('address'), hours: f.get('hours'),
        lat: Number(String(f.get('lat')).replace(',', '.')), lng: Number(String(f.get('lng')).replace(',', '.')), cash_available: !!f.get('cash_available') });
      done('Ponto de atendimento guardado.');
    },
  }),

  agentStats: () => ({
    title: 'As minhas comissões',
    html: '<div data-st><p class="hint">A carregar…</p></div>',
    setup: async (root) => {
      const s = await api('GET', '/agent/stats');
      $('[data-st]', root).innerHTML = `<p class="hint" style="margin-top:0">Desde ${esc(new Date(s.since).toLocaleDateString('pt-PT'))}. Ganha 0,3% de cada depósito (até 3 €) e 40% da taxa de cada levantamento.</p>
        <div class="stat-grid"><div><small>Depósitos</small><strong>${s.cash_in}</strong></div><div><small>Levantamentos</small><strong>${s.cash_out}</strong></div></div>
        <div class="summary">${s.commissions.length ? s.commissions.map((c) => `<div><span>Comissões (${c.count})</span><strong>${esc(money(c.total, c.currency))}</strong></div>`).join('') : '<div><span>Comissões</span><span>0</span></div>'}</div>`;
    },
  }),

  // ---------- Verificação de identidade ----------
  kyc: () => ({
    title: t('Verificar identidade'),
    html: `<form><p class="hint" style="margin-top:0">${t('Com a identidade verificada (nível 2), os seus limites sobem para 2 000 € por operação e 6 000 € por dia.')}</p>
      <label>${t('Nome completo (como no documento)')}<input name="full_name" maxlength="80" required value="${esc(state.me.name)}"></label>
      <label>${t('Documento')}<select name="doc_type"><option value="bi">${t('Bilhete de identidade')}</option><option value="cartao_cidadao">${t('Cartão de cidadão')}</option><option value="passaporte">${t('Passaporte')}</option><option value="residencia">${t('Autorização de residência')}</option></select></label>
      <div class="row"><label>${t('Número')}<input name="doc_number" maxlength="30" required></label><label>${t('Data de nascimento')}<input name="birth_date" type="date" required></label></div>
      <label>📄 ${t('Foto do documento')}<input type="file" accept="image/*" capture="environment" data-img="doc" required></label><img class="kyc-preview" data-prev="doc" hidden alt="">
      <label>🤳 ${t('Selfie (a sua cara, bem iluminada)')}<input type="file" accept="image/*" capture="user" data-img="selfie" required></label><img class="kyc-preview" data-prev="selfie" hidden alt="">
      <button class="btn primary">${t('Enviar para verificação')}</button></form>`,
    setup: (root) => {
      const form = $('form', root);
      form._imgs = {};
      root.querySelectorAll('[data-img]').forEach((input) => input.addEventListener('change', async () => {
        const file = input.files[0];
        if (!file) return;
        try {
          const data = await shrinkImage(file, 1000, 0.75);
          form._imgs[input.dataset.img] = data;
          const prev = $(`[data-prev=${input.dataset.img}]`, root); prev.src = data; prev.hidden = false;
        } catch { toast(t('Não foi possível ler a imagem. Tire a foto de novo.'), true); }
      }));
    },
    submit: async (f, key, form) => {
      if (!form._imgs.doc || !form._imgs.selfie) throw new Error(t('Tire a foto do documento e a selfie.'));
      await api('POST', '/me/kyc', { full_name: f.get('full_name'), doc_type: f.get('doc_type'), doc_number: f.get('doc_number'),
        birth_date: f.get('birth_date'), doc_image: form._imgs.doc, selfie_image: form._imgs.selfie });
      done(t('Enviado! Vamos analisar e avisamos assim que estiver verificado.'));
    },
  }),


  // ---------- Admin: importar extrato do banco ----------
  statementImport: () => ({
    title: 'Importar extrato bancário',
    html: `<form><p class="hint" style="margin-top:0">Descarregue o extrato no homebanking (BISTP, CGD…) e escolha-o aqui. Formatos: <b>CSV</b> (ou Excel guardado como CSV), <b>MT940</b> ou <b>CAMT.053</b>. A app encontra as referências <b>DP…</b> dos carregamentos.</p>
      <div class="row"><label>Conta (moeda)<select name="currency"></select></label><label>Ficheiro<input type="file" name="file" accept=".csv,.txt,.xml,.sta,.940,.mt940" required></label></div>
      <button class="btn primary">Ler extrato</button></form><div data-result></div>`,
    setup: async (root) => {
      const banks = await api('GET', '/bank/accounts');
      $('[name=currency]', root).innerHTML = banks.map((b) => `<option value="${b.currency}">${b.currency} · ${esc(b.bank_name)}</option>`).join('') || '<option value="STN">STN</option>';
    },
    submit: async (f, key, form) => {
      const file = form.file.files[0];
      if (!file) throw new Error('Escolha o ficheiro do extrato.');
      const content = await readTextFile(file);
      const r = await api('POST', '/admin/statements', { currency: f.get('currency'), content, filename: file.name });
      renderStatement($('[data-result]', form.parentElement), r);
    },
  }),

  // ---------- Admin: pagar levantamentos em lote ----------
  payoutBatch: () => ({
    title: 'Pagar levantamentos em lote',
    html: `<form><p class="hint" style="margin-top:0">Junta todos os levantamentos pendentes de uma moeda num ficheiro para carregar no homebanking. Os pedidos ficam bloqueados (o cliente já não os pode cancelar) até marcar o lote como pago ou o cancelar.</p>
      <div class="row"><label>Moeda<select name="currency">${currencyOptions('EUR', ['EUR', 'STN', 'AOA', 'CVE', 'USD'])}</select></label>
      <label>Formato<select name="format"><option value="sepa">SEPA XML (euros: CGD e bancos da UE)</option><option value="csv">CSV (BISTP e outros)</option></select></label></div>
      <div class="quote" data-prev>A carregar…</div>${pinField}
      <button class="btn primary">⬇ Gerar ficheiro do lote</button></form>
      <h3 style="font-size:1rem;margin-top:18px">Lotes</h3><input data-adminpin type="password" inputmode="numeric" maxlength="6" placeholder="PIN (para marcar pago / cancelar)" style="margin-bottom:10px"><div data-batches></div>`,
    setup: async (root) => {
      const form = $('form', root);
      const prev = async () => {
        const p = await api('GET', '/admin/payout-batches/preview?' + qs({ currency: form.currency.value }));
        $('[data-prev]', root).innerHTML = p.count ? `<div><span>Levantamentos pendentes</span><strong>${p.count}</strong></div><div><span>Total a transferir</span><strong>${esc(money(p.total, p.currency))}</strong></div>`
          : '<div><span>Não há levantamentos pendentes nesta moeda.</span></div>';
        if (form.currency.value !== 'EUR') form.format.value = 'csv';
      };
      form.currency.addEventListener('change', prev);
      const loadBatches = async () => {
        const list = await api('GET', '/admin/payout-batches');
        $('[data-batches]', root).innerHTML = list.map((b) => `<div class="req-card" data-id="${esc(b.id)}"><div class="copy-row"><div><strong>${esc(b.id)}</strong>
          <small>${b.count} pagamentos · ${esc(money(b.total, b.currency))} · ${esc(when(b.created_at))}${b.bank_reference ? ' · ref. ' + esc(b.bank_reference) : ''}</small></div>
          <span class="tag ${b.status === 'paid' ? 'completed' : b.status === 'cancelled' ? 'cancelled' : 'pending'}">${{ exported: 'Por pagar', paid: 'Pago', cancelled: 'Cancelado' }[b.status]}</span></div>
          ${b.status === 'exported' ? `<div class="row" style="margin-top:8px"><input data-ref placeholder="Ref. do lote no banco"><button type="button" class="btn small primary" data-paid style="width:auto">Marcar pago</button><button type="button" class="btn small danger" data-cancel-batch>Cancelar</button></div>` : ''}</div>`).join('')
          || '<p class="empty">Ainda não há lotes.</p>';
        root.querySelectorAll('[data-batches] .req-card').forEach((card) => {
          const pin = () => $('[data-adminpin]', root).value;
          const go = async (fn, msg) => { try { await fn(); toast(msg); loadBatches(); prev(); } catch (err) { toast(err.message, true); } };
          const paidBtn = $('[data-paid]', card), cancelBtn = $('[data-cancel-batch]', card);
          if (paidBtn) paidBtn.addEventListener('click', () => go(() => api('POST', `/admin/payout-batches/${encodeURIComponent(card.dataset.id)}/paid`, { bank_reference: $('[data-ref]', card).value, pin: pin() }), 'Lote marcado como pago.'));
          if (cancelBtn) cancelBtn.addEventListener('click', () => { if (confirm('Cancelar o lote? Os levantamentos voltam a ficar por pagar.')) go(() => api('POST', `/admin/payout-batches/${encodeURIComponent(card.dataset.id)}/cancel`, { pin: pin() }), 'Lote cancelado.'); });
        });
      };
      form._reload = () => { prev(); loadBatches(); };
      await Promise.all([prev(), loadBatches()]);
    },
    submit: async (f, key, form) => {
      const r = await api('POST', '/admin/payout-batches', { currency: f.get('currency'), format: f.get('format'), pin: f.get('pin') });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([r.content], { type: r.mime + ';charset=utf-8' }));
      a.download = r.filename; a.click();
      toast(`Lote ${r.batch_id}: ${r.count} pagamentos (${money(r.total, f.get('currency'))}). Carregue o ficheiro no homebanking.`);
      form.pin.value = '';
      form._reload();
    },
  }),


  // ---------- Admin: ligações automáticas aos bancos ----------
  bankSync: () => ({
    title: 'Ligações automáticas aos bancos',
    html: `<div data-st><p class="hint">A carregar…</p></div>`,
    setup: async (root) => {
      const KIND = { sftp: '🔐 SFTP', folder: '📁 Pasta', openbanking: '🏦 Open Banking' };
      const ago = (t) => (t ? when(t) : 'nunca');
      const render = (st) => {
        const conns = st.connections.map((c) => `<div class="req-card"><div class="copy-row"><div><strong>${KIND[c.kind] || c.kind} · ${esc(c.currency)}</strong>
            <small>${esc(c.target)}${c.kind === 'sftp' && !c.secure ? ' · ⚠️ falta a impressão digital do servidor' : ''}</small>
            <small>Última verificação: ${esc(ago(c.last && c.last.started_at))}${c.last ? (c.last.ok ? ` · ✓ ${c.last.files ? c.last.files + ' ficheiros · ' : ''}${c.last.confirmed} confirmados${c.last.to_review ? ' · ' + c.last.to_review + ' por rever' : ''}` : ` · ❌ ${esc(c.last.error || '')}`) : ''}</small>
            ${c.last && c.last.ok && c.last.error ? `<small style="color:var(--red)">${esc(c.last.error)}</small>` : ''}</div>
            ${c.sandbox ? `<button type="button" class="btn small" data-sbx="${esc(c.currency)}">+ Movimento de teste</button>` : ''}</div></div>`).join('')
          || '<p class="hint">Nenhuma ligação SFTP, pasta ou Open Banking configurada. Veja a secção "Ligações automáticas aos bancos" do README (variáveis no Render).</p>';
        const em = st.email.enabled
          ? `<div class="req-card"><strong>✉️ Alertas por e-mail</strong><br><small>Moeda: ${esc(st.email.currency)} · remetentes: ${esc(st.email.senders.join(', ') || '— nenhum configurado —')} · ${st.email.auto ? 'confirma sozinho (com DKIM)' : 'só sugere ao admin'}</small>
             <br><small>Endereço para o serviço de e-mail reencaminhar:</small>${copyRow('Webhook', location.origin + st.email.path)}</div>`
          : '<p class="hint">Alertas por e-mail desativados (falta BANK_EMAIL_TOKEN).</p>';
        const alerts = st.email_alerts.map((a) => `<div class="req-card" data-alert="${a.id}"><div class="copy-row"><div>
            <strong>${a.amount ? esc(money(a.amount, a.currency)) : '—'} ${a.reference ? '· ' + esc(a.reference) : ''}</strong>
            <small>${esc(a.sender || '')} · ${esc(when(a.received_at))} · ${a.dkim_ok ? 'DKIM ✓' : 'sem DKIM'}${a.note ? ' · ' + esc(a.note) : ''}</small>
            <small>${esc((a.subject || '') + ' — ' + (a.excerpt || '')).slice(0, 160)}</small></div>
            <span class="tag ${a.status === 'suggested' ? 'pending' : 'rejected'}">${{ suggested: 'Sugerido', unmatched: 'Sem correspondência', rejected: 'Recusado' }[a.status] || a.status}</span></div>
            <div class="row" style="margin-top:8px">${a.status === 'suggested' ? '<button type="button" class="btn small primary" data-ok-alert style="width:auto">Confirmar carregamento</button>' : ''}<button type="button" class="btn small" data-dismiss>Arquivar</button></div></div>`).join('');
        const review = st.review.map((r) => `<div class="req-card" data-imp="${r.import_id}" data-line="${r.line_id}"><strong>${esc(money(r.amount, ''))} recebidos · pedido de ${esc(money(r.expected, ''))}</strong>
            <small>${esc(r.reference || '')} · ${esc(r.user.name)} · ${esc(r.date || '')} · ${esc(r.description || '')}</small>
            <button type="button" class="btn small primary" data-ok-line style="width:auto;margin-top:8px">Creditar o valor recebido</button></div>`).join('');
        $('[data-st]', root).innerHTML = `<div class="row" style="margin-bottom:12px"><button type="button" class="btn small primary" data-run style="width:auto">↻ Verificar agora</button></div>
          ${conns}${em}
          <label>O seu PIN (para confirmar)<input data-adminpin type="password" inputmode="numeric" maxlength="6"></label>
          ${alerts ? '<h3 style="font-size:1rem">Alertas por e-mail a tratar</h3>' + alerts : ''}
          ${review ? '<h3 style="font-size:1rem">Entradas com valor diferente (por rever)</h3>' + review : ''}
          ${!alerts && !review ? '<p class="who">Nada por rever. ✓</p>' : ''}`;
        bindCopy(root);
        const pin = () => $('[data-adminpin]', root).value;
        const act = async (fn, msg) => { try { await fn(); toast(msg); load(); refresh(); } catch (err) { toast(err.message, true); } };
        $('[data-run]', root).addEventListener('click', async () => {
          try {
            const r = await api('POST', '/admin/bank-sync/run', {});
            const ok = r.reduce((n, x) => n + (x.confirmed || 0), 0);
            await load(); refresh();
            toast(`${r.length} ligações verificadas · ${ok} carregamentos confirmados${r.some((x) => !x.ok) ? ' · houve erros (ver acima)' : ''}`, r.some((x) => !x.ok));
          } catch (err) { toast(err.message, true); }
        });
        root.querySelectorAll('[data-sbx]').forEach((b) => b.addEventListener('click', () => {
          const amount = prompt(`Valor do movimento de teste (${b.dataset.sbx}):`); if (!amount) return;
          const description = prompt('Descritivo (inclua a referência DP… do carregamento):') || '';
          act(() => api('POST', '/admin/bank-sync/sandbox', { currency: b.dataset.sbx, amount, description, pin: pin() }), 'Movimento de teste criado. Carregue em "Verificar agora".');
        }));
        root.querySelectorAll('[data-alert]').forEach((card) => {
          const ok = $('[data-ok-alert]', card);
          if (ok) ok.addEventListener('click', () => act(() => api('POST', `/admin/bank-sync/email/${card.dataset.alert}/confirm`, { pin: pin() }), 'Carregamento confirmado.'));
          $('[data-dismiss]', card).addEventListener('click', () => act(() => api('POST', `/admin/bank-sync/email/${card.dataset.alert}/dismiss`), 'Alerta arquivado.'));
        });
        root.querySelectorAll('[data-ok-line]').forEach((b) => b.addEventListener('click', () => {
          const card = b.closest('[data-line]');
          act(() => api('POST', `/admin/statements/${card.dataset.imp}/confirm`, { line_ids: [Number(card.dataset.line)], pin: pin() }), 'Valor recebido creditado.');
        }));
      };
      const load = async () => render(await api('GET', '/admin/bank-sync'));
      await load();
    },
  }),

  // ---------- Admin: identidade, alertas, relatórios, USSD ----------
  kycAdmin: () => ({
    title: 'Verificações de identidade',
    html: '<label>O seu PIN (para confirmar)<input data-adminpin type="password" inputmode="numeric" maxlength="6"></label><div data-list><p class="hint">A carregar…</p></div>',
    setup: async (root) => {
      const load = async () => {
        const list = await api('GET', '/admin/kyc');
        $('#kycBadge').textContent = list.length || '';
        $('[data-list]', root).innerHTML = list.map((k) => `<div class="req-card" data-id="${k.id}">
          <strong>${flagOf(k.user.country)} ${esc(k.full_name)}</strong><small> · conta: ${esc(k.user.name)} · ${esc(prettyPhone(k.user.phone))}</small>
          <div class="summary" style="margin:8px 0"><div><span>${esc(k.doc_type_label)}</span><span>${esc(k.doc_number)}</span></div><div><span>Nascimento</span><span>${esc(k.birth_date)}</span></div></div>
          <div class="kyc-imgs"><img src="${esc(k.doc_image)}" alt="Documento"><img src="${esc(k.selfie_image)}" alt="Selfie"></div>
          <div class="row"><button type="button" class="btn small primary" data-ok>Aprovar (nível 2)</button><button type="button" class="btn small danger" data-no>Recusar</button></div></div>`).join('')
          || '<p class="empty">Não há verificações pendentes. ✓</p>';
        root.querySelectorAll('.req-card').forEach((card) => {
          const go = async (approve, note) => {
            try { await api('POST', `/admin/kyc/${card.dataset.id}`, { approve, note, pin: $('[data-adminpin]', root).value }); toast(approve ? 'Aprovado.' : 'Recusado.'); load(); }
            catch (err) { toast(err.message, true); }
          };
          $('[data-ok]', card).addEventListener('click', () => go(true));
          $('[data-no]', card).addEventListener('click', () => { const n = prompt('Motivo da recusa (o cliente vai ver):'); if (n) go(false, n); });
        });
      };
      await load();
    },
  }),

  alerts: () => ({
    title: 'Alertas antifraude',
    html: '<label>O seu PIN (para confirmar)<input data-adminpin type="password" inputmode="numeric" maxlength="6"></label><div data-list><p class="hint">A carregar…</p></div>',
    setup: async (root) => {
      const render = (list) => {
        $('#alertBadge').textContent = list.length || '';
        $('[data-list]', root).innerHTML = list.map((a) => `<div class="req-card" data-id="${a.id}">
          <strong>⚠️ ${esc(a.rule_label)}</strong><br><small>${esc(a.detail)} · ${esc(when(a.created_at))}</small><br>
          <small>${flagOf(a.user.country)} ${esc(a.user.name)} · ${esc(prettyPhone(a.user.phone))} · nível ${a.user.tier}${a.user.status === 'blocked' ? ' · BLOQUEADO' : ''}</small>
          <input data-note placeholder="Conclusão da análise" style="margin-top:8px">
          <div class="row" style="margin-top:8px"><button type="button" class="btn small" data-close-alert>Fechar alerta</button><button type="button" class="btn small danger" data-block>Fechar e bloquear conta</button></div></div>`).join('')
          || '<p class="empty">Sem alertas abertos. ✓</p>';
        root.querySelectorAll('.req-card').forEach((card) => {
          const go = async (block) => {
            try { render(await api('POST', `/admin/alerts/${card.dataset.id}/close`, { note: $('[data-note]', card).value, block_user: block, pin: $('[data-adminpin]', root).value })); toast('Alerta fechado.'); }
            catch (err) { toast(err.message, true); }
          };
          $('[data-close-alert]', card).addEventListener('click', () => go(false));
          $('[data-block]', card).addEventListener('click', () => go(true));
        });
      };
      render(await api('GET', '/admin/alerts'));
    },
  }),

  reports: () => ({
    title: 'Relatórios',
    html: `<form><p class="hint" style="margin-top:0">Exporta todos os movimentos (CSV para Excel) para a contabilidade ou para o banco central.</p>
      <div class="row"><label>De<input name="from" type="date" required></label><label>Até<input name="to" type="date" required></label></div>
      <button class="btn primary">⬇ Exportar CSV</button></form>`,
    setup: (root) => {
      const f = $('form', root), d = new Date();
      f.to.value = d.toISOString().slice(0, 10);
      f.from.value = new Date(d - 30 * 86400000).toISOString().slice(0, 10);
    },
    submit: async (f) => {
      const res = await fetch('/api/admin/export.csv?' + qs({ from: f.get('from'), to: f.get('to') }), { headers: { authorization: 'Bearer ' + state.token } });
      if (!res.ok) throw new Error('Não foi possível exportar.');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(await res.blob());
      a.download = `dobrapay-movimentos-${f.get('from')}-a-${f.get('to')}.csv`;
      a.click();
      toast('Ficheiro descarregado.');
    },
  }),

  ussdSim: () => ({
    title: 'Simulador USSD (*239#)',
    html: `<p class="hint" style="margin-top:0">Mostra o menu como num telemóvel sem internet. O número tem de ter conta.</p>
      <label>Número do cliente<input data-phone value="${esc(state.me.phone)}"></label>
      <div class="ussd-screen" data-screen></div>
      <form><div class="row"><input name="reply" inputmode="numeric" autocomplete="off" placeholder="Resposta"><button class="btn primary" style="width:auto">Enviar</button></div></form>
      <button type="button" class="btn small" data-restart style="margin-top:10px">↺ Recomeçar</button>`,
    setup: (root) => {
      const form = $('form', root);
      let path = [], session = String(Date.now());
      const show = async () => {
        const r = await api('POST', '/admin/ussd/simulate', { phone: $('[data-phone]', root).value, text: path.join('*'), session });
        $('[data-screen]', root).textContent = r.response.replace(/^(CON|END) /, '');
        form.hidden = r.response.startsWith('END');
      };
      form._show = show;
      form._push = (v) => { path.push(v); return show(); };
      $('[data-restart]', root).addEventListener('click', () => { path = []; session = String(Date.now()); show(); });
      show().catch((err) => toast(err.message, true));
    },
    submit: async (f, key, form) => { const v = f.get('reply'); form.reply.value = ''; await form._push(v); },
  }),

  admin: () => ({
    title: 'Painel de administração',
    html: '<div data-stats></div><input data-search placeholder="Procurar por nome ou número"><div data-users></div>',
    setup: async (root) => {
      const s = await api('GET', '/admin/stats');
      $('[data-stats]', root).innerHTML = `<div class="stat-grid">
        <div><small>Clientes</small><strong>${s.users}</strong></div>
        <div><small>Agentes</small><strong>${s.agents}</strong></div>
        <div><small>Dinheiro emitido (≈)</small><strong>${esc(money(s.totals_eur.emoney, 'EUR'))}</strong></div>
        <div><small>Taxas + câmbio (≈)</small><strong>${esc(money(s.totals_eur.fees + s.totals_eur.fx_result, 'EUR'))}</strong></div>
        <div><small>Operações hoje</small><strong>${s.today.n}</strong></div>
        <div><small>Livro-razão</small><strong style="color:${s.ledger.ok ? 'var(--green)' : 'var(--red)'}">${s.ledger.ok ? '✓ Certo' : '✗ ERRO'}</strong></div></div>
        <table class="cur"><tr><th>Moeda</th><th>Emitido</th><th>Taxas</th><th>Mesa câmbio</th></tr>${s.by_currency.map((c) =>
          `<tr><td>${c.currency}</td><td>${esc(money(c.emoney, ''))}</td><td>${esc(money(c.fees, ''))}</td><td>${esc(money(c.fx_position, ''))}</td></tr>`).join('')}</table>`;
      const box = $('[data-users]', root);
      const load = async (q = '') => {
        const users = await api('GET', '/admin/users?search=' + encodeURIComponent(q));
        box.innerHTML = users.map((u) => `<div class="user-row">
          <div><strong>${flagOf(u.country)} ${esc(u.name)}</strong>${u.merchant_name ? ` · 🏪 ${esc(u.merchant_name)}` : ''}<br><small>${esc(prettyPhone(u.phone))} · ${u.wallets.map((w) => esc(money(w.balance, w.currency))).join(' · ')}${u.status === 'blocked' ? ' · BLOQUEADO' : ''}</small></div>
          <select data-id="${u.id}" data-field="role">${['user', 'agent', 'admin'].map((r) => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${{ user: 'Cliente', agent: 'Agente', admin: 'Admin' }[r]}</option>`).join('')}</select>
          <button type="button" class="btn small" data-merchant="${u.id}" title="Conta de loja">${u.merchant_name ? '🏪' : '＋🏪'}</button>
          <select data-id="${u.id}" data-field="status"><option value="active" ${u.status === 'active' ? 'selected' : ''}>Ativo</option><option value="blocked" ${u.status === 'blocked' ? 'selected' : ''}>Bloquear</option></select>
        </div>`).join('') || '<p class="empty">Sem resultados.</p>';
        box.querySelectorAll('[data-merchant]').forEach((b) => b.addEventListener('click', async () => {
          const u = users.find((x) => String(x.id) === b.dataset.merchant);
          const name = prompt('Nome da loja (deixe vazio para desligar a conta de loja):', u.merchant_name || '');
          if (name === null) return;
          try { await api('PATCH', `/admin/users/${u.id}`, { merchant_name: name }); toast(name ? 'Conta de loja ativada.' : 'Conta de loja desligada.'); load(q); }
          catch (err) { toast(err.message, true); }
        }));
        box.querySelectorAll('select').forEach((sel) => sel.addEventListener('change', async () => {
          try { await api('PATCH', `/admin/users/${sel.dataset.id}`, { [sel.dataset.field]: sel.value }); toast('Atualizado.'); }
          catch (err) { toast(err.message, true); load(q); }
        }));
      };
      load();
      $('[data-search]', root).addEventListener('input', debounce((e) => load(e.target.value), 300));
    },
  }),

  profile: () => ({
    title: 'O meu perfil',
    html: `<div class="summary"><div><span>Nome</span><strong>${esc(state.me.name)}</strong></div>
      <div><span>Número</span><span>${flagOf(state.me.country)} ${esc(prettyPhone(state.me.phone))}</span></div>
      <div><span>E-mail</span><span data-myemail>${state.me.email ? esc(state.me.email) : '—'}</span></div>
      <div><span>Recebe em</span><span>${esc(state.me.receive_currency)}</span></div>
      <div><span>Conta</span><span>${{ user: 'Cliente', agent: 'Agente', admin: 'Administrador' }[state.me.role]} · nível ${state.me.tier}</span></div></div>
      <div class="toggle-row"><span>🔔 ${t('Notificações')}</span><button type="button" class="btn small" data-push>${t('Ativar')}</button></div>
      <div class="toggle-row"><span>🙂 ${t('Face ID / impressão digital')}</span><button type="button" class="btn small" data-addpasskey>${t('Ativar')}</button></div>
      <div data-passkeys></div>
      <div class="toggle-row"><span>🪪 ${t('Identidade')}: <b data-kycstatus>…</b></span><button type="button" class="btn small" data-go="kyc" data-kycbtn hidden>${t('Verificar')}</button></div>
      <div class="toggle-row"><span>🔁 ${t('Envios automáticos')}</span><button type="button" class="btn small" data-go="scheduled">${t('Ver')}</button></div>
      <div class="toggle-row"><span>🌐 ${t('Idioma')}</span><select data-lang style="width:auto"></select></div>
      <form data-emailform data-own style="margin-top:14px"><h3 style="font-size:1rem">${t(state.me.email ? 'Mudar e-mail' : 'Juntar e-mail')}</h3>
      <p class="hint">${t('Serve para receber o código se esquecer o PIN.')}</p>
      <label>E-mail<input name="email" type="email" inputmode="email" autocomplete="email" maxlength="254" value="${esc(state.me.email || '')}" required></label>
      <label data-emailcode hidden>${t('Código recebido por e-mail')}<input name="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" class="code-input"></label>
      <p class="who" data-emaildev hidden></p>
      <button class="btn" style="width:100%">${t('Enviar código')}</button></form>
      <form data-myiban data-own style="margin-top:14px"><h3 style="font-size:1rem">O meu IBAN (para levantar)</h3>
      <label>IBAN<input name="iban" autocomplete="off" style="text-transform:uppercase" placeholder="PT50 0000 0000 0000 0000 0000 0"></label>
      <label>Titular<input name="holder" maxlength="80" value="${esc(state.me.name)}"></label>
      <button class="btn" style="width:100%;margin-bottom:16px">Guardar IBAN</button></form>
      <form><h3 style="font-size:1rem">Mudar PIN</h3>
      <label>PIN atual<input name="pin" type="password" inputmode="numeric" maxlength="6" required></label>
      <label>Novo PIN<input name="newPin" type="password" inputmode="numeric" maxlength="6" required></label>
      <button class="btn primary">Guardar novo PIN</button></form>
      <button type="button" class="btn danger" data-logout style="width:100%;margin-top:12px">Terminar sessão</button>`,
    setup: async (root) => {
      $('[data-logout]', root).addEventListener('click', async () => {
        try { await api('POST', '/auth/logout'); } catch { /* sai na mesma */ }
        logoutLocal();
      });
      const f = $('[data-myiban]', root);
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        try { await api('POST', '/me/bank-account', { iban: f.iban.value, holder: f.holder.value }); toast(f.iban.value ? 'IBAN guardado.' : 'IBAN apagado.'); }
        catch (err) { toast(err.message, true); }
      });
      // E-mail (com código enviado para o e-mail novo)
      const ef = $('[data-emailform]', root);
      let emailSentTo = null;
      ef.addEventListener('submit', async (e) => {
        e.preventDefault();
        const eb = ef.querySelector('button');
        eb.disabled = true;
        try {
          if (!emailSentTo || emailSentTo !== ef.email.value.trim().toLowerCase()) {
            const o = await api('POST', '/me/email/code', { email: ef.email.value });
            emailSentTo = o.email;
            $('[data-emailcode]', ef).hidden = false;
            const dev = $('[data-emaildev]', ef);
            dev.hidden = !o.dev_code;
            if (o.dev_code) dev.textContent = t('Modo de teste (sem e-mail nem SMS): o seu código é {code}', { code: o.dev_code });
            else toast(t('Enviámos um código para {email}. Veja também a pasta de spam.', { email: o.email }));
            eb.textContent = t('Confirmar e-mail');
            ef.code.focus();
          } else {
            state.me = await api('POST', '/me/email', { email: emailSentTo, code: ef.code.value });
            $('[data-myemail]', root).textContent = state.me.email;
            $('[data-emailcode]', ef).hidden = true; $('[data-emaildev]', ef).hidden = true;
            ef.code.value = ''; emailSentTo = null; eb.textContent = t('Enviar código');
            toast(t('E-mail confirmado ✓'));
          }
        } catch (err) { toast(errText(err), true); }
        finally { eb.disabled = false; }
      });
      fillLangSelect($('[data-lang]', root));
      // Notificações
      const pb = $('[data-push]', root);
      const syncPush = async () => { const on = await pushEnabled().catch(() => false); pb.textContent = t(on ? 'Desativar' : 'Ativar'); pb.dataset.on = on ? '1' : ''; };
      pb.addEventListener('click', async () => {
        try {
          if (pb.dataset.on) { await disablePush(); toast(t('Notificações desativadas.')); }
          else { await enablePush(); await api('POST', '/push/test'); toast(t('Notificações ativadas ✓')); }
        } catch (err) { toast(errText(err), true); }
        syncPush();
      });
      syncPush();
      // Face ID / impressão digital
      const renderKeys = (keys) => {
        $('[data-passkeys]', root).innerHTML = keys.map((k) => `<div class="copy-row"><div><small>${t('Ativo neste dispositivo')}</small><strong>${esc(k.label)}</strong></div>
          <button type="button" class="btn small danger" data-delkey="${esc(k.id)}">${t('Remover')}</button></div>`).join('');
        root.querySelectorAll('[data-delkey]').forEach((b) => b.addEventListener('click', async () => renderKeys(await api('DELETE', `/passkeys/${encodeURIComponent(b.dataset.delkey)}`))));
      };
      const kb = $('[data-addpasskey]', root);
      if (!window.PublicKeyCredential) kb.disabled = true;
      kb.addEventListener('click', async () => {
        try {
          const wa = await loadWebAuthn();
          const o = await api('POST', '/passkeys/options');
          const response = await wa.startRegistration({ optionsJSON: o.options });
          renderKeys(await api('POST', '/passkeys', { challenge_id: o.challenge_id, response, label: /iPhone|iPad/.test(navigator.userAgent) ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android' : 'Este dispositivo' }));
          toast(t('Pronto! Da próxima vez pode entrar com Face ID / impressão digital.'));
        } catch (err) { if (!(err && err.name === 'NotAllowedError')) toast(errText(err), true); }
      });
      // Identidade
      const kyc = await api('GET', '/me/kyc');
      const ks = $('[data-kycstatus]', root);
      ks.textContent = kyc.tier >= 2 ? t('verificada ✓') : kyc.request && kyc.request.status === 'pending' ? t('em análise') : kyc.request && kyc.request.status === 'rejected' ? t('recusada: {why}', { why: kyc.request.note }) : t('por verificar');
      $('[data-kycbtn]', root).hidden = kyc.tier >= 2 || (kyc.request && kyc.request.status === 'pending');
      const [mine, keys] = await Promise.all([api('GET', '/me/bank-account'), api('GET', '/passkeys')]);
      renderKeys(keys);
      if (mine.account) { f.iban.value = mine.account.iban; f.holder.value = mine.account.holder; }
    },
    submit: async (f) => {
      await api('POST', '/me/pin', { pin: f.get('pin'), newPin: f.get('newPin') });
      done('PIN alterado.');
    },
  }),
};

function done(msg) { closeSheet(); toast(msg); refresh(); }

const STATUS = { pending: 'Pendente', completed: 'Concluído', rejected: 'Recusado', cancelled: 'Cancelado', paid: 'Pago', expired: 'Expirado' };
const copyRow = (label, shown, value = shown) => `<div class="copy-row"><div><small>${esc(label)}</small><strong>${esc(shown)}</strong></div>
  <button type="button" class="btn small" data-copy="${esc(value)}">Copiar</button></div>`;
function bindCopy(root) {
  root.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copiado ✓'; setTimeout(() => { b.textContent = 'Copiar'; }, 1500); }
    catch { toast('Não foi possível copiar. Selecione o texto à mão.', true); }
  }));
}

// Mostra o QR da cobrança e espera pelo pagamento (verifica a cada 3 s).
async function showCharge(c) {
  $('#sheetTitle').textContent = 'Mostre ao cliente';
  const root = $('#sheetContent');
  root.innerHTML = `<div class="center" data-chargebox>
    <img class="qr" data-qr alt="QR code de pagamento">
    <p style="margin:0">ou escreva o código:</p>
    <div class="big-code">${esc(c.code)}</div>
    <div class="summary"><div><span>Valor</span><strong>${esc(money(c.amount, c.currency))}</strong></div>
      ${c.description ? `<div><span>Descrição</span><span>${esc(c.description)}</span></div>` : ''}</div>
    <p class="hint" data-wait>⏳ À espera do pagamento… (válido 15 min)</p>
    <button type="button" class="btn danger" data-cancelcharge style="width:100%">Cancelar cobrança</button></div>`;
  const res = await fetch(`/api/charges/${c.id}/qr.svg`, { headers: { authorization: 'Bearer ' + state.token } });
  if (res.ok) $('[data-qr]', root).src = URL.createObjectURL(await res.blob());
  $('[data-cancelcharge]', root).addEventListener('click', async () => {
    try { await api('POST', `/charges/${c.id}/cancel`); done('Cobrança cancelada.'); } catch (err) { toast(err.message, true); }
  });
  const box = $('[data-chargebox]', root);
  const poll = setInterval(async () => {
    if (!box.isConnected) { clearInterval(poll); return; }
    try {
      const s = await api('GET', `/charges/${c.id}`);
      if (s.status === 'pending') return;
      clearInterval(poll);
      box.innerHTML = s.status === 'paid'
        ? `<div class="paid-big">✓</div><h2>Pago!</h2><p><strong>${esc(money(s.amount, s.currency))}</strong> por ${esc(s.payer ? s.payer.name : 'cliente')}</p>
           <button type="button" class="btn primary" data-close>Concluído</button>`
        : `<p class="who err">Cobrança ${esc(STATUS[s.status] || s.status).toLowerCase()}.</p><button type="button" class="btn primary" data-close>Fechar</button>`;
      bindClose();
      if (s.status === 'paid') refresh();
    } catch { /* tenta de novo */ }
  }, 3000);
}

function openSheet(name, arg) {
  const def = SHEETS[name](arg);
  $('#sheetTitle').textContent = def.title;
  const root = $('#sheetContent');
  root.innerHTML = def.html;
  $('#sheet').hidden = false;
  bindClose();
  root.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => openSheet(b.dataset.go)));
  // O formulário principal do ecrã (os marcados com data-own tratam do seu próprio envio).
  const form = $('form:not([data-own])', root);
  if (def.setup) Promise.resolve(def.setup(root)).catch((err) => toast(err.message, true));
  if (!form || !def.submit) return;
  const key = newKey(); // mesma chave se o utilizador carregar duas vezes → nunca paga a dobrar
  if (def.lookup) attachLookup(form, def.lookup);
  if (def.quote) attachQuote(form, (f) => def.quote(f, form), def.quoteOpts);
  const scan = $('[data-scan]', root);
  if (scan) scan.addEventListener('click', () => scanQr(form));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button.primary');
    btn.disabled = true;
    try { await def.submit(new FormData(form), key, form); }
    catch (err) {
      toast(errText(err), true);
      const pin = form.querySelector('[name=pin]'); if (pin) pin.value = '';
      if (['rate_changed', 'quote_expired', 'quote_used', 'quote_invalid'].includes(err.code)) form.dispatchEvent(new Event('change')); // mostra a nova cotação
    }
    finally { btn.disabled = false; }
  });
  const first = form.querySelector('input:not([type=hidden]):not([value]), input[value=""]');
  // Põe o cursor no primeiro campo, mas só se a pessoa ainda não tiver tocado noutro.
  if (first) setTimeout(() => { if (!root.contains(document.activeElement)) first.focus(); }, 50);
}

// Lê os endereços dos QR codes: ".../?pagar=CODIGO" (loja) ou ".../?enviar=+239…&valor=…" (pessoa).
function parseLink(raw) {
  try {
    const url = new URL(raw.replace(/^dobrapay:pay\?to=/, 'https://x/?enviar=').replace(/&amount=/, '&valor='));
    const p = url.searchParams;
    if (p.get('pagar')) return { pagar: p.get('pagar') };
    if (p.get('cartao')) return { cartao: p.get('cartao'), id: p.get('id') };
    if (p.get('enviar')) return { enviar: p.get('enviar'), valor: p.get('valor') };
  } catch { /* não é um endereço */ }
  return null;
}

// Leitor de QR code com a câmara (Chrome/Android suportam BarcodeDetector).
async function scanQr(form) {
  let stream;
  const wrap = document.createElement('div');
  wrap.innerHTML = '<video class="scan" playsinline muted></video><button type="button" class="btn" style="width:100%;margin:8px 0 14px">Cancelar</button>';
  form.prepend(wrap);
  const stop = () => { if (stream) stream.getTracks().forEach((t) => t.stop()); wrap.remove(); };
  wrap.querySelector('button').addEventListener('click', stop);
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    const video = wrap.querySelector('video');
    video.srcObject = stream;
    await video.play();
    const detector = new BarcodeDetector({ formats: ['qr_code'] });
    const tick = async () => {
      if (!wrap.isConnected) return;
      const codes = await detector.detect(video).catch(() => []);
      const raw = codes[0] && codes[0].rawValue;
      const link = raw && parseLink(raw);
      if (link) {
        const set = (name, v) => { const el = form.querySelector(`[name=${name}]`); if (el && v) { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); } };
        if (link.pagar) set('code', link.pagar);
        if (link.enviar) { set('to', link.enviar); set('amount', link.valor && link.valor.replace('.', ',')); }
        stop();
        return;
      }
      requestAnimationFrame(tick);
    };
    tick();
  } catch { stop(); toast('Não foi possível usar a câmara.', true); }
}

function bindClose() { document.querySelectorAll('[data-close]').forEach((b) => { b.onclick = closeSheet; }); }
function closeSheet() {
  $('#sheet').hidden = true;
  $('#sheetContent').querySelectorAll('video').forEach((v) => v.srcObject && v.srcObject.getTracks().forEach((t) => t.stop()));
  $('#sheetContent').innerHTML = '';
}
$('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeSheet(); closeMenu(); } });
document.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openSheet(b.dataset.open)));




// Lê o ficheiro do extrato: tenta UTF-8 e, se falhar, Windows-1252 (comum nos bancos).
async function readTextFile(file) {
  const buf = await file.arrayBuffer();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('windows-1252').decode(buf); }
}

const STATEMENT_STATE = {
  match: ['✅ Corresponde', 'completed'], amount_differs: ['⚠️ Valor diferente', 'pending'], already: ['✓ Já tratado', 'cancelled'],
  unmatched: ['Sem referência', 'rejected'], unknown_ref: ['Referência desconhecida', 'rejected'], wrong_currency: ['Outra moeda', 'rejected'],
  request_closed: ['Pedido já fechado', 'cancelled'],
};
function renderStatement(box, r) {
  const s = r.summary;
  box.innerHTML = `<div class="quote" style="margin-top:14px"><div><span>Formato</span><strong>${esc(r.format.toUpperCase())}</strong></div>
      <div><span>Entradas no extrato</span><strong>${s.credits}</strong></div><div><span>Correspondem</span><strong>${s.match}</strong></div>
      <div><span>Valor diferente</span><strong>${s.amount_differs}</strong></div><div><span>Já tratadas</span><strong>${s.already}</strong></div>
      <div><span>Sem correspondência</span><strong>${s.unmatched}</strong></div></div>
    ${r.rows.map((x) => { const [label, cls] = STATEMENT_STATE[x.state] || [x.state, '']; const can = x.state === 'match' || x.state === 'amount_differs';
      return `<div class="req-card"><label class="check" style="margin:0">${can ? `<input type="checkbox" data-line="${x.line_id}" ${x.state === 'match' ? 'checked' : ''}>` : ''}
        <span><strong>${esc(money(x.amount, r.currency))}</strong> · ${esc(x.date || '')} <span class="tag ${cls}">${esc(label)}</span><br>
        <small>${esc(x.description || '')}${x.user ? ` · <b>${esc(x.user.name)}</b> (${esc(prettyPhone(x.user.phone))})` : ''}${x.state === 'amount_differs' ? ` · pedido: ${esc(money(x.expected, r.currency))}, credita o valor recebido` : ''}</small></span></label></div>`; }).join('')}
    ${r.rows.some((x) => x.state === 'match' || x.state === 'amount_differs') ? `<label>O seu PIN<input data-stpin type="password" inputmode="numeric" maxlength="6"></label>
      <button type="button" class="btn primary" data-confirm-st>Confirmar carregamentos selecionados</button>` : ''}
    ${s.unmatched ? '<p class="hint">As entradas sem correspondência ficam para análise: confirme-as à mão em Banco, se souber de quem são.</p>' : ''}`;
  const btn = $('[data-confirm-st]', box);
  if (btn) btn.addEventListener('click', async () => {
    const ids = [...box.querySelectorAll('[data-line]:checked')].map((c) => Number(c.dataset.line));
    try {
      const c = await api('POST', `/admin/statements/${r.import_id}/confirm`, { line_ids: ids, pin: $('[data-stpin]', box).value });
      const failed = c.results.filter((x) => !x.ok);
      toast(`${c.confirmed} carregamentos confirmados.${failed.length ? ` ${failed.length} falharam: ${failed[0].error}` : ''}`, failed.length > 0);
      box.innerHTML = `<p class="who">✓ ${c.confirmed} carregamentos confirmados e creditados.</p>`;
      refresh();
    } catch (err) { toast(err.message, true); }
  });
}

// Ao voltar da página da Stripe: espera pela confirmação do pagamento.
async function waitCardTopup(id, result) {
  if (!id) return;
  if (result !== 'ok') { toast(t('Pagamento cancelado. Nada foi cobrado.')); return; }
  toast(t('A confirmar o pagamento…'));
  for (let i = 0; i < 15; i++) {
    try {
      const r = await api('GET', `/card-topups/${encodeURIComponent(id)}`);
      if (r.status === 'completed') { toast(t('Carregados {v} na sua carteira ✓', { v: money(r.amount, r.currency) })); refresh(); return; }
      if (r.status !== 'pending') { toast(t('O pagamento não foi concluído.'), true); return; }
    } catch (err) { toast(errText(err), true); return; }
    await new Promise((res) => setTimeout(res, 2000));
  }
  toast(t('O pagamento ainda está a ser confirmado. O saldo aparece assim que a Stripe confirmar.'));
}

// ---------------- Comprovativo (imagem desenhada no telemóvel) ----------------
function drawReceipt(tx) {
  const W = 720, rows = [];
  const out = tx.direction === 'out' || tx.direction === 'self';
  rows.push([t('Data'), new Date(tx.created_at).toLocaleString(LANG)]);
  rows.push([t('Tipo'), t(TX_LABEL[tx.type] || tx.type)]);
  rows.push([t('De'), `${tx.from.name}${tx.from.phone ? ' · ' + prettyPhone(tx.from.phone) : ''}`]);
  rows.push([t('Para'), tx.bank ? `${tx.bank.holder} · ${tx.bank.iban.replace(/(.{4})/g, '$1 ').trim()}` : tx.bill ? `${tx.bill.account_ref}` : `${tx.to.name}${tx.to.phone ? ' · ' + prettyPhone(tx.to.phone) : ''}`]);
  rows.push([t('Valor enviado'), money(tx.amount, tx.currency)]);
  if (tx.fee) rows.push([t('Taxa'), money(tx.fee, tx.currency)]);
  if (tx.currency !== tx.to_currency) rows.push([t('Câmbio'), `1 ${tx.currency} = ${Number(tx.rate).toLocaleString(LANG, { maximumSignificantDigits: 6 })} ${tx.to_currency}`]);
  rows.push([t('Valor recebido'), money(tx.to_amount, tx.to_currency)]);
  if (tx.note) rows.push([t('Mensagem'), tx.note]);
  if (tx.bank) rows.push([t('Referência'), tx.bank.reference]);
  if (tx.bill && tx.bill.token) rows.push([t('Código'), tx.bill.token]);
  rows.push([t('N.º da operação'), tx.id]);
  const H = 300 + rows.length * 62 + 90;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#0f7a3d'; g.fillRect(0, 0, W, 200);
  g.fillStyle = '#d21034'; g.fillRect(0, 0, 18, 200);
  g.fillStyle = '#f6c90e'; g.fillRect(18, 186, W, 14);
  g.fillStyle = '#ffffff'; g.font = 'bold 40px system-ui, sans-serif'; g.fillText('DobraPay', 48, 78);
  g.font = '26px system-ui, sans-serif'; g.fillText(t('Comprovativo'), 48, 120);
  g.font = 'bold 46px system-ui, sans-serif';
  g.fillText(`${out ? '-' : '+'}${money(out ? tx.amount + tx.fee : tx.to_amount, out ? tx.currency : tx.to_currency)}`, 48, 172);
  let y = 270;
  for (const [k, v] of rows) {
    g.fillStyle = '#66736b'; g.font = '22px system-ui, sans-serif'; g.fillText(k, 48, y);
    g.fillStyle = '#17211b'; g.font = 'bold 24px system-ui, sans-serif';
    let text = String(v);
    while (g.measureText(text).width > W - 96 && text.length > 4) text = text.slice(0, -2);
    if (text !== String(v)) text = text.slice(0, -1) + '…';
    g.fillText(text, 48, y + 30);
    g.fillStyle = '#e3e8e4'; g.fillRect(48, y + 44, W - 96, 2);
    y += 62;
  }
  g.fillStyle = '#66736b'; g.font = '20px system-ui, sans-serif';
  g.fillText(t('Operação registada pela DobraPay. Guarde este comprovativo.'), 48, H - 40);
  return c;
}

// Reduz uma foto (ex.: 4000 px da câmara) para enviar rápido mesmo com rede fraca.
async function shrinkImage(file, maxSide, quality) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = url; });
    const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', quality);
  } finally { URL.revokeObjectURL(url); }
}

// ---------------- Notificações push ----------------
const b64ToBytes = (b64) => { const s = atob((b64 + '='.repeat((4 - b64.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(s, (ch) => ch.charCodeAt(0)); };
async function enablePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error(t('Este telemóvel não suporta notificações. No iPhone, instale primeiro a app no ecrã principal (Partilhar → Adicionar ao ecrã principal).'));
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error(t('As notificações foram recusadas. Pode ativá-las nas definições do telemóvel.'));
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await api('GET', '/push/key');
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
  await api('POST', '/push/subscribe', sub.toJSON());
}
async function disablePush() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) { await api('POST', '/push/unsubscribe', { endpoint: sub.endpoint }); await sub.unsubscribe(); }
}
async function pushEnabled() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || Notification.permission !== 'granted') return false;
  const reg = await navigator.serviceWorker.ready;
  return !!(await reg.pushManager.getSubscription());
}


// ---------------- Menu ⋮ (agente e administração) ----------------
function openMenu() { $('#menu').hidden = false; $('#menuBtn').setAttribute('aria-expanded', 'true'); }
function closeMenu() { $('#menu').hidden = true; $('#menuBtn').setAttribute('aria-expanded', 'false'); }
$('#menuBtn').addEventListener('click', openMenu);
$('#menuClose').addEventListener('click', closeMenu);
$('#menu').addEventListener('click', (e) => { if (e.target.id === 'menu') closeMenu(); });
// Ao escolher uma opção do menu, fecha o menu e abre o ecrã.
$('#menu').querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', closeMenu, true));
// Ponto amarelo no ⋮ quando há pedidos à espera (banco, identidade, alertas).
new MutationObserver(() => {
  $('#menuDot').hidden = !['#bankBadge', '#kycBadge', '#alertBadge'].some((id) => $(id) && $(id).textContent);
}).observe($('#menu'), { childList: true, subtree: true, characterData: true });

// ---------------- Arranque ----------------
// Nenhum formulário é enviado "à moda antiga" (isso recarregava a página e
// punha o PIN no endereço). Os formulários são sempre tratados em JavaScript.
document.addEventListener('submit', (e) => e.preventDefault(), true);

setInterval(() => { if (!document.hidden && state.token && $('#sheet').hidden) refresh(); }, 15000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.token) refresh(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

(async () => {
  try { CFG = await api('GET', '/config'); } catch (err) { toast(err.message, true); return; }
  setupAuthCountry();
  fillLangSelect($('#langSelect'));
  setAuthMode('login');
  const link = parseLink(location.href);
  if (link) {
    sessionStorage.setItem('dp_link', JSON.stringify(link));
    history.replaceState(null, '', location.pathname); // limpa o endereço
    if (!state.token && !link.cartao) toast(link.pagar ? 'Entre na sua conta para pagar.' : 'Entre na sua conta para enviar.');
  }
  if (state.token) showHome(); else $('#auth').hidden = false;
})();
