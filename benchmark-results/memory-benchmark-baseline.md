# Memory Benchmark Baseline

Date: 2026-03-31T21:13:54.251Z
Commit: c66cf0d
Node: v24.11.1
Platform: win32 10.0.26200 (x64)
CPU: Intel(R) Core(TM) i7-10870H CPU @ 2.20GHz (16 logical cores)
Memory: 31.91 GB

These measurements are end-to-end MCP stdio timings against the built server in an isolated temp persistence directory.

| Dataset | Measured Writes | Store Throughput ops/s | Search p95 ms | List p95 ms | Traverse d2 p95 ms | Traverse d3 p95 ms | Traverse d5 p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1000 | 100 | 720.4 | 5.31 | 1.41 | 0.54 | 0.42 | 0.43 |
| 5000 | 100 | 274.3 | 31.96 | 3.52 | 0.52 | 0.42 | 0.45 |
| 10000 | 100 | 111.2 | 73.35 | 8.02 | 0.56 | 0.58 | 0.58 |

## Detailed Metrics

### 1000 memories

- Seeded before measurement: 900
- Measured store writes: 100
- Store total duration: 138.81 ms
- Store average per memory: 1.39 ms
- Store p50/p95/max: 1.36 / 1.78 / 2.12 ms
- Store throughput: 720.4 ops/s
- Search avg/p50/p95/max: 4.27 / 3.95 / 5.31 / 11.65 ms
- List avg/p50/p95/max: 0.90 / 0.82 / 1.41 / 3.68 ms
- Traverse depth 2 avg/p50/p95/max: 0.42 / 0.28 / 0.54 / 11.14 ms
- Traverse depth 3 avg/p50/p95/max: 0.30 / 0.27 / 0.42 / 0.68 ms
- Traverse depth 5 avg/p50/p95/max: 0.32 / 0.30 / 0.43 / 0.72 ms
- Connected graph benchmark nodes: 500

### 5000 memories

- Seeded before measurement: 4900
- Measured store writes: 100
- Store total duration: 364.59 ms
- Store average per memory: 3.65 ms
- Store p50/p95/max: 3.62 / 4.66 / 5.02 ms
- Store throughput: 274.3 ops/s
- Search avg/p50/p95/max: 25.41 / 24.34 / 31.96 / 75.45 ms
- List avg/p50/p95/max: 2.63 / 2.54 / 3.52 / 4.98 ms
- Traverse depth 2 avg/p50/p95/max: 0.34 / 0.32 / 0.52 / 0.61 ms
- Traverse depth 3 avg/p50/p95/max: 0.36 / 0.29 / 0.42 / 5.36 ms
- Traverse depth 5 avg/p50/p95/max: 0.30 / 0.27 / 0.45 / 0.51 ms
- Connected graph benchmark nodes: 500

### 10000 memories

- Seeded before measurement: 9900
- Measured store writes: 100
- Store total duration: 899.48 ms
- Store average per memory: 8.99 ms
- Store p50/p95/max: 8.78 / 12.08 / 14.90 ms
- Store throughput: 111.2 ops/s
- Search avg/p50/p95/max: 61.76 / 59.41 / 73.35 / 148.01 ms
- List avg/p50/p95/max: 6.08 / 5.82 / 8.02 / 10.81 ms
- Traverse depth 2 avg/p50/p95/max: 0.36 / 0.35 / 0.56 / 0.78 ms
- Traverse depth 3 avg/p50/p95/max: 0.38 / 0.36 / 0.58 / 0.66 ms
- Traverse depth 5 avg/p50/p95/max: 0.41 / 0.40 / 0.58 / 0.87 ms
- Connected graph benchmark nodes: 500

