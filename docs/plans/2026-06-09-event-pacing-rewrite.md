# Event pacing rewrite (CF-8, 2026-06-09)

## 배경

CF-5~CF-7 일련의 수정 후 ISSEI 폭주는 해결됐지만 51~100위 채널들이 시각적으로 거의 움직이지 않는 회귀가 발생. 분석 결과 두 가지 문제가 겹쳐 있었음:

1. **`SCHEDULE_ACTIVITY_PIVOT`(absNet 곡선이 N_MIN으로 떨어지는 임계점)=300 임계점이 부자연스럽다** — `absNet`(시간당 가야 할 구독자 수)이 클수록 `N`(이벤트 개수)을 줄이는 설계가 의도와 반대. absNet 큰 채널일수록 자연히 활발해야 하는데 N이 강제로 줄어듦.
2. **작은 `absNet` 채널의 시각적 빈도가 너무 낮다** — `absNet`=50인 채널이 시간당 ~80번 이벤트 박지만 그 중 60+개가 magnitude 0(no-op)이라 클라이언트가 무시. 실제 모션은 18번 정도.

이 두 문제를 해결하기 위해 활동성 곡선을 통째로 폐기하고, `N`은 `absNet`에 비례해서 자연 증가하되 작은 `absNet` 채널에 최소 N 보장 + 빈 슬롯 채움 로직을 추가하는 방향으로 재설계.

## 폐기

- `SCHEDULE_ACTIVITY_N_MIN` (= 40)
- `SCHEDULE_ACTIVITY_N_MAX` (= 100)
- `SCHEDULE_ACTIVITY_PIVOT` (= 300)
- `src/lib/schedule-plan.ts`의 `computeActivityN` 함수
- `src/lib/schedule-plan.ts`의 `computeDynamicCounterRatio` 함수
- `NORMAL_REST_RATIO` (= 0.10) — 휴식 슬롯 비율 개념 자체 폐기
- `NORMAL_REST_MIN_MS` (= 500)
- `NORMAL_REST_MAX_MS` (= 2,000)
- `NORMAL_DIVERSIFY_RATIO` (= 0.7) — 다양화 비율 폐기, TARGET_MAG으로 직접 평균 결정
- `src/lib/schedule.ts`의 `buildCycleEvents` 안 `nTrendDiverse` 다양화 항

## 새 변수와 값

| 변수 (의미) | 값 |
|---|---|
| `MOTION_DURATION_MS` (클라 모션 길이) | 4,200ms (변경 없음) |
| `MIN_REST_MS` (모션 끝나고 다음 모션 시작까지 최소 휴식) | **2,000ms** (신규 의미 정의) |
| `MIN_EVENT_INTERVAL_MS` (인접 이벤트 최소 간격) | **6,200ms** = 4,200 + 2,000 (이전 5,500에서 증가) |
| `N_PHYS_MAX` (N의 물리적 상한) | **580** = floor(3,600,000 ÷ 6,200) |
| `SMALL_ABSNET_THRESHOLD` (작은 absNet 임계점) | **1,160** |
| `N_MIN_RANGE` (작은 absNet일 때 N 하한) | **175** |
| `N_MAX_RANGE` (작은 absNet일 때 N 상한) | **300** |
| `TARGET_MAG` (이벤트당 평균 목표 magnitude, 큰 absNet 케이스용) | **5** = MAG_HARD_MAX ÷ 2 |
| `MAG_HARD_MAX` (이벤트당 절대 상한, 기본값) | **10** (변경 없음) |
| `COUNTER_SLOT_RATIO` (총 N 중 감소 방향 슬롯 비율) | **0.10** (= 10%) |
| `COUNTER_MAG` (감소 한 번당 magnitude) | **1** |
| `EMPTY_SLOT_THRESHOLD_RATIO` (빈 슬롯 발생 임계) | **0.8** (absNet < 0.8N이면 적응 분배) |

## 알고리즘

### Step 1 — `N` 결정

```
if |absNet| < SMALL_ABSNET_THRESHOLD (1,160):
    N = random integer in [N_MIN_RANGE, N_MAX_RANGE]   # [175, 300]
else:
    N = round(|absNet| / TARGET_MAG)                    # absNet / 5
    if N > N_PHYS_MAX:                                  # 580 초과 시 캡
        N = N_PHYS_MAX
```

### Step 2 — `MAG_HARD_MAX` 동적 조정 (N=580에 캡됐을 때만)

