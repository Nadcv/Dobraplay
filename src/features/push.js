// Notificações push (Web Push). Funcionam no Android e no iPhone (com a app
// instalada no ecrã principal, iOS 16.4+). As chaves VAPID são geradas no
// primeiro uso e guardadas na base de dados (ou vêm de VAPID_PUBLIC_KEY /
// VAPID_PRIVATE_KEY), por isso não é preciso configurar nada.
const webpush = require('web-push');
const { ApiError, cleanText } = require('../util');

module.exports = function push(kit) {
  const { db, fmt, events, afterCommitHooks, env } = kit;
  let vapid = null;

  async function keys() {
    if (vapid) return vapid;
    if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
      vapid = { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
    } else {
      const get = async (k) => (await db.get('SELECT value FROM schema_meta WHERE key = ?', k))?.value;
      let pub = await get('vapid_public'), priv = await get('vapid_private');
      if (!pub || !priv) {
        const k = webpush.generateVAPIDKeys();
        await db.run('INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT DO NOTHING', 'vapid_public', k.publicKey);
        await db.run('INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT DO NOTHING', 'vapid_private', k.privateKey);
        pub = await get('vapid_public'); priv = await get('vapid_private'); // outro servidor pode ter ganho a corrida
      }
      vapid = { publicKey: pub, privateKey: priv };
    }
    return vapid;
  }

  // Quem envia: nos testes é substituído por um falso; em produção usa web-push.
  const sender = kit.pushSender || (async (sub, payload) => {
    const k = await keys();
    return webpush.sendNotification(sub, payload, {
      vapidDetails: { subject: env.VAPID_SUBJECT || 'mailto:apoio@dobrapay.app', publicKey: k.publicKey, privateKey: k.privateKey },
      TTL: 24 * 3600,
    });
  });

  async function notify(userId, { title, body, url = '/' }) {
    const subs = await db.all('SELECT * FROM push_subscriptions WHERE user_id = ?', userId);
    const payload = JSON.stringify({ title, body, url });
    await Promise.all(subs.map(async (s) => {
      try {
        await sender({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, userId);
      } catch (err) {
        // Subscrição expirada ou removida no telemóvel: apaga-se.
        if ([404, 410].includes(err.statusCode)) await db.run('DELETE FROM push_subscriptions WHERE endpoint = ?', s.endpoint);
        else console.error('Falha ao enviar notificação:', err.message);
      }
    }));
  }
  kit.notify = notify;

  // Depois de cada operação: avisa quem recebeu dinheiro.
  afterCommitHooks.push(async (txId) => {
    const t = await db.get('SELECT * FROM transactions WHERE id = ?', txId);
    if (!t) return;
    const to = await kit.accountById(t.to_account);
    const from = await kit.accountById(t.from_account);
    const sender_ = from.user_id ? await kit.userById(from.user_id) : null;
    const who = sender_ ? (sender_.merchant_name || sender_.name) : null;
    const amount = fmt(t.to_amount, t.to_currency);
    if (t.type === 'bank_out' && to.kind === 'system_float') {
      const r = await db.get('SELECT * FROM bank_requests WHERE final_tx_id = ?', txId);
      if (r) return notify(r.user_id, { title: '🏦 Transferência concluída', body: `${fmt(r.amount, r.currency)} chegaram a ${r.holder} (${r.reference}).` });
      return;
    }
    if (!to.user_id || from.user_id === to.user_id) return;
    const msg = {
      p2p: ['💸 Recebeu dinheiro', `${amount} de ${who}${t.note ? ' · ' + t.note : ''}`],
      request: ['✅ Pedido pago', `${who} pagou ${amount}`],
      merchant: ['🛒 Pagamento recebido', `${amount} de ${who}`],
      cash_in: ['⬇ Depósito na carteira', `${amount} depositados`],
      bank_in: ['🏦 Transferência recebida', `${amount} entraram na sua carteira`],
      card_in: ['💳 Carregamento com cartão', `${amount} entraram na sua carteira`],
      refund: ['↩ Devolução', `${amount} voltaram à sua carteira${t.note ? ' · ' + t.note : ''}`],
      commission: ['💰 Comissão', `Recebeu ${amount} de comissão`],
      issue: ['🏦 Float recebido', `${amount} de float na carteira de agente`],
    }[t.type];
    if (msg) await notify(to.user_id, { title: msg[0], body: msg[1] });
  });

  events.on('request_created', ({ requester, payer, amount, currency, note }) => {
    notify(payer.id, { title: '✋ Pedido de dinheiro', body: `${requester.name} pede ${fmt(amount, currency)}${note ? ' · ' + note : ''}` })
      .catch((err) => console.error(err.message));
  });

  return {
    async pushPublicKey() { return { publicKey: (await keys()).publicKey }; },
    async pushSubscribe(user, sub) {
      const endpoint = sub && typeof sub.endpoint === 'string' ? sub.endpoint : '';
      const k = (sub && sub.keys) || {};
      if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000 || typeof k.p256dh !== 'string' || typeof k.auth !== 'string') {
        throw new ApiError(400, 'bad_subscription', 'Subscrição inválida.');
      }
      await db.run(`INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
      endpoint, user.id, cleanText(k.p256dh, 200), cleanText(k.auth, 100), Date.now());
      return { ok: true };
    },
    async pushUnsubscribe(user, endpoint) {
      await db.run('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', String(endpoint || ''), user.id);
      return { ok: true };
    },
    async pushTest(user) {
      await notify(user.id, { title: 'DobraPay', body: 'As notificações estão a funcionar ✓' });
      return { ok: true };
    },
  };
};
