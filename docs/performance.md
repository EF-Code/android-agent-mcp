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

## Physical-device follow-up: 2026-11-01

A Samsung SM-A075F running Android 16 (API 36), with a 720×1600 display, was connected and authorized. The host had scrcpy 5.0.1 and FFmpeg 9.0.2. MCP initialization, device selection, device information, and visual-action image responses worked against the actual device. The published `0.6.0` baseline was commit `765dda4`.

The test flow used alternating volume-up/down keys through `visual_control_action`, with two warmup calls and ten measured one-action calls per run. There were no settling/change waits. Baseline and initial follow-up comparisons used the launcher as the foreground application. The media-volume level was 9 before and after the runs. Owned scrcpy/FFmpeg helpers were absent after cleanup. Raw JSON and a run manifest were saved outside the repository; no screenshots or recordings were retained as report artifacts.

| Run                                      |   Median |      p95 | Input | Returned frames              |
| ---------------------------------------- | -------: | -------: | ----- | ---------------------------- |
| Published 0.6.0, JPEG, launcher          | 1,456 ms | 1,599 ms | ADB   | 9 streamed JPEG, 1 ADB frame |
| Published 0.6.0, PNG, launcher           | 1,480 ms | 1,597 ms | ADB   | 10 ADB frames                |
| Retry-cache prototype, JPEG, launcher    |   766 ms | 1,217 ms | ADB   | 9 streamed JPEG, 1 ADB frame |
| Committed follow-up, JPEG, different app |   915 ms | 1,601 ms | ADB   | 9 streamed JPEG, 1 ADB frame |

The device reported that the scrcpy server version `5.0.1` did not match the direct-control client's `4.1`. In `0.6.0`, failed direct startup was retried before every streamed visual action. The launcher baseline's streamed-action preflight took 732–922 ms, including the repeated push/start failure. The retry-cache prototype reduced those preflights to 164–228 ms and reduced the matched launcher run's median by approximately 47%. The failed-start ADB socket is also now closed, and late startup results cannot restore a transport after close/reselection.

The prototype comparison was measured before commit; bounded fallback diagnostic fields were added afterward. The completed implementation is commit `1de0750`. A final run against that exact commit confirmed the `input_fallback_reason` field and retained working ADB input, but the foreground application had changed. Its 915 ms median and 1,601 ms p95 are recorded separately and must not be presented as a controlled before/after improvement. All runs retained their ADB frame fallback outlier. These are sequential ten-sample measurements, without thermal controls or randomization, and do not establish a general app-performance improvement.

The follow-up passed `npm run verify` with 126 tests (125 passed, one skipped), the compiled suite on Node 22 and 24, and the clean installed-package smoke check. The opt-in application fixture remains unrun because no designated test package and harmless selector were supplied. This follow-up is included in `0.7.0`; the npm `0.6.0` package contains the baseline behavior.
