import { spawn, type ChildProcess } from 'node:child_process';
import { config } from '../config.js';

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

/** No shell, bounded output, and terminate the process tree (including ffmpeg). */
export function runProcess(command: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('process cancelled')); return; }
    const child = spawn(command, args, { shell: false, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let size = 0;
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
    child.stderr.resume();
    const clear = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    child.once('error', () => { clear(); reject(new Error('process unavailable')); });
    child.once('close', (code) => {
      clear();
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error('process failed'));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}
