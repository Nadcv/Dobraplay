// Dobraplay — carteira móvel para São Tomé e Príncipe.
// Arranque: npm start   (variáveis: PORT, DB_FILE, ADMIN_PHONE, APP_NAME)
const path = require('path');
const { openDb } = require('./src/db');
const { createService } = require('./src/service');
const { createApp } = require('./src/app');

const dbFile = process.env.DB_FILE || path.join(__dirname, 'data', 'dobraplay.db');
const db = openDb(dbFile);
const service = createService(db, { adminPhone: process.env.ADMIN_PHONE });
const app = createApp(service);

const check = service.ledgerCheck();
if (!check.ok) console.error('⚠️  ATENÇÃO: o livro-razão não bate certo!', check);

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`✅ Dobraplay a correr em http://localhost:${port}  (base de dados: ${dbFile})`);
  if (!process.env.ADMIN_PHONE) console.log('ℹ️  Defina ADMIN_PHONE=+239XXXXXXX para escolher a conta de administrador.');
});
