# Performance and activation

The connection path now binds the invoking project to its actual extension host.
It does not run a native CLI version process, discover every historical alias,
enumerate every thread, or issue an extra full inspection before/after connection.
Connection success is checked against the official sidebar's initialize/list
receipt, with bounded page counts.
The helper restores a window binding during eager activation, before the
official extension starts its CLI. It does not declare an activation dependency
on the official extension, which would force the opposite order after reload.
If a restored chat view activates first, the dispatcher waits briefly for an
explicit Slurm/local decision from that host. WebSocket dependencies are loaded
only by socket clients, reducing helper startup I/O.

Interactive history uses indexed metadata by default. The relay preserves an
explicit repair request, all write methods, all protocol events and user input.
Receipts are written asynchronously; ordinary RPC responses no longer trigger
synchronous shared-storage writes before the next message can flow. Canonical
working-directory strings avoid redundant filesystem resolution. Dependencies
are reused by lock-file identity, so changing connector code does not repeat npm
installation. Linux Node 22 can replace the dispatcher process with the selected
launcher, avoiding another proxy process.

New allocations place SQLite/WAL activity on the node and restore/save consistent
backups in the durable namespace. This change requires a new allocation. Existing
workers and active turns are retained; reconnecting a client does not migrate an
in-progress turn to another app-server process.

## Measurement

The checked-in benchmark measures `thread/list` with indexed metadata, 20 items
per page, four concurrent clients and eight requests per client. It reports
p50/p95 and errors and writes small CSVs without conversation content:

```bash
source scripts/codex_backend/runtime.sh
node scripts/codex_backend/benchmark.cjs /absolute/project tmp/benchmarks
```

A formal CPU allocation using the new local SQLite store completed 32 direct
and 32 relayed requests with zero errors. In its synthetic project, direct
p50/p95 were 0.48/2.58 ms and relay p50/p95 were 0.51/2.76 ms. The tests ran
sequentially, so the difference is cache/noise and is not a claim that a relay
is faster than direct access. These are transport/history-query measurements,
not browser rendering or model-generation timings.

The previous live backend also timed out on direct indexed RPC calls: its
initial direct phase failed 12/32 requests, and a later direct phase failed
32/32 at the 20-second client deadline. The old relay failed 31/32; the updated
relay could not cure the same stalled backend. The fresh synthetic benchmark
and the loaded old backend are different cohorts. Do not turn those numbers
into a speedup factor for real conversation history.

Timing-only diagnostic CSVs are retained for the
[loaded original relay](assets/figures/backend-performance-20261006/csv/loaded-before.csv),
[loaded updated relay](assets/figures/backend-performance-20261006/csv/loaded-updated-relay.csv),
and [fresh local SQLite worker](assets/figures/backend-performance-20261006/csv/fresh-local-sqlite.csv).

## Diagnose the current window

Run `connect_codex_backend.sh status` in that window's integrated terminal or
use **Codex Backend: Show Connection Status**. A verified Slurm connection
includes job, node, backend PID, project, and a live relay process identity.
`backendAvailable` alone is insufficient. A legacy helper or a terminal outside
the owning window may be reported as unverified until it is upgraded/reconnected.

When the sidebar is slow, compare a bounded `doctor` initialize probe and direct
RPC measurements. Backend stalls, shared filesystem I/O, CPU contention,
large rollout reads, webview rendering and model/network latency are distinct
causes. Bridge optimizations do not promise to remove all of them. Re-run the
same benchmark and representative UI/history operations after an allocation
upgrade before claiming a measured end-to-end speedup.