```
if N == N_PHYS_MAX AND |absNet| > N × MAG_HARD_MAX (580 × 10 = 5,800):
    avg_mag = |absNet| / N
    MAG_HARD_MAX = round(2 × avg_mag)
# 평균값(avg_mag)이 중간값이 되도록 최대값을 2배로
```

예: `absNet`=6,100 → `avg_mag`=10.5 → `MAG_HARD_MAX`=21

### Step 3 — 분배 방식 분기 (빈 슬롯 회피)

```
trendDir = +1 if absNet ≥ 0 else -1
absAbsNet = |absNet|

if absAbsNet < EMPTY_SLOT_THRESHOLD_RATIO × N (0.8 × N):
    → 적응 분배 (Step 4a)
else:
    → 정규 분배 (Step 4b)
```

`absAbsNet < 0.8 × N`인 경우: 10% 감소 비율로 펴면 추세 슬롯에 1씩 깔아도 부족해서 0짜리 슬롯 생김. 이 케이스에서는 10% 규칙 무시하고 모든 슬롯을 ±1로 채움.

### Step 4a — 적응 분배 (작은 absNet 케이스)

```
P_trend (추세 슬롯 수) = (N + absAbsNet) / 2   # 정수 보정
Q_counter (감소 슬롯 수) = N - P_trend

trendMags = P_trend 개의 [trendDir × 1]
counterMags = Q_counter 개의 [-trendDir × 1]

# 합 = P_trend − Q_counter = absAbsNet (정수 보정 후 ±1 차이 가능)
# 모든 N 슬롯이 ±1, 0짜리 없음
```

검증: `absNet`=50, `N`=230 → `P`=140, `Q`=90, 합=50, 모든 슬롯 ±1 ✓

### Step 4b — 정규 분배 (10% 감소 비율)

```
nCounter (감소 슬롯 수) = round(N × COUNTER_SLOT_RATIO)   # = round(N × 0.10)
nTrend (추세 슬롯 수) = N - nCounter

counterTotal = nCounter × COUNTER_MAG   # = nCounter
trendTotal = absAbsNet + counterTotal

trendMags = distributeRandom(trendTotal, nTrend, MAG_HARD_MAX, rng)
            .map(m => trendDir × m)
counterMags = nCounter 개의 [-trendDir × COUNTER_MAG]
```

`distributeRandom`은 기존 함수 그대로 사용. 평균 ± 분산 폭으로 자연스러운 분포.

### Step 5 — 슬롯 시각 배치

```
merged = trendMags와 counterMags를 무작위 위치로 섞음
         (감소 슬롯 위치 = pickRandomSlots(N, Q_counter or nCounter, rng))

slot_ms (슬롯 폭) = 3,600,000 ÷ N
phaseShift = rng() × 3,600,000   # 채널별 desync용

# 인접 간격 >= MIN_EVENT_INTERVAL_MS 보장하는 jitter 폭으로 제한
safe_jitter_max = max(0, (slot_ms - MIN_EVENT_INTERVAL_MS) / 2)

for i in 0..N-1:
    raw = i × slot_ms + slot_ms/2 + jitter ± safe_jitter_max + phaseShift
    offsetMs[i] = raw mod 3,600,000

events.sort(by offsetMs)
```

## 예시 출력

| absNet (signed) | N | 분기 | MAG_HARD_MAX | 추세 슬롯 | 감소 슬롯 | 평균 trend mag | 1시간 후 도달 |
|---|---|---|---|---|---|---|---|
| +50 | random[175~300], 예 230 | 4a 적응 | 10 | 140 (+1) | 90 (−1) | 1 | +50 |
| +200 | random, 예 230 | 4a 적응 | 10 | 215 (+1) | 15 (−1) | 1 | +200 |
| +500 | random, 예 230 | 4b 정규 | 10 | 207 | 23 | 2.5 | +500 |
| +1,159 (한계) | random | 4b 정규 | 10 | ~207 | ~23 | 5.7 | +1,159 |
| +1,160 (임계) | 232 | 4b 정규 | 10 | 209 | 23 | 5.66 | +1,160 |
| +3,000 | 580 (캡) | 4b 정규 | 10 | 522 | 58 | 5.86 | +3,000 |
| +5,800 (경계) | 580 | 4b 정규 | 10 | 522 | 58 | 11.2 → 다양화 위해 캡으로 평탄화 우려 | +5,800 |
| +6,100 | 580 | 4b 정규 | **21** (동적) | 522 | 58 | 11.78 | +6,100 |
| +12,000 | 580 | 4b 정규 | **41** (동적) | 522 | 58 | 23.1 | +12,000 |
| -50 (하락) | random | 4a 적응 (trendDir=−1) | 10 | 140 (−1) | 90 (+1) | 1 | −50 |

