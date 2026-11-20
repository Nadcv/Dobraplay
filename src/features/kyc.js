// Verificação de identidade (nível 2): o cliente envia o documento e uma
// selfie; o admin compara e aprova. Aprovado = nível 2 = limites maiores.
// As fotos são reduzidas no telemóvel (JPEG ~1000 px) antes de serem enviadas.
const { ApiError, cleanText } = require('../util');

const DOC_TYPES = { bi: 'Bilhete de identidade', passaporte: 'Passaporte', residencia: 'Autorização de residência', cartao_cidadao: 'Cartão de cidadão' };
const MAX_IMAGE = 700_000; // ~500 KB de imagem em base64

function checkImage(img, what) {
  if (typeof img !== 'string' || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(img)) {
    throw new ApiError(400, 'bad_image', `A foto ${what} é inválida. Tire a foto de novo.`);
  }
  if (img.length > MAX_IMAGE) throw new ApiError(413, 'image_too_big', `A foto ${what} é demasiado grande.`);
  return img;
}

module.exports = function kyc(kit) {
  const { db, requireRole, audit, now } = kit;
  const notify = (...a) => (kit.notify ? kit.notify(...a) : null);

  const view = (r, { images = false } = {}) => ({
    id: r.id, status: r.status, full_name: r.full_name, doc_type: r.doc_type, doc_type_label: DOC_TYPES[r.doc_type] || r.doc_type,
    doc_number: r.doc_number, birth_date: r.birth_date, note: r.note, created_at: r.created_at, updated_at: r.updated_at,
    ...(images ? { doc_image: r.doc_image, selfie_image: r.selfie_image } : {}),
  });

  async function submitKyc(user, { fullName, docType, docNumber, birthDate, docImage, selfieImage }, ip) {
    if (user.tier >= 2) throw new ApiError(409, 'already_verified', 'A sua identidade já está verificada.');
    if (await db.get("SELECT 1 AS x FROM kyc_requests WHERE user_id = ? AND status = 'pending'", user.id)) {
      throw new ApiError(409, 'kyc_pending', 'Já tem um pedido em análise. Aguarde a resposta.');
    }
    const name = cleanText(fullName, 80);
    if (!name || name.split(' ').length < 2) throw new ApiError(400, 'bad_name', 'Escreva o nome completo, como está no documento.');
    if (!DOC_TYPES[docType]) throw new ApiError(400, 'bad_doc', 'Escolha o tipo de documento.');
    const number = cleanText(docNumber, 30);
    if (!number || number.length < 5) throw new ApiError(400, 'bad_doc_number', 'Número do documento inválido.');
    const birth = String(birthDate || '');
    const age = (now() - Date.parse(birth)) / (365.25 * 86_400_000);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birth) || !(age >= 18 && age < 120)) throw new ApiError(400, 'bad_birth', 'Data de nascimento inválida (tem de ter 18 anos ou mais).');
    const { id } = await db.get(`INSERT INTO kyc_requests (user_id, full_name, doc_type, doc_number, birth_date, doc_image, selfie_image, created_at, updated_at)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`, user.id, name, docType, number, birth,
    checkImage(docImage, 'do documento'), checkImage(selfieImage, 'da selfie'), now(), now());
    await audit(user.id, 'kyc_submitted', { id, docType }, ip);
    return view(await db.get('SELECT * FROM kyc_requests WHERE id = ?', id));
  }

  async function myKyc(user) {
    const r = await db.get('SELECT * FROM kyc_requests WHERE user_id = ? ORDER BY id DESC LIMIT 1', user.id);
    return { tier: user.tier, request: r ? view(r) : null };
  }

  async function adminListKyc(admin, { status = 'pending' } = {}) {
    requireRole(admin, 'admin');
    const rows = await db.all('SELECT * FROM kyc_requests WHERE status = ? ORDER BY created_at ASC LIMIT 50', status);
    return Promise.all(rows.map(async (r) => {
      const u = await kit.userById(r.user_id);
      return { ...view(r, { images: true }), user: { id: u.id, name: u.name, phone: u.phone, country: u.country } };
    }));
  }

  async function reviewKyc(admin, id, { approve, note, pin }, ip) {
    requireRole(admin, 'admin');
    const why = cleanText(note, 140);
    if (!approve && !why) throw new ApiError(400, 'bad_reason', 'Indique o motivo da recusa (o cliente vai vê-lo).');
    await kit.checkPin(admin, pin, ip);
    const r = await db.tx(async () => {
      const row = await db.get('SELECT * FROM kyc_requests WHERE id = ? FOR UPDATE', Number(id) || 0);
      if (!row) throw new ApiError(404, 'not_found', 'Pedido não encontrado.');
      if (row.status !== 'pending') throw new ApiError(409, 'not_pending', 'Este pedido já foi tratado.');
      await db.run('UPDATE kyc_requests SET status = ?, note = ?, reviewed_by = ?, updated_at = ? WHERE id = ?',
        approve ? 'approved' : 'rejected', why, admin.id, now(), row.id);
      if (approve) await db.run('UPDATE users SET tier = 2 WHERE id = ? AND tier < 2', row.user_id);
      return row;
    });
    await audit(admin.id, approve ? 'kyc_approved' : 'kyc_rejected', { id: r.id, user: r.user_id, why }, ip);
    await notify(r.user_id, approve
      ? { title: '✅ Identidade verificada', body: 'A sua conta passou ao nível 2: limites maiores.' }
      : { title: 'Verificação de identidade', body: `Não foi aprovada: ${why}. Pode enviar de novo.` });
    return view(await db.get('SELECT * FROM kyc_requests WHERE id = ?', r.id));
  }

  return { submitKyc, myKyc, adminListKyc, reviewKyc, KYC_DOC_TYPES: DOC_TYPES };
};
