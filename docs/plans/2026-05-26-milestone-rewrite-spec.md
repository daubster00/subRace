# 마일스톤 기반 구독자 수 표시 재설계 — 원본 스펙

> 출처: 사용자가 GPT와 대화한 결과를 2026-05-26에 전달.
> 이 문서는 **원본 보관용**이다. 해석/축약 금지. 작업 계획은 별도 audit/plan 문서에서 만든다.
> 짝꿍 문서: [2026-05-26-milestone-rewrite-audit.md](./2026-05-26-milestone-rewrite-audit.md)

---

subRace 프로젝트의 구독자 수 표시 계산 로직을 다시 정리하고 수정해줘.

이 프로젝트는 YouTube API로 각 채널의 구독자 수를 주기적으로 폴링해서 DB에 저장하고, 화면에는 100개 채널만 노출하며, 나머지 100개 채널은 대기 상태로 백그라운드에서 관리하는 프로젝트다.

중요한 점은 화면에 표시되는 구독자 수가 단순히 YouTube API 값을 그대로 노출하는 방식이 아니라, 마일스톤 DB에 누적된 데이터를 기준으로 하루 동안 자연스럽게 증가/감소하도록 계산되어야 한다는 것이다.

이번 작업의 핵심 목표는 다음과 같다.

1. 기존 코드와 DB 구조를 먼저 분석해라.
2. 기존 코드와 충돌하거나 꼬이지 않도록 불필요한 기존 계산 로직은 정리하거나 제거해라.
3. 필요한 테이블, 컬럼, 함수, 스케줄러 로직은 새롭게 생성하거나 수정해라.
4. 기존에 동작 중인 유트라 채널 수집 로직은 이미 완료되어 있으므로 건드리지 마라.
5. YouTube API 폴링 자체도 기존 로직이 있다면 최대한 유지하고, 구독자 수 계산/저장/표시 로직만 필요한 범위에서 수정해라.
6. DB명, 테이블명, 파일명, 기존 함수명은 프로젝트 코드를 직접 확인해서 현재 구조에 맞춰 반영해라.
7. 임의로 없는 경로나 없는 테이블명을 단정하지 말고, 반드시 기존 코드 기준으로 추적해서 수정해라.

가장 중요한 변경 사항은 다음이다.

기존에는 내가 알기로 SocialBlade 60일 마일스톤 데이터를 그대로 DB에 저장한 것이 아니라, 그 데이터를 기준으로 “하루 평균 증감량”만 계산해서 DB에 저장한 것으로 알고 있다.

이번 방식은 절대 그렇게 하면 안 된다.

이번에는 “하루 평균 증감량”만 저장하는 것이 아니라, SocialBlade 60일 마일스톤 데이터 자체를 날짜별, 채널별, 구독자 수 기준으로 마일스톤 DB에 기록해야 한다.

예를 들면 이런 개념이다.

- channel_id
- channel_name
- source
- milestone_date
- subscriber_count
- delta_count
- created_at

즉, “이 채널이 이 날짜에 이 구독자 수 마일스톤에 도달할 것으로 예측됨” 또는 “이 날짜/시간에 실제 API 구독자 수가 변경됨” 같은 원본성 기록이 남아야 한다.

평균 증감량은 DB에 고정값으로 저장해서 쓰는 것이 아니라, 이 마일스톤 DB에 쌓인 날짜별/채널별 구독자 수 기록을 기준으로 매번 계산해야 한다.

만약 기존 DB 안에 이미 SocialBlade 60일 마일스톤 데이터가 날짜별, 채널별, 구독자 수 형태로 기록되어 있다면 그 데이터를 그대로 사용해라.

하지만 기존 DB에 그런 원본 마일스톤 데이터가 없고, 하루 평균 증감량만 저장되어 있다면 그 값은 이번 알고리즘의 기준 데이터로 사용하지 마라.

그 경우 SocialBlade 데이터를 새롭게 가져오는 작업은 이번 작업 범위에서 제외한다. 나중에 내가 별도로 SocialBlade 60일 마일스톤 데이터를 다시 수집해서 넣을 것이다.

