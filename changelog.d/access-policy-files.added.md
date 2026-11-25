- When explicit policy is enabled, confine file access: verify fresh conversation and file
  sharing evidence before downloads, use ID-based attachment references, refuse
  external files and redirects, and recheck upload targets before sharing.
  File deletion requires a recorded upload and a current admitted writable share;
  deletion still removes the file from its other shares too. Unshared or unverifiable
  files are left for manual cleanup. Upload provenance is capped at 1000 entries;
  evicted entries also require manual cleanup. Checks cannot make concurrent unsharing atomic.
  A download needs the conversation's metadata read grant and `files:read`, not its
  history grant: a caller that knows a conversation ID and an associated file ID can
  fetch that file even where `fetch_history`, `fetch_thread` and inbound delivery
  are refused for missing history grants.

  ID-only `check_file_info` stubs may offer a fetch hint without known mode or
  fresh association, unless explicit unavailable markers veto the hint;
  downloads still require fresh conversation and file checks.
- An uncertain upload outcome asks for inspection before retrying or cleanup:
  keep a confirmed successful upload, remove only unwanted residue, and remember
  that deleting a file removes all its shares.
- Withheld attachment notes, rather than exposing token setup instructions, say
  who can act: missing file access asks the host to restore it and the agent to
  re-read for a current reference; a deleted, external, unassociated or otherwise
  unverifiable file asks its sender to share a supported file here.
- A policy `historyRecord` renders policy file notes only for explicit-policy
  reads; an embedded legacy attachment with extra `channelId` metadata stays legacy.
- A policy download that the file endpoint rate-limits (HTTP 429) repeats its
  Retry-After as a wait only when the header is decimal seconds or an
  IMF-fixdate (`Sun, 06 Nov 1994 08:49:37 GMT`) naming a real date, and only up
  to one hour; a longer wait says "try again later", and any other form,
  including the obsolete RFC 850 and asctime dates, says "try again shortly".
