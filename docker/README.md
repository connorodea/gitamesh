# Docker packaging for @gitamesh/daemon

The only containerized app in this repo (as of this milestone) is the
coordination daemon (`apps/daemon`). Its `Dockerfile` lives at
`apps/daemon/Dockerfile`, not under this `docker/` directory — see that
file's header comment for why (single app today; this directory is for
docs, and would gain per-service Dockerfiles once a second containerized app
exists).

## Build

Must be built with the **repository root** as the build context, because
`@gitamesh/daemon` depends on three workspace packages
(`@gitamesh/protocol`, `@gitamesh/core`, `@gitamesh/storage-sqlite`) that
have to be visible to `pnpm install`:

```bash
docker build -f apps/daemon/Dockerfile -t gitamesh-daemon .
```

Or via Compose, which already points at the right file/context:

```bash
docker compose up -d --build
```

### How the image is built (multi-stage)

1. **`build` stage** (`node:24-bookworm-slim` + `python3`/`make`/`g++`):
   installs the full workspace with `pnpm install --frozen-lockfile`
   (this is what compiles `better-sqlite3`'s native binding — see below),
   builds only `@gitamesh/daemon` and its dependency closure
   (`pnpm --filter "@gitamesh/daemon..." run build` — deliberately skips
   `apps/site`, `packages/cli`, `packages/mcp-server`, etc., since the
   daemon doesn't depend on them), then produces a pruned,
   production-only, standalone copy with
   `pnpm --filter @gitamesh/daemon --prod deploy --legacy /out`.
2. **`runtime` stage** (`node:24-bookworm-slim`, no build tools): copies
   only `/out` from the build stage, runs as a non-root user, and starts
   `node dist/index.js`.

**Why `node:24-bookworm-slim` and not `-alpine`**: `better-sqlite3` is a
native module. Prebuilt binaries (and any node-gyp fallback compile) are
far less friction against Debian's glibc than Alpine's musl libc, so this
avoids a class of native-module runtime crashes some Alpine images hit with
`better-sqlite3`.

**Why `pnpm deploy --legacy`**: pnpm 10 defaults to an "injected
workspace" deploy that requires `inject-workspace-packages=true` in
`.npmrc`, which this repo doesn't set. `--legacy` deploy was verified
locally (both on macOS and inside the Linux build stage) to correctly
resolve the `workspace:*` dependencies to real files (not symlinks back
into the monorepo) and to carry over the compiled
`better-sqlite3.node` binding into the pruned output.

## Run

```bash
docker run -d --name gitamesh-daemon \
  -p 8787:8787 \
  -v gitamesh-data:/data \
  -e GITAMESH_DB_PATH=/data/gitamesh.db \
  gitamesh-daemon
```

Or:

```bash
docker compose up -d
```

### Environment variables

| Variable | Container default | Meaning |
|---|---|---|
| `GITAMESH_BIND_HOST` | `0.0.0.0` | See "Bind-host default" below. |
| `GITAMESH_PORT` | `8787` | Listen port. Matches `EXPOSE 8787` / the healthcheck. |
| `GITAMESH_STORAGE_DRIVER` | `sqlite` | `sqlite` or `postgres` — see "Postgres storage driver" below. |
| `GITAMESH_DB_PATH` | `/data/gitamesh.db` | SQLite file path (driver `sqlite` only). Point this at a mounted volume (below) for persistence, or `:memory:` for an ephemeral container. |
| `GITAMESH_POSTGRES_URL` | — | `postgresql://user:pass@host:port/db` (driver `postgres` only). |
| `LOG_LEVEL` | `info` | Pino log level. |

These are the same variables `apps/daemon/README.md` documents for
bare-metal — only the **defaults** differ between the two contexts (see
below).

### Postgres storage driver

`docker-compose.yml` also defines an opt-in `postgres` Compose profile
(a `postgres:16-alpine` service plus a `daemon-postgres` service wired to
it with `GITAMESH_STORAGE_DRIVER=postgres`), for the
`@gitamesh/storage-postgres` adapter described in
`packages/storage-postgres/README.md`. It does not start with a plain
`docker compose up` — only:

```bash
docker compose --profile postgres up
```

This is the same image (`gitamesh-daemon:local`) as the default `daemon`
service; only the environment variables differ. `pg` (node-postgres) is a
pure-JS dependency with no native compile step, so it added no new build
requirements to the `Dockerfile`'s `build` stage — `@gitamesh/storage-postgres`
is imported dynamically at daemon startup only when
`GITAMESH_STORAGE_DRIVER=postgres` is actually set.

### Volume mount for persistence

The image creates `/data` (owned by the non-root `gitamesh` user) as the
expected mount point for the SQLite file:

```bash
docker run -d -v gitamesh-data:/data -e GITAMESH_DB_PATH=/data/gitamesh.db gitamesh-daemon
```

Verified locally: stopping and restarting the container against the same
named volume correctly reopens the existing database and all previously
created agents/tasks/attempts are still there (`GET /v1/tasks` after a
restart returns the same task created before the restart).

`docker-compose.yml` wires this up as a named volume (`gitamesh-data`) by
default.

## Bind-host default: 127.0.0.1 (bare metal) vs 0.0.0.0 (container)

`apps/daemon/README.md` documents the bare-metal default as
`GITAMESH_BIND_HOST=127.0.0.1` — **secure by default**: a daemon started
directly on a developer's machine or a shared host should not be reachable
over the network unless someone explicitly opts in, because there's no
isolation boundary between "this process" and "the rest of the network"
other than the bind address itself.

Inside this container image, the default is flipped to
`GITAMESH_BIND_HOST=0.0.0.0`. This is not a security regression — it's the
same secure-by-default principle applied to a different boundary:

- Docker's network namespace + explicit port publishing (`-p 8787:8787` /
  compose's `ports:`) is *already* the isolation boundary. Nothing outside
  the container can reach the daemon unless the operator explicitly
  publishes the port, regardless of what the daemon binds to inside its
  own network namespace.
- If the daemon bound to `127.0.0.1` *inside* the container, it would only
  accept connections from within that same network namespace — Docker's
  port publishing/proxy connects from outside that namespace, so the
  daemon would be **unreachable even with `-p 8787:8787` set**. Binding to
  `0.0.0.0` inside the container is what makes the already-explicit `-p`
  publish step actually work.

In short: bare-metal's safe default keeps a stray `node dist/index.js`
from being accidentally exposed to the LAN; the container's safe default
keeps an explicit, operator-chosen port publish from silently no-opping.
Both defaults protect against a different accidental-exposure failure
mode for their respective contexts.

## Verification performed (2026-08-04)

Docker (via Colima, linux/arm64) was available in this environment, so the
image was actually built and exercised, not just written:

- `docker build -f apps/daemon/Dockerfile -t gitamesh-daemon:test .` — succeeds.
- Container starts, `GET /healthz` and `GET /readyz` return `200`.
- Full coordination flow smoke-tested end to end against the running
  container: `POST /v1/agents` (register) → `POST /v1/tasks` (create) →
  `POST /v1/tasks/:id/claim` (claim) → `GET /v1/tasks` reflects the
  `running` status.
- Persistence verified: `docker stop` + `docker start` against the same
  named volume reopens the existing SQLite file; the task created before
  the restart is still returned by `GET /v1/tasks` afterward.
- `docker compose up -d --build` brings up the same image via the
  top-level `docker-compose.yml` and answers `/healthz`.
- `HEALTHCHECK` reports `healthy` once the daemon is accepting requests.

### Known gap: `--bootstrap-admin-token` crashes in this container image

`apps/daemon/README.md` documents `node dist/index.js
--bootstrap-admin-token` as a dev convenience for minting a bootstrap admin
token at startup. Inside this container image specifically (Node
`v24.19.0` on Linux/arm64, `better-sqlite3@11.10.0`'s compiled native
binding), invoking that code path reliably crashes the process with a
native assertion failure (`Assertion failed: (env) != nullptr` inside
`better-sqlite3`'s `Statement::~Statement()`, during
`node::RemoveEnvironmentCleanupHook`) — reproduced 3 times in a row,
100% repro rate, both with and without a volume mount. This reproduces
**only** for that specific in-process startup code path (mint-then-listen
in the same process); it does not affect normal daemon operation:

- Starting the daemon normally (no flag) and running the full
  register/create/claim/list flow above never crashed, across multiple
  containers and a stop/restart cycle.
- Minting a token via a **separate** short-lived process against the same
  mounted database file works fine, e.g.:
  ```bash
  docker exec gitamesh-daemon node --input-type=module -e "
  import { createFileSqliteStorage } from '@gitamesh/storage-sqlite';
  import { mintToken } from './dist/auth.js';
  const storage = createFileSqliteStorage('/data/gitamesh.db');
  console.log(mintToken(storage, ['admin']).rawToken);
  storage.close();
  "
  ```
  This is the recommended way to bootstrap an admin token against a
  running container until the upstream crash is understood/fixed — it was
  used for the smoke test above and worked without incident.

This looks like a Node 24 / `better-sqlite3` native-module interaction
specific to this exact build (it did **not** reproduce running the
identical `--bootstrap-admin-token` flag directly on macOS with the host's
Node `v24.11.1`), not a bug in this Dockerfile's packaging approach. It's
called out here rather than silently worked around so it doesn't get
mistaken for "the container doesn't work" — the daemon itself works;
one specific CLI convenience flag does not, in this container's Node/arch
combination.