## 영향

### 51~100위 채널 (작은 absNet)

- 현재: 시간당 80~100 이벤트 박지만 60+개가 0짜리 → 실제 모션 ~18번
- 새 설계: 시간당 175~300 이벤트, 모두 ±1 → **실제 모션 175~300번**, 1번/12~20초
- 시각적 활발도 약 10배 증가

### 1~10위 채널 (큰 absNet)

- 현재: 다양화 + 캡으로 시간당 ~500 이벤트, magnitude 평균 ~7
- 새 설계: absNet에 비례해서 N=200~580, magnitude 평균 5~10
- 큰 차이 없음, 미세하게 magnitude 분포가 5 근처로 모임

### Bounce phase

- 변경 없음 — `buildBounceEvents`는 별도 함수, ±10 랜덤 워크 그대로 유지

### Catch-up phase

- 변경 없음 — `buildCatchUpEvents`도 별도, 5초 간격 + 5% 감소 + 10% 휴식 슬롯 유지

## 구현 변경 파일

1. **`src/lib/schedule.ts`**
   - `MIN_EVENT_INTERVAL_MS`: 5,500 → 6,200
   - `NORMAL_*` 상수들 정리 (REST_*, DIVERSIFY_RATIO 제거)
   - 신규 상수: `SMALL_ABSNET_THRESHOLD=1160`, `N_MIN_RANGE=175`, `N_MAX_RANGE=300`, `TARGET_MAG=5`, `EMPTY_SLOT_THRESHOLD_RATIO=0.8`, `N_PHYS_MAX=580`
   - `buildCycleEvents` 전면 재작성: Step 1~5

2. **`src/lib/schedule-plan.ts`**
   - `computeActivityN` 삭제
   - `computeDynamicCounterRatio` 삭제
   - `PlanConfig`에서 `minEvents`, `counterRatio`, `activityNMin/Max/Pivot` 제거
   - `planTargetCycle`에서 `buildCycleEvents` 호출부 단순화 (absNet만 넘김)

3. **`src/lib/env.ts`**
   - `SCHEDULE_ACTIVITY_N_MIN/N_MAX/PIVOT` 삭제
   - `SCHEDULE_MIN_EVENTS` 이미 deprecated, 같이 제거 검토

4. **`src/lib/runtime-settings.ts`**
   - 위 env 키들 overridableShape에서 제거

5. **`.env` (prod)**
   - `SCHEDULE_ACTIVITY_*` override 있으면 제거 (현재 없음, 확인 필요)

6. **테스트**
   - `src/lib/schedule.test.ts`: `buildCycleEvents` 새 알고리즘에 맞게 갱신
   - `src/lib/schedule-plan.test.ts`: `computeActivityN`, `computeDynamicCounterRatio` 테스트 삭제. `planTargetCycle` 테스트 absNet 분포 갱신

## 배포 계획

1. 위 코드 변경 + 테스트 통과
2. 로컬 빌드 + 컨테이너 재기동
3. prod git pull + docker build
4. prod 워커 정지 → DB 미적용 이벤트 DELETE + next_cycle_reset_at NULL → 컨테이너 재기동 (전 채널 새 코드로 강제 재계획)
5. ISSEI, Sagawa, 51~100위 채널 표본 검증
6. 사용자 화면 확인

## 알려진 제약

- **단조 추세에 대한 정확성**: 정규 분배(Step 4b)는 `distributeRandom`이 합을 정확히 맞춰주지만, 적응 분배(Step 4a)는 N이 홀수일 때 정수 보정으로 ±1 오차 가능. 다음 사이클이 새 gap으로 보정.
- **임계점 1,160의 불연속**: `absNet`=1,159와 `absNet`=1,160의 N이 다를 수 있음(random vs 232). 평균은 일치하지만 한 사이클 안에서는 불연속. 시각적 영향 거의 없음.
- **Bounce drift**: 변경 없음. bounce는 ±amp 안에서 랜덤 워크라 사이클 끝에 ±maxEach 드리프트 가능.

## 메모

이번 재설계의 핵심 관점은 자네가 명시:

> "PIVOT 300을 세워서 absNet 값이 크면 N 값을 줄인다는 기획은 필요 없다고. absNet 값이 크면 자연 스럽게 N 값이 올라가겠지. 활동성이 커지고 말이야."

활동성 곡선의 의도(작은 absNet에 더 많은 슬롯)는 살리되, "큰 absNet에 적은 슬롯"이라는 부분만 폐기. 그리고 빈 슬롯 회피를 위해 적응 분배 분기 추가.
