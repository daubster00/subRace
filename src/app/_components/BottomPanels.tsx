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
      className="relative h-[78px] overflow-hidden px-[14px] py-[10px] flex flex-col justify-center gap-[6px]"
      style={{
        background: 'linear-gradient(180deg, rgba(10,27,44,0.96), rgba(5,13,24,0.94))',
        border: '1px solid rgba(0,178,255,0.32)',
        borderRadius: 'var(--radius-panel)',
        boxShadow: '0 0 32px rgba(0,178,255,0.1), inset 0 0 0 1px rgba(255,255,255,0.04)',
      }}
    >
      <div className="flex items-center gap-[12px]">
        <p className="m-0 text-[10px] font-[850] uppercase leading-none whitespace-nowrap" style={{ color: 'var(--color-primary)', letterSpacing: '0.08em' }}>
          Page
        </p>
        <div className="flex items-center gap-[8px]">
          <span
            className="inline-flex h-[30px] items-center justify-center rounded-[6px] px-[12px] text-[14px] font-[900]"
            style={{
              color: isTopPage ? '#06111b' : 'rgba(216,227,242,0.74)',
              background: isTopPage ? 'linear-gradient(135deg, #00b2ff, #1ee6b8)' : 'rgba(255,255,255,0.06)',
              boxShadow: isTopPage ? '0 0 16px rgba(0,178,255,0.34)' : undefined,
              border: '1px solid rgba(0,178,255,0.22)',
            }}
          >
            1位 - 50位
          </span>
          <span className="text-[16px] font-[900]" style={{ color: 'var(--color-primary)' }}>⇄</span>
          <span
            className="inline-flex h-[30px] items-center justify-center rounded-[6px] px-[12px] text-[14px] font-[900]"
            style={{
              color: !isTopPage && displayLimit === 100 ? '#06111b' : 'rgba(216,227,242,0.74)',
              background: !isTopPage && displayLimit === 100 ? 'linear-gradient(135deg, #00b2ff, #1ee6b8)' : 'rgba(255,255,255,0.06)',
              boxShadow: !isTopPage && displayLimit === 100 ? '0 0 16px rgba(0,178,255,0.34)' : undefined,
              border: '1px solid rgba(0,178,255,0.22)',
            }}
          >
            51位 - 100位
          </span>
        </div>
      </div>
      <div className="flex items-center justify-between gap-[10px] text-[11px] font-[750] whitespace-nowrap" style={{ color: 'var(--color-muted)' }}>
        <span>{displayLimit === 100 ? `次は ${nextLabel}` : 'TOP 50 固定表示'}</span>
        <span>20秒ごとに切替</span>
      </div>
    </article>
  );
}

function RisingChannelsPanel({ channels }: Pick<BottomPanelsProps, 'channels'>) {
  // 急上昇 = 최근 24h 증가량. readSnapshot이 매 요청마다 surge_baseline_count
  // (≥24h 전 가장 최근 스냅샷)로 다시 계산하므로 폴링 갱신마다 순위가 갱신된다.
  // 30~60일 누적인 trendDelta로 정렬하면 baseline 기간이 다른 채널끼리 표시값과
  // 정렬 키가 어긋난다 (사용자 보고: 큰 값이 뒷 순위).
  const rising = channels
    .filter((c) => c.surgeDelta24h != null && c.surgeDelta24h > 0)
    .sort((a, b) => (b.surgeDelta24h ?? 0) - (a.surgeDelta24h ?? 0))
    .slice(0, 5);

  return (
    <article
      className="h-[78px] px-[14px] py-[8px] flex items-center gap-[10px]"
      style={{
        background: 'linear-gradient(180deg, rgba(10,27,44,0.96), rgba(5,13,24,0.94))',
        border: '1px solid rgba(30,230,184,0.28)',
        borderRadius: 'var(--radius-panel)',
        boxShadow: '0 0 32px rgba(30,230,184,0.1), inset 0 0 0 1px rgba(255,255,255,0.04)',
      }}
    >
      <div className="flex flex-col flex-none">
        <p className="m-0 text-[10px] font-[850] uppercase leading-none" style={{ color: '#1ee6b8', letterSpacing: '0.08em' }}>
          Trending
        </p>
        <h2 className="m-0 mt-[4px] text-[14px] font-[900] leading-none text-white whitespace-nowrap" style={{ letterSpacing: 0 }}>
          急上昇
        </h2>
      </div>
      {rising.length === 0 ? (
        <div
          className="flex-1 flex h-[58px] items-center justify-center rounded-[8px] text-[11px] font-[750]"
          style={{ color: 'var(--color-muted)', background: 'rgba(255,255,255,0.04)', border: '1px dashed rgba(216,227,242,0.12)' }}
        >
          履歴データが揃い次第表示します
        </div>
      ) : (
        <div className="flex-1 grid gap-[6px]" style={{ gridTemplateColumns: 'repeat(5, minmax(0, 1fr))' }}>
          {rising.map((channel, index) => (
            <div
              key={channel.id}
              className="min-w-0 rounded-[8px] px-[7px] py-[5px] flex items-center gap-[7px]"
              style={{
                background: index === 0 ? 'rgba(30,230,184,0.13)' : 'rgba(255,255,255,0.055)',
                border: index === 0 ? '1px solid rgba(30,230,184,0.3)' : '1px solid rgba(216,227,242,0.1)',
              }}
            >
              <div
                className="h-[30px] w-[30px] flex-none overflow-hidden rounded-full text-[10px] font-[900]"
                style={{
                  background: 'linear-gradient(135deg, #1d9fff, #1ee6b8)',
                  boxShadow: '0 0 0 1px rgba(255,255,255,0.12), 0 4px 12px rgba(0,0,0,0.24)',
                }}
              >
                {channel.thumbnailUrl ? (
                  <Image
                    src={channel.thumbnailUrl}
                    alt={channel.name}
                    width={30}
                    height={30}
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
                <div className="flex items-center gap-[5px] min-w-0">
                  <span
                    className="inline-flex h-[15px] min-w-[22px] flex-none items-center justify-center rounded-[4px] text-[9px] font-[900]"
                    style={{ color: '#06111b', background: index === 0 ? '#1ee6b8' : 'rgba(216,227,242,0.86)' }}
                  >
                    {index + 1}
                  </span>
                  <p className="m-0 truncate text-[12px] font-[800]" style={{ color: '#edf7ff' }}>
                    {channel.name}
                  </p>
                </div>
                <p className="m-0 mt-[2px] text-[11px] font-[850]" style={{ color: 'var(--color-increase)' }}>
                  +{(channel.surgeDelta24h ?? 0).toLocaleString('ja-JP')}
                </p>
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
