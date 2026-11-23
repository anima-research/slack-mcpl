`main-legacy-surface.json` is `legacySurfaceProbe()` (test/legacySurfaceProbe.ts),
run verbatim against an export of main `d885b862` with Node v22.23.3 on
Linux: feature-set descriptions, the plain-MCP and MCPL `tools/list` results
(MCPL adds `refresh_channels`), subscription tool results, a listing and the
legacy backscroll attachment line, with the access policy unset. To recapture,
export that revision, copy the probe into its `test/`, and write
`JSON.stringify(await legacySurfaceProbe(), null, 2)` plus a newline.
