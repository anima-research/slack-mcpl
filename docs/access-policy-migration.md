# Explicit access policy migration

SLACK_ACCESS_POLICY **intersects**, never overrides, SLACK_DISABLE_DMS,
SLACK_DM_USERS and SLACK_SEND_CHANNELS. Keep and review those restrictions:
invalid switches and empty legacy lists refuse startup in both modes.
A DM peer must pass both policy dmUsers and SLACK_DM_USERS (if set), with
SLACK_DISABLE_DMS off. Group DMs also require SLACK_DISABLE_DMS off, but
SLACK_DM_USERS does not filter groups. Every write additionally intersects
SLACK_SEND_CHANNELS, including the returned D-ID for send_dm. Slack must open
the peer DM to return its exact ID; if destination admission then refuses the
post, the error reports the opened DM and that nothing was posted.
A legacy inbound-only DM whitelist is not a mechanical rename: policy dmUsers
permits reads **and writes**, subject to all these additional restrictions.

## Schema and examples

The complete JSON object requires boolean readJoinedChannels, array
writeChannels (exact uppercase C/G IDs), and array dmUsers (exact uppercase
U/W IDs). Optional groupDms accepts exact uppercase G IDs; omission/empty
means no group DMs. Empty arrays deny their category. Unknown keys, wrong
kinds, missing required fields and malformed IDs refuse startup. Only absence
of the setting selects legacy mode. Empty/whitespace/null are not absence.

Values for SLACK_ACCESS_POLICY:

- Conversation-deny-all: `{"readJoinedChannels":false,"writeChannels":[],"dmUsers":[]}`
- Joined ordinary channels read-only: `{"readJoinedChannels":true,"writeChannels":[],"dmUsers":[]}`
- One writable joined channel: `{"readJoinedChannels":true,"writeChannels":["CEXAMPLE"],"dmUsers":[]}`
- DM-only: `{"readJoinedChannels":false,"writeChannels":[],"dmUsers":["UEXAMPLE","WEXAMPLE"]}`
- Group-only: `{"readJoinedChannels":false,"writeChannels":["GEXAMPLE"],"dmUsers":[],"groupDms":["GEXAMPLE"]}`

For a read-only group use empty writeChannels. If joined reads are false,
every write pin must also occur in groupDms; ordinary pins would be unusable.
A G prefix alone is not MPIM proof: a legacy private channel mistakenly named
in groupDms can pass syntactic validation but cannot gain group-DM access.
With joined reads off, such a pin remains unusable. No auto-join or
pinned-channel fallback.

| Target | Read | Write |
|---|---|---|
| Joined ordinary channel | readJoinedChannels true, fresh membership | Also writeChannels pin |
| 1:1 DM | Peer in dmUsers | Same peer grant, no D-ID pin |
| Group DM | Named groupDms, fresh membership | Also writeChannels pin |
| Other target | Denied | Denied |

The table describes policy grants; the legacy intersections above also apply.

## Rollout and scopes

Review the underlying admission/file chain. Snapshot the legacy environment,
choose the entire policy, grant needed OAuth scopes and reinstall the Slack
app if necessary. Test permitted and denied operations with guarded loopback
fixtures before deployment. Install complete JSON atomically and restart;
there is no hot reload. Inspect the explicit-mode summary (effective peer/group counts and write intersection),
unavailable-scope warning and directory notice. Verify tools, early
inbound delivery, host publish, uploads and rollback with actual host grants.

Legacy DM-off maps to empty dmUsers AND omitted/empty groupDms. Resolve
legacy D-ID write destinations to deliberately permitted peers. Ordinary
C/G write pins need joined reads; group pins additionally need groupDms.

Matching channels/groups/im/mpim read and history scopes still apply.
Effects need chat:write, files:write or reactions:write; opening a one-to-one
DM needs im:write. Existing pinned group-DM effects do not need mpim:write. File reads **and policy
rollback deletion need files:read** for fresh association. Unknown scope
metadata stops explicit startup. Known limited grants start with diagnostics
and affected operations denied. Subscriptions, acknowledgements and host
grants remain separate controls and cannot broaden admission.

