const jstFormatter = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  year:   'numeric',
  month:  '2-digit',
  day:    '2-digit',
  hour:   '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

export function formatJST(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const parts = jstFormatter.formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}.${get('month')}.${get('day')} ${get('hour')}:${get('minute')}:${get('second')} (JST)`;
}

export function secondsAgo(from: string | Date, now: Date): number {
  const fromMs = typeof from === 'string' ? new Date(from).getTime() : from.getTime();
  return Math.floor((now.getTime() - fromMs) / 1000);
}

// JST(UTC+9, no DST)는 항상 UTC + 9h 고정 offset이므로 Intl 없이 산술로 처리.
// display_state.plan_date 비교 + JST 자정까지 남은 시간 계산용.
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function getJstDate(now: Date): string {
  return new Date(now.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

export function getMsUntilJstMidnight(now: Date): number {
  const jstMs = now.getTime() + JST_OFFSET_MS;
  const msIntoJstDay = ((jstMs % DAY_MS) + DAY_MS) % DAY_MS;
  return DAY_MS - msIntoJstDay;
}
