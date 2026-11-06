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
- Plugin tasks use the ordinary task model and permissions selected by the user. No hidden tasks, background Agent invocation, arbitrary target access or Node worker is requested. Version 1.2.0 adds the explicit Discord-only network and vault-backed bot credential described below.
- Account access and successful external delivery still depend on the actual installed connectors and their live receipts. Source availability cannot be inferred from code alone.

Validation performed in this repository uses unit tests, a simulated-host browser smoke test and Cindy Forge package validation. The distributable is not automatically installed, and no new end-to-end account run is claimed before its owner imports and authorizes it.

## Version 1.1.0 authorization flow

The update uses the same verified 0.1.121 interfaces. It persists one task per monitor authorization scope, registers the bounded main-task scope through setTeamPlan, then invokes the real requestWriteAccess({mode: auto}) confirmation only from configuration. The registration does not start a team or create worker agents. Send and scheduler entry points only reuse approved tasks, never synthesize grants or choose bypassPermissions.

The scope-generation counter changes for sources, recipient values or channel changes. Time and focus edits preserve the same task. Native Auto permissions are rechecked before dispatch. Duplicate daily triggers share a stable request key; unknown native dispatches do not receive fresh keys. Configuration and task identity persist across plugin logic-page restarts.

Evidence: [main-task scope registration](https://github.com/makecindy/cindy/blob/727afb1ad6902176e2ec55254154b900c489a998/apps/desktop/src/main/maker-ipc/pluginTaskService.ts#L440), [actual task permission snapshot](https://github.com/makecindy/cindy/blob/727afb1ad6902176e2ec55254154b900c489a998/apps/desktop/src/shared/pluginTasks.ts#L24), [write-access refusal gate](https://github.com/makecindy/cindy/blob/727afb1ad6902176e2ec55254154b900c489a998/apps/desktop/src/main/maker-ipc/pluginWriteAccessGate.ts#L1).

Mail remains delegated to the user's approved Feishu connector. It must use Cindy's standard mail-draft/send flow. Recipient email delivery status and chat message creation are distinct proofs; accepted mail is not reported as confirmed inbox delivery.

## Version 1.1.1 setup recovery

The executing host was rechecked on 2026-11-05 and is still 0.1.121. At the same pinned source commit, pluginTaskService.ts checks the immutable send-receipt fingerprint before the live revision, then returns REVISION_CONFLICT before inserting a receipt (lines 525–566). Only this definite pre-dispatch rejection allows one revision refresh with the same key and text. Unknown results retain the original tuple and are reconciled on an explicit setup retry. New setup tokens are staged with that tuple and do not invalidate the old token before acceptance; a result that arrives before acknowledgement remains valid. No native permissions are granted by these checks, and a rejected complete_setup call is never bypassed.

## Version 1.2.0 official Discord REST collector

The executing host was rechecked on 2026-11-06 and remains Cindy 0.1.121.

The same supported 0.1.121 bridge provides cindy.fetch with a declared exact discord.com host, network.secrets Authorization format `Bot {value}`, /secrets write-only settings and fs root=data. Matching networkSlot.ts verifies that user headers are sanitized, credentials are injected by the Host and Retry-After is available to the plugin; the bot credential is never returned to the plugin logic or Agent. An explicit empty setup.requires preserves access to legacy browser configurations and history; bot preflight checks the optional credential only when that mode is configured. Network access is disclosed as a new installation permission.

Official Discord API documentation was checked at commit da52492ced82d375981c46618cc3e182daada9a2 of discord/discord-api-docs: message.mdx (GET channel messages, limit 1–100, newest first, mutually exclusive before/after/around, empty response without Read Message History), guild.mdx (roles, self member, channels and active threads), channel.mdx (public archive timestamp cursor and joined-private archive ID cursor), application.mdx (message-content flags), permissions.mdx (role/member overwrite order), oauth2.mdx (actual current bot application identity) and rate-limits.mdx (Retry-After / retry_after).

The collector uses only GET and the user-configured sources. It does not use personal-account tokens, a Gateway or privileged member-list access. Archived timestamp cursors retain submillisecond precision; joined-private archive pagination uses IDs. Local cache paths are isolated from reports/receipts, bounded, and checked before cleanup. Tests use mock API/Host data, not a real bot: actual credentials, server installation, channel coverage and first Feishu delivery remain owner-side acceptance steps. This is not a claim that the pre-existing Host Auto-review rejection has been fixed.
