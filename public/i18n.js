// Traduções da app do cliente (Português, Español, English, Français).
// As chaves são o próprio texto em português: o que não estiver traduzido
// aparece em português. Os painéis de admin e agente ficam em português.
'use strict';
const LANGS = { pt: 'Português', es: 'Español', en: 'English', fr: 'Français' };
let LANG = localStorage.getItem('dp_lang') || (navigator.language || 'pt').slice(0, 2).toLowerCase();
if (!LANGS[LANG]) LANG = 'pt';
document.documentElement.lang = LANG;

// [pt, es, en, fr]
const ROWS = [
  ['Entrar', 'Entrar', 'Sign in', 'Se connecter'],
  ['Criar conta', 'Crear cuenta', 'Create account', 'Créer un compte'],
  ['País', 'País', 'Country', 'Pays'],
  ['Número de telemóvel', 'Número de móvil', 'Mobile number', 'Numéro de portable'],
  ['Nome completo', 'Nombre completo', 'Full name', 'Nom complet'],
  ['PIN (4 a 6 dígitos)', 'PIN (4 a 6 dígitos)', 'PIN (4 to 6 digits)', 'Code PIN (4 à 6 chiffres)'],
  ['Novo PIN (4 a 6 dígitos)', 'Nuevo PIN (4 a 6 dígitos)', 'New PIN (4 to 6 digits)', 'Nouveau code PIN (4 à 6 chiffres)'],
  ['Código recebido por SMS', 'Código recibido por SMS', 'Code received by SMS', 'Code reçu par SMS'],
  ['Enviar código por SMS', 'Enviar código por SMS', 'Send code by SMS', 'Envoyer le code par SMS'],
  ['E-mail', 'Correo electrónico', 'Email', 'E-mail'],
  ['Código recebido por e-mail', 'Código recibido por correo', 'Code received by email', 'Code reçu par e-mail'],
  ['Código recebido', 'Código recibido', 'Code received', 'Code reçu'],
  ['Enviar código por e-mail', 'Enviar código por correo', 'Send code by email', 'Envoyer le code par e-mail'],
  ['Enviar código', 'Enviar código', 'Send code', 'Envoyer le code'],
  ['Confirmar e-mail', 'Confirmar correo', 'Confirm email', 'Confirmer l’e-mail'],
  ['E-mail confirmado ✓', 'Correo confirmado ✓', 'Email confirmed ✓', 'E-mail confirmé ✓'],
  ['Juntar e-mail', 'Añadir correo', 'Add email', 'Ajouter un e-mail'],
  ['Mudar e-mail', 'Cambiar correo', 'Change email', 'Changer d’e-mail'],
  ['Serve para receber o código se esquecer o PIN.', 'Sirve para recibir el código si olvida el PIN.', 'Used to receive a code if you forget your PIN.', 'Sert à recevoir un code si vous oubliez votre code PIN.'],
  ['Indique o seu e-mail: é para lá que enviamos o código.', 'Indique su correo: ahí enviamos el código.', 'Enter your email: we send the code there.', 'Indiquez votre e-mail : nous y envoyons le code.'],
  ['Modo de teste (sem e-mail nem SMS): o seu código é {code}', 'Modo de prueba (sin correo ni SMS): su código es {code}', 'Test mode (no email or SMS): your code is {code}', 'Mode test (sans e-mail ni SMS) : votre code est {code}'],
  ['Enviámos um código para {email}. Veja também a pasta de spam.', 'Enviamos un código a {email}. Revise también la carpeta de spam.', 'We sent a code to {email}. Also check your spam folder.', 'Nous avons envoyé un code à {email}. Vérifiez aussi les spams.'],
  ['Se este número tiver conta com e-mail, enviámos um código para o e-mail registado. Sem e-mail? Peça ajuda a um agente.', 'Si este número tiene cuenta con correo, enviamos un código al correo registrado. ¿Sin correo? Pida ayuda a un agente.', 'If this number has an account with an email, we sent a code to that email. No email? Ask an agent for help.', 'Si ce numéro a un compte avec e-mail, nous avons envoyé un code à cet e-mail. Pas d’e-mail ? Demandez de l’aide à un agent.'],
  ['Guardar novo PIN', 'Guardar nuevo PIN', 'Save new PIN', 'Enregistrer le nouveau PIN'],
  ['Esqueci o PIN', 'Olvidé mi PIN', 'Forgot PIN', 'Code PIN oublié'],
  ['Voltar a entrar', 'Volver a entrar', 'Back to sign in', 'Revenir à la connexion'],
  ['Recuperar o PIN', 'Recuperar el PIN', 'Recover your PIN', 'Récupérer le code PIN'],
  ['Entrar com Face ID / impressão digital', 'Entrar con Face ID / huella', 'Sign in with Face ID / fingerprint', 'Se connecter avec Face ID / empreinte'],
  ['Nunca partilhe o seu PIN, nem com agentes nem com funcionários.', 'Nunca comparta su PIN, ni con agentes ni con empleados.', 'Never share your PIN, not even with agents or staff.', 'Ne partagez jamais votre code PIN, même avec des agents ou des employés.'],
  ['Modo de teste (sem SMS): o seu código é {code}', 'Modo de prueba (sin SMS): su código es {code}', 'Test mode (no SMS): your code is {code}', 'Mode test (sans SMS) : votre code est {code}'],
  ['Enviámos um código por SMS para {phone}.', 'Enviamos un código por SMS a {phone}.', 'We sent a code by SMS to {phone}.', 'Nous avons envoyé un code par SMS au {phone}.'],
  ['PIN alterado. Já entrou na sua conta.', 'PIN cambiado. Ya ha entrado en su cuenta.', 'PIN changed. You are now signed in.', 'Code PIN modifié. Vous êtes connecté.'],
  ['Indique o seu nome completo.', 'Indique su nombre completo.', 'Enter your full name.', 'Indiquez votre nom complet.'],
  ['Envie e receba dinheiro entre São Tomé e Príncipe, Angola, Cabo Verde, Portugal e Espanha, em qualquer moeda.', 'Envíe y reciba dinero entre Santo Tomé y Príncipe, Angola, Cabo Verde, Portugal y España, en cualquier moneda.', 'Send and receive money between São Tomé and Príncipe, Angola, Cape Verde, Portugal and Spain, in any currency.', 'Envoyez et recevez de l’argent entre Sao Tomé-et-Principe, l’Angola, le Cap-Vert, le Portugal et l’Espagne, dans toutes les devises.'],
  ['Olá,', 'Hola,', 'Hello,', 'Bonjour,'],
  ['Saldo disponível', 'Saldo disponible', 'Available balance', 'Solde disponible'],
  ['Enviar', 'Enviar', 'Send', 'Envoyer'],
  ['Receber', 'Recibir', 'Receive', 'Recevoir'],
  ['Pagar', 'Pagar', 'Pay', 'Payer'],
  ['Pedir', 'Pedir', 'Request', 'Demander'],
  ['Carregar', 'Recargar', 'Top up', 'Recharger'],
  ['Levantar', 'Retirar', 'Withdraw', 'Retirer'],
  ['Câmbio', 'Cambio', 'Exchange', 'Change'],
  ['Contas', 'Facturas', 'Bills', 'Factures'],
  ['Movimentos', 'Movimientos', 'Activity', 'Opérations'],
  ['Ainda sem movimentos. Deposite dinheiro num agente para começar.', 'Aún sin movimientos. Deposite dinero en un agente para empezar.', 'No activity yet. Deposit money with an agent to start.', 'Aucune opération. Déposez de l’argent chez un agent pour commencer.'],
  ['Enviar dinheiro', 'Enviar dinero', 'Send money', 'Envoyer de l’argent'],
  ['Para (número)', 'Para (número)', 'To (number)', 'À (numéro)'],
  ['Enviar da carteira', 'Enviar desde la cartera', 'Send from wallet', 'Envoyer depuis le portefeuille'],
  ['Valor a enviar', 'Importe a enviar', 'Amount to send', 'Montant à envoyer'],
  ['Mensagem (opcional)', 'Mensaje (opcional)', 'Message (optional)', 'Message (facultatif)'],
  ['O seu PIN', 'Su PIN', 'Your PIN', 'Votre code PIN'],
  ['Valor', 'Importe', 'Amount', 'Montant'],
  ['Moeda', 'Moneda', 'Currency', 'Devise'],
  ['Paga', 'Paga', 'You pay', 'Vous payez'],
  ['Taxa', 'Comisión', 'Fee', 'Frais'],
  ['Total', 'Total', 'Total', 'Total'],
  ['Recebe', 'Recibe', 'They receive', 'Reçoit'],
  ['Para', 'Para', 'To', 'À'],
  ['De', 'De', 'From', 'De'],
  ['🔒 Câmbio garantido', '🔒 Cambio garantizado', '🔒 Rate locked', '🔒 Taux garanti'],
  ['Receber dinheiro', 'Recibir dinero', 'Receive money', 'Recevoir de l’argent'],
  ['Mostre este código ou partilhe o seu número:', 'Muestre este código o comparta su número:', 'Show this code or share your number:', 'Montrez ce code ou partagez votre numéro :'],
  ['Quero receber em', 'Quiero recibir en', 'I want to receive in', 'Je veux recevoir en'],
  ['Partilhar o meu número', 'Compartir mi número', 'Share my number', 'Partager mon numéro'],
  ['Pedir dinheiro', 'Pedir dinero', 'Request money', 'Demander de l’argent'],
  ['A quem pede (número)', 'A quién pide (número)', 'Ask who (number)', 'À qui demander (numéro)'],
  ['Motivo (opcional)', 'Motivo (opcional)', 'Reason (optional)', 'Motif (facultatif)'],
  ['Enviar pedido', 'Enviar solicitud', 'Send request', 'Envoyer la demande'],
  ['Pagar pedido', 'Pagar solicitud', 'Pay request', 'Payer la demande'],
  ['Pagar com', 'Pagar con', 'Pay with', 'Payer avec'],
  ['Recusar', 'Rechazar', 'Decline', 'Refuser'],
  ['Pagar numa loja', 'Pagar en una tienda', 'Pay in a shop', 'Payer dans un magasin'],
  ['Código mostrado pela loja', 'Código mostrado por la tienda', 'Code shown by the shop', 'Code affiché par le magasin'],
  ['Loja', 'Tienda', 'Shop', 'Magasin'],
  ['Descrição', 'Descripción', 'Description', 'Description'],
  ['A loja recebe', 'La tienda recibe', 'The shop receives', 'Le magasin reçoit'],
  ['Com cartão', 'Con tarjeta', 'By card', 'Par carte'],
  ['Cartão', 'Tarjeta', 'Card', 'Carte'],
  ['Visa, Mastercard, Apple Pay ou Google Pay. O saldo entra na hora.', 'Visa, Mastercard, Apple Pay o Google Pay. El saldo entra al momento.', 'Visa, Mastercard, Apple Pay or Google Pay. Balance arrives instantly.', 'Visa, Mastercard, Apple Pay ou Google Pay. Le solde arrive immédiatement.'],
  ['Carregar com cartão', 'Recargar con tarjeta', 'Top up by card', 'Recharger par carte'],
  ['Valor a carregar (EUR)', 'Importe a recargar (EUR)', 'Amount to top up (EUR)', 'Montant à recharger (EUR)'],
  ['Pagar com cartão', 'Pagar con tarjeta', 'Pay by card', 'Payer par carte'],
  ['Vai para a página segura da Stripe para pagar. A DobraPay nunca vê o número do seu cartão.', 'Irá a la página segura de Stripe para pagar. DobraPay nunca ve el número de su tarjeta.', 'You will pay on Stripe’s secure page. DobraPay never sees your card number.', 'Vous paierez sur la page sécurisée de Stripe. DobraPay ne voit jamais votre numéro de carte.'],
  ['Carrega', 'Recarga', 'Top up', 'Recharge'],
  ['Entra na carteira', 'Entra en la cartera', 'Goes to wallet', 'Arrive dans le portefeuille'],
  ['Pagamento cancelado. Nada foi cobrado.', 'Pago cancelado. No se cobró nada.', 'Payment cancelled. Nothing was charged.', 'Paiement annulé. Rien n’a été débité.'],
  ['A confirmar o pagamento…', 'Confirmando el pago…', 'Confirming payment…', 'Confirmation du paiement…'],
  ['Carregados {v} na sua carteira ✓', 'Se recargaron {v} en su cartera ✓', '{v} added to your wallet ✓', '{v} ajoutés à votre portefeuille ✓'],
  ['O pagamento não foi concluído.', 'El pago no se completó.', 'The payment was not completed.', 'Le paiement n’a pas abouti.'],
  ['Modo de teste: use o cartão 4242 4242 4242 4242, qualquer data futura e qualquer código.', 'Modo de prueba: use la tarjeta 4242 4242 4242 4242, cualquier fecha futura y cualquier código.', 'Test mode: use card 4242 4242 4242 4242, any future date and any code.', 'Mode test : utilisez la carte 4242 4242 4242 4242, une date future et n’importe quel code.'],
  ['Carregamento com cartão', 'Recarga con tarjeta', 'Card top-up', 'Recharge par carte'],
  ['Carregar a carteira', 'Recargar la cartera', 'Top up wallet', 'Recharger le portefeuille'],
  ['Por transferência bancária', 'Por transferencia bancaria', 'By bank transfer', 'Par virement bancaire'],
  ['Em dinheiro, num agente', 'En efectivo, en un agente', 'In cash, at an agent', 'En espèces, chez un agent'],
  ['Levantar dinheiro', 'Retirar dinero', 'Withdraw money', 'Retirer de l’argent'],
  ['Para a minha conta bancária', 'A mi cuenta bancaria', 'To my bank account', 'Vers mon compte bancaire'],
  ['Agentes perto de mim', 'Agentes cerca de mí', 'Agents near me', 'Agents près de moi'],
  ['Onde depositar ou levantar dinheiro', 'Dónde depositar o retirar dinero', 'Where to deposit or withdraw cash', 'Où déposer ou retirer de l’argent'],
  ['Levantar num agente', 'Retirar en un agente', 'Withdraw at an agent', 'Retirer chez un agent'],
  ['Quero levantar', 'Quiero retirar', 'I want to withdraw', 'Je veux retirer'],
  ['Sai da carteira', 'Sale de la cartera', 'From wallet', 'Débité du portefeuille'],
  ['Gerar código', 'Generar código', 'Generate code', 'Générer un code'],
  ['Mostre este código ao agente:', 'Muestre este código al agente:', 'Show this code to the agent:', 'Montrez ce code à l’agent :'],
  ['Câmbio entre as minhas moedas', 'Cambio entre mis monedas', 'Exchange between my currencies', 'Change entre mes devises'],
  ['Trocar', 'Cambiar', 'Exchange', 'Changer'],
  ['Fica com', 'Obtiene', 'You get', 'Vous obtenez'],
  ['Valor a trocar', 'Importe a cambiar', 'Amount to exchange', 'Montant à changer'],
  ['Levantar para o banco', 'Retirar al banco', 'Withdraw to bank', 'Retirer vers la banque'],
  ['IBAN da sua conta', 'IBAN de su cuenta', 'Your account IBAN', 'IBAN de votre compte'],
  ['Titular da conta', 'Titular de la cuenta', 'Account holder', 'Titulaire du compte'],
  ['Pedir transferência', 'Solicitar transferencia', 'Request transfer', 'Demander le virement'],
  ['Recebe no banco', 'Recibe en el banco', 'Received in bank', 'Reçu à la banque'],
  ['Enviar para uma conta bancária', 'Enviar a una cuenta bancaria', 'Send to a bank account', 'Envoyer vers un compte bancaire'],
  ['Para uma conta bancária (IBAN)', 'A una cuenta bancaria (IBAN)', 'To a bank account (IBAN)', 'Vers un compte bancaire (IBAN)'],
  ['Para quem ainda não tem DobraPay', 'Para quien aún no tiene DobraPay', 'For people without DobraPay yet', 'Pour ceux qui n’ont pas encore DobraPay'],
  ['Chega em', 'Llega en', 'Arrives in', 'Arrive en'],
  ['Valor a chegar', 'Importe a recibir', 'Amount to arrive', 'Montant à recevoir'],
  ['Chega à conta', 'Llega a la cuenta', 'Arrives in account', 'Arrive sur le compte'],
  ['Envio automático todos os meses', 'Envío automático cada mes', 'Automatic monthly transfer', 'Envoi automatique chaque mois'],
  ['Ex.: mesada para a família', 'Ej.: dinero mensual para la familia', 'E.g. monthly money for family', 'Ex. : argent mensuel pour la famille'],
  ['Envios automáticos', 'Envíos automáticos', 'Automatic transfers', 'Envois automatiques'],
  ['Novo envio todos os meses', 'Nuevo envío mensual', 'New monthly transfer', 'Nouvel envoi mensuel'],
  ['Dia do mês', 'Día del mes', 'Day of month', 'Jour du mois'],
  ['Da carteira', 'Desde la cartera', 'From wallet', 'Depuis le portefeuille'],
  ['Agendar', 'Programar', 'Schedule', 'Programmer'],
  ['Parar', 'Detener', 'Stop', 'Arrêter'],
  ['Ainda não tem envios automáticos.', 'Aún no tiene envíos automáticos.', 'No automatic transfers yet.', 'Aucun envoi automatique.'],
  ['Enviamos automaticamente nesse dia, às 9h. Se faltar saldo, tentamos nos dias seguintes e avisamos.', 'Enviamos automáticamente ese día a las 9h. Si falta saldo, lo intentamos los días siguientes y le avisamos.', 'We send automatically on that day at 9am. If your balance is short, we retry on the next days and let you know.', 'Nous envoyons automatiquement ce jour-là à 9h. Si le solde est insuffisant, nous réessayons les jours suivants et vous prévenons.'],
  ['Todos os meses, dia {d} · próximo: {date}', 'Cada mes, día {d} · próximo: {date}', 'Monthly on day {d} · next: {date}', 'Chaque mois, le {d} · prochain : {date}'],
  ['Envio automático agendado.', 'Envío automático programado.', 'Automatic transfer scheduled.', 'Envoi automatique programmé.'],
  ['Recargas e contas', 'Recargas y facturas', 'Top-ups and bills', 'Recharges et factures'],
  ['Serviço', 'Servicio', 'Service', 'Service'],
  ['Referência', 'Referencia', 'Reference', 'Référence'],
  ['Número de telemóvel', 'Número de móvil', 'Mobile number', 'Numéro de portable'],
  ['Número do contador', 'Número de contador', 'Meter number', 'Numéro du compteur'],
  ['Referência da fatura', 'Referencia de la factura', 'Invoice reference', 'Référence de la facture'],
  ['A empresa recebe', 'La empresa recibe', 'The company receives', 'L’entreprise reçoit'],
  ['Últimos pagamentos', 'Últimos pagos', 'Recent payments', 'Derniers paiements'],
  ['Código de energia para introduzir no contador:', 'Código de energía para introducir en el contador:', 'Energy code to enter on the meter:', 'Code d’énergie à saisir sur le compteur :'],
  ['Modo de demonstração: os pagamentos são simulados até haver contrato com cada empresa.', 'Modo demostración: los pagos son simulados hasta tener contrato con cada empresa.', 'Demo mode: payments are simulated until there is a contract with each company.', 'Mode démo : les paiements sont simulés jusqu’à la signature d’un contrat avec chaque entreprise.'],
  ['Comprovativo', 'Comprobante', 'Receipt', 'Reçu'],
  ['Partilhar comprovativo', 'Compartir comprobante', 'Share receipt', 'Partager le reçu'],
  ['Guardar imagem', 'Guardar imagen', 'Save image', 'Enregistrer l’image'],
  ['Data', 'Fecha', 'Date', 'Date'],
  ['Tipo', 'Tipo', 'Type', 'Type'],
  ['Valor enviado', 'Importe enviado', 'Amount sent', 'Montant envoyé'],
  ['Valor recebido', 'Importe recibido', 'Amount received', 'Montant reçu'],
  ['Mensagem', 'Mensaje', 'Message', 'Message'],
  ['N.º da operação', 'N.º de operación', 'Transaction no.', 'N° d’opération'],
  ['Operação registada pela DobraPay. Guarde este comprovativo.', 'Operación registrada por DobraPay. Guarde este comprobante.', 'Transaction recorded by DobraPay. Keep this receipt.', 'Opération enregistrée par DobraPay. Conservez ce reçu.'],
  ['Transferência', 'Transferencia', 'Transfer', 'Virement'],
  ['Depósito', 'Depósito', 'Deposit', 'Dépôt'],
  ['Levantamento', 'Retirada', 'Withdrawal', 'Retrait'],
  ['Pagamento em loja', 'Pago en tienda', 'Shop payment', 'Paiement en magasin'],
  ['Devolução', 'Devolución', 'Refund', 'Remboursement'],
  ['Recarga / conta', 'Recarga / factura', 'Top-up / bill', 'Recharge / facture'],
  ['O meu perfil', 'Mi perfil', 'My profile', 'Mon profil'],
  ['Notificações', 'Notificaciones', 'Notifications', 'Notifications'],
  ['Ativar', 'Activar', 'Turn on', 'Activer'],
  ['Desativar', 'Desactivar', 'Turn off', 'Désactiver'],
  ['Face ID / impressão digital', 'Face ID / huella', 'Face ID / fingerprint', 'Face ID / empreinte'],
  ['Identidade', 'Identidad', 'Identity', 'Identité'],
  ['Verificar', 'Verificar', 'Verify', 'Vérifier'],
  ['verificada ✓', 'verificada ✓', 'verified ✓', 'vérifiée ✓'],
  ['em análise', 'en revisión', 'under review', 'en cours d’examen'],
  ['por verificar', 'sin verificar', 'not verified', 'non vérifiée'],
  ['Idioma', 'Idioma', 'Language', 'Langue'],
  ['Ver', 'Ver', 'View', 'Voir'],
  ['Remover', 'Eliminar', 'Remove', 'Supprimer'],
  ['Mudar PIN', 'Cambiar PIN', 'Change PIN', 'Changer le code PIN'],
  ['PIN atual', 'PIN actual', 'Current PIN', 'Code PIN actuel'],
  ['Novo PIN', 'Nuevo PIN', 'New PIN', 'Nouveau code PIN'],
  ['Terminar sessão', 'Cerrar sesión', 'Sign out', 'Se déconnecter'],
  ['Verificar identidade', 'Verificar identidad', 'Verify identity', 'Vérifier l’identité'],
  ['Documento', 'Documento', 'Document', 'Document'],
  ['Número', 'Número', 'Number', 'Numéro'],
  ['Data de nascimento', 'Fecha de nacimiento', 'Date of birth', 'Date de naissance'],
  ['Foto do documento', 'Foto del documento', 'Photo of document', 'Photo du document'],
  ['Selfie (a sua cara, bem iluminada)', 'Selfie (su cara, bien iluminada)', 'Selfie (your face, well lit)', 'Selfie (votre visage, bien éclairé)'],
  ['Enviar para verificação', 'Enviar para verificación', 'Submit for verification', 'Envoyer pour vérification'],
  ['Passaporte', 'Pasaporte', 'Passport', 'Passeport'],
  ['Bilhete de identidade', 'Documento de identidad', 'Identity card', 'Carte d’identité'],
  ['Cartão de cidadão', 'Tarjeta de ciudadano', 'Citizen card', 'Carte de citoyen'],
  ['Autorização de residência', 'Permiso de residencia', 'Residence permit', 'Titre de séjour'],
  ['Ver no mapa', 'Ver en el mapa', 'View on map', 'Voir sur la carte'],
  ['Ligar', 'Llamar', 'Call', 'Appeler'],
  ['paga em', 'paga en', 'pays in', 'paie en'],
  ['Do mais perto para o mais longe:', 'Del más cercano al más lejano:', 'Nearest first:', 'Du plus proche au plus éloigné :'],
  ['Agentes no seu país:', 'Agentes en su país:', 'Agents in your country:', 'Agents dans votre pays :'],
  ['A procurar a sua localização…', 'Buscando su ubicación…', 'Finding your location…', 'Recherche de votre position…'],
  ['A carregar…', 'Cargando…', 'Loading…', 'Chargement…'],
  ['Fechar', 'Cerrar', 'Close', 'Fermer'],
  ['Cancelar', 'Cancelar', 'Cancel', 'Annuler'],
  ['Pendente', 'Pendiente', 'Pending', 'En attente'],
  ['Concluído', 'Completado', 'Completed', 'Terminé'],
  ['Recusado', 'Rechazado', 'Declined', 'Refusé'],
  ['Cancelado', 'Cancelado', 'Cancelled', 'Annulé'],
  ['Pago', 'Pagado', 'Paid', 'Payé'],
  ['Expirado', 'Caducado', 'Expired', 'Expiré'],
  ['Notificações ativadas ✓', 'Notificaciones activadas ✓', 'Notifications on ✓', 'Notifications activées ✓'],
  ['Notificações desativadas.', 'Notificaciones desactivadas.', 'Notifications off.', 'Notifications désactivées.'],
  ['Pronto! Da próxima vez pode entrar com Face ID / impressão digital.', '¡Listo! La próxima vez puede entrar con Face ID / huella.', 'Done! Next time you can sign in with Face ID / fingerprint.', 'C’est fait ! La prochaine fois, connectez-vous avec Face ID / empreinte.'],
  ['Enviado! Vamos analisar e avisamos assim que estiver verificado.', '¡Enviado! Lo revisaremos y le avisaremos en cuanto esté verificado.', 'Sent! We will review it and let you know once verified.', 'Envoyé ! Nous allons l’examiner et vous prévenir dès que c’est vérifié.'],
];
const DICT = { es: {}, en: {}, fr: {} };
for (const [pt, es, en, fr] of ROWS) { DICT.es[pt] = es; DICT.en[pt] = en; DICT.fr[pt] = fr; }

