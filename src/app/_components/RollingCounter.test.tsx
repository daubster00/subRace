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
    vi.setSystemTime(new Date('2026-06-08T00:00:00Z'));
    const future = Date.now() + 5_000;
    const { container } = render(
      <RollingCounter value={10100} prevPolledCount={10000} motionActiveUntil={future} />
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
    vi.setSystemTime(new Date('2026-06-08T00:00:00Z'));
    const future = Date.now() + 5_000;
    const { container } = render(
      <RollingCounter value={9900} prevPolledCount={10000} motionActiveUntil={future} />
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

  // 2026-06-08: motionActiveUntil이 이미 지난 mount-time stale prev에는 증감
  // 표시도 띄우지 않는다 (테두리 모션과 동기화). 페이지 스왑 직후 "테두리 없이
  // 화살표만 떠 있는" 부자연스러운 잔존을 막기 위함.
  it('motionActiveUntil이 지난 상태로 mount되면 방향 표시 안 나타남', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-08T00:00:00Z'));
    const past = Date.now() - 1_000;
    const { container } = render(
      <RollingCounter value={10100} prevPolledCount={10000} motionActiveUntil={past} />
    );
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(container.querySelector('polygon')).toBeNull();
  });

  it('상승 시 column은 위로 슬라이드 (translateY 종료값이 음수)', async () => {
    vi.useFakeTimers();
    const { rerender, container } = render(<RollingCounter value={10000} />);

    await act(async () => {
      rerender(<RollingCounter value={10001} />);
    });
    // requestAnimationFrame 콜백이 setOffset(endEm) 호출하도록 한 프레임 진행
    await advance(50);

    const wheels = Array.from(
      container.querySelectorAll<HTMLElement>('[style*="transition"]')
    );
    const rolling = wheels.filter((w) => w.style.transform && w.style.transform !== 'translateY(0em)');
    expect(rolling.length).toBeGreaterThan(0);
    for (const w of rolling) {
      // 상승 종료 transform = -Xem (음수)
      expect(w.style.transform).toMatch(/translateY\(-[\d.]+em\)/);
    }
  });

  it('하락 시 column은 아래로 슬라이드 (translateY 종료값이 0)', async () => {
    vi.useFakeTimers();
    const { rerender, container } = render(<RollingCounter value={10001} />);

    await act(async () => {
      rerender(<RollingCounter value={10000} />);
    });
    await advance(50);

    const wheels = Array.from(
      container.querySelectorAll<HTMLElement>('[style*="transition"]')
    );
    // 하락은 시작 -Xem → 종료 0em. setOffset이 endEm으로 바뀐 뒤 transform = translateY(0em)
    const ended = wheels.filter((w) => w.style.transform === 'translateY(0em)');
    expect(ended.length).toBeGreaterThan(0);
  });
});