따라서 이번 작업에서는 다음 중 하나로 처리해라.

1. 기존 DB에 날짜별/채널별 SocialBlade 마일스톤 원본 데이터가 있으면 그것을 마일스톤 DB 기준 데이터로 사용한다.
2. 없다면 마일스톤 DB 구조와 저장/계산 로직만 만들어두고, SocialBlade 데이터 import 부분은 나중에 별도로 연결할 수 있게 함수 또는 명령 구조만 준비한다.
3. 없는 SocialBlade 마일스톤 데이터를 임의로 생성하거나, 기존 평균 증감량만 가지고 가짜 마일스톤 데이터를 만들지 마라.

마일스톤 DB는 이 프로젝트의 구독자 변화 계산 기준이 된다.

초기에는 SocialBlade 60일 마일스톤 데이터가 이 DB에 들어가고, 시간이 지나면 YouTube API 폴링 중 실제 구독자 수가 변경될 때마다 이 DB에 새 기록이 쌓인다.

그러면 시간이 지날수록 SocialBlade 예측 데이터보다 실제 API 기반 데이터의 비중이 자연스럽게 커지고, 개발자가 알고리즘을 따로 바꾸지 않아도 마일스톤 DB 자체를 기준으로 계산이 점점 정교해져야 한다.

즉, 아래처럼 구현해라.

- 초기 데이터 부족 시: 마일스톤 DB에 들어있는 SocialBlade 60일 마일스톤 기록 기준으로 계산
- 시간이 지난 후: 같은 마일스톤 DB에 쌓인 YouTube API 변경 기록까지 함께 기준으로 계산
- 알고리즘 자체는 계속 마일스톤 DB만 바라보도록 구현
- 개발자가 “초기에는 SocialBlade, 나중에는 API 데이터”라고 수동으로 바꾸지 않아도 되게 구현

마일스톤 DB에는 source 구분값이 필요하다.

예시:

- socialblade_milestone
- youtube_api_change
- manual

계산할 때는 source별로 가중치를 다르게 줄 수 있다.

권장 방식은 다음과 같다.

1. 최근 YouTube API 변경 데이터가 충분하면 youtube_api_change를 더 신뢰한다.
2. API 변경 데이터가 부족하면 socialblade_milestone 데이터를 더 많이 참고한다.
3. 하지만 이 판단도 별도 하드코딩 전환이 아니라, 마일스톤 DB 안에 실제로 존재하는 최근 데이터 양과 날짜 간격을 기준으로 자동 판단한다.
4. 예를 들어 최근 7일~14일 안에 youtube_api_change 데이터가 충분하면 그쪽 가중치를 높이고, 부족하면 socialblade_milestone을 더 참고한다.
5. 가중치 계산 기준도 설정값으로 분리해라.

구독자 수 표시 계산 방식은 다음을 기준으로 해라.

각 채널별로 화면 DB 또는 display 상태 테이블에는 현재 화면 표시 구독자 수가 저장되어야 한다.

화면에 노출되는 구독자 수는 항상 이 display 상태 테이블을 기준으로 보여줘야 한다.

YouTube API 폴링 테이블의 구독자 수는 기준 데이터일 뿐이고, 화면에 직접 표시하면 안 된다.

필요한 주요 테이블 개념은 다음이다. 기존 테이블이 있으면 기존 테이블을 수정해서 사용하고, 없으면 새로 생성해라.

1. YouTube 폴링 상태 테이블

역할:
- 채널별 최신 YouTube API 구독자 수 저장
- 이전 API 구독자 수와 비교
- 다음 목표 마일스톤 저장
- cap 계산값 저장
- 마지막 폴링 시각 저장
- 마지막 API 변경 시각 저장

필요한 개념 컬럼:
- channel_id
- channel_name
- api_subscriber_count
- previous_api_subscriber_count
- next_milestone
- cap_subscriber_count
- last_polled_at
- last_api_changed_at
- updated_at
- created_at

2. 마일스톤 히스토리 테이블

