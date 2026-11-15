// DobraPay — carteira móvel multimoeda.
// Arranque: npm start
// Variáveis: PORT, DATABASE_URL (PostgreSQL, obrigatório em produção),
//            DB_FILE (SQLite, só no computador), ADMIN_PHONE, APP_NAME
const path = require('path');
const { openDb } = require('./src/db');
const { createService } = require('./src/service');
const { createApp } = require('./src/app');

async function main() {
  const url = process.env.DATABASE_URL;
  const file = process.env.DB_FILE || path.join(__dirname, 'data', 'dobrapay.db');
  if (!url && !process.env.DB_FILE && process.env.NODE_ENV === 'production') {
    // Em produção os alojamentos grátis apagam o disco: sem PostgreSQL perdia-se o dinheiro dos clientes.
    throw new Error('Falta DATABASE_URL. Em produção a DobraPay tem de usar PostgreSQL (ex.: Neon grátis). Ver README.');
  }
  const db = await openDb({ url, file });
  const service = createService(db, { adminPhone: process.env.ADMIN_PHONE, sandboxDelayMs: Number(process.env.PAYOUT_SANDBOX_DELAY_MS) || 5000 });
  const app = createApp(service);

  const check = await service.ledgerCheck();
  if (!check.ok) console.error('⚠️  ATENÇÃO: o livro-razão não bate certo!', check);

  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    console.log(`✅ DobraPay a correr em http://localhost:${port}  (base de dados: ${url ? 'PostgreSQL' : file})`);
    if (!process.env.ADMIN_PHONE) console.log('ℹ️  Defina ADMIN_PHONE=+239XXXXXXX para escolher a conta de administrador.');
  });
}

main().catch((err) => { console.error('❌', err.message); process.exit(1); });
