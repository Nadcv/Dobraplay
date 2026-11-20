// Ligação ao banco por ficheiros (ex.: BISTP, CGD), sem precisar de API:
//
//  1. IMPORTAR EXTRATO: o admin descarrega o extrato no homebanking e envia-o.
//     A app lê-o (CSV/Excel guardado como CSV, MT940 ou CAMT.053), encontra as
//     referências dos carregamentos (DP……) e propõe as confirmações. O admin
//     revê e confirma com o PIN. Cada linha só pode ser usada uma vez, mesmo
//     que o mesmo extrato seja importado de novo.
//
//  2. PAGAR EM LOTE: a app junta os levantamentos pendentes de uma moeda num
//     ficheiro (CSV genérico ou SEPA XML pain.001 para euros) para carregar no
//     homebanking. Depois de o banco pagar, o admin marca o lote como pago.
const crypto = require('crypto');
const { ApiError, cleanText, normalizeIban } = require('../util');

const REF_RE = /\bDP[2-9A-HJ-NP-Z]{6}\b/g;

// ---------- Valores e datas ----------
// "1.234,56", "1,234.56", "-50,00", "1234.5", "12.500" (= doze mil e quinhentos), "50,00 C" / "50,00 D"
function parseMoney(raw) {
  if (raw == null) return null;
  let s = String(raw).trim().replace(/\s|€|EUR|STN|Db|USD|AOA|CVE/gi, '');
  if (!s) return null;
  let sign = 1;
  if (/^\(.*\)$/.test(s)) { sign = -1; s = s.slice(1, -1); }
  if (/[Dd]$/.test(s)) { sign = -1; s = s.slice(0, -1); } else if (/[Cc]$/.test(s)) s = s.slice(0, -1);
  if (s.startsWith('-')) { sign = -sign; s = s.slice(1); } else if (s.startsWith('+')) s = s.slice(1);
  if (!/^[\d.,]+$/.test(s)) return null;
  const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
  let int, dec = '';
  if (lastDot >= 0 && lastComma >= 0) {
    const sep = lastDot > lastComma ? '.' : ',';
    [int, dec] = [s.slice(0, s.lastIndexOf(sep)), s.slice(s.lastIndexOf(sep) + 1)];
    int = int.replace(/[.,]/g, '');
  } else if (lastComma >= 0) {
    [int, dec] = [s.slice(0, lastComma).replace(/,/g, ''), s.slice(lastComma + 1)];
  } else if (lastDot >= 0) {
    const after = s.slice(lastDot + 1);
    // Com só pontos: "12.500" ou "1.234.567" são milhares; "12.50" é decimal.
    if (after.length === 3 && !/^0+$/.test(s.slice(0, s.indexOf('.')))) int = s.replace(/\./g, '');
    else [int, dec] = [s.slice(0, lastDot).replace(/\./g, ''), after];
  } else int = s;
  if (dec.length > 2 || !/^\d*$/.test(int + dec)) return null;
  return sign * (Number(int || 0) * 100 + Number((dec + '00').slice(0, 2)));
}

function parseDate(raw) {
  const s = String(raw || '').trim();
  let m;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/.exec(s))) {
    const y = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  if ((m = /^(\d{2})(\d{2})(\d{2})$/.exec(s))) return `20${m[1]}-${m[2]}-${m[3]}`; // MT940: AAMMDD
  return s || null;
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

// ---------- CSV ----------
function splitCsvLine(line, sep) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === sep) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

