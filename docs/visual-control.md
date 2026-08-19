# Low-latency visual control

Visual control sessions are the preferred MCP workflow for games, canvases, video controls, and other surfaces that are not represented reliably by UIAutomator.

The design follows the continuous frame → structured action → ADB → next-frame loop used by [Google's Android Computer Use quickstart](https://github.com/google-gemini/gemini-android-computer-use-quickstart), but it remains model-neutral. Android Agent MCP does not call a model; the connected agent supplies the action and interprets the returned image.

## Session loop

1. Select one authorized device with `device_select` when needed.
2. Call `visual_control_start`. The response contains an initial frame, a session ID, display dimensions, MIME type, and the default coordinate space. Visual sessions prefer Android's JPEG capture path and fall back to PNG automatically; pass `frame_format: "png"` only when lossless pixels are required.
3. Call `visual_control_action` for each visual decision. The server checks the session-pinned foreground package and dispatches the bounded action in one device command, then returns a frame plus the post-action foreground state in one observation command.
4. Call `visual_control_stop` when the visual task is complete.

Do not call `screen_capture` between visual actions. The image returned by `visual_control_action` is the observation for the next model decision.

## Coordinates and actions

The default coordinate space is `normalized_1000`, matching the Google quickstart convention. Each axis is an integer from `0` through `999`; the server maps it to the selected phone's native screenshot dimensions. Use `device_pixels` only when the agent has deliberately calibrated native coordinates.

Actions are bounded to at most 32 taps, swipes, or allowlisted non-sensitive key presses per call. A chess move should be one swipe when the app supports drag-to-move, or two taps in one action otherwise:

```json
{
  "session_id": "session-id-from-start",
  "actions": [
    { "type": "tap", "x": 375, "y": 700 },
    { "type": "tap", "x": 458, "y": 700 }
  ],
  "coordinate_space": "normalized_1000",
  "wait_for_change_ms": 0
}
```

`wait_for_change_ms` is optional and bounded to 15 seconds. It polls frames only while the screen still matches the previous session frame. `settle_ms` delays the first observation when the app needs time to animate or an opponent needs time to respond. `stable_ms` then requests a quiet-frame window after the first observed change. Keep all three at zero for immediate board actions; add only the shortest delay the app genuinely needs.

The result reports `elapsed_ms`, `wait_elapsed_ms`, `changed`, the frame hash/MIME type, and `timing_ms` split into preflight, input, settle, observation, and postflight. That distinguishes device overhead from the model's reasoning/tool-call latency.

## Physical latency benchmark

With one authorized device and a non-sensitive app in the foreground, run:

```zsh
npm run benchmark:visual -- --iterations 10
```

The benchmark uses reversible volume keys, performs an unmeasured warmup, and prints p50/p95 action-to-frame latency plus phase timings. It does not measure model vision or reasoning. Use one action per sample to approximate a chess swipe, or the default two-action batch to approximate source/destination taps:

```sh
npm run benchmark:visual -- --iterations 10 --actions 1
npm run benchmark:visual -- --iterations 10 --actions 2
```

Compare JPEG and PNG directly when diagnosing a device:

```zsh
npm run benchmark:visual -- --iterations 10 --frame-format jpeg
npm run benchmark:visual -- --iterations 10 --frame-format png
```

## Safety and performance boundaries

- The session is bound to the selected device session and is invalidated after disconnect/reselection.
- Foreground package policy is checked before actions and after returned frames; sensitive packages remain blocked by default.
- UI hierarchy verification is intentionally not performed in this visual path.
- Screenshot content is returned with the action, avoiding an extra MCP round trip.
- Single actions use direct ADB argument arrays; multi-action batches use a validated, quoted remote script and reject Android input usage output instead of reporting false success.
- The session does not make model reasoning faster. Use the host's low-latency or low-thinking mode when available and keep one model decision per visual action.
- Use semantic `ui_dump`/`ui_find`/`ui_tap` for ordinary controls; do not use visual sessions as a replacement for accessibility-aware interaction.
