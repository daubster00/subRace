# syntax=docker/dockerfile:1.7

# ---------- deps ----------
# Native build tools are needed because better-sqlite3 compiles from source.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

# ---------- builder ----------
# next build imports @/lib/env which exits the process if required secrets are
# missing. Provide placeholder values for the build only; real values come from
# docker-compose env_file at runtime.
FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    CLIENT_CHANNEL_ID=build_placeholder \
    BASIC_AUTH_USERNAME=build_placeholder \
    BASIC_AUTH_PASSWORD=build_placeholder \
    YOUTUBE_API_KEY=build_placeholder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---------- runner ----------
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# yutura.net sits behind Cloudflare, which blocks Debian's stock curl on
# JA3/JA4 TLS fingerprint. curl-impersonate ships browser-matching TLS stacks
# as drop-in replacements (`curl_chrome131`, etc.). Worker calls it via the
# YUTURA_CURL_BIN env var; web doesn't use it.
ARG CURL_IMPERSONATE_VERSION=v1.5.6
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) ci_arch="x86_64-linux-gnu" ;; \
      arm64) ci_arch="aarch64-linux-gnu" ;; \
      *) echo "unsupported arch: $arch"; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/ci.tar.gz \
      "https://github.com/lexiforest/curl-impersonate/releases/download/${CURL_IMPERSONATE_VERSION}/curl-impersonate-${CURL_IMPERSONATE_VERSION}.${ci_arch}.tar.gz"; \
    mkdir -p /opt/curl-impersonate; \
    tar -xzf /tmp/ci.tar.gz -C /opt/curl-impersonate; \
    rm /tmp/ci.tar.gz; \
    for f in /opt/curl-impersonate/*; do ln -sf "$f" "/usr/local/bin/$(basename "$f")"; done

# Worker uses tsx (a dev dependency) so we keep the full node_modules.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/package-lock.json ./package-lock.json
COPY --from=builder /app/migrations ./migrations
COPY --from=builder /app/src ./src
COPY --from=builder /app/worker ./worker

# /app/data is a mounted volume at runtime (SQLite db + runtime-settings.json).
# Pre-create with correct ownership so the non-root user can write to it.
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["node_modules/.bin/next","start","-p","3000"]