// Mensagens de erro do servidor mais comuns, pelo código.
const ERRORS = {
  insufficient_funds: ['Saldo insuficiente.', 'Insufficient balance.', 'Solde insuffisant.'],
  wrong_pin: ['PIN incorrecto.', 'Wrong PIN.', 'Code PIN incorrect.'],
  pin_locked: ['Demasiados intentos. Inténtelo más tarde.', 'Too many attempts. Try again later.', 'Trop de tentatives. Réessayez plus tard.'],
  bad_login: ['Número o PIN incorrecto.', 'Wrong number or PIN.', 'Numéro ou code PIN incorrect.'],
  not_found: ['Este número aún no tiene cuenta DobraPay.', 'This number has no DobraPay account yet.', 'Ce numéro n’a pas encore de compte DobraPay.'],
  bad_phone: ['Número no válido.', 'Invalid number.', 'Numéro invalide.'],
  bad_amount: ['Importe no válido.', 'Invalid amount.', 'Montant invalide.'],
  limit_tx: ['Supera su límite por operación.', 'Exceeds your per-transaction limit.', 'Dépasse votre plafond par opération.'],
  limit_daily: ['Supera su límite diario.', 'Exceeds your daily limit.', 'Dépasse votre plafond journalier.'],
  phone_taken: ['Este número ya tiene cuenta. Entre con su PIN.', 'This number already has an account. Sign in with your PIN.', 'Ce numéro a déjà un compte. Connectez-vous avec votre code PIN.'],
  bad_pin: ['El PIN debe tener 4 a 6 dígitos y no ser obvio.', 'The PIN must have 4 to 6 digits and not be obvious.', 'Le code PIN doit avoir 4 à 6 chiffres et ne pas être évident.'],
  otp_wrong: ['Código incorrecto.', 'Wrong code.', 'Code incorrect.'],
  otp_expired: ['El código caducó. Pida uno nuevo.', 'The code expired. Request a new one.', 'Le code a expiré. Demandez-en un nouveau.'],
  rate_limited: ['Demasiadas solicitudes. Espere un poco.', 'Too many requests. Please wait.', 'Trop de demandes. Patientez un peu.'],
  quote_expired: ['El cambio garantizado caducó. Revise y confirme de nuevo.', 'The locked rate expired. Check and confirm again.', 'Le taux garanti a expiré. Vérifiez et confirmez à nouveau.'],
  liquidity_paused: ['Envíos a esta moneda temporalmente pausados. Inténtelo más tarde.', 'Transfers to this currency are temporarily paused. Try later.', 'Envois vers cette devise temporairement suspendus. Réessayez plus tard.'],
  bad_iban: ['IBAN no válido.', 'Invalid IBAN.', 'IBAN invalide.'],
  bad_email: ['Correo no válido.', 'Invalid email.', 'E-mail invalide.'],
  otp_send_failed: ['No se pudo enviar el código. Inténtelo en unos minutos.', 'Could not send the code. Try again in a few minutes.', 'Impossible d’envoyer le code. Réessayez dans quelques minutes.'],
  unauthorized: ['Sesión caducada. Entre de nuevo.', 'Session expired. Sign in again.', 'Session expirée. Reconnectez-vous.'],
};

