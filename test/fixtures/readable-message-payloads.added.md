- Render readable attachments and blocks in history, threads, backscroll and
  eligible live messages, while preserving original Slack text and valid single-line mention/wake
  decisions. Search the rendered history content. Supplemental content counts toward bounded
  history/thread byte budgets: reads may stop earlier with a byte_limit cursor
  or reject an oversized first message.
  Include shared-source attribution, rich styles, classic fields and readable
  fallback; deduplicate supplemental bot mirrors and repeated units within
  the same source message. Keep distinct source timestamps separate for attributed attachments.
  Skip human rich-text mirrors when ordinary text is non-whitespace; retain blocks-only
  and bot/integration rich text unless client_msg_id is a string (including
  an empty string; null and other non-string values do not suppress app rich text). Bound supplemental traversal and output with
  visible truncation markers, and prioritize attachment-nested readable blocks over their omission labels.
  Top-level blocks retain input order, including omission labels.
  Bound framed backscroll to 32 KiB, replacing oversized messages in position
  and summarizing the older prefix. Suggest fetch_history only when granted,
  without promising recovery beyond its result limits.
  Supplemental-only mentions use cached names or raw IDs without lookups
  in live messages, backscroll and explicit history/thread reads. Authors and original-text
  mentions retain their lookups, which can delay live delivery, reaction ack and wake.
  App-as-user posts without bot_id remain eligible live under chat:from-human by default,
  including rendered app bodies; the tag is not proof of human authorship.
  Malformed nested angle tokens restart at the inner opener; malformed and
  multiline angle tokens otherwise remain literal, and multiline mentions
  do not trigger mention-based wake or auto-subscription.
  Render usergroup references as @label or @ID. Backscroll omission notices
  are server notices, not author text; when history is unavailable they name
  the host grant needed. Yield between batches of text-filtered history candidates.
  Channel mirrors deduplicate before reused-label expansion; normalized omission
  labels deduplicate before charging their deferred allowance. Rendering cuts
  from discarded nonempty duplicate units do not add truncation markers.
  Only unattributed units deduplicate against original text; attributed units
  compare within the displayed header plus channel ID and timestamp when supplied;
  missing keys fall back to the displayed attribution, not full source identity.
  Yield between batches of backscroll rendering.
  Omission hints explain cursor pagination, including when no placeholder fits.
  Accept decimal-digit SLACK_BACKSCROLL_LIMIT values in [1, 1000]; invalid or
  out-of-range values fall back to 50 rather than accepting an integer prefix.
