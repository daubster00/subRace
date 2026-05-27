# 마일스톤 기반 재설계 — 사전 감사 (audit)

**작성:** 2026-05-26
**짝꿍 스펙:** [2026-05-26-milestone-rewrite-spec.md](./2026-05-26-milestone-rewrite-spec.md) (GPT 원본)
**이전 계획:** [2026-05-18-revision-plan.md](./2026-05-18-revision-plan.md) (Phase A/C/E 완료, D/SocialBlade 미결)
**목적:** 스펙대로 구현하기 전에 현재 DB·코드 실태를 파악하고, 무엇을 유지/제거/신설할지 결정.
**범위:** 코드 1줄도 수정 안 함. 다음 세션부터의 작업 입력값으로만 쓰임.

---

## 1. DB 실측 (local `data/subrace.db`, 2026-05-26 13:05 기준)

| 테이블 | 행수 | 비고 |
|---|---|---|
| `_migrations` | 6 | 001~006 적용 완료 |
| `channels` | 151 | + `source_id`, `inactive_since` 컬럼 |
| `subscriber_snapshots` | 33,169 | (channel_id, polled_at) PK, ~222행/채널, 2026-03-21~ |
| `client_channel_snapshots` | 9,424 | 라이브/좋아요 — 별개 도메인 |
| `chart_pulls` | 8 | yutura chart/monthly_backfill 로그 |
| `youtube_polls` | 227 | YouTube API 폴링 로그 |
| `yutura_pulls` | 22 | yutura ranking sweep 로그 |
| `projected_subscriber_snapshots` | 51,750 | **한시 진단용** (1분 sampler) |

### 1.1 SocialBlade 60일 마일스톤은 이미 DB에 있다 — M1 진행 중 발견 (audit 정정)

초기 audit에서 "SocialBlade 데이터 없음"이라 적었으나 사용자 의심을 계기로 재검증한 결과 **이미 들어가 있다**:

- `social_blade_pulls` 폴링 테이블은 migration 002에서 DROP된 게 맞지만,
- 2026-05-20에 `chart_pulls`에 `kind='sb_backfill'` 단발성 import가 한 번 돌았고 (150채널 × ~30행 = 4,519행), 그 데이터가 `subscriber_snapshots`로 들어감.
- 현재 `subscriber_snapshots`의 가장 오래된 행이 **2026-03-21** = 오늘 기준 정확히 60일 전. SB 60일 마일스톤 데이터의 좌측 경계.
- 자정 UTC 행 10,187건은 두 출처 혼합:
  - 2026-03-21 ~ 2026-05-17 (58일) → SocialBlade 백필
  - 2026-05-18 ~ 2026-05-27 (10일) → yutura-chart 매일 sweep

**"하루 평균 증감량" 형태로 저장된 컬럼은 없음** (이건 audit 원안대로 맞음). rate는 `src/lib/snapshot.ts`에서 매번 SQL COALESCE로 동적 계산.

### 1.2 그런데 사실 `subscriber_snapshots`가 이미 "마일스톤 히스토리"다 — 단, 노이즈가 많음

스펙이 가정한 두 시나리오 ((a) SB 원본 day×channel 데이터 존재, (b) 평균 증감량만 저장) 중 **사실상 (a)가 맞다**:

- 2026-05-20 `sb_backfill`로 SocialBlade 60일 데이터 들어옴 → 자정 UTC 행으로 박힘
- `worker/yutura-chart.ts`가 매일 sweep으로 같은 형태(자정 UTC) 추가 (M1에서 삭제)
- YouTube API 폴링이 10분 간격으로 같은 테이블에 INSERT → 대부분 동일값 중복

**실측 (2026-05-27)**:
- 총 43,719행 중 인접 행 변화 비율 평균 2.6% → **97.4%가 중복 폴링 응답**
- 의미 있는 마일스톤 데이터는 약 11,000행
  - 자정 UTC 10,187건 (SB + yutura-chart)
  - 그 외 변화 있는 행 ~870건 (API 폴링이 감지한 실제 변경)

샘플 (`UC6QZ_ss3i_8qLV_RczPZBkw` = ISSEI): 2026-03-21 ~ 2026-05-27 사이 290행, 73.6M → 75.5M으로 20개 마일스톤 달성.