역할:
- SocialBlade 60일 마일스톤 원본 기록 저장
- YouTube API 변경 이벤트 기록 저장
- 평균 증감량이 아니라 날짜별/채널별 구독자 수 기록 자체를 저장
- 이 테이블을 기준으로 하루 예상 증감량을 계산

필요한 개념 컬럼:
- channel_id
- channel_name
- source
- milestone_date 또는 event_at
- subscriber_count
- previous_subscriber_count
- delta_count
- raw_data 또는 memo
- created_at

주의:
- 같은 채널, 같은 source, 같은 날짜, 같은 구독자 수가 중복 저장되지 않도록 unique 조건 또는 중복 방지 로직을 넣어라.
- YouTube API 값이 기존 값과 다를 때만 youtube_api_change 기록을 새로 추가해라.
- 기존 기록을 덮어쓰지 마라.
- 마일스톤 히스토리는 누적 기록이다.

3. 화면 표시 상태 테이블

역할:
- 실제 화면에 표시할 현재 구독자 수 저장
- 하루 목표값 저장
- 다음 변경 예정 시간 저장
- 오늘 변경해야 할 총량과 변경 횟수 저장
- 현재까지 적용된 변경 횟수 저장
- 화면에는 이 테이블의 display_subscriber_count를 기준으로 노출

필요한 개념 컬럼:
- channel_id
- channel_name
- display_subscriber_count
- target_subscriber_count
- cap_subscriber_count
- today_delta
- change_count
- applied_change_count
- next_change_at
- last_changed_at
- plan_date
- updated_at
- created_at

4. 필요하다면 화면 변경 계획 테이블

기존 구조상 별도 계획 테이블이 필요하면 생성해라.

역할:
- 하루 동안 몇 시에 몇 명씩 증가/감소시킬지 저장
- 각 변경 이벤트가 적용되었는지 관리

필요한 개념 컬럼:
- channel_id
- plan_date
- change_at
- change_amount
- before_count
- after_count
- is_applied
- applied_at
- created_at

단, 기존 코드가 화면 상태 테이블만으로 충분히 처리하는 구조라면 불필요하게 새 테이블을 만들지 말고 기존 구조에 맞춰라.

구독자 수 계산 알고리즘은 다음 기준으로 구현해라.

1. 채널별로 마일스톤 히스토리 테이블에서 최근 데이터만 가져온다.
2. 기본 조회 기간은 120일로 한다.
3. 설정값으로 90일 또는 120일을 선택할 수 있게 만들어라.
4. 오래된 데이터는 무한정 쌓이지 않도록 정리하는 cleanup 로직을 만들어라.
5. 단, 미래 날짜의 SocialBlade 60일 마일스톤 예측 데이터가 있다면 단순히 오래된 데이터 정리 기준에 걸려서 삭제되지 않게 주의해라.
6. 삭제 기준은 “event_at 또는 milestone_date가 현재 기준으로 120일보다 과거인 데이터”를 대상으로 하되, 미래 예측 데이터는 유지해라.
7. 이 값은 설정값으로 분리해라.

예상 하루 증감량 계산 방식:

마일스톤 히스토리에서 같은 채널의 기록을 날짜순으로 정렬한다.

인접한 기록끼리 비교해서 다음 값을 계산한다.

- 이전 기록 구독자 수
- 다음 기록 구독자 수
- 구독자 차이
- 시간 차이
- 하루 기준 증감량

예시:

delta = 다음 구독자 수 - 이전 구독자 수
days = 두 기록 사이의 시간 차이
daily_delta = delta / days

이 daily_delta들을 모아서 최근 데이터일수록 더 높은 가중치를 주고, 오래된 데이터일수록 낮은 가중치를 주는 방식으로 expected_daily_delta를 계산해라.

중요:
- 증가만 계산하지 마라.
- delta가 음수이면 감소 데이터로 인정해라.
- 구독자가 줄어드는 경우도 반드시 화면에 반영되어야 한다.
- 화면 표시 숫자가 매일 증가만 하면 부자연스럽다.
- 실제 API 변경 데이터에서 감소가 발생하면 마일스톤 DB에 음수 delta로 기록하고, 화면 표시 계획에도 감소 이벤트가 반영되어야 한다.

