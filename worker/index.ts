import '@/lib/env';
import '@/lib/db';
import { startScheduler } from './scheduler';

console.log('[worker] starting');
startScheduler();
