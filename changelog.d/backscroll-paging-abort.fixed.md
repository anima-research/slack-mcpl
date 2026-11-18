- Timed-out initial backscroll lookups stop before starting another history
  request, including after a delayed channel check. An in-flight Slack request
  may still finish, but its result is discarded after cancellation.
