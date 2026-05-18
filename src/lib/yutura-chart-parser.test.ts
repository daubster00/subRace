import { describe, it, expect } from 'vitest';
import { parseChartTable } from './yutura-chart-parser';

// Real sample copied from yutura.net/channel/2293/chart/ on 2026-05-18.
// Trimmed to header + first 4 data rows + 合計 + closing.
const SAMPLE_FOUR_ROWS = `<section class="count-table"><h1><i class="material-icons">equalizer</i>DATA</h1><div class="scroll"><table class="tbl"><tbody><tr><th colspan="2">調査日</th><th colspan="2">チャンネル登録者数</th><th colspan="2">動画再生回数</th><th colspan="2">動画本数</th></tr><tr><td>2026.04.19</td><td><span class="holiday">日</span></td><td>3,230,000</td><td><span class="minus"></span></td><td>7,332,399,658</td><td><span class="minus"></span></td><td>1,898</td><td><span class="minus"></span></td></tr><tr><td>2026.04.20</td><td><span>月</span></td><td>3,230,000</td><td><span>0</span></td><td>7,334,095,642</td><td><span class="plus">+1,695,984</span></td><td>1,898</td><td><span>0</span></td></tr><tr><td>2026.05.10</td><td><span class="holiday">日</span></td><td>3,240,000</td><td><span class="plus">+10,000</span></td><td>7,356,945,003</td><td><span class="plus">+1,523,918</span></td><td>1,901</td><td><span>0</span></td></tr><tr><td>2026.05.18</td><td><span>月</span></td><td>3,240,000</td><td><span>0</span></td><td>7,365,606,599</td><td><span class="plus">+1,291,760</span></td><td>1,901</td><td><span>0</span></td></tr><tr><td>合計</td><td></td><td></td><td><span class="plus">+10,000</span></td><td></td><td><span class="plus">+33,206,941</span></td><td></td><td><span class="plus">+3</span></td></tr></tbody></table></div></section>`;

describe('parseChartTable', () => {
  it('헤더와 합계 행을 건너뛰고 데이터 행만 추출한다', () => {
    const rows = parseChartTable(SAMPLE_FOUR_ROWS);
    expect(rows).toHaveLength(4);
  });

  it('YYYY.MM.DD 일자를 ISO midnight UTC로 변환한다', () => {
    const rows = parseChartTable(SAMPLE_FOUR_ROWS);
    expect(rows[0]?.date).toBe('2026-04-19T00:00:00.000Z');
    expect(rows[3]?.date).toBe('2026-05-18T00:00:00.000Z');
  });

  it('구독자수를 콤마 제거 후 정수로 파싱한다', () => {
    const rows = parseChartTable(SAMPLE_FOUR_ROWS);
    expect(rows[0]?.subscriberCount).toBe(3_230_000);
    expect(rows[2]?.subscriberCount).toBe(3_240_000);
  });

  it('영상 수와 조회수도 함께 캡쳐한다', () => {
    const rows = parseChartTable(SAMPLE_FOUR_ROWS);
    expect(rows[0]?.viewCount).toBe(7_332_399_658);
    expect(rows[0]?.videoCount).toBe(1_898);
    expect(rows[3]?.videoCount).toBe(1_901);
  });

  it('milestone transition 시점이 그대로 보존된다 (3.23M → 3.24M @ 2026-05-10)', () => {
    const rows = parseChartTable(SAMPLE_FOUR_ROWS);
    const transition = rows.findIndex(
      (r, i) => i > 0 && r.subscriberCount !== rows[i - 1]?.subscriberCount,
    );
    expect(transition).toBeGreaterThan(0);
    const t = rows[transition];
    const prev = rows[transition - 1];
    expect(t?.date).toBe('2026-05-10T00:00:00.000Z');
    expect((t?.subscriberCount ?? 0) - (prev?.subscriberCount ?? 0)).toBe(10_000);
  });

  it('count-table 섹션이 없으면 빈 배열을 반환한다', () => {
    expect(parseChartTable('<html><body>nope</body></html>')).toEqual([]);
  });

  it('잘못된 일자 형식 / 음수 / 0 구독자 행은 건너뛴다', () => {
    const malformed = `<section class="count-table"><table class="tbl"><tbody>
      <tr><td>not-a-date</td><td>x</td><td>1,000,000</td><td></td><td>0</td><td></td><td>1</td><td></td></tr>
      <tr><td>2026.05.18</td><td>月</td><td>0</td><td></td><td>0</td><td></td><td>1</td><td></td></tr>
      <tr><td>2026.05.19</td><td>火</td><td>1,000,000</td><td></td><td>0</td><td></td><td>1</td><td></td></tr>
    </tbody></table></section>`;
    const rows = parseChartTable(malformed);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.date).toBe('2026-05-19T00:00:00.000Z');
  });
});
