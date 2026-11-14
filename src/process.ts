import { spawn } from 'node:child_process';

/** No shell, bounded output, and kill the entire process group (including ffmpeg). */
export function runProcess(command: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('cancelled')); return; }
    const child = spawn(command, args, { shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    const stop = () => {
      failed = true;
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ } }
    };
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) stop();
      else chunks.push(chunk);
    });
    // Drain stderr but never log downloader output (may contain signed URLs).
    child.stderr.resume();
    const clear = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); };
    child.once('error', () => { clear(); reject(new Error('process unavailable')); });
    child.once('close', (code) => {
      clear();
      if (failed || code !== 0) reject(new Error('process failed'));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}
