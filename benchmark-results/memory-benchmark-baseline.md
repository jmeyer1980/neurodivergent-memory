# Memory Benchmark Baseline

Date: 2026-03-31T19:54:52.809Z
Commit: 69bdfac
Node: v24.11.1
Platform: win32 10.0.26200 (x64)
CPU: Intel(R) Core(TM) i7-10870H CPU @ 2.20GHz (16 logical cores)
Memory: 31.91 GB

These measurements are end-to-end MCP stdio timings against the built server in an isolated temp persistence directory.

| Dataset | Store Avg ms | Store Throughput ops/s | Search p95 ms | List p95 ms | Related p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1000 | 1.70 | 589.4 | 6.23 | 1.51 | 2.23 |
| 5000 | 2.18 | 459.8 | 24.74 | 2.87 | 0.50 |
| 10000 | 4.01 | 249.2 | 67.37 | 14.16 | 0.70 |

## Detailed Metrics

### 1000 memories

- Store total duration: 1696.61 ms
- Store average per memory: 1.70 ms
- Store throughput: 589.4 ops/s
- Search avg/p50/p95/max: 4.60 / 4.19 / 6.23 / 12.67 ms
- List avg/p50/p95/max: 1.04 / 1.03 / 1.51 / 1.51 ms
- Related avg/p50/p95/max: 0.88 / 0.49 / 2.23 / 5.78 ms
- Connected sample size for graph benchmark: 1000

### 5000 memories

- Store total duration: 10875.29 ms
- Store average per memory: 2.18 ms
- Store throughput: 459.8 ops/s
- Search avg/p50/p95/max: 21.92 / 20.58 / 24.74 / 56.22 ms
- List avg/p50/p95/max: 2.26 / 2.20 / 2.87 / 2.87 ms
- Related avg/p50/p95/max: 0.39 / 0.36 / 0.50 / 0.63 ms
- Connected sample size for graph benchmark: 1001

### 10000 memories

- Store total duration: 40120.60 ms
- Store average per memory: 4.01 ms
- Store throughput: 249.2 ops/s
- Search avg/p50/p95/max: 57.46 / 52.69 / 67.37 / 155.36 ms
- List avg/p50/p95/max: 6.01 / 5.74 / 14.16 / 14.16 ms
- Related avg/p50/p95/max: 0.36 / 0.34 / 0.70 / 0.78 ms
- Connected sample size for graph benchmark: 1001

