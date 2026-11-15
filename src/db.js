// Base de dados SQLite (módulo nativo do Node 22 — sem dependências).
// Todo o dinheiro é guardado em CÊNTIMOS (inteiros) para nunca haver erros
// de arredondamento: 150,50 STN = 15050.
//
// Contabilidade de dupla entrada, separada POR MOEDA: em cada moeda, os
// lançamentos (entries) de uma transação somam ZERO. Contas internas por moeda:
//  - system_float: o dinheiro real no banco (fica negativa à medida que se
//    emite dinheiro eletrónico);
//  - fees: taxas cobradas;
//  - fx: a "mesa de câmbio". Numa conversão STN→EUR, a mesa recebe as Dobras e
//    paga os Euros, por isso cada moeda continua a somar zero.
// Logo, em cada moeda, a soma de todos os saldos é sempre 0 — ver ledgerCheck().
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { CURRENCIES } = require('./config');

const SCHEMA_VERSION = 2; // 2 = vários países e moedas

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  const version = db.prepare('PRAGMA user_version').get().user_version;
  const hasTables = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'users'").get();
  if (hasTables && version < SCHEMA_VERSION) {
    throw new Error(`A base de dados ${file} é de uma versão antiga (só Dobras). Como ainda não há clientes reais, apague-a e arranque de novo.`);
  }
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

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
      created_at        INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id        INTEGER PRIMARY KEY,
      user_id   INTEGER REFERENCES users(id),
      kind      TEXT NOT NULL CHECK (kind IN ('wallet','system_float','fees','fx')),
      currency  TEXT NOT NULL,
      balance   INTEGER NOT NULL DEFAULT 0,
      -- Carteiras nunca podem ficar negativas (proteção final na própria BD).
      CHECK (kind <> 'wallet' OR balance >= 0)
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
      type             TEXT NOT NULL CHECK (type IN ('p2p','request','cash_in','cash_out','issue','exchange')),
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
      UNIQUE (created_by, idempotency_key)
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

    CREATE TABLE IF NOT EXISTS audit_log (
      id       INTEGER PRIMARY KEY,
      user_id  INTEGER,
      action   TEXT NOT NULL,
      detail   TEXT,
      ip       TEXT,
      at       INTEGER NOT NULL
    );
  `);

  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);

  // Contas internas da empresa e câmbio inicial (criados uma única vez por moeda).
  for (const [cur, info] of Object.entries(CURRENCIES)) {
    for (const kind of ['system_float', 'fees', 'fx']) {
      db.prepare('INSERT OR IGNORE INTO accounts (kind, currency, balance) VALUES (?, ?, 0)').run(kind, cur);
    }
    db.prepare('INSERT OR IGNORE INTO fx_rates (currency, per_eur, updated_at) VALUES (?, ?, ?)').run(cur, info.perEur, Date.now());
  }
  return db;
}

// Executa fn() numa transação exclusiva: ou tudo é gravado, ou nada.
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { openDb, tx };
