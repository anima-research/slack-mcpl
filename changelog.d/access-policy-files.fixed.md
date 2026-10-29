- Prepare dormant explicit-policy file access: verify fresh conversation and file
  sharing evidence before downloads, use ID-based attachment references, refuse
  external files and redirects, and recheck upload targets before sharing.
  File deletion requires a recorded upload and a current admitted writable share;
  deletion still removes the file from its other shares too. Unshared or unverifiable
  files are left for manual cleanup. Upload provenance is capped at 1000 entries;
  evicted entries also require manual cleanup. Checks cannot make concurrent unsharing atomic.
  No setting activates this policy; legacy URL fetching and rollback stay unchanged.
