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
| **Cliente** | Conta com número de qualquer dos 5 países e PIN · várias carteiras (STN, AOA, CVE, EUR, USD) · **enviar** para qualquer país (nome do destinatário visível antes de confirmar) · **receber** com QR code e escolher a moeda · **pedir** dinheiro · **câmbio** entre carteiras · **pagar em lojas** com QR ou código · **carregar e levantar por transferência bancária** (IBAN) · **enviar para o IBAN de quem não tem DobraPay** (beneficiários guardados) · **câmbio garantido 60 s** · **levantar** num agente com código de 6 dígitos · histórico · mudar PIN |
| **Loja** | Conta de loja (ativada pelo admin) · **cobrar com QR code** ou código de 6 letras · o cliente paga com qualquer moeda e a loja recebe o valor exato · histórico de cobranças |
| **Agente** | **Depósito** para qualquer pessoa em qualquer país (o cliente paga em dinheiro vivo na moeda do agente) · **levantamento** com código |
| **Administrador** | Estatísticas por moeda · gerir utilizadores (agente, admin, bloquear) · **emitir float** na moeda do agente · **atualizar câmbios** (AOA e USD; STN e CVE têm paridade fixa com o euro) · **contas bancárias da empresa** · **confirmar carregamentos e pagar levantamentos bancários** · **acerto entre bancos** (ex.: CGD ⇄ BISTP) · ativar contas de loja · verificação automática do livro-razão |

### Taxas e câmbio (ajustáveis em `src/config.js`)

| Operação | Custo |
|---|---|
| Enviar no mesmo país e na mesma moeda | **Grátis** |
| Enviar para outro país ou noutra moeda | 1% (mín. 0,50 €, máx. 20 €) + margem de câmbio de 1% |
| Câmbio entre as próprias carteiras | só a margem de 1% |
| Levantar num agente | 1% (mín. 0,20 €, máx. 8 €) |
| Carregar por transferência bancária | **Grátis** |
| Levantar para o banco (IBAN) | 1% (mín. 0,50 €, máx. 5 €) |
| Pagar numa loja | **Grátis** para o cliente (só a margem de câmbio, se pagar noutra moeda) |

Câmbios iniciais por 1 €: STN 24,5 (fixo) · CVE 110,265 (fixo) · **AOA 1060 · USD 1,16. Atualize estes dois no painel antes de usar**, porque flutuam todos os dias.

Limites (nível 1, equivalente em euros): 400 € por operação, 1 000 € por dia, saldo máximo 2 000 €.

## Como funciona o dinheiro

- **Contabilidade de dupla entrada por moeda**: em cada moeda, a soma de todos os saldos é sempre 0. Numa conversão STN→EUR, a "mesa de câmbio" da empresa recebe as Dobras e paga os Euros. O painel avisa se algo não bater certo.
- A **posição da mesa de câmbio** por moeda mostra quanto dinheiro tem de existir em cada banco/país. Na prática a empresa tem de **reequilibrar** periodicamente (ex.: transferir euros para o banco em São Tomé) com os parceiros bancários.
- Valores guardados em **cêntimos inteiros**, operações **atómicas**, pedidos repetidos por rede fraca **nunca pagam duas vezes**.
- PIN com `scrypt`, **bloqueio de 15 min** após 5 PINs errados, PIN pedido em cada operação.

## Transferências bancárias e acerto entre bancos

A empresa tem **uma conta bancária por moeda** (ex.: EUR na **Caixa Geral de Depósitos** em Portugal, STN no **BISTP** em São Tomé). O admin regista-as em **Acertos → Conta bancária da empresa**.

- **Carregar:** o cliente escolhe o valor e recebe o IBAN da empresa e uma **referência única** (ex.: `DPK7Q2P9`), que escreve no descritivo da transferência. Quando o dinheiro aparece no extrato, o admin confirma em **Banco** o valor recebido, e o saldo entra na carteira.
- **Levantar:** o cliente indica o seu IBAN (validado). O dinheiro **sai logo da carteira** e fica "por pagar". O admin faz a transferência no banco e marca-a como paga. Se recusar, ou se o cliente cancelar, o valor e a taxa voltam à carteira.
- **Acerto entre bancos:** os envios entre países compensam-se dentro da app, por isso o dinheiro não atravessa a fronteira em cada envio. O ecrã **Acertos** mostra, em cada moeda, se o banco tem o dinheiro dos clientes e **sugere a transferência** a fazer entre os bancos da empresa (ex.: BISTP → CGD). Depois de a fazer, o admin regista-a e as contas ficam certas.

