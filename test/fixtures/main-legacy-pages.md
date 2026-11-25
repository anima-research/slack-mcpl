`main-legacy-pages.json` is `legacyPageProbe()` (test/legacyPageProbe.ts),
run verbatim against an export of main `d885b862` with Node v22.23.3 on
Linux, with the access policy unset: find_user, list_channels, backscroll and
fetch_history over the probe's corpus of page containers, rows and cursors,
each varied alone rather than in combination (126 runs), each result or error
text with the number of Slack requests made. The corpus stays under every
documented page and match limit, so it pins unset paged behaviour to main for
these inputs only. To recapture, export that revision, copy
the probe into its `test/`, and write
`JSON.stringify(await legacyPageProbe(), null, 2)` plus a newline.
