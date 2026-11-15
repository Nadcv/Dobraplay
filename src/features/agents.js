// Mapa de agentes: cada agente indica onde está e o horário; os clientes
// veem os mais próximos (com ligação para o Google Maps). E um resumo das
// comissões do agente (pagas automaticamente em cada depósito/levantamento).
const { ApiError, cleanText } = require('../util');
const { COUNTRIES } = require('../config');

function distanceKm(a, b) {
  const R = 6371, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

module.exports = function agents(kit) {
  const { db, now, audit, requireRole } = kit;

  async function setAgentProfile(agent, { business, address, hours, lat, lng, cashAvailable }, ip) {
    requireRole(agent, 'agent', 'admin');
    const b = cleanText(business, 60), a = cleanText(address, 120);
    if (!b || !a) throw new ApiError(400, 'bad_profile', 'Indique o nome do estabelecimento e a morada.');
    const la = Number(lat), lo = Number(lng);
    if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) throw new ApiError(400, 'bad_location', 'Localização inválida. Carregue em "Usar a minha localização".');
    await db.run(`INSERT INTO agent_profiles (user_id, business, address, hours, lat, lng, cash_available, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT (user_id) DO UPDATE SET business = excluded.business, address = excluded.address, hours = excluded.hours,
                  lat = excluded.lat, lng = excluded.lng, cash_available = excluded.cash_available, updated_at = excluded.updated_at`,
    agent.id, b, a, cleanText(hours, 60), la, lo, cashAvailable === false ? 0 : 1, now());
    await audit(agent.id, 'agent_profile', null, ip);
    return myAgentProfile(agent);
  }

  async function myAgentProfile(agent) {
    const p = await db.get('SELECT * FROM agent_profiles WHERE user_id = ?', agent.id);
    return p ? { business: p.business, address: p.address, hours: p.hours, lat: p.lat, lng: p.lng, cash_available: !!p.cash_available } : null;
  }

  // Agentes ativos, do mais próximo para o mais longe (ou do país do cliente).
  async function nearbyAgents(user, { lat, lng, limit = 20 } = {}) {
    const rows = await db.all(`SELECT p.*, u.name, u.phone, u.country FROM agent_profiles p JOIN users u ON u.id = p.user_id
                               WHERE u.role = 'agent' AND u.status = 'active'`);
    const here = Number.isFinite(Number(lat)) && Number.isFinite(Number(lng)) && lat !== '' && lng !== '' ? { lat: Number(lat), lng: Number(lng) } : null;
    let list = rows.map((p) => ({
      name: p.business, agent: p.name, phone: p.phone, country: p.country, address: p.address, hours: p.hours,
      cash_available: !!p.cash_available, currency: COUNTRIES[p.country].currency, lat: p.lat, lng: p.lng,
      distance_km: here ? Math.round(distanceKm(here, p) * 10) / 10 : null,
      maps_url: `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`,
    }));
    list = here ? list.sort((a, b) => a.distance_km - b.distance_km) : list.filter((x) => x.country === user.country);
    return list.slice(0, Math.min(Number(limit) || 20, 50));
  }

  async function agentStats(agent) {
    requireRole(agent, 'agent', 'admin');
    const since = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1);
    const wallets = (await kit.walletsOf(agent.id)).map((w) => w.id);
    if (!wallets.length) return { commissions: [], cash_in: 0, cash_out: 0, since };
    const marks = wallets.map(() => '?').join(',');
    const commissions = await db.all(`SELECT currency, COALESCE(SUM(amount), 0) AS total, COUNT(*) AS n FROM transactions
                                      WHERE type = 'commission' AND to_account IN (${marks}) AND created_at >= ? GROUP BY currency`, ...wallets, since);
    const count = async (type, col) => (await db.get(`SELECT COUNT(*) AS n FROM transactions WHERE type = ? AND ${col} IN (${marks}) AND created_at >= ?`, type, ...wallets, since)).n;
    return { since, commissions: commissions.map((c) => ({ currency: c.currency, total: Number(c.total), count: Number(c.n) })),
      cash_in: await count('cash_in', 'from_account'), cash_out: await count('cash_out', 'to_account') };
  }

  return { setAgentProfile, myAgentProfile, nearbyAgents, agentStats };
};
module.exports.distanceKm = distanceKm;
