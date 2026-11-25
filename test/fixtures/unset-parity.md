# Unset differential oracle

`unset-parity.json` is the exact JSON output of `unset-parity-worker.mjs`
against the parent of #66's bot-delivery commit. The same worker runs against
current source in `unsetParity.test.ts`. It captures the full initialize
capabilities and raw tool definitions before tools/list adds `mcpl/class`
(not host-visible tool classification), both delivery lanes' content/notices,
valid-argument subscription result variants in both subscription modes (not
argument-validation refusals), with subscription
tools enabled/disabled, plus fractional/zero/negative refresh guidance and
registration retry logs/timer arguments (including oversized waits).

Reproduce offline from the repository root after installing dependencies.
Run this at #66's bot-delivery commit, or set `FEATURE_COMMIT` to that
commit's current ref or SHA if review fixes are stacked above it. The recipe
resolves its first parent, so it still selects the pre-feature source after
#66 is rebased. A shallow checkout may need more history.

```sh
set -eu
feature=${FEATURE_COMMIT:-HEAD}
base=$(git rev-parse --verify "${feature}^1")
scratch=$(mktemp -d /tmp/s66base.XXXXXX)
trap 'rm -rf "$scratch"' EXIT
git archive "$base" src test/harness.ts package.json | tar -x -C "$scratch"
ln -s "$PWD/node_modules" "$scratch/node_modules"
node --import tsx test/fixtures/unset-parity-worker.mjs "$scratch" \
  > "$scratch/unset-parity.json"
# Publish only a completed, valid capture, never a failed or truncated one.
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' \
  "$scratch/unset-parity.json"
if ! cmp -s "$scratch/unset-parity.json" test/fixtures/unset-parity.json; then
  cp "$scratch/unset-parity.json" test/fixtures/unset-parity.json
fi
```

Do not regenerate against current source to make a compatibility failure pass.
After #66 merges, recapture from a PR's own head only when that PR intentionally
changes unset-mode behavior, and document the recapture in its description.
The sibling opt-in tests separately assert the admission-qualified guidance and
safe registration timers; default parity must not disable those behaviors.
