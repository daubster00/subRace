# 고객 수정요청 반영 계획 (2026-05-18 착수)

원본 요청: `수정요청사항.docx` (프로젝트 루트)
관련 PRD: [docs/PRD.md](../PRD.md) — **수정하지 않음**. 이 문서는 PRD 위에 얹는 작업 계획.

---

## 0. 사용자 지시 — 무엇을 받아들이고 무엇을 무시하는가

고객 요청서 9개 항목 중:

| # | 요청 | 처리 |
|---|-----|------|
| 1 | 숫자 애니메이션 방향 분리 (상승↑/하락↓) | **채택** |
| 2 | API 단위 범위 초과 금지 (최우선) | **채택** |
| 3 | 우상향인데 정체/감소처럼 보이는 문제 | **채택** |
| 4 | 데이터 구조 (한 달 단위로 변화 없음 채널 대응) | **채택** |
| 5 | yutura → SocialBlade 전환 | **거절** — 사용자 확인: SocialBlade가 고객이 원하는 방식으로 데이터를 주지 않음. yutura 유지 |
| 6 | SocialBlade 60일 milestone 사용 | **개념만 채택, 출처는 yutura** |
| 7 | 외부 milestone → 자체 milestone 전환 | **채택** (외부 = yutura) |
| 8 | TOP150 이탈 채널 90일 inactive 유지 | **채택**, 카운트는 **2026-05-18부터 시작** |
| 9 | UI 개선 | 고객이 별도 견적 진행 — 이번 작업 범위 외 |

---

## 1. Phase 계획 (우선순위 #9 순서대로)

### ✅ Phase A — API 범위 이탈 방지 + 방향 분리 (완료: 2026-05-18)

**완료 내역**:
- 신규 [src/lib/api-bucket.ts](../../src/lib/api-bucket.ts): `getApiUnit`, `getApiBucket`, `clampToBucket`
  - 단위: `<10M → 1만`, `<100M → 10만`, `≥100M → 100만`
- 신규 [src/lib/api-bucket.test.ts](../../src/lib/api-bucket.test.ts) — 13 케이스
- 수정 [src/hooks/useInterpolatedSnapshot.ts](../../src/hooks/useInterpolatedSnapshot.ts):
  - `getFlatDriftAmplitude(count, bucket)` — amplitude를 `unit/2`로 cap
  - `stepFlatCount`, `stepNaturalCount`에 bucket 전달 — `driftTarget`, `correctionTarget` clamp
  - 호출부에서 bucket을 **폴링값 `sCurr` 기준**으로 잡고 `interpolatedTarget` + 최종 `displayCount` clamp
- 수정 [src/app/_components/RollingCounter.tsx](../../src/app/_components/RollingCounter.tsx):
  - `getDigitSequence(low, high)` — 항상 low→high column (direction 인자 제거)
  - `DigitWheel`: 상승 시 `0 → -Xem` (column 위로), 하락 시 `-Xem → 0` (column 아래로)
- 수정 [src/app/_components/RollingCounter.test.tsx](../../src/app/_components/RollingCounter.test.tsx) — 방향별 시각 검증 2건 추가

**검증**:
- ✓ vitest 39 통과 (api-bucket 13 + RollingCounter 9 외 17)
- ✓ `tsc --noEmit` 클린
- ✓ `next build` 성공
- ⏳ **사용자 시각 검증 대기 중** — 배포 후 1억대/1천만대/100만대 채널 각각 단위 범위 내에서만 움직이는지, 하락 시 새 숫자가 위에서 내려오는지 확인

### ✅ Phase B — 우상향 채널 정체 문제 (#3 임시 보정 → Phase C 완료로 제거됨: 2026-05-18)

Phase A의 bucket clamp는 "단위 벗어나지 않음"을 보장했지만 growthRate가 단위 라운딩 때문에 0으로 잡혀 정체로 보이는 근본 원인은 Phase C(milestone)에서 해결. Phase B는 그 전까지의 임시 보정이었고, **Phase C 완료와 함께 제거됨** ([useInterpolatedSnapshot.ts](../../src/hooks/useInterpolatedSnapshot.ts)의 `trendBias`/비대칭 amplitude 분기 삭제).

이제 milestone 기반 정확한 rate가 들어오므로 flat drift는 다시 대칭 amplitude로 복원되어 있다.

### ✅ Phase C — 60일 milestone 데이터 수집 (#5, #6, #7, 완료: 2026-05-18)

**소스 결정**: yutura 채널 상세 페이지의 `/channel/{yuturaId}/chart/` (`<section class="count-table">`)를 사용. 사용자 직접 확인 결과 30일 일별 데이터 (날짜, 구독자수, 영상수, 조회수). 60일은 yutura에서 직접 받을 수 없어 다음 두 가지로 보강:
1. 매일 chart를 폴링해 자체 누적 → 시간 지나면 30일을 초과한 일별 데이터 자체 보유
2. 월별 ranking 백필 (기존 `backfillYuturaMonthlySnapshots`)을 ~60일 전 월에 대해 30일 cadence로 실행 → 단일 데이터 포인트 fallback