## Deliberate boundaries

With readJoinedChannels:true, workspace members who can invite the bot can
extend its readable set, including private channels; there is no channel-read allow-list.

This policy confines conversations and associated files. It does not confine
the workspace directory: find_user with users:read can return people outside
dmUsers or admitted conversations (ID, username, real name, display name).
Conversation-deny-all is not directory-deny-all. Omitting users:read denies
lookup but affects name resolution. This build has no independent tool-disabling setting. To prevent directory access, omit `users:read` from token grants (also affecting name resolution), or do not connect a host that requires directory confinement. Tool filtering alone cannot replace inbound/publish/rollback gates.
This is not a sandbox for unrelated host filesystem permissions.

Explicit file references use channelId/fileId rather than private URLs.
Only exact hosted/snippet/post modes and current association authorize bytes. Omitted file_access, deletion, tombstone and external flags are accepted unless an explicit restrictive value is present; affirmative visible-state metadata is not required. Deleted, tombstoned, external and explicit unsupported-mode markers offer no download hint. ID-only `check_file_info` stubs are an exception to the absent-mode rule: they may offer a fetch hint without fresh association, but never authorize bytes. A valid file ID with a supported hosted/snippet/post mode may also offer an unverified hint despite sparse message metadata; missing mode without the check_file_info stub or explicit unavailable markers withholds the hint. Canonical private downloads refuse
redirects. Deletion additionally requires this adapter's upload provenance;
it deletes globally across **all shares**, not just the admitted conversation.
Restart or 1000-entry provenance eviction loses authority. Incomplete unshared
uploads and failed association can leave residue; rollback is fail-closed.

Admission is fresh, never positively cached. Missing MPIM membership uses
conversations.members proof (200/page, at most five pages), not listing
visibility. Explicit false, malformed proof, cursor cycles before membership is proven or exhausted
budgets deny. Network failures fail foreground calls; a rate-limited candidate
check or the call deadline returns the admitted rows with an explicit
incomplete notice. Neither masquerades as a complete listing. Events are acknowledged but can be
dropped. Event admission retries transient failures up to three attempts and
ten seconds of requested retry backoff, respecting Retry-After (longer waits cause a drop). This excludes admission queue time, Slack response time and host delivery, and is not an end-to-end deadline.
Separate policy-denial, transient unverifiable-message-drop and unexpected-error counters flush on a
60-second timer and shutdown, without content. Local policy vetoes cost no API
calls. Ambient preparation checks subscription state after earlier addressed host deliveries commit (not after every ambient delivery); delivery rechecks subscription state at its ordered turn; unsubscribed ambient messages are discarded before admission; exact bot
mentions and DM IDs bypass only that delivery veto. Eligible events require fresh admission, with up to three attempts under throttling; concurrent addressed preparation can share pending conversations.info requests,
plus any MPIM membership pages. Concurrent events for one conversation share
only the in-flight admission and retries; the answer is discarded on settlement.
Retry waits add up to 250 ms jitter without shortening Retry-After; jitter counts
toward the ten-second budget.
An addressed exchange may cost roughly three to eight info calls including
backscroll, metadata, reactions, status and reply; there is no positive cache. This
favors revocation over throughput, not guaranteed event delivery. Policy-mode background
admission makes at most five attempts per candidate (four retries), with an
independent counter for each candidate. An ordinary candidate that exhausts admission retries or loses its queue slot
is skipped and counted in an incomplete-registration diagnostic; healthy candidates continue;
refresh_channels can retry later. DM-name lookup keeps the existing
registration give-up behavior: after one name exhausts the waiter, later DMs
still attempt name lookup and use their user IDs if it fails, without further waits. Conversation listings, directory
lookups and backscroll in policy mode fail on a repeated pagination
cursor instead of looping forever, even on the page where the message or match
limit would end the scan: one validator checks each whole page (container, every
row, cursor type and repetition) before any row is used or any return. A malformed
listing candidate refuses its page, in background registration too.

