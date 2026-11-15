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
const when = (t) => new Date(t).toLocaleString('pt-PT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
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
  box.className = 'quote';
  box.innerHTML = rows.join('');
  box.hidden = false;
}

// Pede a cotação ao servidor sempre que o formulário muda.
function attachQuote(form, fetcher, opts) {
  const box = $('[data-quote]', form);
  const update = debounce(async () => {
    const f = new FormData(form);
    form.dataset.expected = '';
    if (!f.get('amount')) { box.hidden = true; return; }
    try {
      const q = await fetcher(f);
      if (!q) { box.hidden = true; return; }
      renderQuote(box, q, opts);
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
    } catch (err) { who.className = 'who err'; who.textContent = err.message; }
    who.hidden = false;
  }, 250);
  form.querySelector(`[name=${field}]`).addEventListener('input', check);
  form.querySelector(`[name=${field}_cc]`).addEventListener('change', check);
  if (form.querySelector(`[name=${field}]`).value) check();
}

// ---------------- Autenticação ----------------
let authMode = 'login';
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
  authMode = b.dataset.tab;
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('[data-only="register"]').forEach((el) => { el.hidden = authMode !== 'register'; });
  $('#authForm button[type=submit]').textContent = authMode === 'login' ? 'Entrar' : 'Criar conta';
  $('#authForm [name=pin]').autocomplete = authMode === 'login' ? 'current-password' : 'new-password';
}));

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

$('#authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    const body = { phone: f.get('phone'), pin: f.get('pin'), country: f.get('country') };
    if (authMode === 'register') body.name = f.get('name');
    const r = await api('POST', '/auth/' + authMode, body);
    state.token = r.token;
    localStorage.setItem('dp_token', r.token);
    localStorage.setItem('dp_country', f.get('country'));
    e.target.reset();
    state.me = r.user;
    showHome();
  } catch (err) { toast(err.message, true); }
  finally { btn.disabled = false; }
});

function logoutLocal() {
  state.token = null; state.me = null;
  localStorage.removeItem('dp_token');
  closeSheet();
  $('#home').hidden = true;
  $('#auth').hidden = false;
}

// ---------------- Ecrã principal ----------------
async function showHome() {
  $('#auth').hidden = true;
  $('#home').hidden = false;
  await refresh();
}

async function refresh() {
  if (!state.token) return;
  try {
    const [me, txs, reqs] = await Promise.all([api('GET', '/me'), api('GET', '/transactions?limit=30'), api('GET', '/requests')]);
    state.me = me;
    renderMe();
    renderHistory(txs);
    renderPending(reqs);
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
}

$('#balance').addEventListener('click', () => {
  state.hideBalance = !state.hideBalance;
  localStorage.setItem('dp_hide', state.hideBalance ? '1' : '0');
  renderMe();
});

const TX_LABEL = { p2p: 'Transferência', request: 'Pedido pago', cash_in: 'Depósito', cash_out: 'Levantamento', issue: 'Float emitido', exchange: 'Câmbio' };
const TX_ICON = { p2p: '↗', request: '✋', cash_in: '⬇', cash_out: '💵', issue: '🏦', exchange: '⇄' };

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
      title = `${flagOf(t.to.country)} ${t.to.name}`;
      amt = esc(`-${money(t.amount + t.fee, t.currency)}`);
    } else {
      title = `${flagOf(t.from.country)} ${t.from.name}`;
      amt = esc(`+${money(t.to_amount, t.to_currency)}`);
    }
    const conv = t.currency !== t.to_currency && t.direction !== 'self'
      ? ` · ${t.direction === 'out' ? 'recebeu ' + money(t.to_amount, t.to_currency) : 'enviou ' + money(t.amount, t.currency)}` : '';
    return `<li>
      <span class="tx-ico">${TX_ICON[t.type] || '•'}</span>
      <span class="tx-main"><strong>${esc(title)}</strong>
        <small>${esc(TX_LABEL[t.type])} · ${esc(when(t.created_at))}${esc(conv)}${t.note ? ' · ' + esc(t.note) : ''}</small></span>
      <span class="tx-amt ${cls}" style="text-align:right">${amt}</span>
    </li>`;
  }).join('');
}

