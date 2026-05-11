'use client';

import { useState, useEffect } from 'react';

const INTERVAL = 30;

export function NextUpdatePanel() {
  const [remaining, setRemaining] = useState(INTERVAL);

  useEffect(() => {
    const start = Date.now();
    const id = setInterval(() => {
      const elapsed = Math.floor((Date.now() - start) / 1000) % INTERVAL;
      setRemaining(INTERVAL - elapsed);
    }, 500);
    return () => clearInterval(id);
  }, []);

  const progress = remaining / INTERVAL;
  const deg = progress * 360;

  return (
    <article
      className="min-h-[54px] flex items-center gap-[11px] px-[13px] py-[9px]"
      style={{
        gridArea: 'next',
        background: 'linear-gradient(180deg, rgba(12,28,45,0.84), rgba(7,16,27,0.82))',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-panel)',
        boxShadow: '0 0 24px rgba(0,178,255,0.06), inset 0 0 0 1px var(--color-border)',
      }}
    >
      <div
        className="relative w-[38px] h-[38px] flex-none flex items-center justify-center rounded-full"
        style={{
          background: `conic-gradient(var(--color-primary) 0deg ${deg}deg, rgba(0,178,255,0.14) ${deg}deg 360deg)`,
          boxShadow: '0 0 18px rgba(0,178,255,0.25)',
        }}
      >
        <div
          className="absolute inset-[2px] rounded-full"
          style={{ background: 'rgba(7,15,25,1)' }}
        />
        <span
          className="relative z-10 text-[12px] font-[800] text-white"
          style={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {String(remaining).padStart(2, '0')}
        </span>
      </div>
      <div className="min-w-0">
        <h2 className="m-0 text-white text-[15px] font-[800]" style={{ letterSpacing: 0 }}>
          次回更新予定
        </h2>
        <p className="m-0 mt-[3px] text-[12px] leading-[1.35]" style={{ color: 'var(--color-muted)' }}>
          {remaining}秒後に最新データへ自動更新されます。
        </p>
      </div>
    </article>
  );
}
