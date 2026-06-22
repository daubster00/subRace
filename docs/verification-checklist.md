# SubRace 작동 검증 체크리스트

> 이 프로젝트(Next.js 웹 + 워커 + SQLite + SSE 대시보드)가 제대로 작동하는지
> 확인하는 검증 항목. 사용자가 "검증해줘"라고 하면 메인 에이전트가 이 목록을
> 위에서부터 실제로 실행/확인하고 항목별 통과/실패를 채운다.
>
> 파이프라인: **데이터 수집(워커) → 마일스톤 저장 → 디스플레이 플래너 → SSE → 화면 애니메이션**

## ⚠️ 검증 환경 — 무조건 운영 서버(prod)에서 (필수)

**검증은 로컬이 아니라 반드시 실제 운영 서버에서 실행한다.** 로컬 DB와 prod DB는
다르며, 화면에 실제로 송출되는 건 prod다. 로컬만 보고 "정상"이라 보고하면 오답이다.

- 접속: SSH alias `subrace-prod-01`, repo `/home/ubuntu/apps/subRace`
- docker는 **`sudo` 필요**(passwordless). 예: `ssh subrace-prod-01 'sudo docker ps'`
- audit 스크립트 실행:
  `ssh subrace-prod-01 'cd /home/ubuntu/apps/subRace && sudo docker exec subrace-worker node scripts/audit-freshness.js'`
  - 컨테이너에 스크립트가 없으면 먼저 호스트→컨테이너 복사하거나 repo를 pull한 상태에서 실행.
- 컨테이너 내부 DB 경로는 `/app/data/subrace.db`.
- 로컬은 어디까지나 사전 점검용. **최종 통과/실패 판정은 prod 결과로만 기록한다.**

---

## 1. 인프라 / 가동 상태
- [ ] `subrace-web`, `subrace-worker` 컨테이너가 모두 `Up` 상태 (`docker ps`)
- [ ] 포트 3100 응답 — `curl -I http://localhost:3100/api/health` → `200`
- [ ] 대시보드 페이지가 Basic Auth 통과 후 정상 렌더 (`/` 접속, RankGrid 50칸 채워짐)
- [ ] 워커 로그에 크래시/재시작 루프 없음 (`docker logs --tail 100 subrace-worker`)

## 2. 빌드 / 코드 건전성
- [ ] `npm run typecheck` (`tsc --noEmit`) 통과
- [ ] `npm run lint` 통과
- [ ] `npm run test` (vitest) 통과 — 특히 `interpolation`(보간), `next-milestone`(다음 마일스톤), `schedule-plan`(이벤트 분배), `rank-alert`(순위 임박) 단위 테스트
- [ ] `migrations/` 12개가 모두 적용됨 (`_migrations` 테이블 행 수 = 파일 수)

## 3. 데이터 수집 파이프라인 (워커 폴링)
`docker exec subrace-worker node scripts/audit-polling.js`
- [ ] `youtube_polls`(유튜브 구독자 폴링 이력)의 마지막 `success`가 **폴링 주기(운영 2분) 내**에 있음
- [ ] `yutura_pulls`(유튜라 폴링 이력) 마지막 성공이 설정 주기 내
- [ ] 최근 폴링에 `quota_exceeded`(API 쿼터 초과) 연속 발생 없음
- [ ] 좋아요/라이브 시청자 폴링(`CLIENT_CHANNEL_ID` 기준)이 SummaryCard 값을 갱신 중

## 4. 마일스톤 데이터 신선도·무결성
`docker exec subrace-worker node scripts/audit-freshness.js`

> ⚠️ **착각 금지 — SB/yutura "백필"의 위치 (2026-06-22 실수 기록)**
> 백필(=과거 한 번 긁어둔 SocialBlade 60일+치 historical 추이)은 `subscriber_snapshots`
> 테이블에 있다(`source='socialblade_milestone'`, 수천 건). 추세 SSOT인 `milestones`
> 테이블에는 migration 012 설계상 **"SB 백필 시드 + 실시간 youtube_api_change"가 함께**
> 들어 있어야 정상이며, 시드는 `scripts/backfill-milestones.js`가 `subscriber_snapshots`→`milestones`로 적재한다.
> **`milestones`만 보고 `socialblade_milestone`=0건이라고 "백필이 사라졌다"고 결론짓지 말 것.**
> 반드시 `subscriber_snapshots`도 같이 조회해 원본이 살아있는지 확인하고,
> `milestones`에 SB 시드가 없으면 "데이터 소실"이 아니라 **"백필 시드 미적재"**로 판정한다.
> ([[sb_scrape_signed_deltas]], [[feedback_milestone_ssot]], [[deprecated_subscriber_snapshots]] 참조)

