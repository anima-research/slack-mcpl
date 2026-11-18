- Operators can opt in to other bots' live messages with `SLACK_BOT_MESSAGES=all`
  or a comma-separated allow-list of bot/user IDs. It defaults off; admitted
  known bots and explicit bot events carry `chat:from-bot` and a bot-source
  text marker; unknown user-only senders in `all` use `chat:from-human`. The connector's
  known own user and bot IDs are filtered, including user-less own bot posts
  in backscroll only when opted in; unset retains legacy backscroll, including
  user-less own bot posts. Existing DM and subscription
  controls still apply; admitted mentions can auto-subscribe and receive
  the configured acknowledgement reaction. With an ID allow-list, explicitly
  listed IDs pass even if verification fails, conservatively marked as bot.
  Unlisted senders must be verified human since startup; until verified, their messages,
  including mentions and DMs, are dropped throughout users.info outages plus
  30 seconds after each failure. Restart clears verification. Failures have a
  bounded 256-entry negative cache and per-user live/host in-flight coalescing;
  eviction can end any cooldown early and renew its warning;
  rate limits honor Retry-After while cached, permanent refusals remain until restart or
  eviction, and other failures retry after 30 seconds. Addressed drops log
  the sender, conversation and message IDs, reason and non-replay warning once per cached failure/cooldown,
  never becoming a human classification. Other bots can form reply loops,
  so prefer an allow-list and host-side bot wake restrictions/rate limits.
- For messages classified as bots, bot delivery exposes `isBot: true` and optional
  `authorBotId` in both incoming metadata and push origin; other messages omit these fields. A user-less bot post uses its bot ID (B-prefixed)
  as the author ID. In `all` mode, user-only senders with failed or
  inconclusive lookups remain unknown, not verified human or bot, and use the
  normal non-bot delivery lane (`chat:from-human` is not proof of humanity).
  Known bots and explicit bot events still carry bot tags. Grant `users:read`
  and reinstall the app for reliable classification. In `all` mode, known missing scopes at
  startup or a `missing_scope` refusal emit one operator warning per adapter
  naming the scope. Permanent refusals remain cached until restart in unset and `all` modes;
  allow-list mode can retry them after eviction from its bounded negative cache.
- Allow-list startup requires `users:read` when token scopes are known; add the
  scope and reinstall the app to the workspace. Unknown scopes defer to lookups.
  Slackbot counts as a bot in opt-in modes even if Slack reports otherwise.
  List-mode history and live author/original-text mention lookups share verification
  state and cooldowns, including for users who have not yet sent a message.
  Unsent deadline failures do not start cooldowns; live events retry a joined
  host lookup if its call budget expires. Other modes retain batched name
  resolution and the existing HTTP-200 rate-limit handling.
- Live delivery, backscroll, `fetch_history` and `fetch_thread` show
  supplemental-only mentions in attachment and block text using cached names
  or raw IDs, without starting lookups for them.
- In opt-in modes, an inconclusive users.info answer keeps any display name it
  returned while the sender stays unverified and is looked up again; a sender
  is verified human once a lookup confirms it. A late refusal or inconclusive
  answer does not replace a verified sender's name; these guards apply only
  in opt-in modes. Queued list-mode batches reuse identities verified meanwhile;
  all-mode incomplete names are published atomically with their eviction markers.
- With an allow-list, senders already known to be unlisted bots are dropped
  before any mention lookup, so they start no verification cooldown for the
  users they mention. An unlisted sender not yet verified is looked up before
  the message's mentions, which are resolved only once it is admitted.
- In `all` mode a permanent refusal ends that user's lookups until restart;
  names awaiting classification are bounded to 256, the oldest evicted and
  looked up again when next seen.
- Admitted bot messages, like other live messages, are forwarded after their
  author and original-text mention name lookups, never supplemental-only lookups.
  Socket Mode is acknowledged first; the configured acknowledgement reaction
  applies only to addressed messages.
- App-as-user posts without `bot_id` use the legacy non-bot lane by default;
  opt-in modes classify them like other user-only senders, with failed or
  inconclusive `all`-mode classifications still using the non-bot lane.
  In `all` mode verified bots carry `chat:from-bot`; an unlisted app-as-user
  sender in allow-list mode must be verified human to pass.
- In allow-list mode, inconclusive display names are evicted with their bounded
  negative entries. Rate-limit diagnostics also recognize the Slack client's
  missing-Retry-After error. Opt-in DM naming retry guidance accounts for time spent
  listing later conversations; unset retains the full legacy retry interval.
- In `all` mode, late inconclusive replies preserve settled permanent refusals.
  Nameless inconclusive replies leave DM names unresolved,
  allowing background naming retries after transient failures.
- Nameless successful classifications retain an earlier display name; an initially
  empty, inconclusive all-mode profile reports a retry wait for DM naming rather
  than announcing a settled raw-ID label. Verification waits retain fractional
  expiry until the final operator-facing rounding. Invalid bot policy guidance
  shows the required uppercase ID format without echoing untrusted input.
- Per-call name snapshots preserve resolved history authors and original-text
  mentions when a batch exceeds the bounded incomplete-profile cache.
- Joined host deadline diagnostics say verification did not complete without
  claiming that no request reached Slack.
- Compatibility clarification for sender framing: its single-line and parsed-value
  assurances describe framing escapes only. Slack angle formatting can still
  change single-line text (for example, a subteam token becomes `@team`), and
  history/thread content can include supplemental attachment and block text;
  these rendered values are not promised byte-identical to earlier releases.

- In `all` mode, concurrent non-abortable live/host lookups of the same user
  share one in-flight answer, including failures and inconclusive profiles.
  In both opt-in modes, abortable backscroll lookups can join live/host work
  but are not shared as owners; concurrent backscroll and live requests can
  therefore run independently. Opt-in nameless
  classifications no longer settle a raw ID as a display name; later encounters
  can retry naming, and DM descriptions retain their own resolved name snapshot.
  Opt-in `send_dm` rejects bot IDs with guidance to reply in the source conversation
  instead of suggesting a human-only user search.

- Only with bot delivery enabled, startup reports the bot policy, the manifest
  declares `chat:from-bot`, and subscription descriptions/results/notices qualify
  sender admission. Auto-subscription notices explain host acceptance and grant
  requirements. Refresh guidance rounds fractional waits up and permits retry now;
  registration retries use validated, rounded timer-safe chunks. With bot delivery
  unset these texts, ontology, refresh wording and registration retries retain
  their behavior from before bot delivery was introduced.

- Opt-in DM naming retries classified but nameless profiles; all-mode permanent
  refusals also settle verified nameless users. Bot-ID DM guidance distinguishes
  thread replies, writable conversations and host-granted history. Non-string
  opt-in live text is treated as empty, consistently with supplemental rendering.
- Opt-in backscroll name/identity lookups discard answers and verification
  failures after cancellation, without making live lookups inherit that
  cancellation. All-mode background DM naming also retries unclassified
  lookup failures before settling for a raw ID.

- Opt-in list-mode lookups retain a live verified name when independent history
  returns an older partial profile. In all mode, permanent refusals clear late
  partial-profile retry markers even for already verified identities.
