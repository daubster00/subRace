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
