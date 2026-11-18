- When explicit policy is enabled, confine file access: verify fresh conversation and file
  sharing evidence before downloads, use ID-based attachment references, refuse
  external files and redirects, and recheck upload targets before sharing.
  File deletion requires a recorded upload and a current admitted writable share;
  deletion still removes the file from its other shares too. Unshared or unverifiable
  files are left for manual cleanup. Upload provenance is capped at 1000 entries;
  evicted entries also require manual cleanup. Checks cannot make concurrent unsharing atomic.
  Embedded policy callers use these protections; legacy URL fetching and rollback stay unchanged.

  ID-only `check_file_info` stubs may offer a fetch hint without known mode or
  fresh association, unless explicit unavailable markers veto the hint;
  downloads still require fresh conversation and file checks.
- An uncertain upload outcome asks for inspection before retrying or cleanup:
  keep a confirmed successful upload, remove only unwanted residue, and remember
  that deleting a file removes all its shares.
- Withheld attachment notes ask the host to restore file access and the agent
  to re-read for a current reference, rather than exposing token setup instructions.
