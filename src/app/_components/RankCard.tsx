'use client';

import { useRef, useState, useEffect } from 'react';
import Image from 'next/image';
import { motion } from 'motion/react';
import type { InterpolatedChannel } from '@/hooks/useInterpolatedSnapshot';
import { RollingCounter } from './RollingCounter';

interface RankCardProps {
  channel: InterpolatedChannel;
  rank: number;
  motionIndex: number;
  isAlerted: boolean;
}

const COUNT_GLOW_DURATION_MS = 5_200;
const COUNT_TRACE_DURATION_MS = 2_600;

const cornerPositions = [
  { position: { top: -1, left: -1 }, rotate: 0, delay: '0ms' },
  { position: { top: -1, right: -1 }, rotate: 90, delay: '525ms' },
  { position: { right: -1, bottom: -1 }, rotate: 180, delay: '1050ms' },
  { position: { bottom: -1, left: -1 }, rotate: 270, delay: '1575ms' },
] as const;

export function RankCard({ channel, rank, motionIndex, isAlerted }: RankCardProps) {
  const prevRankRef = useRef(rank);
  const prevCountRef = useRef(channel.subscriberCount);
  const motionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isSwapping, setIsSwapping] = useState(false);
  const [isCounting, setIsCounting] = useState(false);
  const [countDirection, setCountDirection] = useState<1 | -1>(1);

  // 순위 변경 감지 → 스왑 글로우 800ms
  useEffect(() => {
    if (prevRankRef.current !== rank) {
      prevRankRef.current = rank;
      setIsSwapping(true);
      const t = setTimeout(() => setIsSwapping(false), 800);
      return () => clearTimeout(t);
    }
  }, [rank]);

  // 테두리 모션은 실제 subscriberCount가 바뀌는 시점에 시작한다.
  // motionActiveUntil 기반으로 트리거하면 1~50 / 51~100 페이지가 스왑되며
  // 카드가 모션 중간에 mount될 때, 그 모션의 숫자 스텝은 off-screen에서 이미
  // 끝나 있어서 "테두리는 그려지는데 숫자/증감 표시는 안 나오는" 채널이 생긴다.
  // 카운트 변화에 묶으면 border ⇔ delta 동기가 자연스럽게 유지된다.
  useEffect(() => {
    if (prevCountRef.current === channel.subscriberCount) return;
    prevCountRef.current = channel.subscriberCount;

    const now = Date.now();
    // 활성 모션과 무관한 카운트 변화(스냅샷 도착 직후 correction lerp 등)는
    // 테두리를 그리지 않는다.
    if (channel.motionActiveUntil <= now || channel.motionDirection === 0) return;

    if (motionTimerRef.current !== null) {
      clearTimeout(motionTimerRef.current);
    }

    setCountDirection(channel.motionDirection);
    setIsCounting(true);

    const remaining = channel.motionActiveUntil - now;
    motionTimerRef.current = setTimeout(() => {
      setIsCounting(false);
      motionTimerRef.current = null;
    }, remaining);
  }, [channel.subscriberCount, channel.motionActiveUntil, channel.motionDirection]);

  useEffect(() => () => {
    if (motionTimerRef.current !== null) clearTimeout(motionTimerRef.current);
  }, []);

  const countTraceColor = countDirection > 0
    ? 'rgba(32,228,81,0.95)'
    : 'rgba(255,63,70,0.95)';
  const countGlowShadow = countDirection > 0
    ? '0 0 6px rgba(32,228,81,0.24), inset 0 0 13px rgba(32,228,81,0.24), inset 0 1px 0 rgba(255,255,255,0.05)'
    : '0 0 6px rgba(255,63,70,0.24), inset 0 0 13px rgba(255,63,70,0.24), inset 0 1px 0 rgba(255,255,255,0.05)';

  // 글로우 상태 우선순위: isCounting > isSwapping > 기본
  // (isAlerted는 테두리 대신 보라색 오버레이로 표시)
  const borderColor = isSwapping
    ? 'rgba(0,178,255,0.65)'
    : 'rgba(0,178,255,0.16)';

  const boxShadow = isCounting
    ? countGlowShadow
    : isSwapping
    ? '0 0 16px rgba(0,178,255,0.45), inset 0 1px 0 rgba(255,255,255,0.03)'
    : 'inset 0 1px 0 rgba(255,255,255,0.03)';
  const motionDelay = (motionIndex % 10) * 0.018 + Math.floor((motionIndex % 50) / 10) * 0.035;
  const motionDuration = 0.34 + (motionIndex % 7) * 0.035;
  const motionX = motionIndex % 2 === 0 ? -18 : 18;

  return (
    <motion.article
      layoutId={channel.id}
      layout="position"
      initial={{ opacity: 0, y: 18, x: motionX, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, x: 0, scale: 1 }}
      exit={{ opacity: 0, y: -14, x: -motionX, scale: 0.985 }}
      transition={{
        layout: { duration: 0.5, ease: 'easeOut' },
        opacity: { duration: motionDuration, delay: motionDelay },
        x: { duration: motionDuration, delay: motionDelay, ease: 'easeOut' },
        y: { duration: motionDuration, delay: motionDelay, ease: 'easeOut' },
        scale: { duration: motionDuration, delay: motionDelay, ease: 'easeOut' },
      }}
      className="min-h-0 flex items-center gap-[10px] px-[10px] py-[7px]"
      style={{
        display: 'grid',
        gridTemplateColumns: '32px 48px minmax(0,1fr)',
        position: 'relative',
        background: 'linear-gradient(180deg, rgba(12,29,45,0.78), rgba(8,18,30,0.72))',
        border: `1px solid ${borderColor}`,
        borderRadius: 'var(--radius-card)',
        boxShadow,
        transition: 'border-color 0.9s ease, box-shadow 1.1s ease',
        animation: isAlerted ? 'alertPurplePulse 3.2s ease-in-out infinite' : undefined,
      }}
    >
      {isCounting && (
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            zIndex: 2,
            overflow: 'hidden',
            borderRadius: 'inherit',
          }}
        >
          <span
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: 1,
              background: countTraceColor,
              boxShadow: `0 0 5px ${countTraceColor}, inset 0 0 3px ${countTraceColor}`,
              transformOrigin: 'left center',
              animation: `countTraceHorizontal ${COUNT_TRACE_DURATION_MS}ms ease both`,
            }}
          />
          <span
            style={{
              position: 'absolute',
              top: 0,
              right: 0,
              width: 1,
              height: '100%',
              background: countTraceColor,
              boxShadow: `0 0 5px ${countTraceColor}, inset 0 0 3px ${countTraceColor}`,
              transformOrigin: 'center top',
              animation: `countTraceVertical ${COUNT_TRACE_DURATION_MS}ms ease 525ms both`,
            }}
          />
          <span
            style={{
              position: 'absolute',
              right: 0,
              bottom: 0,
              width: '100%',
              height: 1,
              background: countTraceColor,
              boxShadow: `0 0 5px ${countTraceColor}, inset 0 0 3px ${countTraceColor}`,
              transformOrigin: 'right center',
              animation: `countTraceHorizontal ${COUNT_TRACE_DURATION_MS}ms ease 1050ms both`,
            }}
          />
          <span
            style={{
              position: 'absolute',
              bottom: 0,
              left: 0,
              width: 1,
              height: '100%',
              background: countTraceColor,
              boxShadow: `0 0 5px ${countTraceColor}, inset 0 0 3px ${countTraceColor}`,
              transformOrigin: 'center bottom',
              animation: `countTraceVertical ${COUNT_TRACE_DURATION_MS}ms ease 1575ms both`,
            }}
          />
          {cornerPositions.map((corner, i) => (
            <svg
              key={i}
              viewBox="0 0 10 10"
              aria-hidden="true"
              style={{
                position: 'absolute',
                width: 10,
                height: 10,
                ...corner.position,
                transform: `rotate(${corner.rotate}deg)`,
                overflow: 'visible',
              }}
            >
              <path
                d="M 9 1 A 8 8 0 0 0 1 9"
                fill="none"
                stroke={countTraceColor}
                strokeWidth="1.5"
                strokeLinecap="round"
                pathLength="1"
                style={{
                  filter: `drop-shadow(0 0 4px ${countTraceColor})`,
                  strokeDasharray: 1,
                  strokeDashoffset: 1,
                  animation: `countCornerDraw 900ms ease ${corner.delay} both`,
                }}
              />
            </svg>
          ))}
        </div>
      )}
      <span
        className="text-center text-white text-[20px] font-[750]"
        style={{ fontVariantNumeric: 'tabular-nums' }}
      >
        {rank}
      </span>
      <div
        className="w-[44px] h-[44px] flex items-center justify-center overflow-hidden rounded-full text-white text-[14px] font-[800]"
        style={{
          background: 'linear-gradient(135deg, #1d9fff, #1ee6b8)',
          boxShadow: '0 0 0 1px rgba(255,255,255,0.14), 0 3px 12px rgba(0,0,0,0.32)',
        }}
      >
        {channel.thumbnailUrl ? (
          <Image
            src={channel.thumbnailUrl}
            alt={channel.name}
            width={44}
            height={44}
            className="w-full h-full object-cover"
            unoptimized
          />
        ) : (
          channel.name.slice(0, 2)
        )}
      </div>
      <div className="min-w-0 flex flex-col justify-center gap-[3px]">
        <span
          className="block text-[14px] font-[600] leading-[1.12] whitespace-nowrap overflow-hidden text-ellipsis"
          style={{ color: '#eaf2ff' }}
        >
          {channel.name}
        </span>
        <div
          className="text-white text-[22px] font-[700] leading-[1.05] flex justify-end"
          style={{ overflow: 'visible', minWidth: 0 }}
        >
          <RollingCounter
            value={channel.subscriberCount}
            prevPolledCount={
              channel.prevCount !== channel.subscriberCount
                ? channel.prevCount
                : undefined
            }
            motionActiveUntil={channel.motionActiveUntil}
          />
        </div>
      </div>
    </motion.article>
  );
}
