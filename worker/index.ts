import '@/lib/env';
import '@/lib/db';
import { onReload } from '@/lib/runtime-settings';
import { startScheduler, triggerLikesPoll } from './scheduler';
import { startInternalServer } from './internal-server';
import { triggerLiveDetect } from './youtube-live';

console.log('[worker] starting');
startScheduler();
startInternalServer();

// When settings change (push-notified by the web), re-detect the live stream
// AND re-poll likes immediately so a CLIENT_CHANNEL_ID / CLIENT_VIDEO_ID swap
// reflects in the SummaryCard without waiting for the next cadence tick.
onReload(() => {
  triggerLiveDetect();
  triggerLikesPoll();
});