**M1 결정 (사용자 확정)**: 중복 폴링 행을 모두 삭제하고 `(channel_id, subscriber_count)` 단위로 "처음 도달 시점"만 보존. migration 007 적용 후 43,719행 → **1,086행** (97.5% 감소). 채널당 평균 7.2개 마일스톤. 이로써 `subscriber_snapshots`가 진짜 milestone_history 역할을 한다.

---

## 2. 현재 구독자 수 표시 파이프라인 (전수 매핑)

```
┌─ 입력 ──────────────────────────────────────────────────────────┐
│ worker/yutura-chart.ts     (1/day)  → subscriber_snapshots      │
│   - parseChartTable() 일별 30행/채널                            │
│   - UPSERT ON CONFLICT                                          │
│ worker/youtube-channels.ts (≈10m)   → subscriber_snapshots      │
│   - YouTube channels.list API                                   │
│   - INSERT OR IGNORE (같은 polled_at이면 skip)                  │
│ worker/yutura.ts           (48h)    → channels (TOP150 sweep)   │
└─────────────────────────────────────────────────────────────────┘
                          ↓
┌─ 백엔드 계산 ───────────────────────────────────────────────────┐
│ src/lib/snapshot.ts readSnapshot()                              │
│   - LEFT JOIN channels × 최신 subscriber_snapshots              │
│   - trend_baseline_count: 30d-active → 60d → 가장 오래된 COALESCE│
│   - growthRatePerHour = (curr - baseline) / hours               │
│   - estimateSubscriberCount() 호출                              │
│   - projected_subscriber_snapshots에 <5분 fresh 행이 있으면     │
│     그 projected_count로 대체                                   │
│                                                                 │
│ src/lib/interpolation.ts estimateSubscriberCount()              │
│   - cap = bucket.floor + 0.85 * bucket.unit  ← BUCKET 기반      │
│   - linear < cap이면 linear, ≥ cap이면 sin 곡선 ±10% × unit     │
│   - bucket은 api-bucket.ts의 3-sig-fig 라운딩 구간 (1만/10만/100만) │
│                                                                 │
│ worker/projection-sampler.ts (60s, 한시적)                      │
│   - 위 SQL을 그대로 재현해서 projected_subscriber_snapshots에 박음 │
│   - readSnapshot이 첫 페인트 시드로 사용                        │
└─────────────────────────────────────────────────────────────────┘
                          ↓ /api/snapshot
┌─ 프론트 보간/표시 ──────────────────────────────────────────────┐
│ src/app/_components/Dashboard.tsx                               │
│   - useQuery로 /api/snapshot 30s 폴링                           │
│   - useInterpolatedSnapshot(data, _, safetyRatio) 호출          │
│                                                                 │
│ src/hooks/useInterpolatedSnapshot.ts                            │
│   - RAF 루프, 채널마다 MotionState (nextDecision/active/step)   │
│   - getMotionCadence: rate>=500 / >=100 / >=20 / quiet 4단계    │
│   - stepNaturalCount: target=estimateSubscriberCount() 호출,    │
│     drift+correction 이벤트 발화, ±10% bucket 진폭              │
│   - localStorage 'subRace:displayCounts:v2'에 24h TTL 영속화    │
│                                                                 │
│ RankCard.tsx → RollingCounter.tsx — displayCount 시각화         │
└─────────────────────────────────────────────────────────────────┘
```

### 2.1 cap의 의미 차이가 결정적

| 항목 | 현재 (interpolation.ts) | 스펙 (GPT) |
|---|---|---|
| cap 기준 | 폴링값이 속한 **API bucket** (3-sig-fig 라운딩 구간) | 다음 **milestone** (1M / 10M / 100M 같은 라운드 수치) |
| 공식 | `bucket.floor + 0.85 * bucket.unit` | `api + (next_milestone - api) * 0.85` |
| 예시 (75.4M ISSEI) | bucket [75_400_000, 75_500_000), cap = 75_485_000 | next_milestone = 76_000_000 또는 80_000_000?, cap = ~75.85M~75.92M |

**의문점:** GPT 스펙에서 "next_milestone"이 정확히 무엇인지 모호. 현재 코드의 bucket 경계와 비슷한 의미라면 사실상 동일. 1M 단위의 라운드 수치라면 의미가 다름. **2단계 시작 전 사용자 확인 필요.**

### 2.2 표시값 생성 위치가 다르다