const H = {
  date: ['data', 'data mov', 'data movimento', 'data lancamento', 'data valor', 'data operacao', 'date', 'booking date', 'value date', 'fecha'],
  desc: ['descritivo', 'descricao', 'description', 'movimento', 'detalhes', 'narrativa', 'observacoes', 'referencia', 'reference', 'concepto', 'designacao', 'historico'],
  amount: ['valor', 'montante', 'amount', 'importancia', 'importe', 'quantia'],
  credit: ['credito', 'creditos', 'credit', 'entrada', 'entradas', 'haber'],
  debit: ['debito', 'debitos', 'debit', 'saida', 'saidas', 'debe'],
};
const headerKind = (h) => {
  const n = norm(h);
  for (const [k, list] of Object.entries(H)) if (list.some((x) => n === x || n.startsWith(x + ' ') || n.endsWith(' ' + x))) return k;
  return null;
};

function parseCsv(text) {
  const rows = text.split(/\r?\n/).filter((l) => l.trim());
  const sep = [';', '\t', ','].map((c) => [c, (rows.slice(0, 20).join('\n').match(new RegExp(c === '\t' ? '\t' : '\\' + c, 'g')) || []).length]).sort((a, b) => b[1] - a[1])[0][0];
  // A linha de cabeçalho pode não ser a primeira (os bancos põem títulos antes).
  let hi = -1, kinds = [];
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const k = splitCsvLine(rows[i], sep).map(headerKind);
    if (k.includes('date') && (k.includes('amount') || k.includes('credit'))) { hi = i; kinds = k; break; }
  }
  if (hi < 0) throw new ApiError(400, 'bad_statement', 'Não encontrei as colunas de data e valor no ficheiro. Exporte o extrato em CSV/Excel com cabeçalhos (Data, Descritivo, Valor ou Crédito/Débito).');
  const col = (k) => kinds.map((x, i) => (x === k ? i : -1)).filter((i) => i >= 0);
  const [dateI] = col('date'), amountI = col('amount')[0], creditI = col('credit')[0], debitI = col('debit')[0], descI = col('desc');
  const lines = [];
  for (const row of rows.slice(hi + 1)) {
    const c = splitCsvLine(row, sep);
    let amount = null;
    if (creditI != null || debitI != null) {
      const cr = creditI != null ? parseMoney(c[creditI]) : null, db = debitI != null ? parseMoney(c[debitI]) : null;
      if (cr) amount = Math.abs(cr); else if (db) amount = -Math.abs(db);
    }
    if (amount == null && amountI != null) amount = parseMoney(c[amountI]);
    if (amount == null || !c[dateI]) continue; // linhas de saldo, totais, etc.
    lines.push({ date: parseDate(c[dateI]), amount, description: (descI.length ? descI.map((i) => c[i]) : c).filter(Boolean).join(' · '), raw: c.join(' ') });
  }
  return { format: 'csv', lines };
}

// ---------- MT940 (SWIFT) ----------
function parseMt940(text) {
  const lines = [];
  const blocks = text.replace(/\r/g, '').split(/\n(?=:\d{2}[A-Z]?:)/);
  let cur = null;
  for (const b of blocks) {
    const m = /^:(\d{2}[A-Z]?):([\s\S]*)$/.exec(b.trim());
    if (!m) continue;
    const [, tag, val] = m;
    if (tag === '61') {
      // AAMMDD[MMDD]C|D|RC|RD valor (vírgula decimal) …
      const t = /^(\d{6})(\d{4})?(R?[CD])[A-Z]?([\d,]+)/.exec(val.replace(/\n/g, ''));
      if (!t) continue;
      const amount = parseMoney(t[4]);
      cur = { date: parseDate(t[1]), amount: t[3].endsWith('D') ? -amount : amount, description: val.replace(/\n/g, ' ').slice(t[0].length).trim(), raw: val };
      lines.push(cur);
    } else if (tag === '86' && cur) {
      cur.description = (cur.description ? cur.description + ' · ' : '') + val.replace(/\n/g, ' ').trim();
      cur.raw += ' ' + val;
    }
  }
  return { format: 'mt940', lines };
}

