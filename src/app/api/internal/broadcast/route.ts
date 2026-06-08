import { NextResponse } from 'next/server';
import { broadcast } from '@/lib/sse-hub';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// worker→web push 수신 엔드포인트 (BUG-03).
//
// channel-scheduler가 이벤트 적용 후 여기로 POST하면, 연결된 모든 SSE
// 클라이언트로 channel_update를 fan-out한다. proxy(Basic Auth) 뒤에 있고
// worker가 운영자 자격증명으로 호출하므로 별도 시크릿은 두지 않는다.
//
// body: { updates: [{ channelId, subscriberCount, direction, changedAt }] }

interface ChannelUpdate {
  channelId: string;
  subscriberCount: number;
  direction: 'up' | 'down' | null;
  changedAt: string;
}

function isValidUpdate(u: unknown): u is ChannelUpdate {
  if (!u || typeof u !== 'object') return false;
  const o = u as Record<string, unknown>;
  return (
    typeof o.channelId === 'string' &&
    typeof o.subscriberCount === 'number' &&
    (o.direction === 'up' || o.direction === 'down' || o.direction === null) &&
    typeof o.changedAt === 'string'
  );
}

export async function POST(req: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const updates = (body as { updates?: unknown })?.updates;
  if (!Array.isArray(updates)) {
    return NextResponse.json({ error: 'updates_required' }, { status: 400 });
  }

  let sent = 0;
  for (const u of updates) {
    if (isValidUpdate(u)) {
      broadcast('channel_update', JSON.stringify(u));
      sent++;
    }
  }

  return NextResponse.json({ sent }, { status: 200 });
}