- [ ] `milestones` 테이블에 **SB 백필 시드가 적재돼 있음** — `source`별 건수 조회 시 `socialblade_milestone`이 0이 아님. 0이면 `subscriber_snapshots`에 원본이 있는지 확인 후, 미적재면 `scripts/backfill-milestones.js` 재실행 필요로 판정(데이터 소실 아님)
- [ ] 활성 채널 중 **마일스톤 2개 이상(추세 계산 가능)** 비율이 충분함 — 0~1개면 그 채널은 추세 불가 → `fixed`(정지)로 표시됨. 117/150이 0~1개면 백필 미적재 신호
- [ ] `ACTIVE channels with ZERO milestones`(마일스톤 0개 활성 채널)가 비정상적으로 많지 않음
- [ ] `SUSPICIOUS milestone jumps`(값의 5% 초과 급변) = 비정상 급증 없음 — `sb_scrape_signed_deltas`(음수 delta 누락) 메모리 이슈 재발 점검
- [ ] `NEGATIVE milestone values`(음수 구독자 값) = 없음
- [ ] `SAME-TIMESTAMP conflicts`(동일 시각·다른 값 충돌) = 없음 — 마일스톤 SSOT(단일 출처) 원칙 준수
- [ ] `LIFECYCLE inconsistencies`(활성/비활성 플래그와 `inactive_since` 모순) = 없음
- [ ] `DUPLICATE source_id mappings`(한 원천 채널이 두 SubRace 채널로 매핑) = 없음

source별 건수 확인 쿼리:
`docker exec subrace-worker node -e "const d=require('better-sqlite3')('/app/data/subrace.db',{readonly:true}); console.log('milestones',d.prepare('SELECT source,COUNT(*) n FROM milestones GROUP BY source').all()); console.log('snapshots',d.prepare('SELECT source,COUNT(*) n FROM subscriber_snapshots GROUP BY source').all());"`

## 5. 디스플레이 플래너 — phase별 정밀 검증 (★ 핵심)

> **검증 전 필독.** 화면 모션은 채널마다 **4개 phase(위상)** 중 하나로 움직이며, 각
> phase는 **발동 조건·이동 방식·파라미터가 전부 다르다.** "화면값이 올라간다"만 보고
> 정상이라 판정하면 안 된다. 채널이 *어떤 phase에 있어야 맞는지* 판정하고, *그 phase의
> 거동 규칙*을 지키는지 봐야 한다. (2026-06-22: `normal`과 `catch-up`을 혼동해 오진한 사고)
>
> 관련 코드: `src/lib/schedule-plan.ts`(phase 결정), `src/lib/schedule.ts`(이벤트 빌더),
> `src/lib/milestone-delta.ts`(trendSign·예상속도), `worker/channel-scheduler.ts`(트리거),
> `worker/display-planner.ts`(조립). prod 기본 파라미터: MIN_MILESTONES=3, 상승천장=마일스톤+0.99단위,
> 기본속도=0.9×예상속도, catch-up=간격 5초·이벤트당 ≤40, normal/bounce=이벤트당 ≤10(동적상한 30),
> 사이클=1시간, normal 최소 이벤트간격=6.2초, bounce 진동폭: 상승주차 0.2%·하락정체 1%.

### 5.0 트리거 → phase 맵 (먼저 이걸 알아야 함)
- **`cycle` 트리거**(사이클 만료 = 이벤트 소진 or `next_cycle_reset_at` 도달) → `planTargetCycle` → **fixed/normal/target-bounce**
- **`startup` 트리거**(워커 부팅, 스케줄 없는 신규 채널) → `planTargetCycle` → 위와 동일
- **새 마일스톤 감지**(`onNewMilestone`) → ⚠️ **`cycle` 트리거를 부른다** (catch-up 아님!) → `planTargetCycle`
- **`milestone` 트리거**(→ `planCatchUp`)는 코드에 존재하나 **라이브 경로에서 호출되지 않음.** 따라서 **상승 채널은 새 마일스톤이 떠도 catch-up 점프를 하지 않는다.** (5.C 참조)

