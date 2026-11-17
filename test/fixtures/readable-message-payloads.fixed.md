- Render readable attachments and blocks in history, threads, backscroll and
  eligible live messages; deduplicate each supplemental unit independently.
  Preserve original Slack text for channels/incoming raw metadata and mention/wake decisions.
  Search rendered history content, retain shared messages, and mark bounded
  supplemental output visibly when truncated.
  Skip top-level human rich_text when non-empty text accompanies client_msg_id
  or no bot/app provenance; keep blocks-only and bot/integration rich text.
  Deduplicate attachment units within attribution, format classic Slack fields,
  preserve rich styles and prefer readable fallback over omission placeholders.
  Apply a 32 KiB framed backscroll budget, including ordinary text-only history.
  Mark backscroll messages exceeding the remaining byte budget in position
  and summarize older context outside the bounded newest window.
  Use linear scans for angle tokens and bare URLs, including long labelled links.
  Malformed nested angle tokens now restart at the inner opener; this also affects
  original-text mention extraction and formatting.
  Size rich mirror traversal to original text, normalize prose bullet spellings,
  preserve code newlines inside fences, and deduplicate by displayed attribution headers, including source kind and caps.
  Bound backscroll channel labels as well as message content; avoid reserving an
  omission summary when the complete block fits.
  Reserve separate attachment and top-level traversal allowances including rich
  containers, keep malformed angle tokens within logical lines, and quote every
  logical line safely. Avoid redundant hidden-source attachment copies and
  unnecessary history rendering after author/scan/match limits.
  Stop pending list iteration when traversal is exhausted, ignore invalid attribution
  fields in dedup keys, and retain fallback for empty rich quotes/code blocks.
  Classic unfurl suppression requires an exact extracted URL match, with no URL
  canonicalization: slash, case, default-port or fragment differences retain
  previews, which can consume the full supplemental allowance.
  Malformed and multiline angle tokens remain literal in original text too;
  multiline mentions do not trigger mention-based wake or auto-subscription.
  Ignore non-string author names and absent optional text objects; bound even
  truncation markers by tiny supplemental caps. DM addressing remains text-independent.
