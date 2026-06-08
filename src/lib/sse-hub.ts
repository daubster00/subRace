// SSE 클라이언트 레지스트리 (BUG-03).
//
// /api/events가 연결을 등록하고, /api/internal/broadcast(worker→web push)가
// 등록된 모든 클라이언트로 fan-out한다. `next start`는 단일 Node 프로세스라
// 이 모듈 싱글톤 Set이 두 라우트 핸들러 사이에서 공유된다.

export type SseSender = (event: string, data: string) => void;

const clients = new Set<SseSender>();

export function addClient(send: SseSender): void {
  clients.add(send);
}

export function removeClient(send: SseSender): void {
  clients.delete(send);
}

export function broadcast(event: string, data: string): void {
  for (const send of clients) {
    try {
      send(event, data);
    } catch {
      // 끊긴 연결 — 다음 abort 콜백에서 정리됨. 여기선 무시.
    }
  }
}

export function clientCount(): number {
  return clients.size;
}
