- Render readable attachments and blocks in history, threads, backscroll and
  eligible live messages; deduplicate each supplemental unit independently.
  Preserve original Slack text for channels/incoming raw metadata and mention/wake decisions.
  Search rendered history content, retain shared messages, and mark bounded
  supplemental output visibly when truncated.
  Skip top-level human rich_text when non-empty text accompanies client_msg_id
  or no bot/app provenance; keep blocks-only and bot/integration rich text.
  Deduplicate attachment units within attribution, format classic Slack fields,
  preserve rich styles and prefer readable fallback over omission placeholders.
  Mark backscroll messages exceeding the remaining byte budget in position
  and summarize older context outside the bounded newest window.
  Use linear scans for angle tokens and bare URLs, including long labelled links.
  Malformed nested angle tokens now restart at the inner opener; this also affects
  original-text mention extraction and formatting.
  Size rich mirror traversal to original text, normalize prose bullet spellings,
  preserve code newlines inside fences, and keep distinct full attribution identities.
  Bound backscroll channel labels as well as message content; avoid reserving an
  omission summary when the complete block fits.
