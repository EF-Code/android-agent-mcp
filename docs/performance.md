# Performance measurements and validation

## Device-free core benchmark

Run from a source checkout after installing locked dependencies:

```sh
npm run benchmark:core
```

This builds the current source and runs fixed synthetic workloads without connecting to a phone or changing host configuration. Each workload has three warmup iterations followed by 15 measured iterations. JSON output contains host metadata, the median, and the nearest-rank p95 (the slowest of 15 samples). Assertions validate result counts during every iteration. Timings are diagnostic measurements, not CI thresholds.

The workloads are:

- A 512 KiB JPEG-shaped byte stream delivered in 2,048 chunks of 256 bytes. This isolates marker scanning and buffer assembly; it does not decode an image or benchmark FFmpeg. The frame limit remains 25,000,000 bytes.
- An ancestor regex query across 3,001 nodes: one root, 1,500 groups, and one item inside each group. Exactly 1,500 items must match.
- A descendant query with no match across the same hierarchy. It must return no matches without repeatedly traversing the same subtrees.

## Measured comparison

Measured on 2026-11-01 with Node.js v26.13.0, Linux x64, Intel Core i7-6600U at 2.60 GHz. The baseline was release commit `af0dea0`; the candidate implementation was `784b356`. Both used the same benchmark script and the same installed dependencies. The baseline was rebuilt from an isolated archive, and the runs were sequential on the same host.

| Workload                        | Baseline median | Improved median | Approximate speedup | Baseline p95 | Improved p95 |
| ------------------------------- | --------------: | --------------: | ------------------: | -----------: | -----------: |
| Fragmented JPEG assembly        |       116.88 ms |         3.06 ms |               38.2x |    156.47 ms |      7.37 ms |
| Ancestor regex, 3,001 nodes     |        29.11 ms |         4.36 ms |                6.7x |     38.28 ms |      6.60 ms |
| Missing descendant, 3,001 nodes |        44.01 ms |         2.13 ms |               20.7x |     77.56 ms |      2.73 ms |

These are local component measurements. They do not establish an end-to-end Android latency improvement. CPU scheduling, allocation pressure, hierarchy shape, chunk size, and image size affect results. No phone was connected for this comparison. Measure physical action latency separately with `npm run benchmark:visual -- --iterations 10 --actions 1` on an authorized test device.

### Reproducing a baseline comparison

Use a disposable source copy of the baseline commit. Copy the current `scripts/benchmark-core.mjs` into its `scripts` directory and install the same dependencies. Build both copies, then run `node scripts/benchmark-core.mjs` from each checkout with the same Node executable. The benchmark uses the legacy extraction API when an older checkout lacks `JpegFrameAssembler`. Avoid running builds, tests, or another benchmark concurrently with the timed runs.

## Implementation changes

`JpegFrameAssembler` scans incoming chunks for markers rather than rescanning the entire partial image. It grows storage geometrically and copies completed frames into independent buffers so later input cannot mutate an already published image. Per-frame byte limits are checked before growth. Noise outside frames is discarded, and SOI/EOI markers can straddle any chunk boundary. Decoder failures clear pending and latest frames and resolve waiting callers.

Selectors compile text, regex, exact-field, and flag predicates once per query. Each query builds indexes from node IDs, parent references, and child references. Relationship matching propagates sets through these indexes, so each edge is visited at most once for each relationship selector. Result sorting remains proportional to the number of returned matches. Indexes are scoped to a query rather than cached against mutable snapshots. Nested relationship constraints are evaluated, cyclic references are bounded, and duplicate node IDs are rejected.

Visual observations use a post-input sequence barrier and compare encoded hashes only within matching capture pipelines. See [visual control](visual-control.md) for the nullable `changed` contract, stability and timeout fields, and receipt-time limitations. The first transition from native ADB capture to a scaled stream can therefore return an unknown change result. Consumers must handle this explicitly.

## Verification commands

```sh
npm run verify
npm run test:package
npm run benchmark:core
```

`test:package` packs the built source, installs the tarball in a temporary directory with lifecycle scripts disabled, exercises setup preview, and initializes its MCP server from that installation. It verifies server version, tool discovery, device selection, and PNG image output using fake ADB. It deletes the temporary installation afterward. This check downloads dependencies from npm and runs in the Node 22/24 CI matrix alongside source verification.

Local validation on 2026-11-01: `npm run verify` passed on Node v26.13.0 with 119 tests (118 passed, one opt-in physical-device test skipped). The compiled suite also passed with the same counts on Node v22.23.4 and v24.22.2. The installed-package smoke check passed on Node v26.13.0. Hosted CI for these changes has not yet run.

Before a release, also run the opt-in physical-device suite on a prepared test application and measure cold/warm visual-session latency. Remaining performance work should be driven by those measurements: native display geometry after rotation, accurate phase timing for combined ADB commands, cancellation and deadlines across in-flight adapters, and decoder startup/shutdown overhead. These are separate from the component gains measured here.
