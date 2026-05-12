import { getBuildId } from '@/lib/build-id';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const HEARTBEAT_MS = 25_000;

export function GET(req: Request): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const safeEnqueue = (chunk: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          closed = true;
        }
      };

      const send = (event: string, data: string) => {
        safeEnqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
      };

      // Initial handshake: client compares this against the buildId it stored
      // on its first SSE message. A mismatch means the container has been
      // replaced (new deploy) and the browser should reload.
      send('hello', JSON.stringify({ buildId: getBuildId() }));

      const heartbeat = setInterval(() => {
        // SSE comments keep the connection alive through proxies (nginx
        // typically idles HTTP connections after ~60s).
        safeEnqueue(encoder.encode(`: heartbeat\n\n`));
      }, HEARTBEAT_MS);

      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      req.signal.addEventListener('abort', close);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      // Nginx-specific: disable response buffering so SSE flushes immediately.
      'X-Accel-Buffering': 'no',
    },
  });
}
