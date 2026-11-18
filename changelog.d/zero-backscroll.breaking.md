- **Operators:** `SLACK_BACKSCROLL_LIMIT=0` now disables automatic backscroll
  instead of falling back to 50 messages. The setting now accepts only decimal
  digits in the range 0–1000 (surrounding whitespace is trimmed); empty,
  malformed, signed, fractional and out-of-range values refuse startup with a
  one-line diagnostic rather than using a prefix or silently falling back.
  Replace values such as `0junk`, `0.5` or `off` with `0` to disable it;
  unset the variable or set it to `50` to keep the default automatic history
  read. Valid non-zero limits and explicit `fetch_history` / `fetch_thread`
  reads (feature set `slack.history`) are unchanged. The effective backscroll
  value is now logged at startup.
