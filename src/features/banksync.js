// Ligações AUTOMÁTICAS aos bancos. Três canais, que acabam todos no mesmo
// sítio (a correspondência das referências DP…… dos carregamentos):
//
//  1. SFTP (host-to-host): o banco deixa os extratos numa pasta segura; a app
//     vai buscá-los de hora a hora, confirma as entradas que correspondem
//     exatamente e deixa as outras para o admin rever. Os ficheiros de
//     pagamentos em lote são enviados para a pasta de saída.
//       BANK_SFTP_<MOEDA>=sftp://utilizador@servidor:porta
//       BANK_SFTP_<MOEDA>_KEY (chave privada) ou BANK_SFTP_<MOEDA>_PASSWORD
//       BANK_SFTP_<MOEDA>_HOSTKEY=SHA256:… (impressão digital do servidor, obrigatória)
//       BANK_SFTP_<MOEDA>_INBOX=/extratos  BANK_SFTP_<MOEDA>_OUTBOX=/pagamentos
//     (ou BANK_DIR_<MOEDA>=/caminho para uma pasta local/partilhada)
//
//  2. Alertas por e-mail: muitos bancos enviam um e-mail por cada entrada na
//     conta. Um serviço de e-mail (Mailgun, SendGrid, Postmark…) reencaminha-o
//     para /api/webhooks/bank-email/<BANK_EMAIL_TOKEN>. Só aceita remetentes
//     autorizados (BANK_EMAIL_SENDERS). Por omissão SUGERE a confirmação ao
//     admin; com BANK_EMAIL_AUTO=true confirma sozinho, mas só se a assinatura
//     DKIM do banco for válida (um e-mail falso não credita nada).
//
//  3. Open Banking: lê os movimentos da conta através de um agregador ou da API
//     do banco, num formato normalizado:
//       OB_<MOEDA>_URL (GET → { transactions: [{ id, booking_date, amount, currency, description }] })
//       OB_<MOEDA>_TOKEN, ou OB_<MOEDA>_PROVIDER=sandbox (simulador)
const crypto = require('crypto');
const { ApiError, cleanText } = require('../util');
const { parseStatement, parseMoney } = require('./statements');

const FILE_RE = /\.(csv|txt|xml|sta|940|mt940)$/i;
const REF_RE = /\bDP[2-9A-HJ-NP-Z]{6}\b/;

function decodeFile(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('windows-1252').decode(buf); }
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const pem = (v) => (v && !v.includes('-----BEGIN') ? Buffer.from(v, 'base64').toString('utf8') : String(v || '').replace(/\\n/g, '\n'));

