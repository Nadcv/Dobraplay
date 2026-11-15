# DobraPay 🇸🇹 🇦🇴 🇨🇻 🇵🇹 🇪🇸

Carteira móvel para enviar, receber e pedir dinheiro entre **São Tomé e Príncipe, Angola, Cabo Verde, Portugal e Espanha**, com **conversão automática de moeda** e uma **rede de agentes** para depositar e levantar dinheiro vivo (modelo M-Pesa / remessas).

| País | Indicativo | Moeda |
|---|---|---|
| 🇸🇹 São Tomé e Príncipe | +239 | Dobra (STN) |
| 🇦🇴 Angola | +244 | Kwanza (AOA) |
| 🇨🇻 Cabo Verde | +238 | Escudo (CVE) |
| 🇵🇹 Portugal / 🇪🇸 Espanha | +351 / +34 | Euro (EUR) |
| Qualquer cliente | | Dólar (USD) como carteira extra |

## Exemplos

- **Depositar Dobras em São Tomé e a pessoa recebe Euros em Espanha.** O cliente entrega 2 474,50 STN ao agente (2 450 + taxa) e a pessoa em Madrid recebe 99,00 € na hora.
- **Enviar Euros de Portugal e receber Dobras ou Kwanzas.** A conversão é automática.
- **Cada pessoa escolhe em que moeda quer receber** (ex.: em USD), e pode ter várias carteiras e trocar entre elas (botão **Câmbio**).
- **Pedir dinheiro numa moeda**: quem paga usa a moeda dele e o pedido chega com o valor exato.
- **Levantar**: escolhe a moeda do dinheiro vivo e a carteira de onde sai. Só um agente que paga nessa moeda pode pagar o código.

Antes de cada confirmação, a app mostra **quanto paga, a taxa, o câmbio e quanto chega do outro lado**. Se o câmbio mudar entre a cotação e a confirmação, a operação é recusada em vez de enviar menos do que o cliente viu.

## O que já funciona

| Para quem | Funcionalidades |
|---|---|
| **Cliente** | Conta com número de qualquer dos 5 países e PIN · várias carteiras (STN, AOA, CVE, EUR, USD) · **enviar** para qualquer país (nome do destinatário visível antes de confirmar) · **receber** com QR code e escolher a moeda · **pedir** dinheiro · **câmbio** entre carteiras · **levantar** num agente com código de 6 dígitos · histórico · mudar PIN |
| **Agente** | **Depósito** para qualquer pessoa em qualquer país (o cliente paga em dinheiro vivo na moeda do agente) · **levantamento** com código |
| **Administrador** | Estatísticas por moeda · gerir utilizadores (agente, admin, bloquear) · **emitir float** na moeda do agente · **atualizar câmbios** (AOA e USD; STN e CVE têm paridade fixa com o euro) · verificação automática do livro-razão |

### Taxas e câmbio (ajustáveis em `src/config.js`)

| Operação | Custo |
|---|---|
| Enviar no mesmo país e na mesma moeda | **Grátis** |
| Enviar para outro país ou noutra moeda | 1% (mín. 0,50 €, máx. 20 €) + margem de câmbio de 1% |
| Câmbio entre as próprias carteiras | só a margem de 1% |
| Levantar num agente | 1% (mín. 0,20 €, máx. 8 €) |

Câmbios iniciais por 1 €: STN 24,5 (fixo) · CVE 110,265 (fixo) · **AOA 1060 · USD 1,16. Atualize estes dois no painel antes de usar**, porque flutuam todos os dias.

Limites (nível 1, equivalente em euros): 400 € por operação, 1 000 € por dia, saldo máximo 2 000 €.

## Como funciona o dinheiro

- **Contabilidade de dupla entrada por moeda**: em cada moeda, a soma de todos os saldos é sempre 0. Numa conversão STN→EUR, a "mesa de câmbio" da empresa recebe as Dobras e paga os Euros. O painel avisa se algo não bater certo.
- A **posição da mesa de câmbio** por moeda mostra quanto dinheiro tem de existir em cada banco/país. Na prática a empresa tem de **reequilibrar** periodicamente (ex.: transferir euros para o banco em São Tomé) com os parceiros bancários.
- Valores guardados em **cêntimos inteiros**, operações **atómicas**, pedidos repetidos por rede fraca **nunca pagam duas vezes**.
- PIN com `scrypt`, **bloqueio de 15 min** após 5 PINs errados, PIN pedido em cada operação.

## Correr no computador

Precisa do Node.js 22.13 ou superior.

```bash
git clone https://github.com/Nadcv/Dobraplay.git && cd Dobraplay
npm install
ADMIN_PHONE=9900000 npm start      # a conta com este número fica administradora
# abrir http://localhost:3000
npm test                            # 14 testes automáticos
```

Para experimentar: crie a conta admin (🇸🇹 9900000), uma conta de agente em São Tomé e clientes em vários países (ex.: 🇪🇸 612 345 678, 🇦🇴 923 456 789). No painel admin torne o agente "Agente", emita-lhe float e faça um depósito para um cliente noutro país.

| Variável | Para que serve |
|---|---|
| `PORT` | Porta (por omissão 3000) |
| `DB_FILE` | Ficheiro da base de dados (por omissão `data/dobrapay.db`) |
| `ADMIN_PHONE` | Número da conta administradora |
| `APP_NAME` | Nome da marca (por omissão DobraPay) |

## Publicar

`docker build -t dobrapay . && docker run -p 3000:3000 -v dobrapay-data:/data -e ADMIN_PHONE=9900000 dobrapay`

⚠️ Use um alojamento com **disco persistente** (Railway com volume, Fly.io, Render com disco pago, um VPS). No plano grátis do Render o disco apaga-se a cada deploy, e aqui isso seria perder o dinheiro dos clientes.

## Antes de lançar com dinheiro real

Este código é uma base técnica sólida, mas **para operar legalmente** ainda falta:

1. **Licenças em cada país**: moeda eletrónica e **remessas internacionais** dependem do Banco Central de cada país (BCSTP, BNA em Angola, BCV em Cabo Verde, Banco de Portugal, Banco de España, este último sob as regras europeias PSD2). O caminho mais rápido costuma ser **parcerias com bancos ou operadores de remessas já licenciados** em cada país. O dinheiro dos clientes tem de ficar em contas fiduciárias.
   - Angola tem controlo cambial: as remessas para fora e para dentro passam por regras do BNA.
2. **KYC e combate ao branqueamento de capitais**: verificação do BI para o nível 2, listas de sanções, alertas de operações suspeitas.
3. **Câmbios automáticos**: ligar o AOA e o USD a uma fonte oficial (BNA, BCE) em vez de os atualizar à mão.
4. **Verificação do número por SMS** no registo e, de preferência, **USSD** (`*xxx#`) para quem não tem smartphone.
5. **Base de dados de produção**: migrar o SQLite para PostgreSQL com cópias de segurança diárias se houver vários servidores.
6. Auditoria de segurança externa, termos de uso e política de privacidade, apoio ao cliente e processo de reclamações e estornos.

## Estrutura

```
server.js          arranque
src/config.js      limites, taxas, regras
src/db.js          esquema SQLite e transações
src/service.js     regras de negócio (contas, transferências, agentes, admin)
src/app.js         API HTTP + segurança (rate limit, cabeçalhos)
public/            app PWA (instalável no telemóvel)
tests/             testes automáticos
```
