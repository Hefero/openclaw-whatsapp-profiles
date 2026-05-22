import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import 'dotenv/config';

import {
  ensureRuntimeDir,
  isPidRunning,
  logPath,
  printStatuses,
  readPidInfo,
  removePidInfo,
  spawnManagedDirect,
  stopManaged,
  tcpOpen,
  waitFor,
  writePidInfo,
  type ManagedStatus
} from './warmup-utils.js';

const root = process.cwd();
const host = process.env.WHISPER_LOCAL_HOST ?? '127.0.0.1';
const port = Number(process.env.WHISPER_LOCAL_PORT ?? '2022');
const modelName = process.env.WHISPER_LOCAL_MODEL ?? 'base';
const installDir = path.resolve(process.env.WHISPER_LOCAL_DIR ?? path.join('data', 'whisper'));
const binDir = path.join(installDir, 'bin');
const modelDir = path.join(installDir, 'models');
const ffmpegDir = path.join(installDir, 'ffmpeg');
const release = process.env.WHISPER_LOCAL_RELEASE ?? 'v1.8.4';
const defaultZipUrl =
  process.platform === 'win32'
    ? `https://github.com/ggml-org/whisper.cpp/releases/download/${release}/whisper-bin-x64.zip`
    : undefined;
const zipUrl = process.env.WHISPER_LOCAL_ZIP_URL ?? defaultZipUrl;
const modelPath = path.resolve(
  process.env.WHISPER_LOCAL_MODEL_PATH ?? path.join(modelDir, `ggml-${modelName}.bin`)
);
const modelUrl =
  process.env.WHISPER_LOCAL_MODEL_URL ??
  `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${modelName}.bin`;
const ffmpegZipUrl =
  process.env.WHISPER_LOCAL_FFMPEG_ZIP_URL ??
  'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';

function download(url: string, destination: string, redirects = 0): Promise<void> {
  const client = url.startsWith('https:') ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.get(url, (response) => {
      const location = response.headers.location;
      if (location && response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
        response.resume();
        if (redirects > 5) {
          reject(new Error(`too many redirects while downloading ${url}`));
          return;
        }
        resolve(download(new URL(location, url).toString(), destination, redirects + 1));
        return;
      }

      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`download failed ${response.statusCode ?? 'unknown'} for ${url}`));
        return;
      }

      const file = fs.createWriteStream(destination);
      response.pipe(file);
      file.on('finish', () => {
        file.close(() => resolve());
      });
      file.on('error', reject);
    });

    request.on('error', reject);
  });
}

async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
}

function findExecutable(dir: string): string | undefined {
  const names =
    process.platform === 'win32'
      ? ['whisper-server.exe', 'server.exe']
      : ['whisper-server', 'server'];

  const pending = [dir];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || !fs.existsSync(current)) {
      continue;
    }

    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
      } else if (names.includes(entry.name)) {
        return fullPath;
      }
    }
  }

  return undefined;
}

function findNamedExecutable(dir: string, executable: string): string | undefined {
  const pending = [dir];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || !fs.existsSync(current)) {
      continue;
    }

    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
      } else if (entry.name.toLowerCase() === executable.toLowerCase()) {
        return fullPath;
      }
    }
  }

  return undefined;
}

function resolveCommand(): string | undefined {
  if (process.env.WHISPER_LOCAL_COMMAND) {
    return path.resolve(process.env.WHISPER_LOCAL_COMMAND);
  }

  const installed = findExecutable(binDir);
  if (installed) {
    return installed;
  }

  const lookup = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(lookup, ['whisper-server'], { encoding: 'utf8' });
  const first = result.stdout?.split(/\r?\n/).find(Boolean);
  return first?.trim();
}

