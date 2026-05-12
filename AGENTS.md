<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Project conventions

- **Auto-reload on deploy** — open dashboard tabs reload themselves when a new
  container is deployed. Mechanism (when `location.reload()` fires, what
  breaks it, what NOT to use it for) is documented in
  [`docs/auto-reload.md`](docs/auto-reload.md). Read it before touching
  `src/app/api/events/route.ts`, `src/lib/build-id.ts`, or the SSE block in
  `src/app/_components/Dashboard.tsx`.
