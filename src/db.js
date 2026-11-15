// Camada de base de dados com duas implementações e a mesma interface:
//  - SQLite (módulo nativo do Node 22): no computador e nos testes;
//  - PostgreSQL (quando DATABASE_URL está definido): em produção, por exemplo
//    numa base grátis do Neon. Servidores grátis (Render, etc.) apagam o disco
//    a cada reinício, por isso o dinheiro dos clientes NUNCA pode ficar num
//    ficheiro local em produção.
//
// O SQL é escrito uma vez, com "?" como marcador; o adaptador traduz.
//
// Todo o dinheiro é guardado em CÊNTIMOS (inteiros). Contabilidade de dupla
// entrada separada POR MOEDA: em cada moeda, os lançamentos (entries) de uma
// transação somam ZERO. Contas internas por moeda:
//  - system_float: o dinheiro real no banco (fica negativa à medida que se
//    emite dinheiro eletrónico);
//  - fees: taxas cobradas;
//  - fx: a "mesa de câmbio". Numa conversão STN→EUR, a mesa recebe as Dobras e
//    paga os Euros, por isso cada moeda continua a somar zero;
//  - payout: levantamentos por transferência bancária já pedidos mas ainda
//    não pagos pelo banco (o dinheiro sai da carteira logo no pedido).
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const { CURRENCIES } = require('./config');

const SCHEMA_VERSION = 5; // 3 = SQLite + PostgreSQL; 4 = transferências bancárias + lojas; 5 = parceiros de pagamento, câmbio garantido, envios para IBAN

