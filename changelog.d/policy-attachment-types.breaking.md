- **Embedded TypeScript callers:** `AttachmentRef` and history attachment types
  now include policy file-reference variants. `AttachmentRef.path` and
  `mimeType`, and a history attachment's `url`, are no longer always present.
  Narrow the legacy URL variant before passing those fields to string-only
  APIs; policy variants use conversation/file IDs and may describe an
  unavailable attachment. This source change applies even when callers never
  configure a policy. Runtime no-policy URL attachment payloads are unchanged.
  `AttachmentRef` is now a union type alias: replace `interface Custom extends
  AttachmentRef` with `type Custom = AttachmentRef & { /* extra fields */ }`,
  or extend the exported `LegacyAttachmentRef` when only URL/path attachments
  are supported. `backscrollLine` / `backscrollBlock` attachment inputs also use the narrowed legacy or
  policy variants. Across inbound, history and backscroll attachment types, remove unrelated
  `channelId` and `fileId` metadata from legacy objects before assignment or passing them in, and narrow on `path`/`url` before string-only use.

  Embedded callers rendering policy file references with `backscrollLine` must set
  the message's `policyAttachments: true`; `backscrollBlock` accepts that flag in
  its location options. Without this explicit flag, attachment names retain
  main's rendering even when unrelated `channelId` metadata is present.

  `historyRecord` now accepts a positional `policyAttachments` flag. Replace
  `messages.map(historyRecord)` with `messages.map(message => historyRecord(message))`
  for legacy rendering, or call `historyRecord(message, true)` inside the arrow
  for policy file references. Passing the function directly as a callback
  supplies the array index as the flag in JavaScript and is rejected by TypeScript.
