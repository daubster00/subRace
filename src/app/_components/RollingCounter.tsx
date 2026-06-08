'use client';

import { useRef, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';

interface RollingCounterProps {
  value: number;
  prevPolledCount?: number;
  motionActiveUntil?: number;
}

const MIN_DIGIT_DURATION = 2_100;
const STEP_DURATION = 260;
const MAX_DIGIT_DURATION = 4_200;
const DELAY_STEP = 48;
const PREVIOUS_VALUE_COMMIT_MS = MAX_DIGIT_DURATION + 800;

interface DeltaState {
  direction: -1 | 1;
  delta: number;
  visibleUntil: number;
}

function fmt(n: number): string {
  return n.toLocaleString('ja-JP');
}

function isDigit(char: string): boolean {
  return /\d/.test(char);
}

// Always builds [low, low+1, ..., high] (wrapping through 9→0 if needed),
// regardless of which direction the counter is rolling. DigitWheel inverts the
// transform start/end based on direction so the same column can scroll either
// up (rising) or down (falling) without rebuilding the sequence.
function getDigitSequence(low: string, high: string): string[] {
  if (low === high) return [high];

  const sequence = [low];
  let current = Number(low);
  const target = Number(high);

  while (current !== target && sequence.length <= 11) {
    current = (current + 1) % 10;
    sequence.push(String(current));
  }

  return sequence;
}

function getWheelDuration(stepCount: number): number {
  return Math.min(
    MAX_DIGIT_DURATION,
    MIN_DIGIT_DURATION + Math.max(stepCount - 1, 0) * STEP_DURATION
  );
}

interface DigitWheelProps {
  digit: string;
  previousDigit: string;
  direction: -1 | 1;
  delay: number;
}

function DigitWheel({ digit, previousDigit, direction, delay }: DigitWheelProps) {
  const canRoll = isDigit(previousDigit) && previousDigit !== digit;
  // Column is always ordered [curr, ..., prev] for falling and [prev, ..., curr]
  // for rising — i.e. low-to-high through whichever path was taken (incl. wrap).
  // The transform then slides the column up (rising) or down (falling) so the
  // viewer sees new digits enter from the bottom on rise and from the top on
  // fall.
  const sequence = canRoll
    ? direction === 1
      ? getDigitSequence(previousDigit, digit)
      : getDigitSequence(digit, previousDigit)
    : [digit];
  const span = (sequence.length - 1) * 1.25;
  const duration = getWheelDuration(sequence.length);
  const startEm = direction === 1 ? 0 : -span;
  const endEm = direction === 1 ? -span : 0;
  const [offset, setOffset] = useState(`${startEm}em`);

  useEffect(() => {
    if (!canRoll) return;

    const frame = requestAnimationFrame(() => {
      setOffset(`${endEm}em`);
    });

    return () => cancelAnimationFrame(frame);
  }, [canRoll, endEm]);

  return (
    <span
      style={{
        display: 'inline-block',
        width: '0.62em',
        overflow: 'hidden',
        position: 'relative',
        height: '1.25em',
        lineHeight: '1.25em',
        textAlign: 'center',
      }}
    >
      <span
        key={`${previousDigit}-${digit}-${direction}`}
        style={{
          display: 'flex',
          flexDirection: 'column',
          transform: `translateY(${offset})`,
          ...(canRoll && {
            transition: `transform ${duration}ms cubic-bezier(0.22, 0.72, 0.25, 1) ${delay}ms`,
          } as CSSProperties),
        }}
      >
        {sequence.map((n, i) => (
          <span
            key={`${n}-${i}`}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '1.25em',
              flex: '0 0 1.25em',
            }}
          >
            {n}
          </span>
        ))}
      </span>
    </span>
  );
}