// Escrito para SQLite; para PostgreSQL os tipos são convertidos em pgSchema().
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS schema_meta (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id                INTEGER PRIMARY KEY,
    phone             TEXT NOT NULL UNIQUE,          -- formato internacional, ex.: +2399912345
    country           TEXT NOT NULL,                 -- ST, AO, CV, PT, ES
    name              TEXT NOT NULL,
    pin_hash          TEXT NOT NULL,
    receive_currency  TEXT NOT NULL,                 -- moeda em que prefere receber
    role              TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','agent','admin')),
    tier              INTEGER NOT NULL DEFAULT 1,    -- nível de verificação (KYC) → limites
    status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked')),
    failed_pins       INTEGER NOT NULL DEFAULT 0,
    locked_until      INTEGER NOT NULL DEFAULT 0,
    merchant_name     TEXT,                          -- preenchido = conta de loja (recebe pagamentos com QR)
    created_at        INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS accounts (
    id        INTEGER PRIMARY KEY,
    user_id   INTEGER REFERENCES users(id),
    kind      TEXT NOT NULL CHECK (kind IN ('wallet','system_float','fees','fx','payout')),
    currency  TEXT NOT NULL,
    balance   INTEGER NOT NULL DEFAULT 0,
    -- Carteiras nunca podem ficar negativas (proteção final na própria BD).
    CONSTRAINT wallet_not_negative CHECK (kind <> 'wallet' OR balance >= 0)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS acc_wallet ON accounts(user_id, currency) WHERE kind = 'wallet';
  CREATE UNIQUE INDEX IF NOT EXISTS acc_internal ON accounts(kind, currency) WHERE kind <> 'wallet';

  CREATE TABLE IF NOT EXISTS fx_rates (
    currency    TEXT PRIMARY KEY,
    per_eur     REAL NOT NULL CHECK (per_eur > 0),   -- unidades desta moeda por 1 EUR
    updated_at  INTEGER NOT NULL,
    updated_by  INTEGER
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id               TEXT PRIMARY KEY,
    type             TEXT NOT NULL CHECK (type IN ('p2p','request','cash_in','cash_out','issue','exchange','bank_in','bank_out','merchant','settlement','refund')),
    from_account     INTEGER NOT NULL REFERENCES accounts(id),
    to_account       INTEGER NOT NULL REFERENCES accounts(id),
    amount           INTEGER NOT NULL CHECK (amount > 0),     -- na moeda de origem
    currency         TEXT NOT NULL,
    to_amount        INTEGER NOT NULL CHECK (to_amount > 0),  -- o que o destinatário recebe
    to_currency      TEXT NOT NULL,
    rate             REAL NOT NULL DEFAULT 1,                 -- 1 unidade de origem = rate unidades de destino
    fee              INTEGER NOT NULL DEFAULT 0 CHECK (fee >= 0), -- na moeda de origem
    note             TEXT,
    created_by       INTEGER NOT NULL REFERENCES users(id),
    idempotency_key  TEXT,
    created_at       INTEGER NOT NULL,
    seq              INTEGER NOT NULL DEFAULT 0,              -- desempate na ordenação do histórico
    CONSTRAINT tx_idempotency UNIQUE (created_by, idempotency_key)
  );
  CREATE INDEX IF NOT EXISTS tx_from ON transactions(from_account, created_at);
  CREATE INDEX IF NOT EXISTS tx_to   ON transactions(to_account, created_at);

  CREATE TABLE IF NOT EXISTS entries (
    id             INTEGER PRIMARY KEY,
    tx_id          TEXT NOT NULL REFERENCES transactions(id),
    account_id     INTEGER NOT NULL REFERENCES accounts(id),
    amount         INTEGER NOT NULL,               -- positivo = crédito, negativo = débito
    balance_after  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS entries_acc ON entries(account_id);

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash  TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    expires_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS money_requests (
    id            INTEGER PRIMARY KEY,
    requester_id  INTEGER NOT NULL REFERENCES users(id),
    payer_id      INTEGER NOT NULL REFERENCES users(id),
    amount        INTEGER NOT NULL CHECK (amount > 0),
    currency      TEXT NOT NULL,                  -- moeda em que o requerente quer receber
    note          TEXT,
    status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','declined','cancelled')),
    tx_id         TEXT REFERENCES transactions(id),
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS cashout_codes (
    id             INTEGER PRIMARY KEY,
    user_id        INTEGER NOT NULL REFERENCES users(id),
    amount         INTEGER NOT NULL CHECK (amount > 0),  -- dinheiro vivo a entregar
    currency       TEXT NOT NULL,                        -- moeda do dinheiro vivo
    from_currency  TEXT NOT NULL,                        -- carteira de onde sai
    code_hash      TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','used','cancelled')),
    attempts       INTEGER NOT NULL DEFAULT 0,
    expires_at     INTEGER NOT NULL,
    agent_id       INTEGER REFERENCES users(id),
    tx_id          TEXT REFERENCES transactions(id),
    created_at     INTEGER NOT NULL
  );

  -- Contas bancárias da EMPRESA, uma por moeda (ex.: EUR na CGD, STN no BISTP).
  CREATE TABLE IF NOT EXISTS company_bank_accounts (
    currency    TEXT PRIMARY KEY,
    bank_name   TEXT NOT NULL,
    holder      TEXT NOT NULL,
    iban        TEXT NOT NULL,
    swift       TEXT,
    updated_at  INTEGER NOT NULL
  );

  -- Carregamentos (deposit) e levantamentos (withdrawal) por transferência bancária.
  CREATE TABLE IF NOT EXISTS bank_requests (
    id              INTEGER PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id),
    kind            TEXT NOT NULL CHECK (kind IN ('deposit','withdrawal')),
    amount          INTEGER NOT NULL CHECK (amount > 0),
    currency        TEXT NOT NULL,
    fee             INTEGER NOT NULL DEFAULT 0,
    reference       TEXT NOT NULL UNIQUE,          -- o cliente escreve-a no descritivo da transferência
    iban            TEXT,                          -- levantamento: conta de destino do cliente
    holder          TEXT,
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','rejected','cancelled')),
    bank_reference  TEXT,                          -- referência do movimento no extrato do banco
    from_currency   TEXT,                          -- envio para IBAN com câmbio: moeda de origem (NULL = igual a currency)
    from_amount     INTEGER,                       -- valor que saiu da carteira (sem a taxa)
    beneficiary_phone TEXT,                        -- envio para outra pessoa: telefone dela (opcional)
    provider        TEXT,                          -- parceiro que faz o pagamento (NULL = manual)
    external_id     TEXT,                          -- identificador da ordem no parceiro
    provider_status TEXT,                          -- submitted / paid / failed
    note            TEXT,
    tx_id           TEXT REFERENCES transactions(id),
    final_tx_id     TEXT REFERENCES transactions(id),
    handled_by      INTEGER REFERENCES users(id),
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS bank_req_status ON bank_requests(status, kind);

  -- Como são pagos os levantamentos de cada moeda: 'manual' (o admin faz a
  -- transferência) ou um parceiro por API ('sandbox' = simulador de testes).
  CREATE TABLE IF NOT EXISTS payout_providers (
    currency    TEXT PRIMARY KEY,
    provider    TEXT NOT NULL,
    updated_at  INTEGER NOT NULL,
    updated_by  INTEGER
  );

  -- Cotações com câmbio garantido durante alguns segundos (usadas uma só vez).
  CREATE TABLE IF NOT EXISTS quotes (
    id          TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    kind        TEXT NOT NULL,                    -- transfer, exchange, cash_in, request, charge, payout
    qkey        TEXT NOT NULL,                    -- o que foi cotado (destinatário, moedas, valor…)
    data        TEXT NOT NULL,                    -- valores da cotação (JSON)
    expires_at  INTEGER NOT NULL,
    used_at     INTEGER,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS quotes_expires ON quotes(expires_at);

  -- Beneficiários bancários de cada cliente (privados: só quem os guardou os vê).
  CREATE TABLE IF NOT EXISTS beneficiaries (
    id          INTEGER PRIMARY KEY,
    owner_id    INTEGER NOT NULL REFERENCES users(id),
    name        TEXT NOT NULL,
    iban        TEXT NOT NULL,
    currency    TEXT NOT NULL,
    phone       TEXT,
    created_at  INTEGER NOT NULL,
    last_used   INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS beneficiaries_owner_iban ON beneficiaries(owner_id, iban);

  -- IBAN do próprio cliente (para levantar sem o escrever de cada vez).
  CREATE TABLE IF NOT EXISTS user_bank_accounts (
    user_id     INTEGER PRIMARY KEY REFERENCES users(id),
    iban        TEXT NOT NULL,
    holder      TEXT NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  -- Cobranças de lojas: a loja gera um QR, o cliente paga.
  CREATE TABLE IF NOT EXISTS charges (
    id           TEXT PRIMARY KEY,
    code         TEXT NOT NULL,                    -- código curto para escrever à mão (ex.: K7Q2P9)
    merchant_id  INTEGER NOT NULL REFERENCES users(id),
    amount       INTEGER NOT NULL CHECK (amount > 0),
    currency     TEXT NOT NULL,
    description  TEXT,
    status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','cancelled')),
    payer_id     INTEGER REFERENCES users(id),
    tx_id        TEXT REFERENCES transactions(id),
    expires_at   INTEGER NOT NULL,
    created_at   INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS charges_code ON charges(code);
  CREATE INDEX IF NOT EXISTS charges_merchant ON charges(merchant_id, created_at);

  -- Limite de liquidez por moeda: quanto o banco dessa moeda pode ficar a
  -- dever aos clientes (à espera de um acerto entre bancos). Sem linha = sem limite.
  CREATE TABLE IF NOT EXISTS liquidity_limits (
    currency       TEXT PRIMARY KEY,
    max_shortfall  INTEGER NOT NULL CHECK (max_shortfall >= 0),
    updated_at     INTEGER NOT NULL,
    updated_by     INTEGER
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id       INTEGER PRIMARY KEY,
    user_id  INTEGER,
    action   TEXT NOT NULL,
    detail   TEXT,
    ip       TEXT,
    at       INTEGER NOT NULL
  );
`;

const pgSchema = () => SCHEMA
  .replace(/INTEGER PRIMARY KEY/g, 'BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY')
  .replace(/\bINTEGER\b/g, 'BIGINT')
  .replace(/\bREAL\b/g, 'DOUBLE PRECISION');

// "?" → "$1, $2, …" (o nosso SQL nunca tem "?" dentro de texto).
function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// ---------- SQLite ----------
function openSqlite(file) {
  const { DatabaseSync } = require('node:sqlite');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

  // O SQLite tem uma única ligação. Como o código é assíncrono, um pedido
  // podia "entrar" na transação de outro entre dois await. Este cadeado
  // garante que, enquanto uma transação corre, mais nada usa a ligação.
  const als = new AsyncLocalStorage();
  let lock = Promise.resolve();
  const exclusive = (fn) => {
    const run = lock.then(fn);
    lock = run.catch(() => {});
    return run;
  };
  const exec = (fn) => (als.getStore() ? Promise.resolve().then(fn) : exclusive(fn));
  const strip = (sql) => sql.replace(/\s+FOR UPDATE\b/gi, '');

  return {
    dialect: 'sqlite',
    get: (sql, ...p) => exec(() => raw.prepare(strip(sql)).get(...p) ?? null),
    all: (sql, ...p) => exec(() => raw.prepare(strip(sql)).all(...p)),
    run: (sql, ...p) => exec(() => raw.prepare(strip(sql)).run(...p)),
    execRaw: (sql) => exec(() => raw.exec(sql)),
    tx: (fn) => {
      if (als.getStore()) return fn(); // já dentro de uma transação
      return exclusive(async () => {
        raw.exec('BEGIN IMMEDIATE');
        try {
          const out = await als.run(true, fn);
          raw.exec('COMMIT');
          return out;
        } catch (err) {
          raw.exec('ROLLBACK');
          throw err;
        }
      });
    },
    close: async () => raw.close(),
  };
}

// ---------- PostgreSQL ----------
function openPostgres(url) {
  const pg = require('pg');
  // BIGINT e NUMERIC (ex.: SUM) chegam como texto: convertemos para número.
  // Os valores cabem com folga em Number (até 9 000 biliões de cêntimos).
  pg.types.setTypeParser(20, (v) => Number(v));
  pg.types.setTypeParser(1700, (v) => Number(v));
  const needsSsl = !/localhost|127\.0\.0\.1/.test(url) && !/sslmode=disable/.test(url);
  const pool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.DB_POOL_MAX) || 5,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
    idleTimeoutMillis: 30_000,
  });
  pool.on('error', (err) => console.error('Erro na ligação à base de dados:', err.message));

  // Dentro de uma transação, todas as consultas usam a MESMA ligação.
  const als = new AsyncLocalStorage();
  const query = async (sql, params) => (als.getStore() || pool).query(toPg(sql), params);

  return {
    dialect: 'postgres',
    get: async (sql, ...p) => (await query(sql, p)).rows[0] ?? null,
    all: async (sql, ...p) => (await query(sql, p)).rows,
    run: async (sql, ...p) => { const r = await query(sql, p); return { changes: r.rowCount }; },
    execRaw: async (sql) => { await (als.getStore() || pool).query(sql); },
    tx: async (fn) => {
      if (als.getStore()) return fn();
      // Em caso de impasse (deadlock) entre dois pedidos, o PostgreSQL
      // cancela um deles; tentamos de novo até 3 vezes.
      for (let attempt = 1; ; attempt++) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const out = await als.run(client, fn);
          await client.query('COMMIT');
          return out;
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          if (['40P01', '40001'].includes(err.code) && attempt < 3) continue;
          throw err;
        } finally {
          client.release();
        }
      }
    },
    close: () => pool.end(),
  };
}

// Atualizações de esquema para bases de dados que já existem (com clientes).
// Cada passo corre uma única vez e não apaga nada.
const MIGRATIONS = {
  4: {
    postgres: `
      ALTER TABLE users ADD COLUMN IF NOT EXISTS merchant_name TEXT;
      ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_kind_check;
      ALTER TABLE accounts ADD CONSTRAINT accounts_kind_check
        CHECK (kind IN ('wallet','system_float','fees','fx','payout'));
      ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
      ALTER TABLE transactions ADD CONSTRAINT transactions_type_check
        CHECK (type IN ('p2p','request','cash_in','cash_out','issue','exchange','bank_in','bank_out','merchant','settlement','refund'));
    `,
    // No SQLite não dá para alterar CHECK sem reconstruir tabelas; como o
    // SQLite só é usado no computador (dados de teste), pede-se para apagar.
    sqlite: null,
  },
  5: {
    postgres: `
      ALTER TABLE bank_requests ADD COLUMN IF NOT EXISTS from_currency TEXT;
      ALTER TABLE bank_requests ADD COLUMN IF NOT EXISTS from_amount BIGINT;
      ALTER TABLE bank_requests ADD COLUMN IF NOT EXISTS beneficiary_phone TEXT;
      ALTER TABLE bank_requests ADD COLUMN IF NOT EXISTS provider TEXT;
      ALTER TABLE bank_requests ADD COLUMN IF NOT EXISTS external_id TEXT;
      ALTER TABLE bank_requests ADD COLUMN IF NOT EXISTS provider_status TEXT;
    `,
    sqlite: `
      ALTER TABLE bank_requests ADD COLUMN from_currency TEXT;
      ALTER TABLE bank_requests ADD COLUMN from_amount INTEGER;
      ALTER TABLE bank_requests ADD COLUMN beneficiary_phone TEXT;
      ALTER TABLE bank_requests ADD COLUMN provider TEXT;
      ALTER TABLE bank_requests ADD COLUMN external_id TEXT;
      ALTER TABLE bank_requests ADD COLUMN provider_status TEXT;
    `,
  },
};

async function openDb({ url, file } = {}) {
  const db = url ? openPostgres(url) : openSqlite(file || ':memory:');
  const tableExists = (name) => (db.dialect === 'sqlite'
    ? db.get('SELECT 1 AS x FROM sqlite_master WHERE name = ?', name)
    : db.get('SELECT 1 AS x FROM information_schema.tables WHERE table_name = ?', name));
  const hasUsers = await tableExists('users');
  const hasMeta = await tableExists('schema_meta');
  if (hasUsers && !hasMeta) {
    throw new Error('A base de dados é de uma versão antiga. Como ainda não há clientes reais, apague-a e arranque de novo.');
  }
  const current = hasMeta ? Number((await db.get("SELECT value FROM schema_meta WHERE key = 'version'"))?.value || 0) : 0;
  if (current > SCHEMA_VERSION) throw new Error(`A base de dados é de uma versão mais recente (${current}) do que esta app (${SCHEMA_VERSION}). Atualize a app.`);

  await db.tx(async () => {
    if (db.dialect === 'postgres') {
      // Impede que dois servidores criem ou atualizem as tabelas ao mesmo tempo.
      await db.execRaw('SELECT pg_advisory_xact_lock(239239)');
      await db.execRaw(pgSchema());
    } else {
      await db.execRaw(SCHEMA);
    }
    if (hasUsers) {
      for (let v = current + 1; v <= SCHEMA_VERSION; v++) {
        const step = MIGRATIONS[v] && MIGRATIONS[v][db.dialect];
        if (step === null) {
          throw new Error(`A base de dados local (SQLite) é da versão ${current}. Apague o ficheiro (ex.: data/dobrapay.db) e arranque de novo: os dados locais são só de teste.`);
        }
        if (step) await db.execRaw(step);
        console.log(`Base de dados atualizada para a versão ${v}.`);
      }
    }
    // Índices que dependem de colunas acrescentadas por atualizações (depois de as aplicar).
    await db.execRaw('CREATE INDEX IF NOT EXISTS bank_req_external ON bank_requests(provider, external_id)');
    await db.run('INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', 'version', String(SCHEMA_VERSION));
    // Contas internas da empresa e câmbio inicial (uma única vez por moeda).
    for (const [cur, info] of Object.entries(CURRENCIES)) {
      for (const kind of ['system_float', 'fees', 'fx', 'payout']) {
        await db.run('INSERT INTO accounts (kind, currency, balance) VALUES (?, ?, 0) ON CONFLICT DO NOTHING', kind, cur);
      }
      await db.run('INSERT INTO fx_rates (currency, per_eur, updated_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', cur, info.perEur, Date.now());
    }
  });
  return db;
}

// Erros da BD que significam "dado repetido" ou "saldo ficaria negativo".
const isUniqueViolation = (err) => err && (err.code === '23505' || /UNIQUE constraint failed/.test(err.message || ''));
const isCheckViolation = (err) => err && (err.code === '23514' || /CHECK constraint failed/.test(err.message || ''));

module.exports = { openDb, isUniqueViolation, isCheckViolation };
