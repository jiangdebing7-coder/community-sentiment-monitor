# Cindy host compatibility

- Execution host checked on 2026-11-04: Cindy 0.1.121.
- Official release tag: v0.1.121.
- Resolved commit: 727afb1ad6902176e2ec55254154b900c489a998.
- This package declares and verifies 0.1.121 as its supported minimum; compatibility with older releases is not claimed.

The implementation was checked against the public bridge and matching host handlers at this immutable commit:

| Feature | Evidence |
| --- | --- |
| Logic-page bridge and task facade | [ghostPreload.ts](https://github.com/makecindy/cindy/blob/727afb1ad6902176e2ec55254154b900c489a998/apps/desktop/src/preload/ghostPreload.ts#L53) |
| Ordinary plugin tasks and capabilities | [taskSlot.ts](https://github.com/makecindy/cindy/blob/727afb1ad6902176e2ec55254154b900c489a998/apps/desktop/src/main/cindy-brain/taskSlot.ts#L9) |
| Automation draft contract | [scheduleSlot.ts](https://github.com/makecindy/cindy/blob/727afb1ad6902176e2ec55254154b900c489a998/apps/desktop/src/main/cindy-brain/scheduleSlot.ts#L145) |
| Draft delivery to the native UI | [index.ts](https://github.com/makecindy/cindy/blob/727afb1ad6902176e2ec55254154b900c489a998/apps/desktop/src/main/cindy-brain/index.ts#L4085) |
| Same-origin configuration, context and wake endpoints | [electronSandboxAdapter.ts](https://github.com/makecindy/cindy/blob/727afb1ad6902176e2ec55254154b900c489a998/apps/desktop/src/main/cindy-brain/runtime/electronSandboxAdapter.ts#L552) |
| Private report storage | [fsSlot.ts](https://github.com/makecindy/cindy/blob/727afb1ad6902176e2ec55254154b900c489a998/apps/desktop/src/main/cindy-brain/fsSlot.ts#L362) |
| Manifest capabilities | [manifest.ts](https://github.com/makecindy/cindy/blob/727afb1ad6902176e2ec55254154b900c489a998/packages/plugin-protocol/src/manifest.ts#L3065) |

Important verified limits:

- requestSchedule requests a draft, not an installed schedule. Its accepted fields are name, prompt and optional intervalMs; clock-based cron/timezone values are not applied by this API. The interface explicitly asks users to check the native form, and the chat-based path returns the exact native schedule specification.
- UI pages have no general preload or network privileges. They use /wake and a same-origin BroadcastChannel to communicate with the logic page.
- /kv is capped at 64 KiB. Report bodies and per-recipient receipts therefore use the private fs data root. Data-storage errors stop delivery rather than resetting the receipt ledger.
- Plugin tasks use the ordinary task model and permissions selected by the user. No hidden tasks, background Agent invocation, arbitrary target access, Node worker, secret or autonomous network capability is requested.
- Account access and successful external delivery still depend on the actual installed connectors and their live receipts. Source availability cannot be inferred from code alone.

Validation performed in this repository uses unit tests, a simulated-host browser smoke test and Cindy Forge package validation. The distributable is not automatically installed, and no new end-to-end account run is claimed before its owner imports and authorizes it.