| 항목 | 현재 | 스펙 |
|---|---|---|
| 표시값 생성 위치 | **클라이언트** (RAF + motion state) | **서버** (display_state 테이블에 미리 박힘) |
| 일 계획 | 없음 (실시간 drift) | 있음 (하루 N회 변경 이벤트 예약) |
| 감소 이벤트 | drift oscillation 일부로만 (±10% unit) | 명시적 비율 (10~25% / 60~85%) |
| localStorage 의존 | 있음 (24h TTL) | 없음 (서버 단일 출처) |

이건 단순한 알고리즘 교체가 아니라 **표시 책임을 클라이언트 → 서버로 옮기는 아키텍처 이동**이다.

---

## 3. 유지 / Deprecate / 신설 결정표

### 3.1 DB 자산

| 자산 | 분류 | 비고 |
|---|---|---|
| `channels` | 유지 | 인덱스/컬럼 그대로 |
| `subscriber_snapshots` | **확장** | `source TEXT` 컬럼 추가 → milestone_history 역할 흡수. 기존 행은 시각 패턴(midnight=yutura)으로 backfill 또는 일괄 `'legacy'`로 마크 |
| `chart_pulls`, `yutura_pulls`, `youtube_polls`, `client_channel_snapshots`, `_migrations` | 유지 | 손댈 이유 없음 |
| `projected_subscriber_snapshots` | **제거** | 한시 진단 인프라. M1/M5에서 sampler·테이블·retention 일괄 제거 |
| 신설 `poll_state` | 신설 | (channel_id PK, api_subscriber_count, previous_api_subscriber_count, next_milestone, cap_subscriber_count, last_polled_at, last_api_changed_at, updated_at) |
| 신설 `display_state` | 신설 | (channel_id PK, display_subscriber_count, target_subscriber_count, cap, today_delta, change_count, applied_change_count, next_change_at, last_changed_at, plan_date, updated_at) |
| `display_plan` (선택) | **미정** | display_state로 충분한지 1단계 후 결정. 1일 N회 이벤트를 테이블로 둘지, 매번 알고리즘으로 재계산할지 트레이드오프 |

### 3.2 코드 자산

| 파일 | 분류 | 변경 내용 |
|---|---|---|
| `src/lib/db.ts` | 유지 | better-sqlite3 init만 |
| `src/lib/env.ts` | 확장 | `MILESTONE_HISTORY_RETENTION_DAYS=120`, `MILESTONE_HISTORY_WINDOW_DAYS=120`, `MILESTONE_WEIGHT_RECENT_DAYS=14`, `CHANGE_BIAS_UP_MIN/MAX`, `CHANGE_BIAS_DOWN_MIN/MAX` 등 |
| `src/lib/api-bucket.ts` | 유지 | "표시값이 API 단위를 침범하지 않게 하는 안전망"으로 남김. cap은 별도 next_milestone 모듈에서 다시 계산 |
| `src/lib/interpolation.ts` | **deprecated** | `estimateSubscriberCount`/`interpolate` 둘 다 호출 제거 후 함수만 유지(테스트 보존). 새 흐름에선 안 씀 |
| `src/lib/snapshot.ts readSnapshot()` | **대규모 수정** | LEFT JOIN을 `channels × display_state × poll_state`로 교체. growthRate/cap/projection SQL 전부 제거. SourceStatus는 유지 |
| `src/hooks/useInterpolatedSnapshot.ts` | **대규모 단순화** | RAF/motion cadence/oscillation 전부 제거. `data.channels[i].subscriberCount`(= display_subscriber_count) 그대로 표시. RollingCounter는 단순 변경 감지로 회전만 |
| `src/app/_components/Dashboard.tsx` | 소폭 | `interpolatedChannels` 분기 제거, displayChannels = `data.channels` 직매핑 |
| `src/app/_components/RankCard.tsx` | 소폭 | motionActiveUntil/motionDirection은 서버에서 받거나(권장) display_state.last_changed_at + 이벤트 방향으로 도출 |
| `src/app/_components/RollingCounter.tsx` | 유지 | 변경 감지·애니메이션은 그대로. 입력만 서버 display_count로 바뀜 |
| `worker/youtube-channels.ts pollYoutubeChannels()` | **수정** | (1) snapshot에 INSERT는 `source='youtube_api_change'` 태깅 + **변경분만** insert (2) `poll_state` upsert (api/prev/last_polled_at/last_api_changed_at) (3) 변경 발생 시 display_plan 재계산 트리거 |
| `worker/yutura-chart.ts` | **소폭 수정** | INSERT 시 `source='yutura_chart'` 태깅. 나머지 그대로 |
| `worker/yutura.ts` | **건드리지 않음** | 채널 sweep 자체는 PRD에서 격리 영역 |
| `worker/projection-sampler.ts` | **제거** | M1 또는 M5 시점 |
| `worker/retention.ts` | **확장** | 채널 90d retention은 유지. milestone_history(=subscriber_snapshots) 120d cleanup 추가 (미래 날짜 socialblade_milestone 행 보존). projected_* sweep 제거 |
| `worker/scheduler.ts` | **수정** | `startProjectionSampler()` 제거. display planner/executor 추가 |
| 신설 `src/lib/milestone-delta.ts` | 신설 | `subscriber_snapshots`에서 channel별 인접 행 delta → daily_delta 가중치 평균. 최근 N일 가중치 분리. source별 가중치 적용 |
| 신설 `src/lib/next-milestone.ts` | 신설 | next round milestone 함수. **정의는 사용자 확인 필요** (M1 시작 전) |
| 신설 `src/lib/cap.ts` | 신설 | `cap = api + (next_milestone - api) * SAFETY_RATIO` |
| 신설 `worker/display-planner.ts` | 신설 | 채널별 daily plan 생성. 하루 변경 횟수, 증가/감소 이벤트 비율, 랜덤 분산, 보정 |
| 신설 `worker/display-executor.ts` | 신설 | next_change_at 도래 시 display_subscriber_count 갱신, applied_change_count 증가 |
| 신설 `worker/socialblade-import.ts` | 신설 (stub) | `importSocialBladeMilestones({channel_id, date, subscriber_count}[])` 함수만. 향후 SB 60d 원본을 받아 `subscriber_snapshots`에 source='socialblade_milestone'으로 insert |

