- Initial backscroll stops requesting history pages when the 5-second delivery
  timer fires or the host disconnects. If the host disconnects while the server
  is handling a host request, paging can continue until that request finishes
  or the timer fires, whichever comes first. An in-flight Slack request may
  still finish, but its result is discarded.