function resolveFfmpeg(): string | undefined {
  if (process.env.WHISPER_LOCAL_FFMPEG_COMMAND) {
    return path.resolve(process.env.WHISPER_LOCAL_FFMPEG_COMMAND);
  }

  const installed = findNamedExecutable(ffmpegDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (installed) {
    return installed;
  }

  const lookup = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(lookup, ['ffmpeg'], { encoding: 'utf8' });
  const first = result.stdout?.split(/\r?\n/).find(Boolean);
  return first?.trim();
}

function envWithFfmpeg(ffmpegPath: string): NodeJS.ProcessEnv {
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const ffmpegBin = path.dirname(ffmpegPath);
  const currentPath = process.env[pathKey] ?? process.env.PATH ?? '';
  const nextPath = [ffmpegBin, currentPath].filter(Boolean).join(delimiter);
  return {
    ...process.env,
    [pathKey]: nextPath,
    PATH: nextPath
  };
}

async function extractZip(zipPath: string, destinationDir: string): Promise<void> {
  if (process.platform === 'win32') {
    const result = spawnSync(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `Expand-Archive -Force -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destinationDir.replace(/'/g, "''")}'`],
      { cwd: root, stdio: 'inherit' }
    );
    if (result.status !== 0) {
      throw new Error('failed to extract whisper.cpp zip');
    }
    return;
  }

  const result = spawnSync('unzip', ['-o', zipPath, '-d', destinationDir], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error('failed to extract whisper.cpp zip');
  }
}

async function ensureInstalled(): Promise<string> {
  await ensureDir(installDir);
  await ensureDir(binDir);
  await ensureDir(modelDir);
  await ensureDir(ffmpegDir);

  let command = resolveCommand();
  if (!command) {
    if (!zipUrl) {
      throw new Error('WHISPER_LOCAL_COMMAND is required on this platform unless whisper-server is on PATH');
    }

    const zipPath = path.join(installDir, `whisper-${release}.zip`);
    if (!fs.existsSync(zipPath)) {
      console.log(`downloading whisper.cpp ${release}`);
      await download(zipUrl, zipPath);
    }

    await extractZip(zipPath, binDir);
    command = resolveCommand();
  }

  if (!command) {
    throw new Error('whisper-server executable not found after install');
  }

  if (!fs.existsSync(modelPath)) {
    console.log(`downloading Whisper model ${modelName}`);
    await download(modelUrl, modelPath);
  }

  let ffmpeg = resolveFfmpeg();
  if (!ffmpeg) {
    if (process.platform !== 'win32') {
      throw new Error('ffmpeg is required for WhatsApp audio conversion; install it or set WHISPER_LOCAL_FFMPEG_COMMAND');
    }

    const zipPath = path.join(installDir, 'ffmpeg-release-essentials.zip');
    if (!fs.existsSync(zipPath)) {
      console.log('downloading portable FFmpeg');
      await download(ffmpegZipUrl, zipPath);
    }

    await extractZip(zipPath, ffmpegDir);
    ffmpeg = resolveFfmpeg();
  }

  if (!ffmpeg) {
    throw new Error('ffmpeg executable not found after install');
  }

  return command;
}

function serverArgs(): string[] {
  return [
    '--model',
    modelPath,
    '--host',
    host,
    '--port',
    String(port),
    '--inference-path',
    '/v1/audio/transcriptions',
    '--threads',
    process.env.WHISPER_LOCAL_THREADS ?? '4',
    '--processors',
    process.env.WHISPER_LOCAL_PROCESSORS ?? '1',
    '--convert',
    '--print-progress'
  ];
}

function status(): ManagedStatus {
  const info = readPidInfo('whisper-local');
  const running = isPidRunning(info?.pid);
  return {
    name: 'whisper-local',
    pid: info?.pid,
    running,
    healthy: undefined,
    detail: running ? 'pid running' : 'not running',
    logPath: info?.logPath ?? logPath('whisper-local')
  };
}

