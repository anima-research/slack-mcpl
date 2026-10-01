- Every incoming message now opens with a header naming its message ID and,
  inside a thread, its thread (#2): `[id=<ts>]`,
  `[thread=<thread_ts> id=<ts>]`, or `[#channel (team) thread=… id=…]` when
  the conversation changes. The thread used to be only in the metadata, and
  the header appeared only on a conversation change, so an agent mentioned
  inside a thread answered in the channel and could not keep two threads of
  one channel apart. Backscroll lines name a reply's thread the same way.
