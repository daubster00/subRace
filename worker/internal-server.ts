import http from 'node:http';
import { reloadFromDisk } from '@/lib/runtime-settings';

// Web → worker push channel for "settings just changed, reload now."
// fs.watch on the shared Docker volume doesn't reliably emit cross-container
// events, so the web's PUT /api/settings sends a fire-and-forget POST here
// after writing the JSON file.
const PORT = Number(process.env.WORKER_INTERNAL_PORT ?? 3001);

export function startInternalServer(): void {
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/internal/reload-settings') {
      reloadFromDisk();
      console.log('[worker] settings_reloaded source=push');
      res.statusCode = 204;
      res.end();
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[worker] internal_server_listening port=${PORT}`);
  });

  server.on('error', (err) => {
    console.warn(`[worker] internal_server_error reason=${err.message}`);
  });
}
