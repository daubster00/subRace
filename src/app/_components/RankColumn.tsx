'use client';

import { AnimatePresence } from 'motion/react';
import { RankCard } from './RankCard';
import type { InterpolatedChannel } from '@/hooks/useInterpolatedSnapshot';

interface RankColumnProps {
  channels: InterpolatedChannel[];
  startRank: number;
  alertedIds: ReadonlySet<string>;
}

export function RankColumn({ channels, startRank, alertedIds }: RankColumnProps) {
  return (
    <div
      className="min-h-0"
      style={{
        display: 'grid',
        gridTemplateRows: 'repeat(10, minmax(0, 1fr))',
        gap: '2px',
      }}
    >
      <AnimatePresence mode="popLayout">
        {channels.map((ch, i) => (
          <RankCard
            key={ch.id}
            channel={ch}
            rank={startRank + i}
            motionIndex={startRank + i - 1}
            isAlerted={alertedIds.has(ch.id)}
          />
        ))}
      </AnimatePresence>
    </div>
  );
}
