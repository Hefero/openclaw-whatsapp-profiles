import path from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { resolveOpenClawCommand } from './openclaw-command.js';

export type OpenClawSendOptions = {
  target: string;
  message: string;
  verbose: boolean;
};

type CliArgs = {
  target?: string;
  message?: string;
  verbose: boolean;
};

type CommandResult = {
  status: number;
  unavailable: boolean;
};

function printChildOutput(result: { stdout?: string | Buffer | null; stderr?: string | Buffer | null }): void {
  const stdout = result.stdout?.toString().trim();
  const stderr = result.stderr?.toString().trim();

  if (stdout) {
    console.log(stdout);
  }

  if (stderr) {
    console.error(stderr);
  }
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { verbose: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--target' || arg === '-t') {
      args.target = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === '--message' || arg === '-m') {
      args.message = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === '--verbose' || arg === '-v') {
      args.verbose = true;
      continue;
    }

    if (!arg.startsWith('-') && !args.message) {
      args.message = arg;
      continue;
    }

    console.error(`Argumento desconhecido: ${arg}`);
    process.exit(1);
  }

  return args;
}

function runSpawn(command: string, args: string[], env: NodeJS.ProcessEnv): CommandResult {
  const spawnCommand = process.platform === 'win32' ? 'cmd.exe' : command;
  const spawnArgs = process.platform === 'win32' ? ['/d', '/c', 'call', command, ...args] : args;
  const result = spawnSync(spawnCommand, spawnArgs, {
    env,
    encoding: 'utf8',
    windowsHide: true
  });

  printChildOutput(result);

  if (result.error) {
    console.error(result.error.message);
    return {
      status: 1,
      unavailable: (result.error as NodeJS.ErrnoException).code === 'ENOENT'
    };
  }

  return { status: result.status ?? 1, unavailable: false };
}

function runNpxFallback(args: string[], env: NodeJS.ProcessEnv): CommandResult {
  if (process.platform === 'win32') {
    const result = spawnSync('cmd', ['/c', 'npx', ...args], {
      env,
      encoding: 'utf8',
      windowsHide: true
    });

    printChildOutput(result);

    if (result.error) {
      console.error(result.error.message);
      return {
        status: 1,
        unavailable: (result.error as NodeJS.ErrnoException).code === 'ENOENT'
      };
    }

    return { status: result.status ?? 1, unavailable: false };
  }

  const result = spawnSync('npx', args, {
    env,
    encoding: 'utf8'
  });

  printChildOutput(result);

  if (result.error) {
    console.error(result.error.message);
    return {
      status: 1,
      unavailable: (result.error as NodeJS.ErrnoException).code === 'ENOENT'
    };
  }

  return { status: result.status ?? 1, unavailable: false };
}

export function runOpenClawSend(opts: OpenClawSendOptions): number {
  const baseSendArgs = [
    'message',
    'send',
    '--channel',
    'whatsapp',
    '--target',
    opts.target,
    '--message',
    opts.message
  ];

  if (opts.verbose) {
    baseSendArgs.push('--verbose');
  }

  const cacheDir = path.join(process.cwd(), '.tmp-npm-cache');
  const fallbackEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NPM_CONFIG_CACHE: cacheDir,
    OPENCLAW_NPM_CACHE: cacheDir
  };

  const command = resolveOpenClawCommand();
  const result = runSpawn(command, baseSendArgs, fallbackEnv);

  if (result.status === 0) {
    return 0;
  }

  if (!result.unavailable) {
    return result.status;
  }

  const npxArgs = [
    '--yes',
    '--cache',
    cacheDir,
    '--package',
    'openclaw@latest',
    'openclaw',
    ...baseSendArgs
  ];

  const npxResult = runNpxFallback(npxArgs, fallbackEnv);
  if (npxResult.unavailable) {
    console.error('npx não estava disponível.');
    return 1;
  }

  return npxResult.status;
}

function usage() {
  console.log(`
Uso:
  npm run openclaw:send -- --target +15551234567 --message "hello"
`);
}

if (process.argv[1]?.endsWith('openclaw-send.ts')) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.target || !args.message) {
    usage();
    process.exit(1);
  }

  const status = runOpenClawSend({
    target: args.target,
    message: args.message,
    verbose: args.verbose
  });

  if (status !== 0) {
    console.error('Falha ao enviar mensagem pelo OpenClaw.');
    console.error('Dica: rode `openclaw status --deep`, valide pairing/plugin/whatsapp e retry.');
    process.exit(status);
  }

  console.log('Mensagem enviada com sucesso (ou enfileirada pelo openclaw).');
}
