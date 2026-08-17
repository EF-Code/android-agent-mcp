# Low-latency visual control

Visual control sessions are the preferred MCP workflow for games, canvases, video controls, and other surfaces that are not represented reliably by UIAutomator.

The design follows the continuous frame → structured action → ADB → next-frame loop used by [Google's Android Computer Use quickstart](https://github.com/google-gemini/gemini-android-computer-use-quickstart), but it remains model-neutral. Android Agent MCP does not call a model; the connected agent supplies the action and interprets the returned image.

## Session loop

1. Select one authorized device with `device_select` when needed.
2. Call `visual_control_start`. The response contains an initial PNG frame, a session ID, display dimensions, and the default coordinate space.
3. Call `visual_control_action` for each visual decision. The server dispatches a bounded action sequence and returns the next PNG frame in the same MCP response.
4. Call `visual_control_stop` when the visual task is complete.

Do not call `screen_capture` between visual actions. The image returned by `visual_control_action` is the observation for the next model decision.

## Coordinates and actions

The default coordinate space is `normalized_1000`, matching the Google quickstart convention. Each axis is an integer from `0` through `999`; the server maps it to the selected phone's native screenshot dimensions. Use `device_pixels` only when the agent has deliberately calibrated native coordinates.

Actions are bounded to at most 32 taps, swipes, or allowlisted non-sensitive key presses per call. A chess move should normally be two taps in one action:

```json
{
  "session_id": "session-id-from-start",
  "actions": [
    { "type": "tap", "x": 375, "y": 700 },
    { "type": "tap", "x": 458, "y": 700 }
  ],
  "coordinate_space": "normalized_1000",
  "wait_for_change_ms": 1500
}
```

`wait_for_change_ms` is optional and bounded to 15 seconds. It polls screenshots until the returned frame differs from the prior session frame. `stable_ms` can request a short stable-frame window after the first change; keep it at zero unless the app has a visible transition or animation. The result reports `elapsed_ms`, `wait_elapsed_ms`, `changed`, and the returned screenshot hash so a host can measure the device-side path.

## Safety and performance boundaries

- The session is bound to the selected device session and is invalidated after disconnect/reselection.
- Foreground package policy is checked before actions and after returned frames; sensitive packages remain blocked by default.
- UI hierarchy verification is intentionally not performed in this visual path.
- Screenshot content is returned with the action, avoiding an extra MCP round trip.
- The session does not make model reasoning faster. Use the host's low-latency or low-thinking mode when available and keep one model decision per visual action.
- Use semantic `ui_dump`/`ui_find`/`ui_tap` for ordinary controls; do not use visual sessions as a replacement for accessibility-aware interaction.
