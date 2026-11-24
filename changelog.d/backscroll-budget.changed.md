- Bound framed backscroll to 32 KiB, replacing messages that exceed the
  remaining budget in position (even if they fit the full budget individually)
  and summarizing the older prefix. Suggest fetch_history only when granted,
  without promising recovery beyond its result limits. The frame count now counts
  retained message positions (including placeholders), not all fetched messages.
- Accept decimal integers for SLACK_BACKSCROLL_LIMIT in [1, 1000], with optional
  surrounding whitespace and an optional leading `+`; invalid or out-of-range
  values fall back to 50 rather than accepting an integer prefix.