화면 표시 계획 생성 방식:

채널별로 다음 값을 준비한다.

- display_subscriber_count: 현재 화면 표시 구독자 수
- api_subscriber_count: 최신 YouTube API 구독자 수
- next_milestone: 다음 목표 마일스톤
- expected_daily_delta: 마일스톤 DB 기준 계산된 하루 예상 증감량

cap 계산은 단순히 next_milestone * 0.85로 하면 안 된다.

반드시 현재 API 기준에서 다음 목표 마일스톤까지 남은 구간의 85% 지점으로 계산해라.

공식:

cap = api_subscriber_count + ((next_milestone - api_subscriber_count) * 0.85)

예시:

api_subscriber_count = 950000
next_milestone = 1000000

cap = 950000 + ((1000000 - 950000) * 0.85)
cap = 992500

즉, cap은 다음 목표 마일스톤 전체의 85%가 아니라, 현재 API 값에서 다음 목표까지 남은 거리의 85% 지점이다.

오늘 목표 표시값 계산:

expected_daily_delta가 양수인 경우:

raw_target = display_subscriber_count + expected_daily_delta
target_subscriber_count = min(raw_target, cap)

expected_daily_delta가 음수인 경우:

raw_target = display_subscriber_count + expected_daily_delta
target_subscriber_count는 너무 과도하게 떨어지지 않도록 안전 하한선을 둔다.

안전 하한선은 기본적으로 최신 api_subscriber_count를 기준으로 하되, API 값 자체가 감소한 경우에는 새 API 값을 기준으로 자연스럽게 내려갈 수 있게 한다.

화면 숫자는 무조건 증가만 하면 안 된다.

expected_daily_delta가 양수인 날에도 소폭 감소 이벤트가 섞일 수 있어야 한다.

예시:

- 전체적으로는 하루 +10,000명을 향해 간다.
- 하지만 중간중간 -20, -50, -100 같은 감소 이벤트가 섞일 수 있다.
- 단, 하루 최종 목표값은 target_subscriber_count에 맞춰야 한다.
- 감소 이벤트 때문에 전체 합계가 틀어지지 않도록 마지막 변경 이벤트에서 보정해라.

증가 추세일 때 권장 이벤트 비율:

- 증가 이벤트: 75% ~ 90%
- 감소 이벤트: 10% ~ 25%

감소 추세일 때 권장 이벤트 비율:

- 감소 이벤트: 60% ~ 85%
- 증가 이벤트: 15% ~ 40%

단, display_subscriber_count가 api_subscriber_count와 거의 같아서 더 내려가면 부자연스러운 경우에는 억지 감소 이벤트를 만들지 마라.

감소 이벤트는 자연스러운 흔들림 정도로만 넣어라.

하루 변경 횟수 계산:

today_delta = target_subscriber_count - display_subscriber_count

today_delta의 절대값과 채널 규모에 따라 하루 변경 횟수를 정해라.

구독자 규모별 1회 변경 기본 단위 예시:

- 10만 미만: 1~5명
- 10만~100만: 5~50명
- 100만~1000만: 50~500명
- 1000만 이상: 500~5000명

변경 횟수는 너무 적거나 너무 많지 않게 최소/최대값을 둬라.

권장:

- 화면 노출 채널: 하루 10~180회
- 대기 채널: 하루 3~60회
- TOP 100 진입 가능성이 있는 90~120위권 채널은 화면 노출 채널에 가깝게 처리

변경 시간은 균등 분배하지 마라.

정확히 10분마다, 20분마다 변하면 기계적으로 보인다.

랜덤 분산을 적용해라.

예시:

- 하루 80회 변경이면 평균 간격은 약 18분
- 실제 변경 간격은 랜덤하게 8분~35분 사이 등으로 흔들리게 처리
- 단, 하루 전체 시간 안에서 모든 이벤트가 처리되게 보정

화면 반영 방식:

- 화면은 항상 display 상태 테이블의 display_subscriber_count를 읽어야 한다.
- 폴링 테이블의 api_subscriber_count를 직접 표시하지 마라.
- 변경 이벤트가 실행될 때마다 display 상태 테이블의 display_subscriber_count를 덮어쓴다.
- 마일스톤 히스토리는 덮어쓰지 않고 계속 insert한다.
- 화면 상태 테이블은 채널별 최신 상태만 유지한다.

YouTube API 폴링 시 처리 방식:

1. 채널별 최신 API 구독자 수를 가져온다.
2. 기존 폴링 테이블에 채널이 없으면 새로 insert한다.
3. 기존 폴링 테이블에 채널이 있으면 기존 api_subscriber_count와 새 api_subscriber_count를 비교한다.
4. 값이 같으면 폴링 테이블의 last_polled_at만 갱신한다.
5. 값이 다르면:
   - previous_api_subscriber_count에 기존 값을 저장
   - api_subscriber_count에 새 값을 저장
   - last_api_changed_at 갱신
   - 마일스톤 히스토리 테이블에 youtube_api_change source로 새 기록 insert
   - delta_count는 새 값 - 기존 값으로 저장
   - delta_count가 음수이면 감소 기록으로 저장
6. 새 API 값이 들어오면 해당 채널의 cap과 화면 표시 계획을 다시 계산한다.
7. 기존 화면 계획이 있다면 남은 시간 기준으로 재계산하거나, 기존 미적용 계획을 정리하고 새 계획으로 교체한다.
8. 이미 적용된 화면 변경 기록은 보존해도 되지만, 앞으로 적용될 계획은 새 API 기준과 충돌하지 않게 정리해라.

SocialBlade 데이터 처리 관련 중요 지시:

- 이번 작업에서 SocialBlade 사이트를 새로 스크래핑하거나 데이터를 새로 가져오는 기능은 만들지 마라.
- 기존 DB에 날짜별/채널별/구독자 수 형태의 SocialBlade 60일 마일스톤 원본 데이터가 있으면 그것을 사용해라.
- 기존 DB에 하루 평균 증감량만 있다면 그 값은 이번 마일스톤 기준 알고리즘에 사용하지 마라.
- 단, 기존 평균 증감량 관련 컬럼이나 테이블은 바로 삭제하지 말고, 코드에서 더 이상 사용하지 않도록 정리한 뒤 필요하면 deprecated 처리하거나 마이그레이션 주석을 남겨라.
- 나중에 내가 SocialBlade 60일 마일스톤 원본 데이터를 다시 수집해서 넣을 수 있도록 import 함수나 command 구조만 준비해도 된다.
- import 함수는 날짜별, 채널별, subscriber_count를 받아 milestone_history에 넣는 구조로 만들어라.
- 없는 데이터를 임의로 생성하지 마라.

마일스톤 DB 정리 정책:

- 기본 보관 기간은 120일로 설정해라.
- 설정값으로 90일 또는 120일을 바꿀 수 있게 해라.
- 오래된 youtube_api_change 기록과 과거 socialblade_milestone 기록은 cleanup 대상이다.
- 단, 미래 날짜 socialblade_milestone 예측 데이터는 삭제하지 마라.
- cleanup은 별도 함수나 스케줄러로 분리해라.
- 폴링 또는 화면 업데이트 로직 안에서 매번 무거운 delete를 실행하지 마라.

기존 코드 충돌 방지 지시:

1. 먼저 전체 관련 파일을 찾아라.
   - YouTube API polling 관련 파일
   - SocialBlade 또는 milestone 관련 파일
   - 화면 표시 subscriber count 관련 파일
   - cron/scheduler 관련 파일
   - DB migration/schema 관련 파일
   - API response 관련 파일
   - frontend에서 subscriber count를 읽는 파일

2. 수정 전에 현재 흐름을 파악해서 간단히 정리해라.

3. 기존 함수와 새 함수가 같은 일을 중복 처리하지 않게 해라.

