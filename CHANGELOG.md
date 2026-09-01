# Changelog

## Unreleased

### Performance

- Keep a scrcpy 4.1 control connection warm so taps, swipes, and keys avoid per-action `adb shell input` startup.
- Decode the owned scrcpy mirror into a continuous bounded JPEG stream and return the first frame after each action.
- Preserve automatic foreground-guarded ADB input and JPEG/PNG capture fallbacks when the fast dependencies are unavailable.

### Observability

- Report the selected input and frame transports on every visual action and include them in the physical benchmark.
- Add streamed-JPEG boundary coverage, including frames split across decoder chunks.

### Validation

- Reduced a chess-like one-action physical-device benchmark from the previous 807 ms median to 414 ms median; direct input itself measured 0-2 ms after warmup. One stream-start fallback outlier kept the 12-sample p95 at 1108 ms and remains visible rather than being omitted.

## 0.4.2 - 2026-09-01

### Performance

- Collapse guarded visual input, optional settling, screenshot capture, and foreground observation into one ADB transaction.
- Reuse the returned action observation instead of immediately capturing the same screen again.
- Bound diagnostic decoding so JPEG and PNG frame payloads are not converted to text.

### Reliability

- Suppress Samsung/OEM `dumpsys` broken-pipe diagnostics that can otherwise contaminate binary screenshot output.
- Preserve stale-foreground detection, JPEG/PNG validation, fallback behavior, coordinate validation, and optional visual-change polling.

### Validation

- Add regression coverage proving a guarded input and its resulting frame use one ADB call.
- Validate the JPEG single-action path on a physical 720x1600 Samsung device at 807 ms p50 and 867 ms p95 over five measured iterations.