module.exports = function banksync(kit) {
  const { db, C, env, now, fmt, audit, requireRole } = kit;
  const CURS = Object.keys(C.CURRENCIES);
  const sandboxTx = {}; // Open Banking simulado: movimentos de teste por moeda

  // ---------- Configuração (vem das variáveis de ambiente: os segredos não ficam na BD) ----------
  function sftpConfig(cur) {
    const raw = env[`BANK_SFTP_${cur}`];
    if (raw) {
      const u = new URL(raw);
      return {
        type: 'sftp', host: u.hostname, port: Number(u.port) || 22, username: decodeURIComponent(u.username),
        password: env[`BANK_SFTP_${cur}_PASSWORD`] || (u.password ? decodeURIComponent(u.password) : undefined),
        privateKey: env[`BANK_SFTP_${cur}_KEY`] ? pem(env[`BANK_SFTP_${cur}_KEY`]) : undefined,
        hostKey: env[`BANK_SFTP_${cur}_HOSTKEY`] || null,
        inbox: env[`BANK_SFTP_${cur}_INBOX`] || '/extratos', outbox: env[`BANK_SFTP_${cur}_OUTBOX`] || '/pagamentos',
      };
    }
    if (env[`BANK_DIR_${cur}`]) {
      const d = env[`BANK_DIR_${cur}`].replace(/\/$/, '');
      return { type: 'folder', inbox: `${d}/extratos`, outbox: `${d}/pagamentos` };
    }
    return null;
  }
  function obConfig(cur) {
    if (env[`OB_${cur}_PROVIDER`] === 'sandbox') return { type: 'sandbox' };
    if (env[`OB_${cur}_URL`]) return { type: 'http', url: env[`OB_${cur}_URL`], token: env[`OB_${cur}_TOKEN`] };
    return null;
  }
  const emailConfig = () => (env.BANK_EMAIL_TOKEN ? {
    token: env.BANK_EMAIL_TOKEN,
    senders: String(env.BANK_EMAIL_SENDERS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean),
    currency: env.BANK_EMAIL_CURRENCY || 'STN',
    auto: env.BANK_EMAIL_AUTO === 'true',
  } : null);

  // As operações automáticas ficam registadas em nome do primeiro administrador.
  async function systemAdmin() {
    const a = await db.get("SELECT * FROM users WHERE role = 'admin' AND status = 'active' ORDER BY id LIMIT 1");
    if (!a) throw new Error('não há nenhum administrador ativo');
    return a;
  }

  // ---------- Transporte de ficheiros (SFTP ou pasta) ----------
  async function openTransport(cfg) {
    if (cfg.type === 'folder') {
      const fs = require('fs/promises'); const path = require('path');
      return {
        async list(dir) {
          const names = await fs.readdir(dir).catch((e) => { if (e.code === 'ENOENT') return []; throw e; });
          const out = [];
          for (const name of names) { const st = await fs.stat(path.join(dir, name)); if (st.isFile()) out.push({ name, size: st.size, mtime: st.mtimeMs }); }
          return out;
        },
        read: (dir, name) => fs.readFile(path.join(dir, name)),
        async write(dir, name, content) { await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, name), content); },
        close: async () => {},
      };
    }
    const Client = require('ssh2-sftp-client');
    const sftp = new Client();
    if (!cfg.hostKey) throw new Error('falta BANK_SFTP_<MOEDA>_HOSTKEY (impressão digital do servidor do banco): sem ela não é seguro ligar');
    const want = cfg.hostKey.replace(/^SHA256:/, '').replace(/=+$/, '');
    let seen = null;
    await sftp.connect({
      host: cfg.host, port: cfg.port, username: cfg.username, password: cfg.password, privateKey: cfg.privateKey, readyTimeout: 15_000,
      // Só fala com o servidor se a identidade dele for a esperada (contra ataques "man-in-the-middle").
      hostVerifier: (key) => { seen = crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, ''); return seen === want; },
    }).catch((err) => { throw new Error(seen && seen !== want ? `a identidade do servidor não corresponde (recebido SHA256:${seen})` : err.message); });
    return {
      async list(dir) { return (await sftp.list(dir)).filter((f) => f.type === '-').map((f) => ({ name: f.name, size: f.size, mtime: f.modifyTime })); },
      read: (dir, name) => sftp.get(`${dir}/${name}`),
      write: (dir, name, content) => sftp.put(Buffer.from(content), `${dir}/${name}`),
      close: () => sftp.end(),
    };
  }

  async function record(source, currency, fn) {
    const { id } = await db.get('INSERT INTO bank_sync_runs (source, currency, started_at) VALUES (?, ?, ?) RETURNING id', source, currency, now());
    try {
      const r = await fn();
      await db.run('UPDATE bank_sync_runs SET finished_at = ?, ok = 1, files = ?, credits = ?, confirmed = ?, to_review = ?, error = ? WHERE id = ?',
        now(), r.files || 0, r.credits || 0, r.confirmed || 0, r.to_review || 0, r.error ? cleanText(r.error, 300) : null, id);
      return { source, currency, ok: true, ...r };
    } catch (err) {
      await db.run('UPDATE bank_sync_runs SET finished_at = ?, ok = 0, error = ? WHERE id = ?', now(), cleanText(err.message, 300), id);
      return { source, currency, ok: false, error: err.message };
    }
  }

  // ---------- 1. Extratos por SFTP / pasta ----------
  async function syncFiles(cur) {
    const cfg = sftpConfig(cur);
    return record(cfg.type, cur, async () => {
      const admin = await systemAdmin();
      const t = await openTransport(cfg);
      const out = { files: 0, credits: 0, confirmed: 0, to_review: 0, errors: [] };
      try {
        for (const f of (await t.list(cfg.inbox)).filter((x) => FILE_RE.test(x.name)).sort((a, b) => a.mtime - b.mtime)) {
          const fp = sha(`${cfg.type}|${cur}|${f.name}|${f.size}|${Math.round(f.mtime / 1000)}`);
          if (await db.get('SELECT 1 AS x FROM bank_files WHERE fingerprint = ?', fp)) continue; // já lido
          let importId = null;
          try {
            const { format, lines } = parseStatement(decodeFile(await t.read(cfg.inbox, f.name)));
            const r = await kit.ingestLines(admin, { currency: cur, format, filename: `${cfg.type}:${f.name}`, lines, autoConfirm: true });
            importId = r.import_id;
            out.credits += r.summary.credits; out.confirmed += r.confirmed; out.to_review += r.summary.amount_differs;
          } catch (err) { out.errors.push(`${f.name}: ${err.message}`); }
          // Marca como lido mesmo com erro (não repete o mesmo erro de hora a hora; aparece no estado).
          await db.run('INSERT INTO bank_files (fingerprint, source, currency, name, import_id, processed_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
            fp, cfg.type, cur, f.name, importId, now());
          out.files++;
        }
      } finally { await t.close(); }
      if (out.errors.length) out.error = out.errors.join(' | ');
      return out;
    });
  }

  // Envia o ficheiro de um lote de pagamentos para a pasta de saída do banco.
  kit.uploadBatchFile = async (cur, filename, content) => {
    const cfg = sftpConfig(cur);
    if (!cfg) return null;
    try {
      const t = await openTransport(cfg);
      try { await t.write(cfg.outbox, filename, content); } finally { await t.close(); }
      return { target: cfg.type, path: `${cfg.outbox}/${filename}` };
    } catch (err) { return { target: cfg.type, error: err.message }; }
  };

  // ---------- 3. Open Banking ----------
  async function syncOpenBanking(cur) {
    const cfg = obConfig(cur);
    return record('openbanking', cur, async () => {
      const admin = await systemAdmin();
      let txs;
      if (cfg.type === 'sandbox') txs = sandboxTx[cur] || [];
      else {
        const since = new Date(now() - 7 * 86_400_000).toISOString().slice(0, 10);
        const res = await fetch(`${cfg.url}${cfg.url.includes('?') ? '&' : '?'}since=${since}`, {
          headers: { accept: 'application/json', ...(cfg.token ? { authorization: 'Bearer ' + cfg.token } : {}) }, signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) throw new Error(`o serviço de Open Banking respondeu ${res.status}`);
        txs = (await res.json()).transactions || [];
      }
      const lines = txs.filter((x) => !x.currency || x.currency === cur).map((x) => {
        const v = typeof x.amount === 'number' ? Math.round(x.amount * 100) : parseMoney(String(x.amount));
        return { id: x.id, date: String(x.booking_date || '').slice(0, 10), amount: v, description: cleanText(x.description || x.remittance || '', 300) || '', raw: '' };
      }).filter((x) => x.id && Number.isSafeInteger(x.amount));
      const r = await kit.ingestLines(admin, { currency: cur, format: 'openbanking', filename: `openbanking:${cfg.type}`, lines, autoConfirm: true, idOf: (l) => l.id });
      return { files: 0, credits: r.summary.credits - r.summary.already, confirmed: r.confirmed, to_review: r.summary.amount_differs };
    });
  }

  async function addSandboxTransaction(admin, { currency, amount, description, pin }, ip) {
    requireRole(admin, 'admin');
    const cfg = obConfig(currency);
    if (!cfg || cfg.type !== 'sandbox') throw new ApiError(409, 'not_sandbox', 'Só disponível com o simulador de Open Banking (OB_<MOEDA>_PROVIDER=sandbox).');
    await kit.checkPin(admin, pin, ip);
    (sandboxTx[currency] = sandboxTx[currency] || []).push({ id: 'sbx-' + crypto.randomBytes(5).toString('hex'), booking_date: new Date(now()).toISOString().slice(0, 10),
      amount: (amount / 100).toFixed(2), currency, description: cleanText(description, 200) || 'Movimento de teste' });
    return { ok: true, pending: sandboxTx[currency].length };
  }

  // ---------- Correr tudo (de hora a hora, ou no botão "Verificar agora") ----------
  async function runBankSync({ only } = {}) {
    const results = [];
    for (const cur of CURS) {
      if ((!only || only === 'files') && sftpConfig(cur)) results.push(await syncFiles(cur));
      if ((!only || only === 'openbanking') && obConfig(cur)) results.push(await syncOpenBanking(cur));
    }
    return results;
  }
  async function runBankSyncAdmin(admin, { only }, ip) {
    requireRole(admin, 'admin');
    const r = await runBankSync({ only });
    await audit(admin.id, 'bank_sync_manual', { only, results: r.map((x) => ({ s: x.source, c: x.currency, ok: x.ok, confirmed: x.confirmed })) }, ip);
    return r;
  }
  let timer = null;
  function startBankSync(minutes = Number(env.BANK_SYNC_MINUTES) || 60) {
    if (timer || !CURS.some((c) => sftpConfig(c) || obConfig(c))) return;
    const tick = () => runBankSync().catch((err) => console.error('Ligações aos bancos:', err.message));
    setTimeout(tick, 15_000).unref?.();
    timer = setInterval(tick, minutes * 60_000);
    if (timer.unref) timer.unref();
  }

  // ---------- 2. Alertas por e-mail ----------
  function normalizeEmail(p) {
    const headers = Array.isArray(p.Headers) ? p.Headers : [];
    const header = (n) => (headers.find((h) => String(h.Name).toLowerCase() === n) || {}).Value || p[n] || p[n.replace(/(^|-)(\w)/g, (m, a, b) => a + b.toUpperCase())] || '';
    const fromRaw = String(p.from || p.sender || p.From || p.FromFull?.Email || '');
    const sender = (/<([^>]+)>/.exec(fromRaw)?.[1] || fromRaw).trim().toLowerCase();
    const html = String(p.html || p.HtmlBody || p['body-html'] || '');
    const text = String(p.text || p['body-plain'] || p['stripped-text'] || p.TextBody || '') || html.replace(/<[^>]+>/g, ' ');
    const auth = String(header('authentication-results') || '');
    const domain = sender.split('@')[1] || '';
    // DKIM: SendGrid ("dkim": "{@bistp.st : pass}"), Postmark/genérico (Authentication-Results), ou campo "dkim": "pass".
    const dk = String(p.dkim || '');
    const dkimOk = !!domain && (
      new RegExp(`@?${domain.replace(/\./g, '\\.')}\\s*:\\s*pass`, 'i').test(dk) || /^pass$/i.test(dk.trim()) ||
      new RegExp(`dkim=pass[^;]*header\\.d=${domain.replace(/\./g, '\\.')}`, 'i').test(auth));
    return { sender, domain, subject: String(p.subject || p.Subject || ''), text: text.replace(/\s+/g, ' ').trim(), messageId: String(p['Message-Id'] || p.MessageID || header('message-id') || ''), dkimOk };
  }

  async function handleBankEmail(token, payload) {
    const cfg = emailConfig();
    if (!cfg) throw new ApiError(503, 'email_disabled', 'Alertas por e-mail desativados: falta BANK_EMAIL_TOKEN.');
    const t = String(token || '');
    if (t.length !== cfg.token.length || !crypto.timingSafeEqual(Buffer.from(t), Buffer.from(cfg.token))) throw new ApiError(404, 'not_found', 'Rota inexistente.');
    const e = normalizeEmail(payload || {});
    const dedup = sha(e.messageId || `${e.sender}|${e.subject}|${e.text}`);
    const dup = await db.get('SELECT id, status FROM bank_email_alerts WHERE dedup = ?', dedup);
    if (dup) return { id: dup.id, status: dup.status, duplicate: true };
    const allowed = cfg.senders.some((s) => (s.startsWith('@') ? e.sender.endsWith(s) : e.sender === s));
    const body = `${e.subject} ${e.text}`;
    const ref = (body.toUpperCase().match(REF_RE) || [])[0] || null;
    const amounts = [...body.matchAll(/(?:\d{1,3}(?:[. ]\d{3})+|\d+)(?:[.,]\d{1,2})?/g)].map((m) => parseMoney(m[0].replace(/ /g, '.'))).filter((v) => v > 0);
    let status = 'unmatched', req = null, amount = amounts.length ? Math.max(...amounts) : null, note = null;
    if (!allowed) { status = 'rejected'; note = `remetente não autorizado (${e.sender || 'desconhecido'})`; }
    else if (ref) {
      req = await db.get("SELECT * FROM bank_requests WHERE reference = ? AND kind = 'deposit'", ref);
      if (!req) note = 'referência desconhecida';
      else if (req.status !== 'pending') note = 'carregamento já tratado';
      else if (req.currency !== cfg.currency) note = `moeda diferente (${req.currency})`;
      else if (amounts.includes(req.amount)) { status = 'suggested'; amount = req.amount; }
      else note = `valor no e-mail diferente do pedido (${fmt(req.amount, req.currency)})`;
    } else note = 'sem referência DP…';
    const { id } = await db.get(`INSERT INTO bank_email_alerts (dedup, received_at, sender, subject, excerpt, dkim_ok, currency, amount, reference, request_id, status, note)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`, dedup, now(), cleanText(e.sender, 120), cleanText(e.subject, 200),
    cleanText(e.text, 500), e.dkimOk ? 1 : 0, cfg.currency, amount, ref, req ? req.id : null, status, note);
    // Confirmação automática só com DKIM válido do banco (um e-mail falsificado não passa).
    if (status === 'suggested' && cfg.auto && e.dkimOk) {
      const r = await confirmAlertCore(await systemAdmin(), id).catch((err) => ({ error: err.message }));
      if (!r.error) status = 'confirmed';
    }
    await audit(null, 'bank_email_alert', { id, status, sender: e.sender, ref, dkim: e.dkimOk });
    return { id, status };
  }

  async function confirmAlertCore(admin, id) {
    const txId = await db.tx(async () => {
      const a = await db.get('SELECT * FROM bank_email_alerts WHERE id = ? FOR UPDATE', Number(id) || 0);
      if (!a) throw new ApiError(404, 'not_found', 'Alerta não encontrado.');
      if (a.status !== 'suggested') throw new ApiError(409, 'not_suggested', 'Este alerta não tem um carregamento para confirmar.');
      const t = await kit.confirmDepositCore(admin, a.request_id, a.amount, `Alerta do banco por e-mail (${(a.subject || '').slice(0, 40)})`);
      await db.run("UPDATE bank_email_alerts SET status = 'confirmed', handled_by = ? WHERE id = ?", admin.id, a.id);
      return t;
    });
    kit.afterCommit(txId);
    return { ok: true };
  }

  async function confirmEmailAlert(admin, id, { pin }, ip) {
    requireRole(admin, 'admin');
    await kit.checkPin(admin, pin, ip);
    await confirmAlertCore(admin, id);
    await audit(admin.id, 'bank_email_confirmed', { id }, ip);
    return bankSyncStatus(admin);
  }
  async function dismissEmailAlert(admin, id) {
    requireRole(admin, 'admin');
    await db.run("UPDATE bank_email_alerts SET status = 'dismissed', handled_by = ? WHERE id = ? AND status IN ('suggested','unmatched','rejected')", admin.id, Number(id) || 0);
    return bankSyncStatus(admin);
  }

  // ---------- Estado para o painel ----------
  async function bankSyncStatus(admin) {
    requireRole(admin, 'admin');
    const last = (source, cur) => db.get('SELECT * FROM bank_sync_runs WHERE source = ? AND currency = ? ORDER BY id DESC LIMIT 1', source, cur);
    const connections = [];
    for (const cur of CURS) {
      const f = sftpConfig(cur), o = obConfig(cur);
      if (f) connections.push({ kind: f.type, currency: cur, target: f.type === 'sftp' ? `${f.username}@${f.host}:${f.port}${f.inbox}` : f.inbox,
        secure: f.type === 'folder' || !!f.hostKey, last: await last(f.type, cur) });
      if (o) connections.push({ kind: 'openbanking', currency: cur, target: o.type === 'sandbox' ? 'simulador' : new URL(o.url).host, sandbox: o.type === 'sandbox', last: await last('openbanking', cur) });
    }
    const em = emailConfig();
    const alerts = await db.all("SELECT * FROM bank_email_alerts WHERE status IN ('suggested','unmatched','rejected') ORDER BY received_at DESC LIMIT 30");
    const review = await db.all(`SELECT l.*, r.amount AS expected, r.user_id FROM statement_lines l JOIN bank_requests r ON r.id = l.request_id
                                 WHERE l.status = 'preview' AND r.status = 'pending' AND l.amount <> r.amount ORDER BY l.id DESC LIMIT 30`);
    const seenFp = new Set();
    const reviewRows = [];
    for (const l of review) {
      if (seenFp.has(l.fingerprint)) continue; seenFp.add(l.fingerprint);
      const u = await kit.userById(l.user_id);
      reviewRows.push({ import_id: l.import_id, line_id: l.id, amount: l.amount, expected: l.expected, date: l.booked_at, description: l.description, reference: l.reference, user: { name: u.name, phone: u.phone } });
    }
    return {
      connections,
      email: em ? { enabled: true, path: `/api/webhooks/bank-email/${em.token}`, senders: em.senders, currency: em.currency, auto: em.auto } : { enabled: false },
      email_alerts: alerts.map((a) => ({ id: a.id, received_at: a.received_at, sender: a.sender, subject: a.subject, excerpt: a.excerpt, dkim_ok: !!a.dkim_ok,
        amount: a.amount, currency: a.currency, reference: a.reference, status: a.status, note: a.note })),
      review: reviewRows,
    };
  }

  return { runBankSync, runBankSyncAdmin, startBankSync, bankSyncStatus, handleBankEmail, confirmEmailAlert, dismissEmailAlert, addSandboxTransaction };
};
