interface LiveStatusPanelProps {
  statusOk: boolean;
}

export function LiveStatusPanel({ statusOk }: LiveStatusPanelProps) {
  const dotColor = statusOk ? 'var(--color-primary)' : '#f97316';
  const dotGlow = statusOk
    ? '0 0 14px rgba(0,178,255,0.7)'
    : '0 0 14px rgba(249,115,22,0.7)';
  const statusText = statusOk
    ? '全チャンネルの登録者数をリアルタイムで追跡中です。'
    : '一部データソースの接続が遅延しています。最後の正常データを表示中です。';

  return (
    <article
      className="min-h-[54px] flex items-center gap-[12px] px-[13px] py-[9px]"
      style={{
        gridArea: 'live',
        background: 'linear-gradient(180deg, rgba(12,28,45,0.84), rgba(7,16,27,0.82))',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-panel)',
        boxShadow: '0 0 24px rgba(0,178,255,0.06), inset 0 0 0 1px var(--color-border)',
      }}
    >
      <div className="min-w-0">
        <h2
          className="m-0 flex items-center gap-[7px] text-white text-[15px] font-[800]"
          style={{ letterSpacing: 0 }}
        >
          <span
            className="w-[12px] h-[12px] flex-none rounded-full"
            style={{
              background: dotColor,
              boxShadow: dotGlow,
              transition: 'background 0.4s, box-shadow 0.4s',
            }}
          />
          リアルタイム状態
        </h2>
        <p
          className="m-0 mt-[3px] text-[12px] leading-[1.35]"
          style={{
            color: 'var(--color-muted)',
            transition: 'color 0.4s',
          }}
        >
          {statusText}
        </p>
      </div>
    </article>
  );
}
