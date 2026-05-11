'use client';

import { useState, useEffect } from 'react';
import { formatJST, secondsAgo } from '@/lib/time';

interface TimestampProps {
  serverTime: string;
}

export function Timestamp({ serverTime }: TimestampProps) {
  const [now, setNow] = useState(() => new Date(serverTime));

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const ago = secondsAgo(serverTime, now);

  return (
    <div
      className="self-center min-w-[214px] text-right whitespace-nowrap text-[12px]"
      style={{ gridArea: 'time', color: 'rgba(216,227,242,0.78)', letterSpacing: 0 }}
    >
      {formatJST(now)} · 更新 {ago}秒前
    </div>
  );
}
