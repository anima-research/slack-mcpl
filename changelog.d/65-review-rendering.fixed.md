- Avoid false supplemental-text truncation notices from discarded duplicate units
  and equivalent unsupported-block labels; app rich text remains readable when
  `client_msg_id` is null.
- Reject non-integer or malformed `SLACK_BACKSCROLL_LIMIT` values, falling back
  to 50 instead of accepting an integer prefix.
