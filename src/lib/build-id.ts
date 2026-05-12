import fs from 'node:fs';
import path from 'node:path';

// Next.js writes a unique BUILD_ID per `next build`. Each new Docker image
// therefore boots with a different value, which the SSE endpoint uses to tell
// already-open browsers "you're stale, reload."
let cached: string | null = null;

export function getBuildId(): string {
  if (cached !== null) return cached;
  try {
    cached = fs.readFileSync(path.join(process.cwd(), '.next', 'BUILD_ID'), 'utf-8').trim();
  } catch {
    // Dev (`next dev`) or unexpected layout — fall back to a per-process value
    // so SSE still has something stable to send during a single run.
    cached = `dev-${process.pid}-${Date.now()}`;
  }
  return cached;
}
