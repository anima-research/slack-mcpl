- Render readable attachments and blocks in history, threads, backscroll and
  eligible live messages; deduplicate each supplemental unit independently.
  Preserve original Slack text for raw metadata and mention/wake decisions.
  Search rendered history content, retain shared messages, and mark bounded
  supplemental output visibly when truncated.
  Skip top-level human rich_text when non-empty text accompanies client_msg_id
  or no bot_id, without heuristic equivalence. Keep blocks-only app-as-user and
  bot/integration rich text; use plain per-unit dedup for rendered supplements.
  Reconstructed client-shaped list, code and bold-link fixtures cover all four
  delivery paths; no live client capture is claimed.
