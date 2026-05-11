import Image from 'next/image';
import type { InterpolatedChannel } from '@/hooks/useInterpolatedSnapshot';

interface BottomPanelsProps {
  rankPage: 0 | 1;
  displayLimit: 50 | 100;
  channels: InterpolatedChannel[];
}

function PageCyclePanel({
  rankPage,
  displayLimit,
}: Pick<BottomPanelsProps, 'rankPage' | 'displayLimit'>) {
  const isTopPage = rankPage === 0;
  const nextLabel = isTopPage ? '51位 - 100位' : '1位 - 50位';

  return (
    <article
      className="relative min-h-[118px] overflow-hidden px-[18px] py-[14px]"
      style={{
        background: 'linear-gradient(180deg, rgba(10,27,44,0.96), rgba(5,13,24,0.94))',
        border: '1px solid rgba(0,178,255,0.32)',
        borderRadius: 'var(--radius-panel)',
        boxShadow: '0 0 32px rgba(0,178,255,0.1), inset 0 0 0 1px rgba(255,255,255,0.04)',
      }}
    >
      <div className="flex items-center justify-between gap-[14px]">
        <div>
          <p className="m-0 text-[11px] font-[850] uppercase leading-none" style={{ color: 'var(--color-primary)', letterSpacing: '0.08em' }}>
            Ranking Page
          </p>
          <h2 className="m-0 mt-[6px] text-[22px] font-[900] leading-none text-white" style={{ letterSpacing: 0 }}>
            {isTopPage ? '1位 - 50位' : '51位 - 100位'}
          </h2>
        </div>
        <div
          className="flex h-[38px] items-center rounded-[8px] p-[3px]"
          style={{ background: 'rgba(1,7,14,0.72)', border: '1px solid rgba(0,178,255,0.22)' }}
        >
          {(['1-50', '51-100'] as const).map((label, index) => {
            const active = index === rankPage;
            return (
              <span
                key={label}
                className="inline-flex h-[30px] min-w-[78px] items-center justify-center rounded-[6px] text-[13px] font-[900]"
                style={{
                  color: active ? '#06111b' : 'rgba(216,227,242,0.74)',
                  background: active
                    ? 'linear-gradient(135deg, #00b2ff, #1ee6b8)'
                    : 'transparent',
                  boxShadow: active ? '0 0 16px rgba(0,178,255,0.34)' : undefined,
                  transition: 'background 260ms ease, color 260ms ease',
                }}
              >
                {label}
              </span>
            );
          })}
        </div>
      </div>
      <div className="mt-[15px] grid items-center gap-[12px]" style={{ gridTemplateColumns: '1fr 38px 1fr' }}>
        <div
          className="h-[30px] rounded-[7px] px-[11px] text-[12px] font-[850] leading-[30px]"
          style={{
            color: isTopPage ? '#06111b' : 'rgba(216,227,242,0.76)',
            background: isTopPage ? 'rgba(30,230,184,0.92)' : 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(30,230,184,0.26)',
          }}
        >
          1位 - 50位
        </div>
        <div
          className="flex h-[30px] items-center justify-center rounded-full text-[18px] font-[900]"
          style={{ color: 'var(--color-primary)', background: 'rgba(0,178,255,0.1)', border: '1px solid rgba(0,178,255,0.25)' }}
        >
          ⇄
        </div>
        <div
          className="h-[30px] rounded-[7px] px-[11px] text-right text-[12px] font-[850] leading-[30px]"
          style={{
            color: !isTopPage && displayLimit === 100 ? '#06111b' : 'rgba(216,227,242,0.76)',
            background: !isTopPage && displayLimit === 100 ? 'rgba(30,230,184,0.92)' : 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(30,230,184,0.26)',
          }}
        >
          51位 - 100位
        </div>
      </div>
      <div className="mt-[11px] flex items-center justify-between gap-[12px] text-[12px] font-[750]" style={{ color: 'var(--color-muted)' }}>
        <span>{displayLimit === 100 ? `次は ${nextLabel}` : 'TOP 50 固定表示'}</span>
        <span>20秒ごとに切替</span>
      </div>
    </article>
  );
}

