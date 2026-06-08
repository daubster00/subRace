import { getBuildId } from '@/lib/build-id';
import { readSnapshot } from '@/lib/snapshot';
import { addClient, removeClient, type SseSender } from '@/lib/sse-hub';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const HEARTBEAT_MS = 25_000;
// status/clientChannel/baseline 보정용 전체 snapshot 재전송 주기. 구독자 수의
// 실시간 모션은 worker→web channel_update push가 담당하고, 이건 느리게 바뀌는
// 부수 데이터(라이브 시청자/좋아요/소스 상태)와 권위값 재동기화 용도.
const SNAPSHOT_REFRESH_MS = 20_000;

// BUG-03: SSE를 순수 데이터 채널로 승격. 연결 시 전체 snapshot 1회 전송 →
// 이후 worker가 push한 channel_update를 fan-out + 주기적 snapshot 재전송.
// 클라는 /api/snapshot 폴링 대신 이 스트림만 구독한다.
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

      const send: SseSender = (event, data) => {
        safeEnqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
      };

      // 핸드셰이크 + 초기 전체 snapshot.
      send('hello', JSON.stringify({ buildId: getBuildId() }));
      try {
        send('snapshot', JSON.stringify(readSnapshot()));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(`[error] sse_initial_snapshot_failed message="${message}"`);
      }

      // 이후 worker push(channel_update)를 받기 위해 등록.
      addClient(send);

      const refresh = setInterval(() => {
        try {
          send('snapshot', JSON.stringify(readSnapshot()));
        } catch {
          // DB 일시 장애 — 다음 주기에 재시도. 연결은 유지.
        }
      }, SNAPSHOT_REFRESH_MS);

      const heartbeat = setInterval(() => {
        // SSE 주석으로 프록시(nginx ~60s idle) keep-alive.
        safeEnqueue(encoder.encode(`: heartbeat\n\n`));
      }, HEARTBEAT_MS);

      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        clearInterval(refresh);
        removeClient(send);
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
      'X-Accel-Buffering': 'no',
    },
  });
}
