# Known Issues

## Dashboard reliability

`macc watch` and the in-picker `watch` command need a deeper pass. The dashboard currently opens, but its behavior is not reliable enough to treat as done.

Things to verify/fix:

- Returning from the dashboard to the agent picker after Ctrl+C.
- Running `watch` from inside the initial picker without stale readline state.
- Refresh behavior while multiple agents are installed or running.
- Token usage does not reliably update in the dashboard even when context limits display correctly.
- Whether handoff triggers from dashboard state are accurate.
