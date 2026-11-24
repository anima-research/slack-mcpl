- Initial backscroll stops starting new history requests once `serve()` exits
  or the 5-second delivery timer fires. If the peer disconnects during a host
  request, paging can continue until `serve()` exits or the timer fires.
  An in-flight Slack request may still finish, but its result is discarded
  after cancellation.
