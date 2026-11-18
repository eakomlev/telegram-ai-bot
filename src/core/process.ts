import { spawn, type ChildProcess } from 'node:child_process';
import { config } from '../config.js';

/** Rolling stderr retained for nonzero-exit diagnostics; growth alone never fails the process. */
const STDERR_TAIL_BYTES = 16 * 1024;
/** Hard cap for the sanitized stderr fragment embedded in Error.message. */
const STDERR_MESSAGE_CAP = 1536;

function killProcessTree(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      shell: false, windowsHide: true, stdio: 'ignore',
    });
    const fallback = () => { try { child.kill('SIGKILL'); } catch { /* Already exited. */ } };
    killer.once('error', fallback);
    killer.once('exit', (code) => { if (code !== 0) fallback(); });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch { try { child.kill('SIGKILL'); } catch { /* Already exited. */ } }
  }
}

function appendStderrTail(current: Buffer, chunk: Buffer): Buffer {
  if (chunk.length >= STDERR_TAIL_BYTES) {
    return Buffer.from(chunk.subarray(chunk.length - STDERR_TAIL_BYTES));
  }
  const combined = Buffer.concat([current, chunk]);
  if (combined.length <= STDERR_TAIL_BYTES) return combined;
  return Buffer.from(combined.subarray(combined.length - STDERR_TAIL_BYTES));
}

function sanitizeStderrForMessage(stderr: Buffer): string {
  const text = stderr.toString('utf8')
    .replace(/\0/g, '')
    .replace(/[\u0001-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= STDERR_MESSAGE_CAP) return text;
  return text.slice(text.length - STDERR_MESSAGE_CAP);
}

/** No shell, bounded output, and terminate the process tree (including ffmpeg). */
export function runProcess(command: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('process cancelled')); return; }
    const child = spawn(command, args, { shell: false, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderrTail: Buffer = Buffer.alloc(0);
    let failure: Error | undefined;
    const stop = (reason: string) => {
      if (failure) return;
      failure = new Error(reason);
      killProcessTree(child);
    };
    const timer = setTimeout(() => stop('process timed out'), timeoutMs);
    const abort = () => stop('process cancelled');
    signal?.addEventListener('abort', abort, { once: true });
    // Abort may happen between the initial check and listener registration.
    if (signal?.aborted) abort();
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > config.PROCESS_MAX_STDOUT_BYTES) stop('process output limit exceeded');
      else if (!failure) chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = appendStderrTail(stderrTail, chunk);
    });
    const clear = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    child.once('error', () => { clear(); reject(new Error('process unavailable')); });
    child.once('close', (code) => {
      clear();
      if (failure) reject(failure);
      else if (code !== 0) {
        const detail = sanitizeStderrForMessage(stderrTail);
        reject(new Error(detail ? `process failed: ${detail}` : 'process failed'));
      } else resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}