4. 기존 평균 증감량 기반 로직이 남아서 새 마일스톤 기반 로직과 동시에 실행되지 않게 해라.

5. 기존 DB 컬럼을 무작정 삭제하지 마라.
   - 삭제가 필요하면 왜 삭제해야 하는지 확인하고 migration으로 처리해라.
   - 당장 삭제가 위험하면 deprecated 처리하고 참조만 제거해라.

6. 새 테이블을 만들 때도 기존 테이블로 충분하면 기존 테이블을 확장해라.

7. 기존 화면 API 응답 구조가 있다면 최대한 유지하되, subscriber count 값의 기준만 display 상태 테이블로 바꿔라.

8. 코드 수정 후 다음 흐름이 정상 동작해야 한다.

최종 동작 흐름:

1. 유트라에서 가져온 200개 채널 목록이 있다.
2. YouTube API 폴링이 채널별 구독자 수를 가져온다.
3. 폴링 테이블에 최신 API 구독자 수를 upsert한다.
4. 기존 API 값과 새 API 값이 다르면 마일스톤 히스토리에 youtube_api_change 기록을 insert한다.
5. 마일스톤 히스토리 테이블의 최근 90일 또는 120일 데이터를 기준으로 채널별 expected_daily_delta를 계산한다.
6. expected_daily_delta에는 증가와 감소가 모두 포함된다.
7. 다음 목표 마일스톤과 현재 API 값을 기준으로 cap을 계산한다.
8. display 상태 테이블의 현재 표시값을 기준으로 오늘 목표값을 계산한다.
9. 하루 동안 변경할 횟수와 각 변경 이벤트의 증가/감소량을 계산한다.
10. 화면 변경 이벤트가 실행될 때마다 display 상태 테이블의 display_subscriber_count를 덮어쓴다.
11. 화면은 항상 display 상태 테이블만 읽는다.
12. 마일스톤 히스토리는 계속 insert되고, 오래된 기록은 90일 또는 120일 기준으로 cleanup된다.

주의할 점:

- 구독자 수가 매번 증가만 하면 안 된다.
- 감소 이벤트도 반드시 포함될 수 있어야 한다.
- 단, 감소 이벤트가 너무 과하면 이상하므로 자연스러운 수준으로 제한해라.
- 하루 최종 target_subscriber_count와 이벤트 합계가 맞아야 한다.
- cap을 넘지 않게 해야 한다.
- 다음 목표 마일스톤을 넘어서 표시값이 먼저 도달하면 안 된다.
- YouTube API 값이 새로 바뀌면 남은 계획은 다시 계산해야 한다.
- 대기 채널도 백그라운드에서 display 상태를 유지해야 한다.
- 화면 노출 100개와 대기 100개의 변경 빈도는 다르게 처리할 수 있게 해라.
- 90~120위권처럼 TOP 100 진입 가능성이 있는 채널은 너무 느리게 갱신되지 않게 해라.

작업 결과로 다음을 제공해라.

1. 수정한 파일 목록
2. 새로 만든 파일 목록
3. 새로 만든 DB migration 또는 schema 변경 내용
4. 제거하거나 deprecated 처리한 기존 평균 증감량 로직 설명
5. 새 마일스톤 기반 계산 흐름 설명
6. 실제 테스트 방법
7. 기존 데이터가 SocialBlade 원본 마일스톤인지, 평균 증감량뿐인지 확인한 결과
8. SocialBlade 원본 마일스톤 데이터가 없을 경우 나중에 import해야 할 데이터 형식 안내

이번 작업에서 가장 중요한 것은 다음이다.

기존 SocialBlade 기반 하루 평균 증감량 저장 방식으로 돌아가면 안 된다.

반드시 날짜별/채널별/구독자 수 마일스톤 원본 기록을 마일스톤 DB에 저장하고, 이 DB를 기준으로 증가/감소 계산을 해야 한다.

그리고 시간이 지나면서 YouTube API 변경 기록이 같은 마일스톤 DB에 계속 쌓이면, 알고리즘은 별도 수동 전환 없이 자연스럽게 더 실제 데이터에 가까워져야 한다.