// ---------- CAMT.053 (XML ISO 20022) ----------
function parseCamt053(text) {
  const lines = [];
  const tag = (xml, name) => { const m = new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`).exec(xml); return m ? m[1].trim() : null; };
  const all = (xml, name) => [...xml.matchAll(new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`, 'g'))].map((m) => m[1]);
  const strip = (s) => (s || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
  for (const e of all(text, 'Ntry')) {
    const amt = parseMoney(tag(e, 'Amt'));
    if (amt == null) continue;
    const debit = (tag(e, 'CdtDbtInd') || '').toUpperCase() === 'DBIT';
    const date = tag(tag(e, 'BookgDt') || '', 'Dt') || tag(tag(e, 'ValDt') || '', 'Dt');
    const desc = [all(e, 'Ustrd').map(strip).join(' '), strip(tag(e, 'AddtlNtryInf')), strip(tag(e, 'Nm'))].filter(Boolean).join(' · ');
    lines.push({ date: parseDate(date), amount: debit ? -Math.abs(amt) : Math.abs(amt), description: desc, raw: strip(e) });
  }
  return { format: 'camt053', lines };
}

function parseStatement(text) {
  const t = String(text || '').replace(/^﻿/, '');
  if (!t.trim()) throw new ApiError(400, 'bad_statement', 'O ficheiro está vazio.');
  if (/<(?:\w+:)?BkToCstmrStmt\b/.test(t) || /<(?:\w+:)?Ntry\b/.test(t)) return parseCamt053(t);
  if (/^:20:/m.test(t) && /^:61:/m.test(t)) return parseMt940(t);
  return parseCsv(t);
}

// ---------- SEPA pain.001 (transferências a crédito em euros) ----------
const xmlEsc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// SEPA só aceita um conjunto limitado de caracteres latinos.
const sepaText = (s, max) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 /\-?:().,'+]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const dec = (c) => (c / 100).toFixed(2);

