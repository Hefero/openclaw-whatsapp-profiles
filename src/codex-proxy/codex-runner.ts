import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type CodexRunnerConfig = {
  bin: string;
  model: string;
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  webSearch: boolean;
  timeoutMs: number;
  workdir: string;
  maxPromptChars: number;
};

export type CodexRunResult = {
  content: string;
  stdout: string;
  stderr: string;
  durationMs: number;
};

export async function runCodex(prompt: string, config: CodexRunnerConfig): Promise<CodexRunResult> {
  if (prompt.length > config.maxPromptChars) {
    throw new Error(`Prompt is too large (${prompt.length} chars > ${config.maxPromptChars})`);
  }

  const startedAt = Date.now();
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-proxy-'));
  const outputPath = path.join(runDir, 'last-message.txt');

  const args = [
    ...(config.webSearch ? ['--search'] : []),
    'exec',
    '--ephemeral',
    '--skip-git-repo-check',
    '--ignore-rules',
    '--sandbox',
    config.sandbox,
    '--color',
    'never',
    '--output-last-message',
    outputPath,
    '-C',
    config.workdir,
    '--model',
    config.model,
    '-'
  ];

  let stdout = '';
  let stderr = '';

  try {
    const child = spawn(config.bin, args, {
      cwd: config.workdir,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      windowsHide: true
    });

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
    }, config.timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.stdin.write(prompt);
    child.stdin.end();

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });

    clearTimeout(timeout);

    if (exitCode !== 0) {
      const detail = stderr.trim() || stdout.trim() || `codex exited with status ${exitCode}`;
      throw new Error(detail);
    }

    let content = '';
    try {
      content = await fs.readFile(outputPath, 'utf8');
    } catch {
      content = stdout;
    }

    return {
      content: content.trim(),
      stdout,
      stderr,
      durationMs: Date.now() - startedAt
    };
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
}