### 5.A phase별 정의·발동조건·거동·검증

**① `fixed` (정지)**
- 발동: 마일스톤 < 3개(MIN_MILESTONES). 추세 계산 불가.
- 거동: display=target=api값, **이벤트 0개**, 화면 완전 정지.
- [ ] `fixed` 채널은 **마일스톤이 3개 미만일 때만** 나와야 정상. 마일스톤 ≥3인데 `fixed`면 버그. (prod는 백필로 대부분 ≥3 → `fixed`가 거의 0이어야 정상. 다수면 §4 백필 확인)

**② `catch-up` (따라잡기)**
- 발동(라이브 실경로): `planTargetCycle`에서 **정체(trendSign=0) AND display < 마일스톤(floor)**일 때만 → `planCatchUp(마일스톤+1%)`. (상승 채널은 이 phase에 못 들어옴 — 5.C)
- 거동: **5초 고정 간격**, 이벤트당 **±40까지**, 단방향. 4연속마다 +8초 쉼, 10연속마다 역방향 1개(±1~5). 1시간 사이클에 안 묶임(갭 크면 1h 초과). "한 번에 30~40씩 점프"가 catch-up의 시그니처.
- [ ] `catch-up` 채널의 미적용 이벤트: 간격 ≈5초, magnitude 최대 40, 대부분 같은 방향 + 가끔 역방향 1개
- [ ] catch-up은 정체+floor아래 채널에서만 — 상승 채널이 `catch-up`이면 비정상

**③ `normal` (분산 이동)**
- 발동(4갈래): (a) 상승(trendSign=1)·display<천장 → 감속곡선 따라 위로 / (b) 상승·display>천장 → 천장으로 끌어내림 / (c) 하락(-1)·display<마일스톤 → 마일스톤+1%까지 위로 / (d) 하락·정체·display>마일스톤+1% → 끌어내림
- 거동: 1시간에 N개 이벤트, 이벤트당 ≤10(동적 최대 30), 간격 ≥6.2초. 상승 감속곡선 배수: p<0.90→1.0, 0.90~0.93→0.5, 0.93~0.97→0.25, 0.97~0.99→0.1, p≥0.99→0(주차). **속도 = 0.9 × (단위/예상도달시간) × 1h × 감속배수.**
- [ ] `normal` 이벤트 magnitude 절대값 ≤30, 간격 ≥6.2초(catch-up 아님)
- [ ] 상승 `normal`: 시간순 누적이 **천장(target=마일스톤+0.99단위)을 절대 추월 안 함**(하드가드)
- [ ] 끌어내림 `normal`(display>천장): netDelta 음수로 천장까지 내려감

**④ `target-bounce` (주차 진동)**
- 발동: (a) 상승·netDelta=0(p≥0.99 주차) → 천장 바로 아래 미세 진동(폭 0.2%, 위로 거의 못 감·아래로만) / (b) 정체·하락·display∈[마일스톤, 마일스톤+1%] → 1% 밴드 내 단방향 진동(마일스톤 밑으로 못 감)
- 거동: **netDelta≈0**, 300개 이벤트, |mag|=1~5, 누적이 [−negCap, +posCap] 안. 다음 마일스톤 절대 추월/이전 마일스톤 절대 하향 돌파 안 함.
- [ ] `target-bounce` 채널 netDelta≈0, display가 천장 위로 안 가고 floor 밑으로 안 감

### 5.B 공통 이벤트 불변식 (`audit-events.js`)
- [ ] `MAGNITUDE VIOLATIONS`(|magnitude|>30) = 0건 — 단일 점프 시각 상한
- [ ] `INTERVAL VIOLATIONS`(<4200ms) = 0건 — 모션이 겹치지 않게(normal 6.2초·catch-up 5초 모두 4.2초 위)
- [ ] `ACTIVE channels MISSING display_state` = 없음
- [ ] 멈춘 채널 없음 — 모든 활성 채널이 진행 중 스케줄/리셋 시각 보유