function buildPain001({ batchId, company, items, executionDate }) {
  const total = items.reduce((s, x) => s + x.amount, 0);
  const now = new Date().toISOString().slice(0, 19);
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03">
  <CstmrCdtTrfInitn>
    <GrpHdr>
      <MsgId>${xmlEsc(batchId)}</MsgId>
      <CreDtTm>${now}</CreDtTm>
      <NbOfTxs>${items.length}</NbOfTxs>
      <CtrlSum>${dec(total)}</CtrlSum>
      <InitgPty><Nm>${xmlEsc(sepaText(company.holder, 70))}</Nm></InitgPty>
    </GrpHdr>
    <PmtInf>
      <PmtInfId>${xmlEsc(batchId)}</PmtInfId>
      <PmtMtd>TRF</PmtMtd>
      <NbOfTxs>${items.length}</NbOfTxs>
      <CtrlSum>${dec(total)}</CtrlSum>
      <PmtTpInf><SvcLvl><Cd>SEPA</Cd></SvcLvl></PmtTpInf>
      <ReqdExctnDt>${executionDate}</ReqdExctnDt>
      <Dbtr><Nm>${xmlEsc(sepaText(company.holder, 70))}</Nm></Dbtr>
      <DbtrAcct><Id><IBAN>${xmlEsc(company.iban)}</IBAN></Id></DbtrAcct>
      <DbtrAgt><FinInstnId>${company.swift ? `<BIC>${xmlEsc(company.swift)}</BIC>` : '<Othr><Id>NOTPROVIDED</Id></Othr>'}</FinInstnId></DbtrAgt>
      <ChrgBr>SLEV</ChrgBr>
${items.map((x) => `      <CdtTrfTxInf>
        <PmtId><EndToEndId>${xmlEsc(x.reference)}</EndToEndId></PmtId>
        <Amt><InstdAmt Ccy="EUR">${dec(x.amount)}</InstdAmt></Amt>
        <Cdtr><Nm>${xmlEsc(sepaText(x.holder, 70))}</Nm></Cdtr>
        <CdtrAcct><Id><IBAN>${xmlEsc(x.iban)}</IBAN></Id></CdtrAcct>
        <RmtInf><Ustrd>${xmlEsc(sepaText(`DobraPay ${x.reference}`, 140))}</Ustrd></RmtInf>
      </CdtTrfTxInf>`).join('\n')}
    </PmtInf>
  </CstmrCdtTrfInitn>
</Document>
`;
}

module.exports = function statements(kit) {
  const { db, now, fmt, audit, requireRole } = kit;
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

  // ---------- 1. Importar extrato ----------
  async function previewStatement(admin, { currency, content, filename }, ip) {
    requireRole(admin, 'admin');
    kit.needCurrency(currency);
    if (typeof content !== 'string' || content.length > 1_500_000) throw new ApiError(400, 'bad_statement', 'Ficheiro inválido ou demasiado grande.');
    const { format, lines } = parseStatement(content);
    const { id: importId } = await db.get('INSERT INTO statement_imports (currency, filename, format, lines_total, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
      currency, cleanText(filename, 120), format, lines.length, admin.id, now());
    const seen = {};
    const rows = [];
    for (const l of lines) {
      if (l.amount <= 0) continue; // só as entradas interessam para os carregamentos
      const base = `${currency}|${l.date}|${l.amount}|${norm(l.description)}`;
      seen[base] = (seen[base] || 0) + 1; // duas linhas iguais no mesmo extrato são movimentos diferentes
      const fingerprint = sha(`${base}|${seen[base]}`);
      const refs = [...new Set(((l.description + ' ' + l.raw).toUpperCase().match(REF_RE) || []))];
      const done = await db.get("SELECT request_id FROM statement_lines WHERE fingerprint = ? AND status = 'confirmed' LIMIT 1", fingerprint);
      let state = 'unmatched', req = null;
      if (done) state = 'already';
      else if (refs.length) {
        req = await db.get("SELECT * FROM bank_requests WHERE reference = ? AND kind = 'deposit'", refs[0]);
        if (!req) state = 'unknown_ref';
        else if (req.currency !== currency) state = 'wrong_currency';
        else if (req.status !== 'pending') state = 'request_closed';
        else state = req.amount === l.amount ? 'match' : 'amount_differs';
      }
      const { id } = await db.get(`INSERT INTO statement_lines (import_id, fingerprint, booked_at, amount, description, reference, request_id, created_at)
                                   VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`, importId, fingerprint, l.date, l.amount, cleanText(l.description, 300),
      refs[0] || null, req ? req.id : null, now());
      let user = null;
      if (req) { const u = await kit.userById(req.user_id); user = { name: u.name, phone: u.phone }; }
      rows.push({ line_id: id, date: l.date, amount: l.amount, description: cleanText(l.description, 300), reference: refs[0] || null, state,
        expected: req ? req.amount : null, user });
    }
    await audit(admin.id, 'statement_preview', { importId, format, credits: rows.length }, ip);
    const count = (s) => rows.filter((r) => r.state === s).length;
    return { import_id: importId, format, currency, rows,
      summary: { credits: rows.length, match: count('match'), amount_differs: count('amount_differs'), already: count('already'),
        unmatched: rows.length - count('match') - count('amount_differs') - count('already') } };
  }

  // Confirma as linhas escolhidas: credita o valor que REALMENTE chegou ao banco.
  async function confirmStatement(admin, importId, { lineIds, pin }, ip) {
    requireRole(admin, 'admin');
    if (!Array.isArray(lineIds) || !lineIds.length) throw new ApiError(400, 'nothing_selected', 'Escolha pelo menos uma linha.');
    await kit.checkPin(admin, pin, ip);
    const results = [];
    for (const lineId of lineIds.slice(0, 500)) {
      try {
        const txId = await db.tx(async () => {
          const l = await db.get('SELECT * FROM statement_lines WHERE id = ? AND import_id = ? FOR UPDATE', Number(lineId) || 0, Number(importId) || 0);
          if (!l || !l.request_id) throw new ApiError(400, 'not_matchable', 'Linha sem carregamento correspondente.');
          if (l.status === 'confirmed' || await db.get("SELECT 1 AS x FROM statement_lines WHERE fingerprint = ? AND status = 'confirmed'", l.fingerprint)) {
            throw new ApiError(409, 'already', 'Esta linha do extrato já foi usada.');
          }
          const t = await kit.confirmDepositCore(admin, l.request_id, l.amount, `Extrato ${l.booked_at || ''} · ${(l.description || '').slice(0, 50)}`);
          await db.run("UPDATE statement_lines SET status = 'confirmed' WHERE id = ?", l.id);
          return t;
        });
        kit.afterCommit(txId);
        results.push({ line_id: Number(lineId), ok: true });
      } catch (err) {
        results.push({ line_id: Number(lineId), ok: false, error: err.message });
      }
    }
    await audit(admin.id, 'statement_confirmed', { importId, ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length }, ip);
    return { confirmed: results.filter((r) => r.ok).length, results };
  }

  // ---------- 2. Pagar em lote ----------
  const pendingPayouts = (currency) => db.all(`SELECT * FROM bank_requests WHERE kind = 'withdrawal' AND status = 'pending' AND currency = ?
    AND (provider IS NULL OR provider = 'manual' OR provider_status = 'error') ORDER BY created_at LIMIT 500`, currency);

  async function payoutBatchPreview(admin, { currency }) {
    requireRole(admin, 'admin');
    const rows = await pendingPayouts(kit.needCurrency(currency));
    return { currency, count: rows.length, total: rows.reduce((s, r) => s + r.amount, 0),
      items: rows.map((r) => ({ id: r.id, reference: r.reference, holder: r.holder, iban: kit.formatIban(r.iban), amount: r.amount })) };
  }

  async function exportPayoutBatch(admin, { currency, format = 'csv', pin }, ip) {
    requireRole(admin, 'admin');
    kit.needCurrency(currency);
    if (!['csv', 'sepa'].includes(format)) throw new ApiError(400, 'bad_format', 'Formato inválido.');
    if (format === 'sepa' && currency !== 'EUR') throw new ApiError(400, 'sepa_eur_only', 'O ficheiro SEPA só serve para euros. Use CSV para outras moedas.');
    const company = await db.get('SELECT * FROM company_bank_accounts WHERE currency = ?', currency);
    if (!company) throw new ApiError(409, 'no_bank', `Registe primeiro a conta bancária da empresa em ${currency} (Acertos).`);
    await kit.checkPin(admin, pin, ip);
    const batchId = `LOTE-${currency}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const items = await db.tx(async () => {
      const rows = await pendingPayouts(currency);
      if (!rows.length) throw new ApiError(409, 'nothing_pending', 'Não há levantamentos pendentes nesta moeda.');
      for (const r of rows) {
        // Ficam "enviados ao banco": o cliente já não os pode cancelar e não entram noutro lote.
        await db.run("UPDATE bank_requests SET provider = 'batch', external_id = ?, provider_status = 'submitted', updated_at = ? WHERE id = ?", batchId, now(), r.id);
      }
      await db.run('INSERT INTO payout_batches (id, currency, format, request_ids, total, count, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        batchId, currency, format, JSON.stringify(rows.map((r) => r.id)), rows.reduce((s, r) => s + r.amount, 0), rows.length, admin.id, now());
      return rows;
    });
    let content, filename, mime;
    if (format === 'sepa') {
      const nextDay = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
      content = buildPain001({ batchId, company, executionDate: nextDay, items: items.map((r) => ({ reference: r.reference, amount: r.amount, holder: r.holder, iban: r.iban })) });
      filename = `${batchId}.xml`; mime = 'application/xml';
    } else {
      const esc = (v) => { const s = String(v ?? ''); return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      content = '﻿' + ['IBAN;Titular;Valor;Moeda;Descritivo'].concat(items.map((r) =>
        [r.iban, r.holder, (r.amount / 100).toFixed(2).replace('.', ','), r.currency, `DobraPay ${r.reference}`].map(esc).join(';'))).join('\r\n') + '\r\n';
      filename = `${batchId}.csv`; mime = 'text/csv';
    }
    await audit(admin.id, 'payout_batch_exported', { batchId, count: items.length, format }, ip);
    return { batch_id: batchId, count: items.length, total: items.reduce((s, r) => s + r.amount, 0), filename, mime, content };
  }

  async function listPayoutBatches(admin) {
    requireRole(admin, 'admin');
    const rows = await db.all('SELECT * FROM payout_batches ORDER BY created_at DESC LIMIT 30');
    return rows.map((b) => ({ id: b.id, currency: b.currency, format: b.format, count: b.count, total: b.total, status: b.status,
      bank_reference: b.bank_reference, created_at: b.created_at, closed_at: b.closed_at }));
  }

  // O banco pagou o lote: fecha todos os levantamentos que ainda estão pendentes nele.
  async function markBatchPaid(admin, id, { bankReference, pin }, ip) {
    requireRole(admin, 'admin');
    const ref = cleanText(bankReference, 80);
    if (!ref) throw new ApiError(400, 'bad_reference', 'Indique a referência do lote no banco.');
    await kit.checkPin(admin, pin, ip);
    const b = await db.get('SELECT * FROM payout_batches WHERE id = ?', String(id));
    if (!b) throw new ApiError(404, 'not_found', 'Lote não encontrado.');
    if (b.status !== 'exported') throw new ApiError(409, 'not_open', 'Este lote já foi fechado.');
    let paid = 0;
    for (const reqId of JSON.parse(b.request_ids)) {
      const txId = await db.tx(async () => {
        const r = await db.get("SELECT * FROM bank_requests WHERE id = ? AND status = 'pending' AND external_id = ? FOR UPDATE", reqId, b.id);
        if (!r) return null; // recusado entretanto, ou já tratado
        return kit.finishPayout(r, admin.id, `${ref} (${b.id})`, admin.id);
      });
      if (txId) { paid++; kit.afterCommit(txId); }
    }
    await db.run("UPDATE payout_batches SET status = 'paid', bank_reference = ?, closed_at = ? WHERE id = ?", ref, now(), b.id);
    await audit(admin.id, 'payout_batch_paid', { id: b.id, paid }, ip);
    return { id: b.id, paid };
  }

  // O banco não aceitou o ficheiro: os levantamentos voltam a ficar para pagar.
  async function cancelBatch(admin, id, { pin }, ip) {
    requireRole(admin, 'admin');
    await kit.checkPin(admin, pin, ip);
    const b = await db.get('SELECT * FROM payout_batches WHERE id = ?', String(id));
    if (!b) throw new ApiError(404, 'not_found', 'Lote não encontrado.');
    if (b.status !== 'exported') throw new ApiError(409, 'not_open', 'Este lote já foi fechado.');
    await db.run("UPDATE bank_requests SET provider = NULL, external_id = NULL, provider_status = NULL, updated_at = ? WHERE external_id = ? AND status = 'pending'", now(), b.id);
    await db.run("UPDATE payout_batches SET status = 'cancelled', closed_at = ? WHERE id = ?", now(), b.id);
    await audit(admin.id, 'payout_batch_cancelled', { id: b.id }, ip);
    return { id: b.id, status: 'cancelled' };
  }

  return { previewStatement, confirmStatement, payoutBatchPreview, exportPayoutBatch, listPayoutBatches, markBatchPaid, cancelBatch };
};
Object.assign(module.exports, { parseMoney, parseDate, parseStatement, buildPain001 });
