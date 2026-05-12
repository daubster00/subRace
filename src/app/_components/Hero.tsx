'use client';

import { SummaryCard } from './SummaryCard';
import type { ClientChannel } from '@/lib/snapshot';

interface HeroProps {
  clientChannel: ClientChannel;
  displayLimit: 50 | 100;
}

const ViewersIcon = (
  <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);
const LikeIcon = (
  <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" /><path d="M7 22V10l5-8a2.4 2.4 0 0 1 4.4 1.7L15 9h5a2 2 0 0 1 2 2.3l-1.4 8A3 3 0 0 1 17.7 22H7Z" />
  </svg>
);

export function Hero({ clientChannel, displayLimit }: HeroProps) {
  const viewers = clientChannel.liveViewers != null
    ? clientChannel.liveViewers.toLocaleString('ja-JP')
    : '—';
  const likes = clientChannel.likeCount.toLocaleString('ja-JP');

  return (
    <section className="flex-none flex justify-between items-start gap-[14px]">
      <div>
        <h1 className="m-0 text-[27px] font-[850] leading-[1.05]" style={{ letterSpacing: 0 }}>
          リアルタイムYouTube登録者ランキング TOP {displayLimit}{' '}
          <span
            className="inline-flex items-center justify-center w-[20px] h-[20px] align-[5px] ml-[5px] text-[13px] font-[800] leading-none rounded-full"
            style={{ border: '2px solid var(--color-primary)', color: 'var(--color-primary)' }}
          >
            i
          </span>
        </h1>
        <p className="m-0 mt-[2px] text-[13px]" style={{ color: 'var(--color-soft)', letterSpacing: 0 }}>
          リアルタイムで集計されるYouTubeチャンネル登録者ランキングです。
        </p>
      </div>
      <div
        aria-label="ライブ概要情報"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(124px, 1fr))',
          gap: '8px',
          minWidth: '268px',
        }}
      >
        <SummaryCard icon={ViewersIcon} label="視聴中" value={viewers} />
        <SummaryCard icon={LikeIcon}    label="高評価" value={likes} />
      </div>
    </section>
  );
}
