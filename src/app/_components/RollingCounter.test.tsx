// @vitest-environment jsdom
import { render, act } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { RollingCounter } from './RollingCounter';

function getDigitContainers(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('span')).filter(
    (el) => el.style.overflow === 'hidden' && el.style.position === 'relative'
  );
}

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

describe('RollingCounter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('숫자를 ja-JP 로케일로 렌더링한다', () => {
    const { getByLabelText } = render(<RollingCounter value={1234567} />);
    expect(getByLabelText('1,234,567')).toBeInTheDocument();
  });

  it('value 변경 시 변경된 자릿수에 transition 스타일이 적용된다', async () => {
    vi.useFakeTimers();
    const { rerender, container } = render(<RollingCounter value={10000} />);

    await act(async () => {
      rerender(<RollingCounter value={10001} />);
    });
    await advance(500);

    const transitioningSpans = container.querySelectorAll('[style*="transition"]');
    expect(transitioningSpans.length).toBeGreaterThan(0);
  });

  it('value 변경 시 changed digit은 세로 숫자열을 digitWheel로 굴린다', async () => {
    vi.useFakeTimers();
    // 10,000 → 10,001: 마지막 '0'→'1' 만 바뀜
    const { rerender, container } = render(<RollingCounter value={10000} />);

    await act(async () => {
      rerender(<RollingCounter value={10001} />);
    });
    await advance(500);

    const digitContainers = getDigitContainers(container);
    expect(digitContainers.length).toBeGreaterThan(0);

    const rollingContainers = digitContainers.filter((c) => {
      const wheel = c.children[0] as HTMLElement | undefined;
      return wheel?.style.transition.includes('transform') ?? false;
    });
    const stillContainers = digitContainers.filter((c) => {
      const wheel = c.children[0] as HTMLElement | undefined;
      return !(wheel?.style.transition.includes('transform') ?? false);
    });

    // 변경된 자릿수: 미리 쌓인 숫자열 하나가 통째로 이동
    expect(rollingContainers.length).toBeGreaterThan(0);
    for (const dc of rollingContainers) {
      const wheel = dc.children[0] as HTMLElement;
      expect(wheel.style.transition).toContain('transform');
      expect(wheel.children.length).toBeGreaterThan(1);
    }

    // 변경되지 않은 자릿수: 숫자 하나만 표시하고 굴리지 않음
    expect(stillContainers.length).toBeGreaterThan(0);
    for (const dc of stillContainers) {
      const wheel = dc.children[0] as HTMLElement;
      expect(wheel.children.length).toBe(1);
      expect(wheel.style.animation ?? '').toBe('');
    }
  });

  it('자릿수 증가(999999 → 1000000) 시 7개의 digit 컨테이너가 렌더된다', async () => {
    vi.useFakeTimers();
    const { rerender, container } = render(<RollingCounter value={999999} />);

    await act(async () => {
      rerender(<RollingCounter value={1000000} />);
    });
    await advance(1900);

    // 1,000,000 은 7자리 digit
    const digitContainers = getDigitContainers(container);
    expect(digitContainers.length).toBe(7);
  });

  it('증가 방향 시 방향 표시(상향 삼각형)가 나타난다', () => {
    vi.useFakeTimers();
    const { container } = render(
      <RollingCounter value={10100} prevPolledCount={10000} />
    );
    act(() => {
      vi.advanceTimersByTime(1);
    });
    const polygon = container.querySelector('polygon');
    expect(polygon).not.toBeNull();
    expect(polygon!.getAttribute('points')).toBe('5,1 9,9 1,9');
  });

  it('감소 방향 시 방향 표시(하향 삼각형)가 나타난다', () => {
    vi.useFakeTimers();
    const { container } = render(
      <RollingCounter value={9900} prevPolledCount={10000} />
    );
    act(() => {
      vi.advanceTimersByTime(1);
    });
    const polygon = container.querySelector('polygon');
    expect(polygon).not.toBeNull();
    expect(polygon!.getAttribute('points')).toBe('1,1 9,1 5,9');
  });

  it('prevPolledCount 없으면 방향 표시가 나타나지 않는다', () => {
    const { container } = render(<RollingCounter value={10000} />);
    expect(container.querySelector('polygon')).toBeNull();
  });
});
