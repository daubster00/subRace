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

### ✅ Phase B — 우상향 채널 정체 문제 (#3 임시 보정, 완료: 2026-05-18)

Phase A의 bucket clamp는 "단위 벗어나지 않음"을 보장했지만, growthRate가 단위 라운딩 때문에 0으로 잡혀 정체로 보이는 근본 원인은 Phase C(milestone)에서 해결. 그 전까지의 임시 보정 완료.

**완료 내역**:
- [src/hooks/useInterpolatedSnapshot.ts](../../src/hooks/useInterpolatedSnapshot.ts):
  - tick 안에서 채널별 `trendBias: -1 | 0 | 1` 계산
    - 1차: `growthRatePerHour`의 부호 (단, `|rate| > 0.5` 일 때만)
    - 2차 fallback: `trendBaselineSubscriberCount` 대비 현재 sCurr 부호
  - `stepFlatCount` 인자에 `trendBias` 추가
    - amplitude를 비대칭으로: 우상향이면 위로 `amplitude`, 아래로 `amplitude * 0.4`
    - 우하향은 그 반대. trendBias=0 채널은 기존 대칭 동작 유지
  - `stepNaturalCount`도 `trendBias`를 받아 flat 분기에 그대로 전달

**효과**:
- ISSEI / Akira처럼 polled 값이 단위 라운딩으로 정체된 채널 → flat 모드 진입 시 trendBaseline 부호로 위쪽 drift가 더 빈번하고 멀리 — 시각적으로 우상향 인식
- bucket clamp는 그대로 작동해 단위 범위 이탈 없음
- trendBias=0인 채널(신규 채널 / 진짜 정체)은 기존 동작 유지

**검증**:
- ✓ vitest 39 통과 (영향 없는 hook 변경)
- ✓ `tsc --noEmit` 클린
- ✓ `next build` 성공
- ⏳ 사용자 시각 검증 대기 — 정체로 보이던 채널이 우상향으로 보이는지

**Phase C 이후 제거 항목**: `trendBias` 인자, 비대칭 `upperReach/lowerReach` 분기. milestone 기반 정확한 rate가 들어오면 단위 라운딩 문제가 사라지므로 대칭 amplitude로 복원.

### ⏭️ Phase C — 60일 milestone 데이터 수집 (#5, #6, #7)

**선결 조건 (사용자 액션 대기)**: yutura의 어떤 페이지에서 채널별 60일 milestone(=API 단위 변화 시점) 데이터를 얻을 수 있는지 사용자가 직접 확인 후 알려주기로 함.

선택지:
- (a) yutura 채널 상세 페이지 `/channel/{yuturaId}/`에 일별/주별 히스토리 그래프 또는 milestone 표기가 있는 경우 → 그것을 파싱
- (b) (a)가 없으면 차선: 기존 [`backfillYuturaMonthlySnapshots`](../../worker/yutura.ts) 함수를 60일 전 / 30일 전 / 현재 시점으로 2~3회 돌려서 그 차이를 milestone 변화량으로 사용 (정확도 낮음)

확정 후 작업:
- 마이그레이션: `subscriber_milestones (channel_id, milestone_value, observed_at, source)` 신규
- 워커: 새 잡 추가 (별도 cadence, 예: 1일 1회)
- [src/lib/snapshot.ts](../../src/lib/snapshot.ts)의 `growthRatePerHour` SQL을 milestone 기반으로 교체

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

- **yutura 60일 milestone 소스**: 사용자가 직접 yutura 페이지 확인 후 알려주기로 함 — Phase C 착수 전 필수
- yutura가 적합한 페이지를 제공하지 않으면 Phase C는 (b) 경로(월별 백필 차이)로 갈지, 다른 외부 소스 후보를 다시 논의할지 결정 필요

---

## 3. 다음 세션이 시작할 때 할 것

1. 이 문서를 읽는다
2. 사용자가 Phase A 시각 검증을 마쳤는지 확인 (배포된 화면에서 단위 범위 / 방향 OK인지)
3. OK면 Phase B 또는 Phase C 진행 (yutura 조사 결과 들어왔는지에 따라)
4. NG면 Phase A 보완 후 Phase B로

git log에서 `Phase A` 키워드로 변경 내역 확인 가능.