Page-count limits apply equally in legacy and explicit-policy mode. A normal
limit stop returns eligible partial results with an explicit incomplete signal;
it is not a cursor-cycle, rate-limit or authorization error. Fresh admission,
per-candidate retries and the five-page MPIM membership proof remain unchanged.
Page-limit incompleteness is reported in logs and refresh status; candidate admission skips and enumeration failures are logged but are not retained as refresh registration status at this layer; a repeated
refresh starts over and need not reach missing conversations. Truncated
backscroll may omit older context and is not a complete archive. Complete
valid responses below all limits retain their normal complete results. Without a policy, the only intended difference is the explicit bounded incomplete-result contract, including partial backscroll; main directory validation and cursor behavior are otherwise retained. See README's **Bounded pagination**
section for the three validated operator settings and result fields.

## Troubleshooting and rollback

Fix invalid/empty JSON, unknown keys or contradictory pins and restart.
Startup refusals name the setting and relevant field without echoing the policy value; keep this non-secret configuration free of secrets. Fix scope reporting or review
grants/reinstall for missing scopes. Stale pins/membership loss deny even
after earlier success. Unsupported file modes/orphaned uploads require
separately authorized operator inspection, not weaker gates.

Rollback intentionally changes security mode: restore reviewed legacy
settings and unset SLACK_ACCESS_POLICY, then restart and reverify. Unsetting
can broaden access; never automatically fall back after malformed policy.

Shutdown wakes pending inbound admission pacing and retry sleeps (candidate retry sleeps are not cancelled) and prevents starting subsequent policy message handlers. It does not cancel or join an already-running embedded or server handler or its asynchronous lookups; such a handler may still deliver after stop begins.
An already-running Slack request remains subject to its timeout and the CLI shutdown deadline; diagnostics for such unfinished requests are best effort.

Initial admission slots are released at least 1.2 seconds apart per adapter (event-loop stalls can bunch actual starts), including fast refusals; pacing adds queue latency without caching settled evidence. Final delivery checks, ACK and optional backscroll admission, foreground effects and SDK internal retries are not covered by this pacing bound; foreground listing candidates are. The single final check runs before rendering or delivery state, retries at most twice within two seconds of requested waits and a five-second delivery wait bound (the lookup may finish later), and retains original admission only on classified rate-limit, transport and Slack service failures when no lasting refusal or withdrawn grant is known. Other failures, including expired delivery waits, drop the event and request ACK cleanup; cleanup needs fresh write admission and may leave a visible reaction.

Policy enumeration costs: each eligible listed candidate needs a fresh, serial
`conversations.info` request. This layer does not implement pinned history fallback. Foreground
`list_channels` and `refresh_channels` candidates are released through the
same inbound pacer (at least 1.2 seconds apart, shared with inbound events)
within the existing 25-second call deadline: a candidate is checked only if its
slot and its 10-second request fit, so with fast responses and no other traffic
about 13 candidates fit one call, and inbound traffic, Retry-After or Slack
latency lower that. A rate-limited candidate check or the deadline ends the
scan with the admitted rows and an explicit incomplete notice (with Slack's
Retry-After when known); a rate-limited `conversations.list` page fails the
call. A new call starts over, so repeating a large scan may stop near the same
place; page ceilings do not guarantee interactive completion. The host's requests
are handled one at a time, so a paced scan holds up to its 25 seconds of other
work: a send, publish or listing queued behind it can start with too little of its
own call time left and fail unsent, and a queued `featureSets/update` or
`channels/typing` waits until the scan ends. Background
registration checks use the shared 1.2-second pacer, including retry attempts,
and yield to addressed inbound work. Descriptors are announced only after the
scan completes; 100 candidates take at least about 119 seconds before listing
and response costs or contention. Refresh refuses while registration is active.