### Limite de liquidez

As remessas vão sobretudo num sentido (ex.: de Portugal para São Tomé), por isso o banco de uma moeda pode ficar a dever aos clientes até ao próximo acerto. Em **Acertos → Limite de liquidez**, o admin define, para cada moeda, a **falta máxima permitida** (vazio = sem limite; 0 = só com dinheiro já no banco).

Se um envio **com câmbio** ultrapassar o limite, a app avisa o cliente **antes** de confirmar ("envios pausados…") e recusa a operação sem tocar no saldo. Envios na mesma moeda não são afetados. Depois de um acerto entre bancos, os envios voltam a passar automaticamente. A verificação bloqueia a mesa de câmbio dessa moeda, por isso vários envios ao mesmo tempo nunca ultrapassam o limite.

Como cobrir a falta sem pausar envios: agentes que compram float (trazem dinheiro para o banco local), uma reserva inicial da empresa, ou uma linha de crédito do banco parceiro. **Nunca** com o dinheiro de outros clientes.

## Carregar com cartão (Stripe)

Os clientes carregam a carteira com **Visa, Mastercard, Apple Pay ou Google Pay** através da **Stripe Checkout**:
1. Em **Carregar → Com cartão**, o cliente escolhe o valor (em euros) e vê a taxa (1,5% + 0,25 €, ajustável em `src/config.js → FEES.cardIn`).
2. É levado à **página segura da Stripe**. A DobraPay **nunca vê nem guarda o número do cartão**.
3. A Stripe confirma por **webhook assinado**, e o saldo entra na carteira **uma única vez**, mesmo que a Stripe repita a notificação. Se o webhook atrasar, a app confirma diretamente com a Stripe quando o cliente volta.
4. Se o titular contestar o pagamento (*chargeback*), abre-se um **alerta** no ecrã Alertas.

**Como ativar (modo de teste, grátis):**
1. Crie conta em https://stripe.com (fica em modo de teste até ativar a conta).
2. Em **Developers → API keys**, copie a **Secret key** (`sk_test_…`).
3. Em **Developers → Webhooks → Add endpoint**, use `https://SEU-ENDEREÇO/api/webhooks/stripe` com os eventos `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired` e `charge.dispute.created`. Copie o **Signing secret** (`whsec_…`).
4. No Render, em **Environment**, preencha `STRIPE_SECRET_KEY` e `STRIPE_WEBHOOK_SECRET`. A opção "Com cartão" aparece sozinha.
5. Para testar, use o cartão `4242 4242 4242 4242`, com qualquer data futura e qualquer código.

Para receber dinheiro real (`sk_live_…`), a Stripe pede uma **empresa registada** num país suportado (ex.: Portugal) e a verificação da conta.

## Segurança e conformidade

- **Verificação do número por SMS**: criar conta e recuperar o PIN ("Esqueci o PIN") exigem um código de 6 dígitos enviado por SMS (válido 10 min, 5 tentativas, no máximo 5 SMS por hora por número). Recuperar o PIN termina as sessões noutros telemóveis. Sem fornecedor de SMS configurado, a app funciona em **modo de teste**: o código aparece no ecrã, com esse aviso.
- **Face ID / impressão digital** (passkeys): entrar sem escrever o PIN. A chave privada nunca sai do telemóvel. Enviar dinheiro continua a pedir o PIN.
- **Verificação de identidade (nível 2)**: o cliente envia a foto do documento e uma selfie (reduzidas no telemóvel). O admin compara e aprova em **Identidade**, e os limites sobem para 2 000 € por operação e 6 000 € por dia.
- **Alertas antifraude / branqueamento** (ecrã **Alertas**): a app assinala automaticamente operações de 1 000 € ou mais, mais de 10 envios numa hora, envios repetidos perto do limite (fracionamento), contas com menos de 7 dias a enviar mais de 500 € em 24 h, e 5 ou mais pessoas diferentes a enviar para a mesma conta. O admin regista a conclusão e pode bloquear a conta. Os valores estão em `src/config.js → AML`.
- **Relatórios**: exportação de todos os movimentos em CSV (abre no Excel) para a contabilidade ou para o banco central.

