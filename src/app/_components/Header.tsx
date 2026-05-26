import type { ReactNode } from 'react';
import { SettingsButton } from './SettingsPanel';
import { Clock } from './Clock';
import type { ClientChannel } from '@/lib/snapshot';

interface HeaderProps {
  timezone: string;
  clientChannel: ClientChannel;
  displayLimit: 50 | 100;
}

const ViewersIcon = (
  <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);
const LikeIcon = (
  <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" /><path d="M7 22V10l5-8a2.4 2.4 0 0 1 4.4 1.7L15 9h5a2 2 0 0 1 2 2.3l-1.4 8A3 3 0 0 1 17.7 22H7Z" />
  </svg>
);

function StatChip({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <span
      className="inline-flex items-center gap-[7px] h-[32px] px-[11px] rounded-[7px] whitespace-nowrap"
      style={{
        background: 'linear-gradient(180deg, rgba(12,28,45,0.9), rgba(8,18,30,0.84))',
        border: '1px solid var(--color-border-strong)',
        boxShadow: 'inset 0 0 0 1px var(--color-border)',
      }}
    >
      <span className="w-[14px] h-[14px] flex-none" style={{ color: 'var(--color-primary)' }} aria-hidden="true">{icon}</span>
      <span className="text-[12px] font-[700]" style={{ color: '#d6e2f2', letterSpacing: 0 }}>{label}</span>
      <strong className="text-[16px] font-[850] leading-none tabular-nums" style={{ letterSpacing: 0 }}>{value}</strong>
    </span>
  );
}

export function Header({ timezone, clientChannel, displayLimit }: HeaderProps) {
  const viewers = clientChannel.liveViewers != null
    ? clientChannel.liveViewers.toLocaleString('ja-JP')
    : '—';
  const likes = clientChannel.likeCount.toLocaleString('ja-JP');

  return (
    <header
      className="flex-none h-[54px] flex items-center justify-between gap-[14px] px-[var(--page-padding)]"
      style={{ borderBottom: '1px solid rgba(0,178,255,0.16)' }}
    >
      <div className="inline-flex items-center gap-[12px] min-w-0">
        <span
          className="w-[26px] h-[26px] inline-flex items-center justify-center flex-none"
          style={{ color: 'var(--color-primary)', filter: 'drop-shadow(0 0 10px rgba(0,178,255,0.75))' }}
          aria-hidden="true"
        >
          <svg viewBox="0 0 48 48" width={26} height={26} fill="none" stroke="currentColor" strokeWidth={3} strokeLinejoin="round">
            <path d="M14 8L39 24L14 40V8Z" />
            <path d="M21 15L34 24L21 33" />
          </svg>
        </span>
        <span className="text-[20px] font-[800] whitespace-nowrap" style={{ letterSpacing: 0 }}>
          ライブサブランク
        </span>
        <span
          className="inline-flex items-center h-[28px] px-[11px] rounded-[7px] text-[15px] font-[900] whitespace-nowrap"
          style={{
            color: 'var(--color-primary)',
            background: 'rgba(0,178,255,0.1)',
            border: '1px solid var(--color-border-strong)',
            letterSpacing: 0,
          }}
        >
          リアルタイム TOP {displayLimit}
        </span>
      </div>
      <div className="inline-flex items-center gap-[10px]">
        <StatChip icon={ViewersIcon} label="視聴中" value={viewers} />
        <StatChip icon={LikeIcon}    label="高評価" value={likes} />
        <Clock timezone={timezone} />
        <SettingsButton />
      </div>
    </header>
  );
}