---

## 4. 단계 분해 (제안)

각 단계는 별도 세션에서 진행. 끝마다 vitest/tsc/next build 검증.

| # | 단계 | 산출물 | 사전 결정 필요 |
|---|---|---|---|
| **M0** | (이 문서) audit | spec + audit + 결정표 | — |
| **M1** | 스키마 마이그레이션 + 진단 인프라 제거 | migration 007 (`source` 컬럼, `poll_state`, `display_state`), projected_* drop, retention 확장 | next_milestone 정의 확정 |
| **M2** | polling → milestone_history 변경분 insert + poll_state upsert | worker/youtube-channels.ts, worker/yutura-chart.ts 태깅 | — |
| **M3** | milestone-delta 계산기 (가중치 블렌딩) + cap 계산기 + 단위테스트 | `src/lib/milestone-delta.ts`, `src/lib/next-milestone.ts`, `src/lib/cap.ts` | — |
| **M4** | display-planner — daily plan 생성 | worker/display-planner.ts, env 추가 | 증감 이벤트 비율 값(스펙은 범위 제시) |
| **M5** | display-executor + scheduler 통합 (projection-sampler 제거) | worker/display-executor.ts, scheduler.ts 수정 | — |
| **M6** | API/프론트 컷오버 | snapshot.ts 단순화, useInterpolatedSnapshot 단순화, Dashboard.tsx 조정 | RankCard motion 트리거 방식 |
| **M7** | retention/cleanup 마무리 + SB import stub | retention.ts 확장, worker/socialblade-import.ts | — |
| **M8** | deprecated 정리 (interpolation.ts 호출부 제거 등) | refactor | — |

---

## 5. 사용자 확정 결정 (M1 차단 이슈)

**1. `next_milestone` 정의 — 확정: (a) api-bucket 그대로** (2026-05-27)
   - <10M은 1만 단위, <100M은 10만 단위, ≥100M은 100만 단위. 75.4M의 next_milestone = 75.5M.
   - 의미적으로 현재 bucket cap과 거의 동일하지만 두 값을 분리 보관 (poll_state.next_milestone + poll_state.cap_subscriber_count).
   - cap = api + (next_milestone - api) * SAFETY_RATIO. next_milestone은 cap 입력 + 절대 상한선 역할.