## Para os clientes

- **Notificações** no telemóvel: dinheiro recebido, pedidos, transferências bancárias concluídas, verificação de identidade. No iPhone funcionam com a app instalada no ecrã principal (iOS 16.4+). As chaves são geradas automaticamente.
- **Comprovativos**: tocar num movimento mostra um recibo em imagem, que se partilha pelo WhatsApp ou se guarda.
- **Envios automáticos mensais** (ex.: mesada): o cliente autoriza uma vez com o PIN, e o servidor envia no dia escolhido às 9h. Se faltar saldo, tenta nos 2 dias seguintes e avisa. Cada mês é pago uma única vez. ⚠️ No plano grátis do Render, o servidor adormece; o envio é feito quando acordar (ou mantenha-o acordado com o UptimeRobot).
- **Recargas e contas**: recargas CST, Unitel STP, Unitel Angola e CV Móvel, energia pré-paga EMAE (dá o código para o contador) e fatura da água EMAE. Pode pagar-se a partir de qualquer carteira. Se a empresa recusar, o dinheiro volta. **Simulado** até haver contrato (ver `BILLS_HTTP_URL`).
- **Agentes perto de mim**: lista dos agentes do mais perto para o mais longe, com ligação para o Google Maps e para telefonar.
- **Idiomas**: Português, Español, English e Français. Escolhe-se no ecrã de entrada ou no perfil; por omissão segue o idioma do telemóvel. Os painéis de admin e agente ficam em português.
- **USSD (`*xxx#`)** para telemóveis sem internet: ver saldo, enviar (com PIN), gerar código de levantamento e últimos movimentos. É compatível com gateways como o Africa's Talking (`POST /api/ussd?key=USSD_SECRET`). No painel de admin há um **simulador** para mostrar o menu a operadoras e parceiros.

## Para os agentes

- **O meu ponto**: nome, morada, horário e localização (botão "Usar a minha localização"), para aparecer aos clientes.
- **Comissões automáticas**: 0,3% de cada depósito (até 3 €) e 40% da taxa de cada levantamento, pagas na hora pela empresa a partir das taxas. O ecrã **Comissões** mostra o total do mês.

## Câmbio garantido (60 segundos)

Cada cotação mostrada ao cliente (enviar, câmbio, pagar numa loja, pedidos, depósitos de agentes, envios para IBAN) fica **garantida durante 60 segundos**, com uma contagem decrescente no ecrã. Se o cliente confirmar a tempo, paga exatamente o que viu, mesmo que o admin mude o câmbio entretanto. Depois disso, a app mostra uma cotação nova. Cada cotação só pode ser usada uma vez.

## Enviar para quem não tem DobraPay (IBAN)

Ao escrever um número que ainda não tem conta, a app oferece **"Enviar para a conta bancária desta pessoa"**. O cliente indica o titular e o IBAN, escolhe a moeda em que o dinheiro chega (ex.: paga em EUR e chega em STN a uma conta no BISTP) e vê a cotação garantida. Os beneficiários ficam guardados, **visíveis só para quem os guardou**. Cada cliente pode também guardar o seu próprio IBAN no perfil, para levantar sem o escrever de cada vez.

## Parceiros de pagamento (pagamentos automáticos)

Em **Acertos → Pagamentos automáticos**, cada moeda escolhe quem paga os levantamentos e envios para IBAN:

| Opção | O que faz |
|---|---|
| **Manual** | O admin faz a transferência no banco e marca como paga (ecrã Banco). |
| **Simulador** | Para testes: "paga" sozinho alguns segundos depois. Se o titular tiver a palavra `FALHA`, simula uma recusa e devolve o dinheiro. |
| **Parceiro por API** | Aparece quando `PAYOUT_HTTP_URL` está definido. A DobraPay envia a ordem por `POST` (com `Authorization: Bearer PAYOUT_HTTP_TOKEN` e `Idempotency-Key` = referência, para nunca pagar duas vezes). O parceiro confirma depois em `POST /api/webhooks/payouts/http` com `{ "external_id", "status": "paid" \| "failed", "bank_reference", "reason" }`, assinado no cabeçalho `X-DobraPay-Signature` (HMAC-SHA256 do corpo com `PAYOUT_WEBHOOK_SECRET`). |

