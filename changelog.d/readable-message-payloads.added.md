- Render readable attachments and blocks in history, threads, backscroll and
  eligible live messages, while preserving original Slack text and valid single-line mention/wake
  decisions. Search the rendered history content. Supplemental content counts toward bounded
  history/thread byte budgets: reads may stop earlier with a byte_limit cursor
  or reject an oversized first message.
  Include shared-source attribution, rich styles, classic fields and readable
  fallback; deduplicate supplemental bot mirrors and repeated units within
  the same source message. Keep distinct source timestamps separate for attributed attachments.
  Skip human rich-text mirrors when ordinary text is non-whitespace; retain blocks-only
  and bot/integration rich text unless original text is non-whitespace and
  client_msg_id is a string (including
  an empty string; null and other non-string values do not suppress app rich text). Bound supplemental traversal and output with
  visible truncation markers, and prioritize attachment-nested readable blocks over their omission labels.
  Preserve readable attachment block order when its text matches a deferred omission notice.
  Top-level blocks retain input order, including omission labels.
  Supplemental mentions use cached names or raw IDs (even when the same ID has
  an original-text fallback label), without extra lookups
  in live messages, backscroll and explicit history/thread reads. Authors and original-text
  mentions retain their lookups, which can delay live delivery, reaction ack and wake.
  App-as-user posts without bot_id remain eligible live under chat:from-human by default,
  including rendered app bodies; the tag is not proof of human authorship.
  Backscroll omission notices are server notices, not author text; when history is unavailable they name
  the inactive host-selected `slack.history` feature set, not a capability grant or environment setting.
  Omission authors are quoted once. Unclosed code fences retain edge breaks,
  and CR/LF breaks across rich sections remain distinct. Yield between batches of text-filtered history candidates.
  Channel mirrors deduplicate before reused-label expansion; normalized omission
  labels deduplicate before charging their deferred allowance. Rendering cuts
  retain a conservative marker even when their bounded prefixes deduplicate.
  Only unattributed units deduplicate against original text; attributed units
  compare within the displayed header plus channel ID and timestamp when supplied;
  missing keys fall back to the displayed attribution, not full source identity.
  Yield between batches of backscroll rendering; stop abandoned shaping and
  further name-lookup batches when delivery gives up. Reference comparison keys
  escape literal NULs so prose cannot collide with mention identities.
  Omission hints explain cursor pagination, including when no placeholder fits.
  Classic link previews can appear in reads and match textContains; they are
  skipped only when from_url exactly matches an extracted original URL. App
  unfurls are skipped separately; shares retain their source bodies.
  Supplemental deduplication preserves internal prose row boundaries and code
  whitespace, while normalizing equivalent line endings, trailing horizontal
  prose whitespace and rich-section separators. Closed code fences normalize
  supported edge line breaks. Rich-container joining is linear; truncated
  supplemental text preserves complete Slack angle tokens and escaped entities.