**2. `subscriber_snapshots` 처리 — 확정: 확장 + 중복 정리 + source 3-way 마킹** (2026-05-27)
   - 새 테이블 신설 X. `source TEXT` 컬럼 추가 후 마일스톤 히스토리 역할.
   - 중복 정리 정책: `(channel_id, subscriber_count)` 단위로 가장 오래된 `polled_at`만 보존. 43,719행 → 1,086행.
   - source 마킹:
     - polled_at이 `T00:00:00.000Z`이고 `< 2026-05-18` → `'socialblade_milestone'` (sb_backfill 출처)
     - polled_at이 `T00:00:00.000Z`이고 `≥ 2026-05-18` → `'yutura_chart'` (M1에서 삭제될 worker 출처)
     - 그 외 → `'youtube_api_change'`
   - `(channel_id, subscriber_count)` unique index 생성.
   - migration 007에 모두 포함.

**3. `display_plan` 별도 테이블 — 잠정: display_state 단일 테이블로 시작** (M4 시작 전 재결정)

**4. RankCard motion 트리거 — 미결** (M6 시작 전 결정 필요)
   - 옵션 (a) 폴링 diff: display_state에 `last_changed_at`, `last_change_direction` 두고 30s 폴링 응답에 포함
   - 옵션 (b) SSE(`/api/events`)로 변경 푸시
   - (a)로 시작하고 시연 후 부족하면 (b) 추가하는 점진적 전환이 권장.

**5. 30s 폴링 화면 체감 시연 시점 — 미결** (M6 완료 후 권장)
   - 옵션 (1) M6 컷오버 직후 로컬 시연 → 알고리즘 파라미터 튜닝 → 운영 배포 (권장)
   - 옵션 (2) M5 직후 dev 환경에서 데이터만 확인
   - 옵션 (3) M6 완료 후 운영 서버에 바로 배포 → 사용자 체감

## 5.1 M1에서 결정·완료된 추가 사항 (2026-05-27)

- `worker/yutura-chart.ts` 매일 자정 sweep 삭제 (`pollYuturaChartHistory` + `backfillSixtyDaySnapshots` 둘 다).
- 앞으로 yutura는 TOP200 채널 sweep(`worker/yutura.ts`, 48h)만 유지. 마일스톤 데이터는 YouTube API 폴링에서만 누적.
- `src/lib/yutura-chart-parser.ts` + 테스트 파일 같이 삭제 (parser 사용처가 yutura-chart.ts 뿐).
- `worker/projection-sampler.ts` 삭제 + `src/lib/snapshot.ts` projected fallback 분기 제거 + `worker/retention.ts` projected sweep 제거. `projected_subscriber_snapshots` 테이블 + 인덱스도 migration 007에서 DROP.
- env 변수 `YUTURA_CHART_INTERVAL_HOURS`, `YUTURA_MONTHLY_BACKFILL_INTERVAL_HOURS`는 더 이상 참조되지 않지만 일단 schema에는 유지 (M8 deprecated 정리 때 제거).
- M2 작업 (변경분만 INSERT + poll_state upsert)는 별도 세션으로 분리.

---

## 6. 스펙 결과 보고용 사전 답변 (참고)

스펙 마지막의 "작업 결과로 다음을 제공해라" 8개 항목 중 **7번/8번은 이 audit으로 이미 답이 나옴**:

- **7. 기존 데이터가 SocialBlade 원본 마일스톤인지, 평균 증감량뿐인지 확인한 결과**
  - **둘 다 아님.** SocialBlade 데이터는 DB에 없음 (migration 002에서 삭제). 평균 증감량 컬럼도 없음. 실제로는 **yutura chart 일별 데이터 + YouTube API 폴링값**이 단일 테이블(`subscriber_snapshots`)에 source 구분 없이 섞여 있음. 이건 GPT 스펙의 가정에는 없었던 제3의 케이스.

- **8. SocialBlade 원본 마일스톤 데이터가 없을 경우 나중에 import해야 할 데이터 형식 안내**
  - `worker/socialblade-import.ts` 함수에 `{ channel_id: string, date: string ISO, subscriber_count: number }[]` 배열을 넘기면 됨. 내부에서 `subscriber_snapshots`에 `source='socialblade_milestone'`, `polled_at=date`로 UPSERT. 미래 날짜 행(예측치)도 같은 함수로 입력 가능 — retention sweep에서 미래 날짜는 보존.

---

## 7. 변경하지 않는 것 (스펙 §4 명시)

- `worker/yutura.ts` 채널 sweep 로직
- `src/lib/api-bucket.ts` (안전망으로 유지)
- `src/lib/rank-alert.ts`, `src/lib/runtime-settings.ts`, 클라이언트 채널 라이브 폴링 등 부수 도메인
- PRD.md (필요 시 별도 업데이트)
