import { NextResponse } from 'next/server';
import { readSnapshot } from '@/lib/snapshot';

export function GET(): NextResponse {
  try {
    const data = readSnapshot();
    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[error] db_query_failed query=snapshot.read message="${message}"`);
    return NextResponse.json({ error: 'snapshot_unavailable' }, { status: 500 });
  }
}
