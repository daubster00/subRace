# Projection Sampler — 한시적 진단 인프라 (2026-05-26 착수)

> ⚠️ **이건 정식 기능이 아니라 한시적 진단 도구입니다.** 원인 확정 후 제거할
> 코드입니다. 이 문서는 누가 보든 (다른 Claude 세션 포함) 이걸 영구 기능으로
> 오해하지 않도록 남깁니다.

## 왜 만들었는가

고객 보고:
- **ISSEI**: 30일 마일스톤 기준 일평균 증가 **>30,000명** (시간당 ~1,528명)인데
  화면은 **시간당 약 169명** 정도로만 늘어남. 3일 지켜본 결과 75,400,000
  → 75,419,800 수준 (시간당 ~275명).
- **ADO**: 30일 마일스톤 기준 일평균 ~2,500명(시간당 ~104명)인데 화면은
  **시간당 ~16명** 정도.
- 고객의 잠정 진단: "`ESTIMATION_SAFETY_RATIO=0.85` 인데 0.15가 적용된 것
  같다." 이건 옛 `interpolate` 함수의 의미("폴링 주기 동안 표시 속도의
  85%")와 현재 `estimateSubscriberCount`의 의미("다음 API 버킷 경계의 85%
  위치를 cap")가 다르다는 데서 온 멘탈모델 불일치.

이전 분석(`src/lib/interpolation.ts:76`의 cap 진동 가설)으로는 ISSEI의
75,419,800 관찰값이 설명되지 않음 — cap(75,485,000)보다 한참 아래.
즉 화면이 cap에 막힌 게 아니라, **`estimateSubscriberCount`에 들어가는
`growthRatePerHour` 자체가 1,528이 아니라 ~275/h 정도로 잡혔을 가능성**이
가장 유력. 그러나 production DB 상태 없이는 확정 불가.

추리 그만하고 **데이터로 확인**하기 위해 이 진단 인프라를 깐다.

## 무엇을 기록하나

`projected_subscriber_snapshots` 테이블 (`migrations/006_projected_subscriber_snapshots.sql`):

| 컬럼 | 의미 |
|---|---|
| `channel_id` | 채널 |
| `sampled_at` | 샘플 찍은 시각 (UTC ISO) |
| `projected_count` | `estimateSubscriberCount` 출력 — 화면에 뿌려질 값 |
| `polled_count` | 입력: 최신 YouTube API 폴링값 |
| `growth_rate_per_hour` | 입력: COALESCE baseline으로 계산한 시간당 rate |
| `elapsed_seconds` | 입력: 마지막 폴링 이후 경과 |
| `trend_baseline_count` | 입력: 어떤 baseline이 잡혔는지 (값) |
| `trend_baseline_at` | 입력: 그 baseline의 polled_at — 30d / 60d / oldest 어느 분기인지 시각으로 판별 |

입력값까지 같이 저장하는 이유: "어떤 입력이 어떤 출력을 만들었는가"를 한
SQL로 확인 가능해야 함. 결과만 저장하면 또 추리해야 함.

## 어떻게 작동하나

- **`worker/projection-sampler.ts`**: `setInterval(60_000)`. 활성 채널
  `BACKGROUND_LIMIT=150`개 전부에 대해 `snapshot.ts`의 trend baseline
  COALESCE를 그대로 재현해서 한 행씩 insert. 배치는 단일 트랜잭션.
- **`worker/retention.ts`**: 기존 24h sweep에 14일 retention 추가.
  150채널 × 1440분/일 × 14일 = 약 300만 행 / 240MB 상한.
- **`src/lib/snapshot.ts` `readSnapshot`**: `estimatedSubscriberCount`를
  반환할 때, 5분 이내 sampler 행이 있으면 그 `projected_count`를 우선
  사용. 없으면 기존 `estimateSubscriberCount` 호출로 fallback. 클라이언트
  hook(`useInterpolatedSnapshot`)은 그 값을 첫 페인트 시드로 받아서
  이후엔 자체 tick으로 계속 갱신.

부가 효과: 첫 페인트 화면이 항상 라운드 수(`...000`)에서 시작하던 UX
이슈가 해소됨.

## 진단이 끝난 뒤 무엇을 할지

데이터가 쌓이면 다음 SQL 한 줄로 ISSEI 케이스 분석 가능:

```sql
-- ISSEI 최근 24h projection 추적
SELECT
  sampled_at,
  projected_count,
  polled_count,
  growth_rate_per_hour,
  elapsed_seconds,
  trend_baseline_count,
  trend_baseline_at,
  -- 어느 COALESCE 분기인지 (대략):
  CASE
    WHEN trend_baseline_at IS NULL THEN 'null'
    WHEN julianday(sampled_at) - julianday(trend_baseline_at) >= 60.0 THEN '60d+'
    WHEN julianday(sampled_at) - julianday(trend_baseline_at) >= 30.0 THEN '30d+'
    ELSE 'oldest_fallback'
  END AS baseline_branch
FROM projected_subscriber_snapshots
WHERE channel_id = 'UC6QZ_ss3i_8qLV_RczPZBkw'
  AND sampled_at >= datetime('now', '-1 day')
ORDER BY sampled_at DESC;
```

확인 사항:
1. `growth_rate_per_hour`가 진짜 ~275/h인가, 아니면 1,528/h가 잡히는데도
   화면이 ~275/h로 보이는가?
2. (1)이 ~275/h라면 어느 COALESCE 분기가 골랐고 그 baseline은 합당한가?
3. (1)이 1,528/h인데 화면이 느리다면 → `estimateSubscriberCount`의
   cap/진동 로직 또는 클라이언트 hook의 모션 페이싱 문제.

원인을 확정한 뒤:
- 코드 수정 (rate 계산 보정 / projection 함수 수정 / 모션 페이싱 조정 등)
- **같은 sampler로 수정 결과 검증**
- 검증되면 다음 항목 **전부** 제거:
  - `migrations/006_projected_subscriber_snapshots.sql` (테이블 자체는
    유지해도 무해하지만, 미사용이 명확해지면 별도 DROP 마이그레이션 추가)
  - `worker/projection-sampler.ts`
  - `worker/scheduler.ts`의 `startProjectionSampler()` 호출
  - `worker/retention.ts`의 `PROJECTED_RETENTION_DAYS` 블록
  - `src/lib/snapshot.ts`의 `latestProjected` Map 조회 (fresh
    `estimateSubscriberCount` 호출로 되돌림)
  - 이 plan 문서

## 관련 파일

- `migrations/006_projected_subscriber_snapshots.sql`
- `worker/projection-sampler.ts`
- `worker/retention.ts` (수정)
- `worker/scheduler.ts` (수정)
- `src/lib/snapshot.ts` (수정)
- 메모리: `projection_sampler_diagnostic.md` (auto-memory)
