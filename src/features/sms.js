// Envio de SMS (códigos de verificação). Fornecedores:
//  - sandbox: não envia nada; o código aparece no ecrã com o aviso "modo de
//             teste" (para experimentar sem contrato com uma operadora);
//  - http:    modelo para um fornecedor real (Twilio, Vonage, CST, Unitel…).
//             Ativa-se com SMS_HTTP_URL (+ SMS_HTTP_TOKEN). Envia por POST
//             { to, message } e espera 2xx.
// Escolhe-se com SMS_PROVIDER (por omissão: http se houver SMS_HTTP_URL, senão sandbox).
function createSmsSender(env = process.env) {
  const name = env.SMS_PROVIDER || (env.SMS_HTTP_URL ? 'http' : 'sandbox');
  if (name === 'http') {
    if (!env.SMS_HTTP_URL) throw new Error('SMS_PROVIDER=http precisa de SMS_HTTP_URL');
    return {
      name,
      sandbox: false,
      async send(to, message) {
        const res = await fetch(env.SMS_HTTP_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(env.SMS_HTTP_TOKEN ? { authorization: 'Bearer ' + env.SMS_HTTP_TOKEN } : {}) },
          body: JSON.stringify({ to, message }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new Error(`fornecedor de SMS respondeu ${res.status}`);
      },
    };
  }
  return { name: 'sandbox', sandbox: true, async send() { /* não envia: o código vai na resposta, em modo de teste */ } };
}

module.exports = { createSmsSender };
