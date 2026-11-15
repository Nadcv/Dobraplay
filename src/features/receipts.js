// Comprovativos: detalhes de um movimento para o recibo (a imagem é desenhada
// no telemóvel). Só quem participou no movimento o pode ver.
const { ApiError } = require('../util');

module.exports = function receipts(kit) {
  const { db } = kit;
  async function transactionDetail(user, id) {
    const t = await db.get('SELECT * FROM transactions WHERE id = ?', String(id));
    if (!t) throw new ApiError(404, 'not_found', 'Movimento não encontrado.');
    const mine = (await kit.walletsOf(user.id)).map((w) => w.id);
    if (!mine.includes(t.from_account) && !mine.includes(t.to_account)) throw new ApiError(404, 'not_found', 'Movimento não encontrado.');
    const v = await kit.txView(t.id, user);
    const bank = await db.get('SELECT reference, iban, holder, status FROM bank_requests WHERE tx_id = ?', t.id);
    const bill = await db.get('SELECT biller, account_ref, token, status FROM bill_payments WHERE tx_id = ?', t.id);
    return { ...v, bank: bank || null, bill: bill || null };
  }
  return { transactionDetail };
};