### 5.C 상승 채널 FLOOR 위반 — 수정 반영됨(2026-06-22)
**이력**: 상승 채널은 새 마일스톤이 확정돼도 catch-up을 안 하고(5.0 참조) normal의 느린
속도(0.9×예상속도)로만 따라가, floor가 점프했는데 display가 한참 아래면 갭을 못 닫아
`display < 최신 마일스톤`(FLOOR 위반)이 장시간 지속됐다.

**수정**(`src/lib/schedule-plan.ts` 상승 분기): `display < floor`(최신 마일스톤)이면
정체 분기와 동일하게 **`planCatchUp(마일스톤+1%)`로 라우팅** → 이벤트당 ≤40·5초 간격으로
빠르게 닫고, 닫은 뒤 다음 사이클부터 normal 감속 곡선이 이어받는다. 단위 테스트:
`schedule-plan.test.ts`의 "상승 + display < 마일스톤(floor) → catch-up".

검증(수정 적용 후 기대):
- [ ] FLOOR 위반(`display < 최신 마일스톤`) 채널을 뽑았을 때, **그 채널들이 `catch-up` phase로 잡혀** 빠르게 닫히는 중이어야 함(이전처럼 `normal`로 정체 ❌)
- [ ] 시간 경과 재측정 시 부족분이 **빠르게 감소**(catch-up 속도). 여전히 `normal`로 정체하면 수정이 배포 안 됐거나 회귀
- [ ] 마일스톤 점프 직후 해당 채널이 "한 번에 30~40씩" 상승하는 catch-up 모션을 보이는지(육안)

phase 분포 + FLOOR 위반 동시 확인 쿼리:
`docker exec subrace-worker node -e "const d=require('better-sqlite3')('/app/data/subrace.db',{readonly:true}); console.log('phase',d.prepare('SELECT phase,COUNT(*) n FROM display_state GROUP BY phase').all()); const v=d.prepare(\"WITH l AS (SELECT m.channel_id,m.subscriber_count ms FROM milestones m JOIN (SELECT channel_id,MAX(recorded_at) mx FROM milestones GROUP BY channel_id) t ON t.channel_id=m.channel_id AND t.mx=m.recorded_at) SELECT c.name,ds.display_subscriber_count disp,l.ms,l.ms-ds.display_subscriber_count deficit,ds.phase FROM display_state ds JOIN channels c ON c.id=ds.channel_id JOIN l ON l.channel_id=ds.channel_id WHERE c.is_active=1 AND ds.display_subscriber_count<l.ms ORDER BY deficit DESC\").all(); console.log('floor_violations',v.length); console.log(JSON.stringify(v.slice(0,15),null,2));"`

## 6. SSE / 프론트엔드 표시
- [ ] `curl -N http://localhost:3100/api/events` → `hello` + `snapshot` 이벤트 수신, 이후 `channel_update` 푸시 + 20초마다 `snapshot` 재전송, 25초 heartbeat
- [ ] 구독자 수가 **롤링 카운터**(자릿수별 순차 변화)로 부드럽게 증가
- [ ] 순위 변동 시 카드가 사라지지 않고 부드럽게 이동(FLIP), 50위권 진입/이탈 애니메이션 작동
- [ ] 순위 임박 쌍이 강조되고 `RankAlertPanel`(임박 개수 배지)에 숫자 반영
- [ ] 배포 시 열린 탭이 자동 리로드 (`build-id` 변경 감지 — `docs/auto-reload.md` 메커니즘)

## 7. 장애 / 페일오버 안전성 (OBS 송출 보호)
- [ ] API 폴링 실패해도 화면은 **마지막 정상 데이터 유지**, 숫자 유지
- [ ] 장애 시 `LiveStatusPanel`(실시간 상태 점/문구) **색상만 경고색**으로 변경 — 에러 배너·모달 절대 미표시
- [ ] DB 일시 장애 시 SSE 연결 끊기지 않고 다음 주기 재시도

## 8. 보안 / 배포
- [ ] `git status`/`git log`에 API 키·`.env`·`자료/` 커밋 흔적 없음 (`.gitignore` 적용 확인)
- [ ] Basic Auth 미인증 접근 시 401
- [ ] 로컬↔prod 동기화 상태 일치 (host DB 수정 전 컨테이너 정지 — DB 락 방지 원칙)