function renderPending(reqs) {
  const incoming = reqs.filter((r) => r.incoming && r.status === 'pending');
  $('#pending').innerHTML = incoming.map((r) => `
    <div class="pending-card">
      <div>${flagOf(r.requester.country)} <strong>${esc(r.requester.name)}</strong> pede <strong>${esc(money(r.amount, r.currency))}</strong>${r.note ? '<br><small>' + esc(r.note) + '</small>' : ''}</div>
      <button type="button" class="btn small" data-decline="${r.id}">Recusar</button>
      <button type="button" class="btn small primary" data-pay="${r.id}" style="width:auto">Pagar</button>
    </div>`).join('');
  $('#pending').querySelectorAll('[data-pay]').forEach((b) => b.addEventListener('click', () => {
    openSheet('payRequest', incoming.find((x) => String(x.id) === b.dataset.pay));
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
        note: f.get('note'), pin: f.get('pin'), idempotency_key: key, expected_to_amount: expectedOf(form) });
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
    submit: async (f, key) => {
      await api('POST', `/requests/${r.id}/pay`, { pin: f.get('pin'), from_currency: f.get('from_currency'), idempotency_key: key });
      done('Pedido pago.');
    },
  }),

  cashout: () => ({
    title: 'Levantar dinheiro',
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
          pin: f.get('pin'), idempotency_key: key, expected_to_amount: expectedOf(form) });
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
        idempotency_key: key, expected_to_amount: expectedOf(form) });
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
          <div><strong>${flagOf(u.country)} ${esc(u.name)}</strong><br><small>${esc(prettyPhone(u.phone))} · ${u.wallets.map((w) => esc(money(w.balance, w.currency))).join(' · ')}${u.status === 'blocked' ? ' · BLOQUEADO' : ''}</small></div>
          <select data-id="${u.id}" data-field="role">${['user', 'agent', 'admin'].map((r) => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${{ user: 'Cliente', agent: 'Agente', admin: 'Admin' }[r]}</option>`).join('')}</select>
          <select data-id="${u.id}" data-field="status"><option value="active" ${u.status === 'active' ? 'selected' : ''}>Ativo</option><option value="blocked" ${u.status === 'blocked' ? 'selected' : ''}>Bloquear</option></select>
        </div>`).join('') || '<p class="empty">Sem resultados.</p>';
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
      <div><span>Recebe em</span><span>${esc(state.me.receive_currency)}</span></div>
      <div><span>Conta</span><span>${{ user: 'Cliente', agent: 'Agente', admin: 'Administrador' }[state.me.role]} · nível ${state.me.tier}</span></div></div>
      <form><h3 style="font-size:1rem">Mudar PIN</h3>
      <label>PIN atual<input name="pin" type="password" inputmode="numeric" maxlength="6" required></label>
      <label>Novo PIN<input name="newPin" type="password" inputmode="numeric" maxlength="6" required></label>
      <button class="btn primary">Guardar novo PIN</button></form>
      <button type="button" class="btn danger" data-logout style="width:100%;margin-top:12px">Terminar sessão</button>`,
    setup: (root) => $('[data-logout]', root).addEventListener('click', async () => {
      try { await api('POST', '/auth/logout'); } catch { /* sai na mesma */ }
      logoutLocal();
    }),
    submit: async (f) => {
      await api('POST', '/me/pin', { pin: f.get('pin'), newPin: f.get('newPin') });
      done('PIN alterado.');
    },
  }),
};

function done(msg) { closeSheet(); toast(msg); refresh(); }

function openSheet(name, arg) {
  const def = SHEETS[name](arg);
  $('#sheetTitle').textContent = def.title;
  const root = $('#sheetContent');
  root.innerHTML = def.html;
  $('#sheet').hidden = false;
  bindClose();
  const form = $('form', root);
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
      toast(err.message, true);
      const pin = form.querySelector('[name=pin]'); if (pin) pin.value = '';
      if (err.code === 'rate_changed') form.dispatchEvent(new Event('change')); // mostra a nova cotação
    }
    finally { btn.disabled = false; }
  });
  const first = form.querySelector('input:not([type=hidden]):not([value]), input[value=""]');
  if (first) setTimeout(() => first.focus(), 50);
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
      if (raw && raw.startsWith('dobrapay:pay?')) {
        const p = new URLSearchParams(raw.slice('dobrapay:pay?'.length));
        form.querySelector('[name=to]').value = p.get('to') || '';
        if (p.get('amount')) form.querySelector('[name=amount]').value = p.get('amount').replace('.', ',');
        form.querySelector('[name=to]').dispatchEvent(new Event('input', { bubbles: true }));
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
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });
document.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openSheet(b.dataset.open)));

// ---------------- Arranque ----------------
setInterval(() => { if (!document.hidden && state.token && $('#sheet').hidden) refresh(); }, 15000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.token) refresh(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

(async () => {
  try { CFG = await api('GET', '/config'); } catch (err) { toast(err.message, true); return; }
  setupAuthCountry();
  if (state.token) showHome(); else $('#auth').hidden = false;
})();