function t(s, vars) {
  let out = (LANG !== 'pt' && DICT[LANG][s]) || s;
  if (vars) out = out.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
  return out;
}
function errText(err) {
  const i = { es: 0, en: 1, fr: 2 }[LANG];
  return (i != null && err && err.code && ERRORS[err.code] && ERRORS[err.code][i]) || (err && err.message) || String(err);
}
function fillLangSelect(sel) {
  sel.innerHTML = Object.entries(LANGS).map(([k, v]) => `<option value="${k}" ${k === LANG ? 'selected' : ''}>${v}</option>`).join('');
  sel.addEventListener('change', () => { localStorage.setItem('dp_lang', sel.value); location.reload(); });
}

// Traduz automaticamente os textos conhecidos que aparecem no ecrã
// (incluindo os ecrãs que abrem depois), sem mexer no resto da app.
function translateTree(root) {
  if (LANG === 'pt' || !root) return;
  const dict = DICT[LANG];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const n of nodes) {
    const raw = n.nodeValue, key = raw.trim();
    if (key && dict[key]) n.nodeValue = raw.replace(key, dict[key]);
  }
  const els = root.querySelectorAll ? root.querySelectorAll('[placeholder],[aria-label],[title]') : [];
  for (const el of els) for (const a of ['placeholder', 'aria-label', 'title']) {
    const v = el.getAttribute(a);
    if (v && dict[v]) el.setAttribute(a, dict[v]);
  }
}
if (LANG !== 'pt') {
  document.addEventListener('DOMContentLoaded', () => {
    translateTree(document.body);
    new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) {
        if (n.nodeType === 1) translateTree(n);
        else if (n.nodeType === 3 && DICT[LANG][n.nodeValue.trim()]) n.nodeValue = n.nodeValue.replace(n.nodeValue.trim(), DICT[LANG][n.nodeValue.trim()]);
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: false });
  });
}