export function RollingCounter({ value, prevPolledCount, motionActiveUntil = 0 }: RollingCounterProps) {
  const [deltaState, setDeltaState] = useState<DeltaState | null>(null);
  const prevRef = useRef<number>(value);
  const prevCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deltaSourceRef = useRef<number>(prevPolledCount ?? value);

  useEffect(() => {
    const source = deltaSourceRef.current;
    if (value === source) return;

    deltaSourceRef.current = value;
    const now = Date.now();
    // mount 직후 stale prev 때문에 value !== source가 잡히지만 motionActiveUntil
    // 이 이미 지난 경우 — RankCard 테두리 모션은 그려지지 않는다. 증감만 4.5초
    // 띄우면 "테두리 없이 화살표만 떠 있는" 부자연스러운 표시가 됨. 두 표시는
    // 항상 동기화되어야 하므로 motionActiveUntil 활성일 때만 증감을 띄운다.
    if (motionActiveUntil <= now) return;

    setDeltaState({
      direction: value > source ? 1 : -1,
      delta: Math.abs(value - source),
      visibleUntil: motionActiveUntil,
    });
  }, [value, motionActiveUntil]);

  useEffect(() => {
    if (deltaState === null) return;

    const remaining = Math.max(0, deltaState.visibleUntil - Date.now());
    const timer = setTimeout(() => {
      setDeltaState((current) => (current === deltaState ? null : current));
    }, remaining);

    return () => clearTimeout(timer);
  }, [deltaState]);

  // eslint-disable-next-line react-hooks/refs
  const prevStr = fmt(prevRef.current);
  const currStr = fmt(value);
  // eslint-disable-next-line react-hooks/refs
  const rollDirection = value >= prevRef.current ? 1 : -1;

  const maxLen = Math.max(prevStr.length, currStr.length);
  const paddedPrev = prevStr.padStart(maxLen, ' ');
  const paddedCurr = currStr.padStart(maxLen, ' ');

  useEffect(() => {
    if (prevCommitTimerRef.current !== null) {
      clearTimeout(prevCommitTimerRef.current);
    }

    prevCommitTimerRef.current = setTimeout(() => {
      prevRef.current = value;
      prevCommitTimerRef.current = null;
    }, PREVIOUS_VALUE_COMMIT_MS);

    return () => {
      if (prevCommitTimerRef.current !== null) {
        clearTimeout(prevCommitTimerRef.current);
        prevCommitTimerRef.current = null;
      }
    };
  }, [value]);

  const chars = Array.from(paddedCurr);

  return (
    <div className="flex items-center gap-[4px] justify-end">
      {deltaState !== null && (
        <span
          className="inline-flex items-center gap-[3px] text-[11px] font-[750] whitespace-nowrap"
          style={{
            color: deltaState.direction > 0 ? 'var(--color-increase, #1ee6b8)' : 'var(--color-decrease, #ff5558)',
            animation: 'deltaHold 420ms ease-out both',
          }}
        >
          <svg
            viewBox="0 0 10 10"
            width="9"
            height="9"
            aria-hidden="true"
            style={{ flex: '0 0 auto' }}
          >
            {deltaState.direction > 0 ? (
              <polygon points="5,1 9,9 1,9" fill="currentColor" />
            ) : (
              <polygon points="1,1 9,1 5,9" fill="currentColor" />
            )}
          </svg>
          {fmt(deltaState.delta)}
        </span>
      )}
      <span
        className="flex items-center"
        aria-label={currStr}
        style={{ fontVariantNumeric: 'tabular-nums' }}
      >
        {chars.map((char, i) => {
          const prevChar = paddedPrev[i] ?? ' ';
          // 오른쪽으로부터 digit 개수 (콤마 제외)
          const digitPos = Array.from(paddedCurr.slice(i + 1)).filter((c) => /\d/.test(c)).length;
          const delay = digitPos * DELAY_STEP;

          if (!isDigit(char)) {
            return (
              <span
                key={i}
                style={{
                  display: 'inline-block',
                  width: char === ',' ? '0.4em' : '0.6em',
                  textAlign: 'center',
                }}
              >
                {char.trim() || null}
              </span>
            );
          }

          return (
            <DigitWheel
              key={`${i}-${prevChar}-${char}-${rollDirection}`}
              digit={char}
              previousDigit={prevChar}
              direction={rollDirection}
              delay={delay}
            />
          );
        })}
      </span>
    </div>
  );
}