**완료 내역**:
- 신규 마이그레이션 [migrations/005_chart_pulls.sql](../../migrations/005_chart_pulls.sql) — `chart_pulls` 로그 테이블 (kind = 'chart' | 'monthly_backfill')
- 신규 fetcher 모듈 [worker/yutura-fetch.ts](../../worker/yutura-fetch.ts) — yutura.ts에서 분리한 Cloudflare bypass / curl-impersonate / FlareSolverr 헬퍼 (yutura.ts와 yutura-chart.ts 공유)
- 신규 파서 [src/lib/yutura-chart-parser.ts](../../src/lib/yutura-chart-parser.ts) — count-table → `{ date, subscriberCount, videoCount, viewCount }[]` (7 vitest 케이스, sample HTML 검증)
- 신규 워커 [worker/yutura-chart.ts](../../worker/yutura-chart.ts):
  - `pollYuturaChartHistory()` — 활성 채널 N개 sweep, `INSERT … ON CONFLICT … DO UPDATE`로 `subscriber_snapshots` 머지
  - `backfillSixtyDaySnapshots()` — `backfillYuturaMonthlySnapshots` 래퍼, 자동으로 현재 월에서 -2개월 month 계산
- 스케줄러 [worker/scheduler.ts](../../worker/scheduler.ts) — chart (24h cadence) + monthly_backfill (720h = 30일 cadence) 추가, single-flight + 60s tick
- env [src/lib/env.ts](../../src/lib/env.ts) — `YUTURA_CHART_INTERVAL_HOURS=24`, `YUTURA_MONTHLY_BACKFILL_INTERVAL_HOURS=720`
- [src/lib/snapshot.ts](../../src/lib/snapshot.ts) baseline SQL 교체:
  - 1차: 30일+ 떨어진 행 중 현재와 카운트가 다른 가장 최근 행 (활성 채널의 transition 잡음)
  - 2차: 60일+ 떨어진 가장 최근 행 (1차 NULL = 30일 정체 채널의 60일 baseline)
  - 3차: 가장 오래된 행 (60일치 데이터 없는 신규 채널)
- Phase B 제거: [src/hooks/useInterpolatedSnapshot.ts](../../src/hooks/useInterpolatedSnapshot.ts)의 `trendBias` 인자, 비대칭 `upperReach/lowerReach` 분기, 호출부 trendBias 계산 모두 삭제

**검증**:
- ✓ vitest 46 통과 (chart parser 7개 추가)
- ✓ `tsc --noEmit` 클린
- ✓ `next build` 성공
- ⏳ 배포 후 검증: chart_pulls 테이블에 'chart' 잡 row가 생기는지, subscriber_snapshots에 일별 행이 누적되는지, ~24h 후 stagnant 채널의 growthRate가 더 이상 NULL/0이 아닌지

**향후 (#6 SocialBlade)**: 고객 별도 결제 후 추가 데이터 소스로 통합 예정. 현재 코드에는 자리 만들어두지 않음.

### ⏭️ Phase D — 데이터 기록 구조 (#4)

- 6h `subscriber_snapshots`는 유지
- 일별 집계 테이블 `subscriber_daily` 추가 검토 (Phase C 진행 중 데이터 양 보고 결정)

### ✅ Phase E — TOP150 이탈 채널 90일 유지 (완료: 2026-05-18)

**완료 내역**:
- 신규 [migrations/004_inactive_since.sql](../../migrations/004_inactive_since.sql)
  - `channels.inactive_since TEXT` 컬럼 추가
  - 마이그레이션 적용 시점에 이미 `is_active=0`인 채널들은 `inactive_since = NOW()`로 박음 → "오늘부터 카운트 시작"
  - `idx_channels_inactive_since` 인덱스 추가
- 수정 [worker/yutura.ts](../../worker/yutura.ts):
  - upsert에 `inactive_since = NULL` 추가 → 재진입 시 카운트 리셋
  - sweep을 `inactive_since = COALESCE(inactive_since, NOW)`로 — 처음 빠지는 채널만 timestamp 박고, 이미 inactive인 채널의 90일 카운트는 보존
- 신규 [worker/retention.ts](../../worker/retention.ts):
  - `runRetentionSweep()`: `is_active=0 AND inactive_since < NOW-90d` 채널 선별 후 `subscriber_snapshots → channels` 순으로 트랜잭션 DELETE
  - `startRetentionScheduler()`: 워커 시작 시 1회 + 24h 주기
- 수정 [worker/scheduler.ts](../../worker/scheduler.ts): `startScheduler` 마지막에 `startRetentionScheduler()` 호출

**검증**:
- ✓ vitest 39 통과
- ✓ `tsc --noEmit` 클린
- ✓ `next build` 성공
- ✓ Docker 재기동 후 `migration_applied file=004_inactive_since.sql` 로그 확인
- ✓ DB 확인: active 150 / inactive 1 / inactive_since=NULL인 inactive 채널 0개 (정책 의도대로)
- ✓ retention sweep은 90일 전 채널이 없어 0건 정리 (정상)

---

## 2. 미결 사항 (open questions)

- **Phase D (#4 데이터 기록 구조)**: 현재 6h `subscriber_snapshots`에 chart 일별 행이 함께 들어가는 구조로 단일화됨. 별도 `subscriber_daily` 집계 테이블이 필요한지는 데이터 양 보고 결정. 당장 미착수.
- **#6 SocialBlade 통합**: 고객 별도 결제 후 진행. 현재 코드에는 자리 없음.

---

## 3. 다음 세션이 시작할 때 할 것

1. 이 문서를 읽는다
2. 배포 후 검증 결과 확인 — `chart_pulls` row 생성, `subscriber_snapshots` 일별 행 누적, stagnant 채널 growthRate가 NULL/0이 아닌지
3. Phase D 필요성 판단 또는 SocialBlade 결제 진행 상태 확인

git log에서 `Phase A`, `Phase C`, `Phase E` 키워드로 변경 내역 확인 가능.
