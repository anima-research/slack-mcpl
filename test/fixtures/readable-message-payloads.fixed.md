- Render readable attachments and blocks in history, threads, backscroll and
  eligible live messages, while preserving original Slack text and valid single-line mention/wake
  decisions. Search the rendered history content. Supplemental content counts toward bounded
  history/thread byte budgets: reads may stop earlier with a byte_limit cursor
  or reject an oversized first message.
  Include shared-source attribution, rich styles, classic fields and readable
  fallback; deduplicate supplemental bot mirrors and repeated units within
  the same source message. Keep distinct source timestamps separate for attributed attachments.
  Skip human rich-text mirrors when ordinary text is non-whitespace; retain blocks-only
  and bot/integration rich text without a client_msg_id (that marker takes
  precedence). Bound supplemental traversal and output with
  visible truncation markers, and prioritize attachment-nested readable blocks over their omission labels.
  Top-level blocks retain input order, including omission labels.
  Bound framed backscroll to 32 KiB, replacing oversized messages in position
  and summarizing the older prefix. Suggest fetch_history only when granted,
  without promising recovery beyond its result limits.
  Supplemental-only mentions use cached names or raw IDs without lookups
  in live messages, backscroll and explicit history/thread reads. Authors and original-text
  mentions retain their lookups, which can delay live delivery, reaction ack and wake.
  App-as-user posts without bot_id remain eligible live under chat:from-human,
  including rendered app bodies; the tag is not proof of human authorship.
  Malformed nested angle tokens restart at the inner opener; malformed and
  multiline angle tokens otherwise remain literal, and multiline mentions
  do not trigger mention-based wake or auto-subscription.
  Render usergroup references as @label or @ID. Backscroll omission notices
  are server notices, not author text; when history is unavailable they name
  the host grant needed. Yield between batches of text-filtered history candidates.
  Deduplicate channel mirrors before expanding reused labels, and repeated
  omission labels before charging their deferred allowance.
  Only unattributed units deduplicate against original text; attributed units
  retain their source identity. Yield between batches of backscroll rendering.
  Omission hints explain cursor pagination, including when no placeholder fits.
