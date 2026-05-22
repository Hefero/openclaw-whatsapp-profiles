import 'dotenv/config';

type Channel = 'sms' | 'whatsapp';

type CliArgs = {
  body?: string;
  channel?: Channel;
  dryRun: boolean;
  from?: string;
  messagingServiceSid?: string;
  statusCallback?: string;
  to?: string;
};

type TwilioResponse = {
  sid?: string;
  status?: string;
  to?: string;
  from?: string;
  messaging_service_sid?: string | null;
  error_code?: string | number | null;
  error_message?: string | null;
  code?: string | number;
  message?: string;
  more_info?: string;
};

const twilioMessagesUrl = (accountSid: string) =>
  `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`;

function parseChannel(value: string | undefined): Channel | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.toLowerCase();
  if (normalized === 'sms' || normalized === 'whatsapp') {
    return normalized;
  }

  throw new Error(`Canal invalido: ${value}. Use sms ou whatsapp.`);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { dryRun: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--to' || arg === '-t') {
      args.to = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === '--from' || arg === '-f') {
      args.from = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === '--body' || arg === '--message' || arg === '-m') {
      args.body = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === '--channel' || arg === '-c') {
      args.channel = parseChannel(argv[i + 1]);
      i += 1;
      continue;
    }

    if (arg === '--messaging-service-sid') {
      args.messagingServiceSid = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === '--status-callback') {
      args.statusCallback = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }

    if (!arg.startsWith('-') && !args.body) {
      args.body = arg;
      continue;
    }

    throw new Error(`Argumento desconhecido: ${arg}`);
  }

  return args;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Env obrigatoria ausente: ${name}`);
  }

  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function normalizeDestination(value: string, channel: Channel): string {
  const trimmed = value.trim();
  if (channel === 'whatsapp' && !trimmed.startsWith('whatsapp:')) {
    return `whatsapp:${trimmed}`;
  }

  return trimmed;
}

function usage(): void {
  console.log(`
Uso:
  npm run twilio:send -- --to +15551234567 --body "hello from twilio" --channel whatsapp
  npm run twilio:send -- --to +15551234567 --body "hello by sms" --channel sms

Envs:
  TWILIO_ACCOUNT_SID=AC...
  TWILIO_AUTH_TOKEN=...
  TWILIO_FROM=whatsapp:+14155238886
  TWILIO_TO=+15551234567
  TWILIO_CHANNEL=whatsapp
  TWILIO_MESSAGING_SERVICE_SID=MG...

Notas:
  - Para WhatsApp sandbox, o destinatario precisa ter entrado no sandbox da Twilio.
  - Para SMS, use um TWILIO_FROM SMS-capable ou TWILIO_MESSAGING_SERVICE_SID.
`);
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  const channel = cli.channel ?? parseChannel(optionalEnv('TWILIO_CHANNEL')) ?? 'whatsapp';
  const accountSid = optionalEnv('TWILIO_ACCOUNT_SID');
  const authToken = optionalEnv('TWILIO_AUTH_TOKEN');
  const to = normalizeDestination(cli.to ?? optionalEnv('TWILIO_TO') ?? '', channel);
  const body = cli.body ?? optionalEnv('TWILIO_BODY') ?? 'oi';
  const messagingServiceSid = cli.messagingServiceSid ?? optionalEnv('TWILIO_MESSAGING_SERVICE_SID');
  const defaultWhatsAppFrom = channel === 'whatsapp' ? 'whatsapp:+14155238886' : undefined;
  const from = normalizeDestination(cli.from ?? optionalEnv('TWILIO_FROM') ?? defaultWhatsAppFrom ?? '', channel);
  const statusCallback = cli.statusCallback ?? optionalEnv('TWILIO_STATUS_CALLBACK');

  if (!to) {
    throw new Error('Destino ausente. Use --to ou TWILIO_TO.');
  }

  if (!body) {
    throw new Error('Mensagem ausente. Use --body ou TWILIO_BODY.');
  }

  if (!from && !messagingServiceSid) {
    throw new Error('Sender ausente. Use --from, TWILIO_FROM ou TWILIO_MESSAGING_SERVICE_SID.');
  }

  const params = new URLSearchParams();
  params.set('To', to);
  params.set('Body', body);

  if (messagingServiceSid) {
    params.set('MessagingServiceSid', messagingServiceSid);
  } else {
    params.set('From', from);
  }

  if (statusCallback) {
    params.set('StatusCallback', statusCallback);
  }

  if (cli.dryRun) {
    console.log(JSON.stringify({
      channel,
      endpoint: accountSid ? twilioMessagesUrl(accountSid).replace(accountSid, `${accountSid.slice(0, 6)}...`) : undefined,
      to,
      from: messagingServiceSid ? undefined : from,
      messagingServiceSid: messagingServiceSid ? `${messagingServiceSid.slice(0, 6)}...` : undefined,
      bodyLength: body.length
    }, null, 2));
    return;
  }

  if (!accountSid) {
    throw new Error('Env obrigatoria ausente: TWILIO_ACCOUNT_SID');
  }

  if (!authToken) {
    throw new Error('Env obrigatoria ausente: TWILIO_AUTH_TOKEN');
  }

  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const response = await fetch(twilioMessagesUrl(accountSid), {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params
  });

  const contentType = response.headers.get('content-type') ?? '';
  const payload = contentType.includes('application/json')
    ? (await response.json() as TwilioResponse)
    : ({ message: await response.text() } satisfies TwilioResponse);

  if (!response.ok) {
    console.error('Falha ao enviar pelo Twilio.');
    console.error(JSON.stringify({
      httpStatus: response.status,
      code: payload.code ?? payload.error_code,
      message: payload.message ?? payload.error_message,
      moreInfo: payload.more_info
    }, null, 2));
    process.exit(1);
  }

  console.log(JSON.stringify({
    sid: payload.sid,
    status: payload.status,
    to: payload.to,
    from: payload.from,
    messagingServiceSid: payload.messaging_service_sid
  }, null, 2));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  usage();
  process.exit(1);
});