function RisingChannelsPanel({ channels }: Pick<BottomPanelsProps, 'channels'>) {
  // Rank by long-window average velocity: prefer a roughly one-month baseline,
  // falling back to the oldest available snapshot until enough history exists.
  const rising = channels
    .filter((c) => c.growthRatePerHour != null && c.trendDelta != null && c.trendDelta > 0)
    .sort((a, b) => (b.growthRatePerHour ?? 0) - (a.growthRatePerHour ?? 0))
    .slice(0, 5);

  return (
    <article
      className="min-h-[118px] px-[18px] py-[14px]"
      style={{
        background: 'linear-gradient(180deg, rgba(10,27,44,0.96), rgba(5,13,24,0.94))',
        border: '1px solid rgba(30,230,184,0.28)',
        borderRadius: 'var(--radius-panel)',
        boxShadow: '0 0 32px rgba(30,230,184,0.1), inset 0 0 0 1px rgba(255,255,255,0.04)',
      }}
    >
      <div className="flex items-center justify-between gap-[10px]">
        <div>
          <p className="m-0 text-[11px] font-[850] uppercase leading-none" style={{ color: '#1ee6b8', letterSpacing: '0.08em' }}>
            Trending
          </p>
          <h2 className="m-0 mt-[6px] text-[21px] font-[900] leading-none text-white" style={{ letterSpacing: 0 }}>
            最近急上昇チャンネル
          </h2>
        </div>
        <span className="text-[18px] font-[900]" style={{ color: '#1ee6b8', filter: 'drop-shadow(0 0 10px rgba(30,230,184,0.34))' }}>
          HOT
        </span>
      </div>
      {rising.length === 0 ? (
        <div
          className="mt-[14px] flex h-[64px] items-center justify-center rounded-[8px] text-[12px] font-[750]"
          style={{ color: 'var(--color-muted)', background: 'rgba(255,255,255,0.04)', border: '1px dashed rgba(216,227,242,0.12)' }}
        >
          履歴データが揃い次第表示します
        </div>
      ) : (
        <div className="mt-[12px] grid gap-[7px]" style={{ gridTemplateColumns: 'repeat(5, minmax(0, 1fr))' }}>
          {rising.map((channel, index) => (
            <div
              key={channel.id}
              className="min-w-0 rounded-[8px] px-[8px] py-[7px]"
              style={{
                background: index === 0 ? 'rgba(30,230,184,0.13)' : 'rgba(255,255,255,0.055)',
                border: index === 0 ? '1px solid rgba(30,230,184,0.3)' : '1px solid rgba(216,227,242,0.1)',
              }}
            >
              <div className="flex items-center justify-between gap-[8px]">
                <span
                  className="inline-flex h-[19px] min-w-[30px] items-center justify-center rounded-[6px] text-[10px] font-[900]"
                  style={{ color: '#06111b', background: index === 0 ? '#1ee6b8' : 'rgba(216,227,242,0.86)' }}
                >
                  No.{index + 1}
                </span>
                <span className="text-[12px] font-[900]" style={{ color: 'var(--color-increase)' }}>
                  +{(channel.trendDelta ?? 0).toLocaleString('ja-JP')}
                </span>
              </div>
              <div className="mt-[7px] flex min-w-0 items-center gap-[7px]">
                <div
                  className="h-[28px] w-[28px] flex-none overflow-hidden rounded-full text-[10px] font-[900]"
                  style={{
                    background: 'linear-gradient(135deg, #1d9fff, #1ee6b8)',
                    boxShadow: '0 0 0 1px rgba(255,255,255,0.12), 0 4px 12px rgba(0,0,0,0.24)',
                  }}
                >
                  {channel.thumbnailUrl ? (
                    <Image
                      src={channel.thumbnailUrl}
                      alt={channel.name}
                      width={28}
                      height={28}
                      className="h-full w-full object-cover"
                      unoptimized
                    />
                  ) : (
                    <span className="flex h-full w-full items-center justify-center text-white">
                      {channel.name.slice(0, 2)}
                    </span>
                  )}
                </div>
                <div className="m-0 min-w-0 flex-1">
                  <p className="m-0 truncate text-[12px] font-[800]" style={{ color: '#edf7ff' }}>
                    {channel.name}
                  </p>
                  <p className="m-0 text-[10px] font-[750]" style={{ color: 'var(--color-increase)' }}>
                    +{Math.round((channel.growthRatePerHour ?? 0) * 24).toLocaleString('ja-JP')} / day
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

export function BottomPanels({
  rankPage,
  displayLimit,
  channels,
}: BottomPanelsProps) {
  return (
    <section
      aria-label="ランキング補助情報"
      className="flex-none mt-[8px]"
      style={{
        display: 'grid',
        gridTemplateColumns: '0.9fr 1.35fr',
        gap: '10px',
        alignItems: 'stretch',
      }}
    >
      <PageCyclePanel rankPage={rankPage} displayLimit={displayLimit} />
      <RisingChannelsPanel channels={channels} />
    </section>
  );
}
