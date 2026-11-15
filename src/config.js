// Regras de negócio num só sítio.
// Todos os valores são guardados em CÊNTIMOS (unidades / 100) da respetiva moeda.
// Os limites e as taxas mínimas/máximas são definidos em EUROS e convertidos.
const EUR = 100; // 1 euro = 100 cêntimos

module.exports = {
  APP_NAME: process.env.APP_NAME || 'Dobraplay',

  // Países onde a app funciona. "pattern" valida o número nacional (sem indicativo).
  COUNTRIES: {
    ST: { name: 'São Tomé e Príncipe', dial: '239', currency: 'STN', flag: '🇸🇹', pattern: /^[29]\d{6}$/, example: '991 2345' },
    AO: { name: 'Angola', dial: '244', currency: 'AOA', flag: '🇦🇴', pattern: /^9\d{8}$/, example: '923 456 789' },
    CV: { name: 'Cabo Verde', dial: '238', currency: 'CVE', flag: '🇨🇻', pattern: /^[2359]\d{6}$/, example: '991 2345' },
    PT: { name: 'Portugal', dial: '351', currency: 'EUR', flag: '🇵🇹', pattern: /^9[1236]\d{7}$/, example: '912 345 678' },
    ES: { name: 'Espanha', dial: '34', currency: 'EUR', flag: '🇪🇸', pattern: /^[67]\d{8}$/, example: '612 345 678' },
  },

  // Moedas suportadas e câmbio inicial (quantas unidades valem 1 EURO).
  // STN e CVE têm paridade fixa com o euro. AOA e USD flutuam: o
  // administrador atualiza-os no painel (ficam guardados na base de dados).
  CURRENCIES: {
    EUR: { name: 'Euro', symbol: '€', perEur: 1, fixed: true },
    STN: { name: 'Dobra', symbol: 'Db', perEur: 24.5, fixed: true },
    CVE: { name: 'Escudo cabo-verdiano', symbol: 'CVE', perEur: 110.265, fixed: true },
    AOA: { name: 'Kwanza', symbol: 'Kz', perEur: 1060, fixed: false },
    USD: { name: 'Dólar americano', symbol: 'US$', perEur: 1.16, fixed: false },
  },

  // Margem de câmbio aplicada quando há conversão de moeda (receita da empresa).
  FX_SPREAD: 0.01, // 1%

  // Limites por nível de verificação (em cêntimos de EURO, equivalentes).
  // Ajuste conforme as regras dos bancos centrais (BCSTP, BNA, BCV, BdP/BdE).
  LIMITS: {
    1: { perTx: 400 * EUR, daily: 1_000 * EUR, maxBalance: 2_000 * EUR },   // só telefone
    2: { perTx: 2_000 * EUR, daily: 6_000 * EUR, maxBalance: 12_000 * EUR }, // com BI/passaporte verificado
  },
  // Agentes e administradores movimentam o float da rede, sem estes limites.
  AGENT_LIMITS: { perTx: 80_000 * EUR, daily: Infinity, maxBalance: Infinity },

  // Taxas (calculadas em euros e cobradas na moeda de origem).
  FEES: {
    domestic: () => 0,                                                          // mesmo país e mesma moeda: grátis
    international: (eur) => Math.min(Math.max(Math.round(eur * 0.01), 50), 20 * EUR), // 1% (mín. 0,50 €, máx. 20 €)
    cashOut: (eur) => Math.min(Math.max(Math.round(eur * 0.01), 20), 8 * EUR),        // 1% (mín. 0,20 €, máx. 8 €)
    exchange: () => 0,                                                          // trocar entre as próprias carteiras: só a margem de câmbio
  },

  MIN_AMOUNT: 1, // 1 cêntimo (valida-se também pelo mínimo em euros abaixo)
  MIN_AMOUNT_EUR: 10, // 0,10 €
  SESSION_DAYS: 30,
  PIN_MAX_FAILS: 5,
  PIN_LOCK_MINUTES: 15,
  CASHOUT_CODE_MINUTES: 30,
  CASHOUT_CODE_MAX_ATTEMPTS: 5,
};
