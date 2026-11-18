# Unset differential oracle

`unset-parity-44e95bd3.json` is the exact JSON output of
`unset-parity-worker.mjs` against frozen PR #65 commit `44e95bd3` (not current
source and not handwritten expected prose). The worker runs identically against
current source in `unsetParity.test.ts`. It captures the full initialize
capabilities and raw tool definitions before tools/list adds `mcpl/class`
(not host-visible tool classification), both delivery lanes' content/notices,
valid-argument subscription result variants in both subscription modes (not
argument-validation refusals), with subscription
tools enabled/disabled, plus fractional/zero/negative refresh guidance and
registration retry logs/timer arguments (including oversized waits).

Reproduce entirely offline from the repository root, using a fresh short scratch
path (replace `/tmp/s66base` if occupied). The frozen base commit must already
exist locally; a shallow checkout without it cannot reproduce this offline.
The preflight fails before creating output if that prerequisite is missing:

```sh
set -eu
git cat-file -e '44e95bd3^{commit}'
mkdir /tmp/s66base
trap 'rm -rf /tmp/s66base' EXIT
git archive 44e95bd3 src test/harness.ts package.json | tar -x -C /tmp/s66base
ln -s "$PWD/node_modules" /tmp/s66base/node_modules
node --import tsx test/fixtures/unset-parity-worker.mjs /tmp/s66base \
  > /tmp/s66base/unset-parity.json
# Publish only a completed, valid capture, never a failed or truncated one.
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' \
  /tmp/s66base/unset-parity.json
cp /tmp/s66base/unset-parity.json test/fixtures/unset-parity-44e95bd3.json
```

Do not regenerate against current source to make a compatibility failure pass.
The sibling opt-in tests separately assert the admission-qualified guidance and
safe registration timers; default parity must not disable those behaviors.
