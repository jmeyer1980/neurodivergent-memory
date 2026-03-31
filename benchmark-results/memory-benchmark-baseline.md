# Memory Benchmark Baseline

Date: 2026-03-31T21:01:29.773Z
Commit: 54e44ad
Node: v24.11.1
Platform: win32 10.0.26200 (x64)
CPU: Intel(R) Core(TM) i7-10870H CPU @ 2.20GHz (16 logical cores)
Memory: 31.91 GB

These measurements are end-to-end MCP stdio timings against the built server in an isolated temp persistence directory.

| Dataset | Measured Writes | Store Throughput ops/s | Search p95 ms | List p95 ms | Traverse d2 p95 ms | Traverse d3 p95 ms | Traverse d5 p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1000 | 100 | 654.1 | 5.39 | 1.02 | 0.40 | 0.45 | 0.38 |
| 5000 | 100 | 260.5 | 27.99 | 3.24 | 0.43 | 0.39 | 0.37 |
| 10000 | 100 | 175.4 | 71.97 | 8.58 | 0.49 | 0.43 | 0.58 |

## Detailed Metrics

### 1000 memories

- Seeded before measurement: 900
- Measured store writes: 100
- Store total duration: 152.89 ms
- Store average per memory: 1.53 ms
- Store p50/p95/max: 1.42 / 2.06 / 2.36 ms
- Store throughput: 654.1 ops/s
- Search avg/p50/p95/max: 4.35 / 4.02 / 5.39 / 12.02 ms
- List avg/p50/p95/max: 0.73 / 0.67 / 1.02 / 3.97 ms
- Traverse depth 2 avg/p50/p95/max: 0.27 / 0.24 / 0.40 / 0.50 ms
- Traverse depth 3 avg/p50/p95/max: 0.28 / 0.26 / 0.45 / 0.81 ms
- Traverse depth 5 avg/p50/p95/max: 0.28 / 0.25 / 0.38 / 0.74 ms
- Connected graph benchmark nodes: 500

### 5000 memories

- Seeded before measurement: 4900
- Measured store writes: 100
- Store total duration: 383.95 ms
- Store average per memory: 3.84 ms
- Store p50/p95/max: 3.82 / 4.65 / 4.95 ms
- Store throughput: 260.5 ops/s
- Search avg/p50/p95/max: 22.98 / 21.63 / 27.99 / 60.40 ms
- List avg/p50/p95/max: 2.50 / 2.45 / 3.24 / 3.99 ms
- Traverse depth 2 avg/p50/p95/max: 0.31 / 0.29 / 0.43 / 0.98 ms
- Traverse depth 3 avg/p50/p95/max: 0.32 / 0.27 / 0.39 / 4.62 ms
- Traverse depth 5 avg/p50/p95/max: 0.29 / 0.28 / 0.37 / 0.62 ms
- Connected graph benchmark nodes: 500

### 10000 memories

- Seeded before measurement: 9900
- Measured store writes: 100
- Store total duration: 570.26 ms
- Store average per memory: 5.70 ms
- Store p50/p95/max: 5.54 / 6.78 / 12.69 ms
- Store throughput: 175.4 ops/s
- Search avg/p50/p95/max: 55.12 / 53.63 / 71.97 / 140.19 ms
- List avg/p50/p95/max: 6.48 / 6.55 / 8.58 / 18.00 ms
- Traverse depth 2 avg/p50/p95/max: 0.31 / 0.29 / 0.49 / 0.58 ms
- Traverse depth 3 avg/p50/p95/max: 0.30 / 0.29 / 0.43 / 0.59 ms
- Traverse depth 5 avg/p50/p95/max: 0.42 / 0.39 / 0.58 / 0.77 ms
- Connected graph benchmark nodes: 500

