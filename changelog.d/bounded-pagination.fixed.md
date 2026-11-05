- Bound conversation listings, user-directory searches and backscroll pagination
  in both legacy and explicit-policy mode. Page-limit stops retain eligible
  results and explicitly report incompleteness rather than throwing; background
  registration and refresh distinguish partial enumeration from full coverage.
- Add validated operator page limits, defaulting to 1000 conversation pages,
  1000 directory pages and 100 backscroll pages. Existing match/message limits
  also remain visible when they truncate results. Complete results below all
  limits retain their previous API, tool-text and log bytes.
