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
const DELTA_HOLD_MS = 4_500;
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

function getDigitSequence(from: string, to: string, direction: -1 | 1): string[] {
  if (from === to) return [to];

  const sequence = [from];
  let current = Number(from);
  const target = Number(to);

  while (current !== target && sequence.length <= 11) {
    current = (current + direction + 10) % 10;
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
  const sequence = canRoll
    ? getDigitSequence(previousDigit, digit, direction)
    : [digit];
  const distance = `${-(sequence.length - 1) * 1.25}em`;
  const duration = getWheelDuration(sequence.length);
  const [offset, setOffset] = useState('0');

  useEffect(() => {
    if (!canRoll) return;

    const frame = requestAnimationFrame(() => {
      setOffset(distance);
    });

    return () => cancelAnimationFrame(frame);
  }, [canRoll, distance]);

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
    // 모션 활성 구간이 주어지면 그 종료에 맞춰 증감 표시를 숨김
    // (테두리 모션과 동일 시점에 사라지도록)
    const visibleUntil = motionActiveUntil > now
      ? motionActiveUntil
      : now + DELTA_HOLD_MS;

    setDeltaState({
      direction: value > source ? 1 : -1,
      delta: Math.abs(value - source),
      visibleUntil,
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
