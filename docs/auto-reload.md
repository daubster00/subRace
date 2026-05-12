# Auto-reload on deploy (SSE buildId)

Long-lived dashboard tabs pick up new client JS automatically when a fresh
container is deployed. No manual refresh needed.

## When does `location.reload()` fire?

**Trigger:** the SSE `hello` event arrives with a `buildId` that differs from
the value the client stored on its **first** `hello` after page load.

That is the **only** condition. Do not add reload logic elsewhere.

## Why this works

- Each `next build` generates a unique `.next/BUILD_ID`. Each Docker image
  therefore boots with a different value.
- On page load, the browser opens an `EventSource('/api/events')` connection.
- The server immediately sends `event: hello\ndata: {"buildId": "..."}`.
- The client stores that first buildId as its **baseline** and keeps the
  connection open.
- On deploy, `docker compose up -d --force-recreate web` kills the old
  container. The SSE connection drops. `EventSource` auto-reconnects to the
  new container.
- The new container's `hello` carries a different buildId → mismatch detected
  → `location.reload()`.

The server cannot push to a closed browser, but the browser is already
holding a listening pipe open. We piggyback on that.

## Files

| File | Role |
|---|---|
| [`src/lib/build-id.ts`](../src/lib/build-id.ts) | Reads `.next/BUILD_ID` once per process, caches it. Falls back to `dev-{pid}-{ts}` when `.next` is absent (e.g. `next dev`). |
| [`src/app/api/events/route.ts`](../src/app/api/events/route.ts) | SSE endpoint. Sends `hello` on connect, then 25s heartbeat comments to keep proxies from idling the connection. |
| [`src/app/_components/Dashboard.tsx`](../src/app/_components/Dashboard.tsx) | Client. The `useEffect` block labelled "Auto-reload on new deploy" stores the baseline and reloads on mismatch. |

## Things that would break this

- **Returning a stable buildId across deploys.** The whole mechanism depends
  on `.next/BUILD_ID` changing per build. Don't pin it via `generateBuildId`
  in `next.config.ts` unless you also change the SSE source of truth.
- **Buffering the SSE response.** The `X-Accel-Buffering: no` header in
  `route.ts` disables nginx buffering. If you put a new proxy in front, make
  sure it streams `text/event-stream` without buffering, or the `hello` event
  will be held until the connection closes.
- **Reusing `/api/events` for unrelated push events.** Keep this channel
  scoped to deploy notifications. If you need other server→client events,
  add a different event name on the same connection — but the `hello` /
  baseline contract above must keep working unchanged.
- **Removing the basic auth exclusion path.** `/api/events` is currently
  protected by the same Basic Auth as the rest of the app
  ([`src/proxy.ts`](../src/proxy.ts)). The browser sends credentials
  automatically once authenticated. If you ever move auth, make sure SSE
  still authenticates — `EventSource` does not let you set custom headers.

## What this is NOT for

- It does not replace data polling. `/api/snapshot` still drives subscriber
  data on a 30s `useQuery` interval.
- It does not deliver "soft" updates (e.g. settings changes that don't need
  a page reload). Those should go through the snapshot polling response.
- It does not detect server-side data staleness. Only client code freshness.
