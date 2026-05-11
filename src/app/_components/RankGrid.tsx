'use client';

import { LayoutGroup } from 'motion/react';
import { RankColumn } from './RankColumn';
import type { InterpolatedChannel } from '@/hooks/useInterpolatedSnapshot';

interface RankGridProps {
  channels: InterpolatedChannel[];
  startRank: number;
  alertedIds: ReadonlySet<string>;
}

export function RankGrid({ channels, startRank, alertedIds }: RankGridProps) {
  const cols = 5;
  const perCol = 10;
  const columns: InterpolatedChannel[][] = Array.from({ length: cols }, (_, i) =>
    channels.slice(i * perCol, (i + 1) * perCol)
  );

  return (
    <LayoutGroup>
      <section
        aria-label="リアルタイムYouTube登録者ランキング"
        className="flex-1 min-h-0 overflow-hidden pr-[2px]"
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
          gap: '10px',
        }}
      >
        {columns.map((col, i) => (
          <RankColumn
            key={`${startRank}-${i}`}
            channels={col}
            startRank={startRank + i * perCol}
            alertedIds={alertedIds}
          />
        ))}
      </section>
    </LayoutGroup>
  );
}
