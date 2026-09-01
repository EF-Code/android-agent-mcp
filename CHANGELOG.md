# Changelog

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
