// yutura 채널 상세 페이지(/channel/{id}/chart/)의 <section class="count-table"> 파서.
//
// 테이블 구조 (확인: 2026-05-18, 채널 2293):
//   <tr><th colspan="2">調査日</th><th>登録者数</th><th>再生数</th><th>本数</th>...
//   <tr><td>2026.04.19</td><td>요일</td><td>3,230,000</td><td>delta</td>
//       <td>7,332,399,658</td><td>delta</td><td>1,898</td><td>delta</td></tr>
//   ... (30 데이터 행) ...
//   <tr><td>合計</td>...</tr>   <- 합계 행 (무시)
//
// 일자: 분명한 'YYYY.MM.DD' 형식만 데이터 행으로 인정. 합계 행("合計" 등)은
// 자동으로 reject 된다.

export interface ChartRow {
  date: string;             // ISO date midnight UTC (e.g., '2026-04-19T00:00:00.000Z')
  subscriberCount: number;
  videoCount: number | null;
  viewCount: number | null;
}

const SECTION_RE = /<section\s+class="count-table">[\s\S]*?<\/section>/;
const ROW_RE = /<tr>([\s\S]*?)<\/tr>/g;
const CELL_RE = /<td[^>]*>([\s\S]*?)<\/td>/g;
const DATE_RE = /^(\d{4})\.(\d{2})\.(\d{2})$/;

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function parseIntStrict(raw: string): number | null {
  const cleaned = raw.replace(/,/g, '').trim();
  if (!/^-?\d+$/.test(cleaned)) return null;
  const n = Number.parseInt(cleaned, 10);
  return Number.isFinite(n) ? n : null;
}

export function parseChartTable(html: string): ChartRow[] {
  const section = html.match(SECTION_RE)?.[0];
  if (!section) return [];

  const rows: ChartRow[] = [];
  for (const rowMatch of section.matchAll(ROW_RE)) {
    const inner = rowMatch[1];
    if (!inner) continue;

    const cells: string[] = [];
    for (const cellMatch of inner.matchAll(CELL_RE)) {
      cells.push(stripTags(cellMatch[1] ?? ''));
    }
    // Header rows use <th>, so they yield 0 <td> cells and are skipped naturally.
    // Data rows have 8 cells: [date, dow, subs, dDelta, views, vDelta, vids, vDelta].
    const dateCell = cells[0];
    const subsCell = cells[2];
    if (!dateCell || !subsCell) continue;

    const dateMatch = dateCell.match(DATE_RE);
    if (!dateMatch) continue;   // 合計 row, or anything not YYYY.MM.DD

    const y = dateMatch[1];
    const m = dateMatch[2];
    const d = dateMatch[3];
    const isoDate = `${y}-${m}-${d}T00:00:00.000Z`;

    const subs = parseIntStrict(subsCell);
    if (subs == null || subs <= 0) continue;

    // Video/view counts are at indices 4 and 6 in the standard layout. They are
    // optional — if the cell is empty or non-numeric we keep them null rather
    // than dropping the whole row, since the subscriber count is the only
    // value required for Phase C milestone reconstruction.
    const viewsCell = cells[4];
    const vidsCell = cells[6];
    const views = viewsCell ? parseIntStrict(viewsCell) : null;
    const vids = vidsCell ? parseIntStrict(vidsCell) : null;

    rows.push({
      date: isoDate,
      subscriberCount: subs,
      videoCount: vids,
      viewCount: views,
    });
  }

  return rows;
}