async function pidsForPort(targetPort: number): Promise<number[]> {
  if (process.platform !== 'win32') {
    return [];
  }

  const command = [
    `$pids = Get-NetTCPConnection -LocalPort ${targetPort} -State Listen -ErrorAction SilentlyContinue |`,
    'Select-Object -ExpandProperty OwningProcess -Unique;',
    '$pids -join ","'
  ].join(' ');

  const proc = await new Promise<{ stdout: string }>((resolve) => {
    const ps = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { windowsHide: true }
    );
    let stdout = '';
    ps.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    ps.on('close', () => resolve({ stdout }));
    ps.on('error', () => resolve({ stdout: '' }));
  });

  return proc.stdout
    .trim()
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((pid) => Number.isFinite(pid) && pid > 0 && pid !== process.pid);
}

async function statusWithHealth(): Promise<ManagedStatus> {
  const current = status();
  return {
    ...current,
    healthy: await tcpOpen(host, port)
  };
}

async function runForeground(): Promise<void> {
  const command = await ensureInstalled();
  const ffmpeg = resolveFfmpeg();
  if (!ffmpeg) {
    throw new Error('ffmpeg executable not found');
  }
  const child = spawn(command, serverArgs(), {
    cwd: root,
    env: envWithFfmpeg(ffmpeg),
    stdio: 'inherit',
    windowsHide: true
  });

  await new Promise<void>((resolve, reject) => {
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`whisper-server exited with status ${code ?? 'unknown'}`));
      }
    });
    child.on('error', reject);
  });
}

async function startManaged(): Promise<void> {
  const command = await ensureInstalled();
  const ffmpeg = resolveFfmpeg();
  if (!ffmpeg) {
    throw new Error('ffmpeg executable not found');
  }
  printStatuses([stopManaged('whisper-local')]);

  const existingHealthy = await tcpOpen(host, port);
  if (existingHealthy) {
    const pids = await pidsForPort(port);
    if (pids.length === 0) {
      throw new Error(`port ${port} is already in use; stop the existing whisper server first`);
    }

    for (const pid of pids) {
      process.kill(pid, 'SIGTERM');
      console.log(`cleared whisper port ${port} pid ${pid}`);
    }

    const cleared = await waitFor(async () => !(await tcpOpen(host, port)), 10_000);
    if (!cleared) {
      throw new Error(`port ${port} is still in use after stopping previous whisper server`);
    }
  }

  const info =
    process.platform === 'win32'
      ? (() => {
          ensureRuntimeDir();
          const output = fs.openSync(logPath('whisper-local'), 'a');
          const child = spawn(command, serverArgs(), {
            cwd: root,
            detached: true,
            env: envWithFfmpeg(ffmpeg),
            stdio: ['ignore', output, output],
            windowsHide: true
          });
          child.unref();
          const pidInfo = {
            name: 'whisper-local' as const,
            pid: child.pid ?? 0,
            command,
            args: serverArgs(),
            startedAt: new Date().toISOString(),
            logPath: logPath('whisper-local')
          };
          writePidInfo(pidInfo);
          return pidInfo;
        })()
      : spawnManagedDirect('whisper-local', command, serverArgs(), envWithFfmpeg(ffmpeg));

  console.log(`whisper-local started pid=${info.pid} log=${info.logPath}`);
  const ready = await waitFor(() => tcpOpen(host, port), 45_000);
  if (!ready) {
    throw new Error(`whisper-local did not open ${host}:${port} within 45s`);
  }
  printStatuses([await statusWithHealth()]);
}

async function main(): Promise<void> {
  const action = process.argv[2] ?? 'warmup';
  if (action === 'install') {
    const command = await ensureInstalled();
    console.log(`whisper-server: ${command}`);
    console.log(`model: ${modelPath}`);
    return;
  }

  if (action === 'server') {
    await runForeground();
    return;
  }

  if (action === 'start' || action === 'warmup') {
    await startManaged();
    return;
  }

  if (action === 'stop') {
    printStatuses([stopManaged('whisper-local')]);
    removePidInfo('whisper-local');
    return;
  }

  if (action === 'status') {
    printStatuses([await statusWithHealth()]);
    return;
  }

  throw new Error(`unknown whisper-local action: ${action}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
