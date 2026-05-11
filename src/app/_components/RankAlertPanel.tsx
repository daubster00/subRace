interface RankAlertPanelProps {
  alertCount: number;
}

export function RankAlertPanel({ alertCount }: RankAlertPanelProps) {
  return (
    <article
      className="min-h-[54px] flex items-center gap-[11px] px-[13px] py-[9px]"
      style={{
        gridArea: 'alert',
        background: 'linear-gradient(180deg, rgba(12,28,45,0.84), rgba(7,16,27,0.82))',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-panel)',
        boxShadow: '0 0 24px rgba(0,178,255,0.06), inset 0 0 0 1px var(--color-border)',
      }}
    >
      <div
        className="w-[34px] h-[34px] flex-none flex items-center justify-center"
        style={{ color: 'var(--color-alert)', filter: 'drop-shadow(0 0 10px rgba(255,51,69,0.42))' }}
        aria-hidden="true"
      >
        <svg viewBox="0 0 24 24" width={28} height={28} fill="currentColor" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
          <path d="M13.7 21a2 2 0 0 1-3.4 0" />
        </svg>
      </div>
      <div className="min-w-0">
        <h2
          className="m-0 flex items-center gap-[7px] text-white text-[15px] font-[800]"
          style={{ letterSpacing: 0 }}
        >
          順位変動アラート
          <span
            className="inline-flex items-center justify-center min-w-[28px] h-[18px] px-[8px] rounded-full text-white text-[11px] leading-none"
            style={{ background: alertCount > 0 ? 'var(--color-alert)' : 'var(--color-muted)' }}
          >
            {alertCount}
          </span>
        </h2>
        <p
          className="m-0 mt-[3px] text-[12px] leading-[1.35]"
          style={{ color: 'var(--color-muted)' }}
        >
          {alertCount > 0
            ? '一部チャンネルの順位がまもなく変動する可能性があります。'
            : '現在、間近な順位変動はありません。'}
        </p>
      </div>
    </article>
  );
}