Se o parceiro estiver em baixo, o pedido fica para **pagamento manual**, sem perder dinheiro. Se o banco recusar, o cliente recebe tudo de volta (valor + taxa) ao mesmo câmbio. Para ligar um parceiro com outro formato de API (banco, Routefusion, MoneyGram…), basta acrescentar um ficheiro com `send()` em `src/payouts.js`.

## Pagamentos em lojas

O admin ativa a conta de loja de um cliente (**Painel → 🏪**). A loja carrega em **Cobrar**, escreve o valor e mostra o **QR code** ou o **código de 6 letras**. O cliente:
- aponta a **câmara do telemóvel** ao QR (no iPhone também funciona: o QR é um endereço que abre a DobraPay já no pagamento), **ou**
- carrega em **Pagar** e escreve o código.

O cliente paga com qualquer carteira (Dobras, Euros…), e a loja recebe sempre o valor exato na moeda dela. O ecrã da loja mostra **"Pago ✓"** sozinho, em segundos.

## Correr no computador

Precisa do Node.js 22.13 ou superior.

```bash
git clone https://github.com/Nadcv/Dobraplay.git && cd Dobraplay
npm install
ADMIN_PHONE=9900000 npm start      # a conta com este número fica administradora
# abrir http://localhost:3000
npm test                            # 39 testes automáticos (SQLite)
TEST_DATABASE_URL=postgres://... npm test   # os mesmos testes em PostgreSQL (APAGA essa base!)
```

Para experimentar: crie a conta admin (🇸🇹 9900000), uma conta de agente em São Tomé e clientes em vários países (ex.: 🇪🇸 612 345 678, 🇦🇴 923 456 789). No painel admin torne o agente "Agente", emita-lhe float e faça um depósito para um cliente noutro país.

| Variável | Para que serve |
|---|---|
| `PORT` | Porta (por omissão 3000) |
| `DATABASE_URL` | Endereço PostgreSQL. **Obrigatório em produção** (ex.: Neon grátis) |
| `DB_FILE` | Sem `DATABASE_URL`, usa este ficheiro SQLite (por omissão `data/dobrapay.db`), só para o computador |
| `ADMIN_PHONE` | Número da conta administradora |
| `APP_NAME` | Nome da marca (por omissão DobraPay) |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | Carregar com cartão (Stripe). Sem isto, a opção não aparece |
| `SMS_HTTP_URL` / `SMS_HTTP_TOKEN` | Fornecedor de SMS (`POST { to, message }`). Sem isto, os códigos aparecem no ecrã (modo de teste) |
| `OTP_REQUIRED` | `false` desliga o código por SMS no registo (não recomendado) |
| `USSD_SECRET` | Chave que o gateway USSD da operadora envia (`?key=` ou cabeçalho `X-USSD-Key`) |
| `BILLS_HTTP_URL` / `BILLS_HTTP_TOKEN` | Fornecedor de recargas e contas. Sem isto, os pagamentos são simulados |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Chaves das notificações (opcional: geradas e guardadas automaticamente) |
| `PAYOUT_HTTP_URL` / `PAYOUT_HTTP_TOKEN` | Endereço e chave do parceiro de pagamentos por API (opcional) |
| `PAYOUT_WEBHOOK_SECRET` | Segredo partilhado com o parceiro para assinar os webhooks (obrigatório para receber confirmações) |
| `PAYOUT_SANDBOX_DELAY_MS` | Quanto tempo o simulador demora a "pagar" (por omissão 5000 ms) |
| `PUBLIC_URL` | Endereço público usado nos QR codes (opcional: por omissão usa o endereço por onde a app foi aberta) |

## Publicar grátis (Render + Neon)

Os servidores grátis **apagam o disco** a cada reinício. Por isso, online, a DobraPay guarda tudo numa **base de dados PostgreSQL grátis no Neon**, e o **Render** só corre a app. Nenhum dos dois pede cartão.

### 1. Base de dados (Neon), cerca de 3 minutos
1. Crie conta em https://neon.tech (pode entrar com o GitHub).
2. **Create project**: nome `dobrapay`, versão PostgreSQL 16, região **Europe (Frankfurt)**.
3. No painel do projeto, carregue em **Connect** e copie o endereço (*connection string*). É parecido com
   `postgresql://utilizador:senha@ep-xxxx.eu-central-1.aws.neon.tech/neondb?sslmode=require`

