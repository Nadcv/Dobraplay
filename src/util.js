const crypto = require('crypto');

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const { COUNTRIES, CURRENCIES } = require('./config');

// Aceita números locais ("991 2345" — usa o país por omissão) ou internacionais
// ("+244 923 456 789", "00351912345678"). Devolve "+2399912345" ou null.
function normalizePhone(input, defaultCountry = 'ST') {
  if (typeof input !== 'string') return null;
  let s = input.replace(/[\s\-().]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (s.startsWith('+')) {
    const digits = s.slice(1);
    for (const c of Object.values(COUNTRIES)) {
      if (digits.startsWith(c.dial) && c.pattern.test(digits.slice(c.dial.length))) return '+' + digits;
    }
    return null;
  }
  const c = COUNTRIES[defaultCountry];
  if (!c) return null;
  if (c.pattern.test(s)) return '+' + c.dial + s;
  // Número escrito com o indicativo mas sem "+" (ex.: 2399912345).
  if (s.startsWith(c.dial) && c.pattern.test(s.slice(c.dial.length))) return '+' + s;
  return null;
}

function countryOfPhone(phone) {
  for (const [code, c] of Object.entries(COUNTRIES)) {
    if (phone.startsWith('+' + c.dial) && c.pattern.test(phone.slice(c.dial.length + 1))) return code;
  }
  return null;
}

// "150", "150.5", "150,50", "1 500,00" → cêntimos (inteiro). Recusa mais de 2 casas decimais.
function parseAmount(input) {
  if (typeof input === 'number') input = String(input);
  if (typeof input !== 'string') return null;
  const s = input.replace(/\s/g, '').replace(',', '.');
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(s)) return null;
  const [int, dec = ''] = s.split('.');
  const cents = Number(int) * 100 + Number(dec.padEnd(2, '0'));
  return cents > 0 && Number.isSafeInteger(cents) ? cents : null;
}

function formatAmount(cents, currency = 'STN') {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const int = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${sign}${int},${String(abs % 100).padStart(2, '0')} ${currency}`;
}

const isCurrency = (c) => typeof c === 'string' && Object.prototype.hasOwnProperty.call(CURRENCIES, c);

// PIN guardado com scrypt + sal aleatório (nunca em texto).
function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pin, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPin(pin, stored) {
  const [, saltHex, hashHex] = stored.split('$');
  const hash = crypto.scryptSync(pin, Buffer.from(saltHex, 'hex'), 32);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

const isValidPin = (pin) => typeof pin === 'string' && /^\d{4,6}$/.test(pin)
  && !/^(\d)\1+$/.test(pin) && !['1234', '12345', '123456', '4321', '0123'].includes(pin);

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function cleanText(s, max) {
  if (s == null) return null;
  const t = String(s).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
  return t || null;
}

module.exports = { ApiError, normalizePhone, countryOfPhone, parseAmount, formatAmount, isCurrency, hashPin, verifyPin, isValidPin, sha256, cleanText };
