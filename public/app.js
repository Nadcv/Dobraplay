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
  // Veio de um QR code lido com a câmara do telemóvel: abre logo o ecrã certo.
  const link = JSON.parse(sessionStorage.getItem('dp_link') || 'null');
  if (link && state.me) {
    sessionStorage.removeItem('dp_link');
    if (link.pagar) openSheet('pay', { code: link.pagar });
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
    if (me.role === 'admin') api('GET', '/admin/bank/requests').then((r) => { $('#bankBadge').textContent = r.length || ''; }).catch(() => {});
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
  $('#merchantBar').hidden = !m.merchant_name;
  if (m.merchant_name) $('#merchantName').textContent = '🏪 ' + m.merchant_name;
}

$('#balance').addEventListener('click', () => {
  state.hideBalance = !state.hideBalance;
  localStorage.setItem('dp_hide', state.hideBalance ? '1' : '0');
  renderMe();
});

const TX_LABEL = { p2p: 'Transferência', request: 'Pedido pago', cash_in: 'Depósito', cash_out: 'Levantamento', issue: 'Float emitido', exchange: 'Câmbio',
  bank_in: 'Carregamento por banco', bank_out: 'Para conta bancária', merchant: 'Pagamento em loja', refund: 'Devolução', settlement: 'Acerto entre bancos' };
const TX_ICON = { p2p: '↗', request: '✋', cash_in: '⬇', cash_out: '💵', issue: '🏦', exchange: '⇄', bank_in: '🏦', bank_out: '🏦', merchant: '🛒', refund: '↩', settlement: '🏦' };

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
      title = t.type === 'bank_in' ? 'Transferência bancária' : `${flagOf(t.from.country)} ${t.from.name}`;
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
    html: `<button type="button" class="choice" data-go="bankin"><span>🏦</span><div><strong>Por transferência bancária</strong><small>Do seu banco para a conta da DobraPay (ex.: MB Way/homebanking em Portugal, BISTP em São Tomé).</small></div></button>
      <button type="button" class="choice" data-go="agentInfo"><span>🧑🏾‍💼</span><div><strong>Em dinheiro, num agente</strong><small>Entregue o dinheiro a um agente DobraPay e ele carrega a sua carteira na hora.</small></div></button>`,
  }),
  withdraw: () => ({
    title: 'Levantar dinheiro',
    html: `<button type="button" class="choice" data-go="cashout"><span>💵</span><div><strong>Em dinheiro, num agente</strong><small>Gere um código e receba o dinheiro em mão.</small></div></button>
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
    html: `<label>O seu PIN (para confirmar operações)<input data-adminpin type="password" inputmode="numeric" maxlength="6"></label>
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
      <div><span>Recebe em</span><span>${esc(state.me.receive_currency)}</span></div>
      <div><span>Conta</span><span>${{ user: 'Cliente', agent: 'Agente', admin: 'Administrador' }[state.me.role]} · nível ${state.me.tier}</span></div></div>
      <form data-myiban data-own><h3 style="font-size:1rem">O meu IBAN (para levantar)</h3>
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
      const mine = await api('GET', '/me/bank-account');
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
      toast(err.message, true);
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
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });
document.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openSheet(b.dataset.open)));

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
  const link = parseLink(location.href);
  if (link) {
    sessionStorage.setItem('dp_link', JSON.stringify(link));
    history.replaceState(null, '', location.pathname); // limpa o endereço
    if (!state.token) toast(link.pagar ? 'Entre na sua conta para pagar.' : 'Entre na sua conta para enviar.');
  }
  if (state.token) showHome(); else $('#auth').hidden = false;
})();
