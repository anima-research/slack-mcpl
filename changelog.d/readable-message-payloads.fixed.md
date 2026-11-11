- Render readable attachments and blocks in history, threads, backscroll and
  eligible live messages; deduplicate each supplemental unit independently.
  Preserve original Slack text for raw metadata and mention/wake decisions.
  Search rendered history content, retain shared messages, and mark bounded
  supplemental output visibly when truncated.
  Skip top-level human rich_text when non-empty text accompanies client_msg_id
  or no bot/app provenance; keep blocks-only and bot/integration rich text.
  Deduplicate attachment units within attribution, format classic Slack fields,
  preserve rich styles and prefer readable fallback over omission placeholders.
  Mark backscroll messages exceeding the remaining byte budget in position
  and summarize older context outside the bounded newest window.
- Format long labelled Slack links (including 2 KiB dashboard URLs) with a
  linear angle-token scan.
- Keep bare-URL trailing-punctuation trimming linear on long messages.
