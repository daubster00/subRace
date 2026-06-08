// 일회성: 미적용 이벤트 DELETE + next_cycle_reset_at NULL.
// 워커 재시작 시 startChannelSchedulers가 모든 채널을 replanAndArm 한다.
// 호출 전제: subrace-web, subrace-worker 모두 stop 상태 (WAL 충돌 방지).
import Database from 'better-sqlite3';

const db = new Database('./data/subrace.db');

const before = {
  events: db.prepare('SELECT COUNT(*) AS n FROM display_event_schedule WHERE applied = 0').get().n,
  states: db.prepare('SELECT COUNT(*) AS n FROM display_state WHERE next_cycle_reset_at IS NOT NULL').get().n,
};

db.transaction(() => {
  db.prepare('DELETE FROM display_event_schedule WHERE applied = 0').run();
  db.prepare('UPDATE display_state SET next_cycle_reset_at = NULL').run();
})();

const after = {
  events: db.prepare('SELECT COUNT(*) AS n FROM display_event_schedule WHERE applied = 0').get().n,
  states: db.prepare('SELECT COUNT(*) AS n FROM display_state WHERE next_cycle_reset_at IS NOT NULL').get().n,
};

console.log('before', before);
console.log('after ', after);
db.close();
