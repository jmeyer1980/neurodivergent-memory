# Cross-Process Coordination Runbook

`neurodivergent-memory` is designed for **single-writer** usage by default.
When you need to run multiple server processes that share the same
`memories.json` file, enable the optional filesystem-level coordination lock.

---

## Environment Variables

| Variable | Values | Default | Purpose |
|---|---|---|---|
| `NEURODIVERGENT_COORDINATION_MODE` | `filesystem-lock` | _(unset — no locking)_ | Enable cross-process coordination mode |
| `NEURODIVERGENT_MEMORY_FILE` | absolute path | `~/.neurodivergent-memory/memories.json` | Shared snapshot path |
| `NEURODIVERGENT_MEMORY_DIR` | absolute path | `~/.neurodivergent-memory/` | Shared snapshot directory |

---

## Profile A — Single-Writer (Default)

Use this when only one neurodivergent-memory server process accesses a given
snapshot at any time.

### Configuration

```bash
# No coordination variables needed — defaults are safe for single-writer.
NEURODIVERGENT_MEMORY_FILE=/data/shared/memories.json npx neurodivergent-memory
```

### Guarantees

- Writes use a temp-file + atomic rename, so crashes cannot corrupt the
  snapshot mid-write.
- In-process concurrent writes are serialized by the internal `AsyncMutex`.
- **No cross-process ordering guarantee** — do not use this profile when two
  processes can write to the same snapshot simultaneously.

---

## Profile B — Multi-Writer with Filesystem Lock

Use this when multiple neurodivergent-memory server processes must share the
same snapshot file during a **rolling restart or brief overlap window** (e.g.,
the old process is draining while the new one starts up). It is also safe for
a container sidecar alongside a host server where at most one process writes
at any given moment.

> **⚠️ Not for active-active concurrent writers**: each process maintains its
> own **in-memory state** and writes a **full snapshot** without reloading or
> merging state from other processes. The filesystem lock prevents a
> **torn write** (two processes writing at the same instant), but it does **not**
> prevent **lost updates** (last writer wins, overwriting changes made by the
> other process since its last load). For active-active workloads, use a
> single process with multiple agents connecting to it over MCP.

### Configuration

```bash
export NEURODIVERGENT_COORDINATION_MODE=filesystem-lock
export NEURODIVERGENT_MEMORY_FILE=/data/shared/memories.json

# One process replaces another during a rolling restart.
npx neurodivergent-memory &   # new process
# ... allow old process to drain and stop
```

### How it works

1. Before each write, the server atomically creates
   `<snapshot>.lock` using the OS `O_EXCL` flag.
2. The lock file contains `{ "pid": <n>, "timestamp": "<iso>" }` for
   diagnostics.
3. The lock is released immediately after the write completes (or fails).
4. If the lock cannot be acquired within **5 seconds**, the server returns
   error `NM_E009` with a recovery hint that includes the holder's PID and
   timestamp.

### Guarantees

- Writes from competing processes are serialized at the OS level.
- Stale locks (from a crashed process) can be removed manually:

  ```bash
  rm /data/shared/memories.json.lock
  ```

- The 5-second acquire timeout is fixed in this release. A configurable
  timeout will be introduced in a future version.

### Limitations

- **Startup path not covered**: the startup WAL-compaction write (`saveToDiskSync`)
  runs once at process boot without acquiring the lock. In practice this window
  is sub-second and is safe for rolling-restart deployments, but it means two
  processes simultaneously booting against the same snapshot could race on that
  initial compaction write. Use staggered restarts to avoid this window.
- Filesystem locking provides safety only on **local filesystems**. Network
  filesystems (NFS, SMB, some FUSE mounts) may not respect `O_EXCL` atomicity.
  Use a local path or a volume driver that guarantees POSIX lock semantics.
- Reads do not acquire the lock. A reader may observe a **stale snapshot** (the
  previous complete state before a concurrent write committed). Because writes
  use temp-file + atomic rename, readers always see a complete snapshot—never
  partially-written data. For strict read freshness, use a single-writer topology.

---

## Contention Error Reference

| Code | Meaning | Recovery |
|---|---|---|
| `NM_E008` | Reserved for a future fail-fast acquire mode (not currently emitted) | N/A |
| `NM_E009` | Lock acquire timed out after 5 seconds | Remove the stale lock file if the holder process is no longer running |

---

## Verifying Coordination Mode at Startup

When the server starts, it logs the effective coordination mode and the raw env value:

```json
{ "coordinationMode": "filesystem-lock", "rawEnvValue": "filesystem-lock", "msg": "Cross-process coordination mode" }
```

If the env var is absent or set to an unrecognised value, the effective mode is `"none"`
regardless of what the raw value was:

```json
{ "coordinationMode": "none", "rawEnvValue": "(unset)", "msg": "Cross-process coordination mode" }
{ "coordinationMode": "none", "rawEnvValue": "shared-snapshot", "msg": "Cross-process coordination mode" }
```
