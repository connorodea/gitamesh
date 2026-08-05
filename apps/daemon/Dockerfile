# @gitamesh/daemon production image
#
# This Dockerfile lives at apps/daemon/Dockerfile but MUST be built with the
# repository root as the build context, because it's part of a pnpm workspace
# monorepo (packages/protocol, packages/core, packages/storage-sqlite are
# workspace:* dependencies of @gitamesh/daemon and have to be visible to the
# install step). From the repo root:
#
#   docker build -f apps/daemon/Dockerfile -t gitamesh-daemon .
#
# We chose "Dockerfile colocated with the app, root context" over a top-level
# docker/daemon/Dockerfile because there's currently only one containerized
# app (the daemon) — a docker/ directory of Dockerfiles is worth it once a
# second service (e.g. a future Postgres-backed daemon variant, or apps/site)
# also needs one. docker-compose.yml at the repo root documents the `-f`
# path + root context for anyone running `docker build` by hand.
#
# ---------------------------------------------------------------------------
# Stage 1: deps + build
# ---------------------------------------------------------------------------
# node:24-bookworm-slim (not -alpine): better-sqlite3 is a native module built
# against glibc; prebuilt binaries and any from-source fallback compile are
# both far less friction on Debian glibc than on Alpine's musl libc.
FROM node:24-bookworm-slim AS build

# python3/make/g++ are needed in case better-sqlite3 has no prebuilt binary
# for this platform/arch/Node ABI combination and falls back to
# node-gyp compiling from source.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# corepack ships with Node 24 and reads the "packageManager" field in
# package.json to fetch the exact pnpm version this repo is pinned to.
RUN corepack enable

WORKDIR /repo

# Copy just the workspace manifest files first so `pnpm install` is cached
# across rebuilds that only change application source, not dependencies.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/daemon/package.json apps/daemon/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/storage-sqlite/package.json packages/storage-sqlite/package.json
COPY packages/git-adapter/package.json packages/git-adapter/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/mcp-server/package.json packages/mcp-server/package.json
COPY packages/sdk-typescript/package.json packages/sdk-typescript/package.json
COPY packages/simulator/package.json packages/simulator/package.json
COPY packages/testkit/package.json packages/testkit/package.json
COPY apps/site/package.json apps/site/package.json

# Installing with the full workspace manifest present (even packages we
# won't build) keeps this install consistent with the committed lockfile —
# pnpm validates the lockfile against the whole workspace, not a subset.
RUN pnpm install --frozen-lockfile

# Now bring in the actual source for the daemon and everything it depends on.
COPY packages/protocol packages/protocol
COPY packages/core packages/core
COPY packages/storage-sqlite packages/storage-sqlite
COPY apps/daemon apps/daemon

# Build only @gitamesh/daemon and its workspace dependency closure
# (protocol -> core -> storage-sqlite -> daemon). This also transitively
# compiles better-sqlite3's native binding as part of the install step above.
RUN pnpm --filter "@gitamesh/daemon..." run build

# Produce a pruned, production-only, standalone copy of the daemon package
# (its own dist/, production dependencies only, workspace deps resolved to
# real files instead of symlinks into the monorepo store). `--legacy` is
# required on pnpm 10 because this workspace does not set
# inject-workspace-packages=true; verified locally that --legacy still
# correctly resolves workspace:* deps and carries over the compiled
# better-sqlite3 .node binding.
RUN pnpm --filter @gitamesh/daemon --prod deploy --legacy /out

# ---------------------------------------------------------------------------
# Stage 2: runtime
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime

# Non-root user to run the daemon process. UID/GID 10001 avoids colliding
# with the "node" user (uid/gid 1000) baked into the upstream node:*-slim
# base image.
RUN groupadd --gid 10001 gitamesh \
    && useradd --uid 10001 --gid gitamesh --shell /bin/bash --create-home gitamesh

WORKDIR /app

COPY --from=build --chown=gitamesh:gitamesh /out ./

# Directory for the SQLite database file when mounted as a volume
# (see docker-compose.yml / README for the -v gitamesh-data:/data pattern).
RUN mkdir -p /data && chown gitamesh:gitamesh /data

USER gitamesh

ENV NODE_ENV=production
# 0.0.0.0 is the correct default INSIDE a container: the daemon's own
# bare-metal default (127.0.0.1, see apps/daemon/README.md) exists so a
# locally-run process isn't reachable from the network unless explicitly
# opted into. Inside a container, loopback-only would make the daemon
# unreachable from the host or any other container — Docker's network
# isolation is already the boundary, so binding to all interfaces inside
# the container is what makes port publishing (`-p 8787:8787`) work at all.
ENV GITAMESH_BIND_HOST=0.0.0.0
ENV GITAMESH_PORT=8787
ENV GITAMESH_DB_PATH=/data/gitamesh.db
ENV LOG_LEVEL=info

EXPOSE 8787

# Uses Node's built-in global fetch (Node 24) instead of installing curl/wget
# into the slim runtime image, keeping the final image smaller.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:' + (process.env.GITAMESH_PORT || 8787) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/index.js"]
