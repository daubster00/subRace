'use client';

import { useEffect, useMemo, useState } from 'react';

interface ClockProps {
  timezone: string;
}

export function Clock({ timezone }: ClockProps) {
  const formatter = useMemo(() => {
    try {
      return new Intl.DateTimeFormat('ja-JP', {
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      });
    } catch {
      return new Intl.DateTimeFormat('ja-JP', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      });
    }
  }, [timezone]);

  const [text, setText] = useState<string>(() => formatter.format(new Date()));

  useEffect(() => {
    setText(formatter.format(new Date()));
    const id = setInterval(() => {
      setText(formatter.format(new Date()));
    }, 1000);
    return () => clearInterval(id);
  }, [formatter]);

  return (
    <span
      className="font-mono text-[13px] tabular-nums"
      style={{ color: 'var(--color-soft)' }}
      title={timezone}
      suppressHydrationWarning
    >
      {text}
      <span className="ml-1 text-[10px] opacity-60">{timezone}</span>
    </span>
  );
}