### 2. Servidor (Render), cerca de 5 minutos
1. Crie conta em https://render.com (pode entrar com o GitHub).
2. **New → Blueprint** → escolha o repositório **Dobraplay**. O ficheiro `render.yaml` já configura tudo: plano grátis, Node 22, verificação de saúde em `/api/health`.
3. Quando o Render pedir as variáveis:
   - `DATABASE_URL`: cole o endereço do Neon do passo anterior;
   - `ADMIN_PHONE`: o seu número com indicativo (ex.: `+2399900000`).
4. **Apply**. Uns minutos depois a app fica em `https://dobrapay.onrender.com` (ou parecido), com HTTPS.
5. Abra o endereço no telemóvel, **crie a conta com o número do `ADMIN_PHONE`** (fica administrador) e, no menu do navegador, escolha **"Adicionar ao ecrã principal"** para a instalar como app.

Cada `git push` para `main` publica uma versão nova automaticamente. As tabelas criam-se sozinhas no primeiro arranque.

### Limitações do plano grátis
- **Adormece após 15 minutos sem visitas.** A primeira visita depois disso demora cerca de 1 minuto. Para ficar sempre acordada, use um monitor grátis como o https://uptimerobot.com a abrir `https://SEU-ENDEREÇO/api/health` a cada 10 minutos.
- **Neon grátis: 0,5 GB**, o que chega para centenas de milhares de transações. Faça cópias de segurança regulares (o Neon guarda um histórico curto; para dinheiro real use um plano pago com cópias diárias).
- Serve para testes e para um piloto pequeno. Para operar com dinheiro real, passe para planos pagos (com cópias de segurança e sem adormecer) e cumpra a secção seguinte.

### Alternativa: Docker num servidor próprio
`docker build -t dobrapay . && docker run -p 3000:3000 -e DATABASE_URL=postgres://... -e ADMIN_PHONE=+2399900000 dobrapay`
(Sem `DATABASE_URL`, o contentor usa SQLite no volume `/data`: monte um volume persistente.)

## Antes de lançar com dinheiro real

Este código é uma base técnica sólida, mas **para operar legalmente** ainda falta:

1. **Licenças em cada país**: moeda eletrónica e **remessas internacionais** dependem do Banco Central de cada país (BCSTP, BNA em Angola, BCV em Cabo Verde, Banco de Portugal, Banco de España, este último sob as regras europeias PSD2). O caminho mais rápido costuma ser **parcerias com bancos ou operadores de remessas já licenciados** em cada país. O dinheiro dos clientes tem de ficar em contas fiduciárias.
   - Angola tem controlo cambial: as remessas para fora e para dentro passam por regras do BNA.
2. **KYC e combate ao branqueamento de capitais**: verificação do BI para o nível 2, listas de sanções, alertas de operações suspeitas.
3. **Câmbios automáticos**: ligar o AOA e o USD a uma fonte oficial (BNA, BCE) em vez de os atualizar à mão.
4. **Verificação do número por SMS** no registo e, de preferência, **USSD** (`*xxx#`) para quem não tem smartphone.
5. **Base de dados de produção**: plano pago com cópias de segurança diárias e restauro testado. A app já usa PostgreSQL com bloqueios de linha, testados com pedidos simultâneos.
6. Auditoria de segurança externa, termos de uso e política de privacidade, apoio ao cliente e processo de reclamações e estornos.

## Estrutura

```
server.js          arranque
src/config.js      limites, taxas, regras
src/db.js          esquema e transações (SQLite no computador, PostgreSQL online)
src/service.js     regras de negócio (contas, transferências, agentes, admin)
src/app.js         API HTTP + segurança (rate limit, cabeçalhos, webhooks assinados)
src/payouts.js     parceiros de pagamento (manual, simulador, API)
src/features/      sms, push, kyc (identidade), aml (alertas + CSV), passkeys (Face ID),
                   scheduled (envios mensais), bills (recargas/contas), agents (mapa + comissões),
                   ussd, receipts (comprovativos), cards (carregar com cartão, Stripe)
public/i18n.js     traduções (PT, ES, EN, FR)
public/            app PWA (instalável no telemóvel)
tests/             testes automáticos
render.yaml        configuração do Render (publicar grátis)
```
