process.env.WORKER_PROCESS_NAME ??= 'twilio-worker';
process.env.WORKER_PROCESS_ARGS ??= 'run twilio:worker';
process.env.WHATSAPP_ASSISTANT_HOOK_PORT ??= process.env.TWILIO_WORKER_PORT ?? '8791';
process.env.WHATSAPP_ASSISTANT_TWILIO_ONLY = 'true';

await import('../src/index.js');
