# Explicit access policy migration

SLACK_ACCESS_POLICY **replaces**, never intersects, SLACK_DISABLE_DMS,
SLACK_DM_USERS and SLACK_SEND_CHANNELS. Remove all three before migrating;
remaining names generate one stderr warning, even for invalid legacy values.
A legacy inbound-only DM whitelist is not a mechanical rename: dmUsers
intentionally grants reads **and writes** to those peers.

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

## Rollout and scopes

Review the underlying admission/file chain. Snapshot the legacy environment,
choose the entire policy, grant needed OAuth scopes and reinstall the Slack
app if necessary. Test permitted and denied operations with guarded loopback
fixtures before deployment. Install complete JSON atomically and restart;
there is no hot reload. Inspect the explicit-mode summary, ignored-setting
warning, unavailable-scope warning and directory notice. Verify tools, early
inbound delivery, host publish, uploads and rollback with actual host grants.

Legacy DM-off maps to empty dmUsers AND omitted/empty groupDms. Resolve
legacy D-ID write destinations to deliberately permitted peers. Ordinary
C/G write pins need joined reads; group pins additionally need groupDms.

Matching channels/groups/im/mpim read and history scopes still apply.
Effects need chat:write, files:write or reactions:write; DM/group opening
and writing need im:write/mpim:write where applicable. File reads **and policy
rollback deletion need files:read** for fresh association. Unknown scope
metadata stops explicit startup. Known limited grants start with diagnostics
and affected operations denied. Subscriptions, acknowledgements and host
grants remain separate controls and cannot broaden admission.

## Deliberate boundaries

This policy confines conversations and associated files. It does not confine
the workspace directory: find_user with users:read can return people outside
dmUsers or admitted conversations (ID, username, real name, display name).
Conversation-deny-all is not directory-deny-all. Omitting users:read denies
lookup but affects name resolution. Independent tool disabling requires #53,
not implemented on this base; it cannot replace inbound/publish/rollback gates.
This is not a sandbox for unrelated host filesystem permissions.

Explicit file references use channelId/fileId rather than private URLs.
Only exact hosted/snippet/post modes, visible state and current association
authorize bytes. Deleted, tombstoned, external, unknown/absent mode and
inaccessible files offer no download hint. Canonical private downloads refuse
redirects. Deletion additionally requires this adapter's upload provenance;
it deletes globally across **all shares**, not just the admitted conversation.
Restart or 1000-entry provenance eviction loses authority. Incomplete unshared
uploads and failed association can leave residue; rollback is fail-closed.

Admission is fresh, never positively cached. Missing MPIM membership uses
conversations.members proof (200/page, at most five pages), not listing
visibility. Explicit false, malformed proof, cursor cycles or exhausted
budgets deny. Rate limits/network failures fail foreground calls rather than
masquerade as complete empty listings. Events are acknowledged but can be
dropped, with bounded aggregate stderr notices containing no content. This
favors revocation over throughput, not guaranteed event delivery. Policy-mode background
admission makes at most five attempts per candidate (four retries), with an
independent counter for each candidate. DM-name lookup keeps the existing
registration give-up behavior: after one name exhausts the waiter, later DMs
use their user IDs without further waits. Conversation listings, directory
lookups and backscroll, including legacy mode, fail on a repeated pagination
cursor instead of looping forever.

Page-count limits apply equally in legacy and explicit-policy mode. A normal
limit stop returns eligible partial results with an explicit incomplete signal;
it is not a cursor-cycle, rate-limit or authorization error. Fresh admission,
per-candidate retries and the five-page MPIM membership proof remain unchanged.
Incomplete registration is reported in logs and refresh status; a repeated
refresh starts over and need not reach missing conversations. Truncated
backscroll may omit older context and is not a complete archive. Complete
responses below all limits are unchanged. See README's **Bounded pagination**
section for the three validated operator settings and result fields.

## Troubleshooting and rollback

Fix invalid/empty JSON, unknown keys or contradictory pins and restart.
Refusals name the setting and JSON-escaped rejected value on one line
(previews over 200 characters are truncated with the original character count); keep
this non-secret configuration free of secrets. Fix scope reporting or review
grants/reinstall for missing scopes. Stale pins/membership loss deny even
after earlier success. Unsupported file modes/orphaned uploads require
separately authorized operator inspection, not weaker gates.

Rollback intentionally changes security mode: restore reviewed legacy
settings and unset SLACK_ACCESS_POLICY, then restart and reverify. Unsetting
can broaden access; never automatically fall back after malformed policy.
