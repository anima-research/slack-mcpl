- Render readable attachments and blocks in history, threads, backscroll and
  eligible live messages, while preserving original Slack text and mention/wake
  decisions. Search the rendered history content.
  Include shared-source attribution, rich styles, classic fields and readable
  fallback; deduplicate supplemental bot mirrors and repeated units within
  the same source message. Keep distinct source timestamps separate.
  Skip human rich-text mirrors when ordinary text is present; retain blocks-only
  and bot/integration rich text. Bound supplemental traversal and output with
  visible truncation markers, and prioritize readable blocks over omission labels.
  Bound framed backscroll to 32 KiB, replacing oversized messages in position
  and summarizing the older prefix. Suggest fetch_history only when granted,
  without promising recovery beyond its result limits.
  Malformed nested angle tokens restart at the inner opener; malformed and
  multiline angle tokens otherwise remain literal, and multiline mentions
  do not trigger mention-based wake or auto-subscription.
