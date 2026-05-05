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
same snapshot file (e.g., two agents on the same machine, a container sidecar
alongside a host server).

### Configuration

```bash
export NEURODIVERGENT_COORDINATION_MODE=filesystem-lock
export NEURODIVERGENT_MEMORY_FILE=/data/shared/memories.json

# Start as many processes as needed — each will coordinate through the lock.
npx neurodivergent-memory &
npx neurodivergent-memory &
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

- Filesystem locking provides safety only on **local filesystems**. Network
  filesystems (NFS, SMB, some FUSE mounts) may not respect `O_EXCL` atomicity.
  Use a local path or a volume driver that guarantees POSIX lock semantics.
- This mode does not handle read–write races for retrieval paths. Reads do not
  acquire the lock and may observe an intermediate snapshot state during a
  concurrent write window. For strict read consistency, use a single-writer
  topology.

---

## Contention Error Reference

| Code | Meaning | Recovery |
|---|---|---|
| `NM_E008` | Lock could not be acquired (another process holds it) | Wait and retry; check the lock holder PID in the error message |
| `NM_E009` | Lock acquire timed out after 5 seconds | Remove the stale lock file if the holder process is no longer running |

---

## Verifying Coordination Mode at Startup

When the server starts, it logs the active coordination mode:

```json
{ "coordinationMode": "filesystem-lock", "msg": "Cross-process coordination mode" }
```

If the env var is absent or set to an unrecognised value, the log shows:

```json
{ "coordinationMode": "none", "msg": "Cross-process coordination mode" }
```
