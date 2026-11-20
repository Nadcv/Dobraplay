// Entrar com Face ID / impressão digital (passkeys, norma WebAuthn).
// A chave privada nunca sai do telemóvel; o servidor só guarda a chave
// pública. Serve para ENTRAR sem escrever o PIN; enviar dinheiro continua a
// pedir o PIN (segunda proteção).
const crypto = require('crypto');
const {
  generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const { isoBase64URL, isoUint8Array } = require('@simplewebauthn/server/helpers');
const { ApiError, cleanText } = require('../util');

module.exports = function passkeys(kit) {
  const { db, C, now, audit } = kit;
  const rp = (origin) => ({ origin, rpID: new URL(origin).hostname });

  async function saveChallenge(userId, challenge, purpose) {
    const id = crypto.randomUUID();
    await db.run('DELETE FROM webauthn_challenges WHERE expires_at < ?', now());
    await db.run('INSERT INTO webauthn_challenges (id, user_id, challenge, purpose, expires_at) VALUES (?, ?, ?, ?, ?)',
      id, userId ?? null, challenge, purpose, now() + 5 * 60000);
    return id;
  }
  async function takeChallenge(id, purpose, userId) {
    const c = await db.get('SELECT * FROM webauthn_challenges WHERE id = ?', String(id || ''));
    await db.run('DELETE FROM webauthn_challenges WHERE id = ?', String(id || ''));
    if (!c || c.purpose !== purpose || c.expires_at < now() || (userId != null && c.user_id !== userId)) {
      throw new ApiError(400, 'passkey_expired', 'O pedido expirou. Tente de novo.');
    }
    return c.challenge;
  }

  async function passkeyRegisterOptions(user, origin) {
    const existing = await db.all('SELECT id, transports FROM webauthn_credentials WHERE user_id = ?', user.id);
    const options = await generateRegistrationOptions({
      rpName: C.APP_NAME, rpID: rp(origin).rpID,
      userName: user.phone, userDisplayName: user.name,
      userID: isoUint8Array.fromUTF8String(`dobrapay-${user.id}`),
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports ? c.transports.split(',') : undefined })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    return { challenge_id: await saveChallenge(user.id, options.challenge, 'register'), options };
  }

  async function passkeyRegisterVerify(user, { challengeId, response, label }, origin, ip) {
    const expectedChallenge = await takeChallenge(challengeId, 'register', user.id);
    let v;
    try {
      v = await verifyRegistrationResponse({ response, expectedChallenge, expectedOrigin: rp(origin).origin, expectedRPID: rp(origin).rpID, requireUserVerification: true });
    } catch (err) { throw new ApiError(400, 'passkey_invalid', 'Não foi possível ativar: ' + err.message); }
    if (!v.verified) throw new ApiError(400, 'passkey_invalid', 'Não foi possível ativar o Face ID / impressão digital.');
    const cred = v.registrationInfo.credential;
    await db.run(`INSERT INTO webauthn_credentials (id, user_id, public_key, counter, transports, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT (id) DO NOTHING`, cred.id, user.id, isoBase64URL.fromBuffer(cred.publicKey), cred.counter,
    (cred.transports || []).join(','), cleanText(label, 40) || 'Este telemóvel', now());
    await audit(user.id, 'passkey_added', null, ip);
    return listPasskeys(user);
  }

  async function passkeyLoginOptions(origin) {
    const options = await generateAuthenticationOptions({ rpID: rp(origin).rpID, userVerification: 'required' });
    return { challenge_id: await saveChallenge(null, options.challenge, 'login'), options };
  }

  async function passkeyLogin({ challengeId, response }, origin, ip) {
    const expectedChallenge = await takeChallenge(challengeId, 'login');
    const cred = response && await db.get('SELECT * FROM webauthn_credentials WHERE id = ?', String(response.id || ''));
    if (!cred) throw new ApiError(401, 'passkey_unknown', 'Este Face ID / impressão digital não está ligado a nenhuma conta. Entre com o PIN.');
    const user = await kit.userById(cred.user_id);
    if (!user || user.status !== 'active') throw new ApiError(403, 'blocked', 'Conta bloqueada. Contacte o apoio ao cliente.');
    let v;
    try {
      v = await verifyAuthenticationResponse({
        response, expectedChallenge, expectedOrigin: rp(origin).origin, expectedRPID: rp(origin).rpID, requireUserVerification: true,
        credential: { id: cred.id, publicKey: isoBase64URL.toBuffer(cred.public_key), counter: cred.counter, transports: cred.transports ? cred.transports.split(',') : undefined },
      });
    } catch (err) { throw new ApiError(401, 'passkey_invalid', 'Não foi possível confirmar: ' + err.message); }
    if (!v.verified) throw new ApiError(401, 'passkey_invalid', 'Não foi possível confirmar a sua identidade.');
    await db.run('UPDATE webauthn_credentials SET counter = ?, last_used = ? WHERE id = ?', v.authenticationInfo.newCounter, now(), cred.id);
    await audit(user.id, 'login_passkey', null, ip);
    return kit.newSessionFor(user);
  }

  async function listPasskeys(user) {
    const rows = await db.all('SELECT id, label, created_at, last_used FROM webauthn_credentials WHERE user_id = ? ORDER BY created_at', user.id);
    return rows.map((r) => ({ id: r.id, label: r.label, created_at: r.created_at, last_used: r.last_used }));
  }
  async function deletePasskey(user, id) {
    await db.run('DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?', String(id), user.id);
    return listPasskeys(user);
  }

  return { passkeyRegisterOptions, passkeyRegisterVerify, passkeyLoginOptions, passkeyLogin, listPasskeys, deletePasskey };
};
