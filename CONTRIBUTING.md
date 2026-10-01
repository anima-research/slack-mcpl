# Contributing to slack-mcpl

slack-mcpl is part of the Connectome ecosystem
([mcpl-core-ts](https://github.com/anima-research/mcpl-core-ts),
[discord-mcpl](https://github.com/anima-research/discord-mcpl),
[zulip_mcp](https://github.com/antra-tess/zulip_mcp),
[agent-framework](https://github.com/anima-research/agent-framework),
[connectome-host](https://github.com/anima-research/connectome-host)). These
conventions are the ones the ecosystem's core repos already follow. When in
doubt, recent merged PRs are the best reference.

Everything below applies to every change however it lands — external PR or
maintainer direct push — and to human and AI authors identically. There is
no separate rulebook for either.

## How changes land

- External contributions come as PRs against `main`, from a fork or a repo
  branch. Maintainers also land small changes directly on `main`; don't be
  surprised by history that never saw a PR.
- Branch names: `feat/<kebab-case>`, `fix/<kebab-case>`, `docs/`, `chore/`.
  Including the issue number is welcome (`fix/12-thread-replies`).
- PRs are merged as **true merge commits** — no squash, no rebase-merge.
  Because nothing is squashed, keep individual commits coherent.
- To update a stale branch, rebase onto `main` or merge `main` in; both are
  accepted.
- Stacked PRs and cross-repo companion PRs are fine, but **declare them** in
  the body with merge-order guidance ("stacked on #1 — review that first";
  "safe to merge in either order because …"). This server sits on
  mcpl-core-ts and is driven by MCPL hosts (connectome-host over
  agent-framework), so protocol changes often come in pairs; say which side
  is safe to land first and what happens if only one does.

## What a PR should contain

Body shape (the PR template mirrors this): **Problem / Changes / Tests**,
plus, when applicable, **Not verified**, **Out of scope**, and
**Companion PRs**. The conventions that matter:

- **Evidence over assertion.** State the test baseline numerically:
  "`npm test`: N pass / M fail, failure count identical to `main` baseline."
  A claim like "all tests pass" without the count will be re-verified anyway,
  so save the reviewer the trip.
- **Say what you did NOT verify.** An honest "not exercised against a live
  Slack workspace" is respected; a silent gap that review uncovers is not.
- **Tests accompany behavior changes.** Review scrutinizes test substance,
  not mere presence — a test that can't fail on the unfixed code will be
  called out.
- **Changelog fragment** in `changelog.d/` for anything behavior-affecting
  (see below).

Conventional-commit-style titles (`feat: …`, `fix(history): …`) are the house
default; plain descriptive titles are accepted.

## Review process — what to expect

- Review arrives as **ordinary PR comments**, not GitHub review approvals —
  the comment thread is the gate. Reviews are frequently AI-generated and
  explicitly labeled as such, with a severity verdict and itemized findings.
- The reviewer will typically **run your branch** (typecheck, test suite,
  sometimes a live workspace) and paste transcripts. Claims are checked, not
  trusted.
- Respond by pushing fix commits and replying per finding — "Addressed in
  `<sha>`" — rather than force-pushing a rewritten branch. A re-review then
  flips the verdict.
- Maintainers may push small review fixes **directly to your branch** to keep
  things moving. Say so in the PR body if you'd rather they didn't.
- PRs are never closed silently: a closed PR gets a one-line disposition
  comment (usually supersession by another PR).

## AI-assisted contributions

AI-written code is the norm in this ecosystem, welcome from everyone, and
held to exactly the same evidence standards as anything else. Declare it the
way we do:

- the `🤖 Generated with [Claude Code](https://claude.com/claude-code)`
  footer (or equivalent for your tooling) in the PR body, and
- a `Co-Authored-By:` trailer naming the model in commits.

What earns an automated contribution a changes-requested review is not being
AI-generated — it's arriving without the suite having been run, with tests
that don't fail on unfixed code, or with claims the branch itself disproves.

## Changelog

Changelog entries land as **fragment files** in
[`changelog.d/`](changelog.d/) — one file per change — and are folded into
`CHANGELOG.md` (loosely [Keep a Changelog](https://keepachangelog.com/)) at
release time. One file per change is what keeps concurrent work from
conflicting: when every PR edits the same `## Unreleased` section, any PR
that outlives another merge hits a conflict in `CHANGELOG.md`; distinct
files never do.

- **Format:** `changelog.d/<slug>.<breaking|added|changed|fixed>.md`, a flat
  file directly in `changelog.d/`, containing one or more markdown bullets
  (`- …`) written exactly as they should appear in `CHANGELOG.md`:
  continuation lines indent two spaces, nested bullets are fine, headings
  and horizontal rules are refused (even indented — a heading inside a
  fragment would corrupt the section structure). The slug just has to be
  unique among pending fragments and filesystem-safe — the PR number works,
  and so does the branch name with `/` replaced by `-`
  (`3-operator-controls.added.md`, `fix-thread-replies.fixed.md`). The
  release script scans the directory fail-closed: a subdirectory, an
  unrecognized category suffix, or any other stray file aborts the release
  rather than silently stranding an entry.
- **The fragment lands with the change** — same commit, or at least the same
  PR. This binds direct pushes to `main` just as much as PRs. On PRs, CI
  enforces it softly: touching `src/` without adding a fragment (or editing
  `CHANGELOG.md`) fails the `changelog` check unless the `no-changelog`
  label is applied.
- **What needs an entry:** anything an operator, a host, or an agent on the
  other end would notice — tools and their schemas or output, environment
  variables, the shape of incoming messages, channel registration and IDs,
  feature sets and grant handling, defaults, required Slack scopes. Internal
  refactors, test-only, and docs-only changes don't.
- **Breaking entries are audience-scoped.** Open the bullet by naming who
  needs to act (`- **Operators:** …`, `- **Hosts:** …`) and cover: **who
  needs to act**, **migration**, and **unchanged** (what readers might fear
  broke but didn't). When a change needs a newer host or mcpl-core, spell
  out the minimum versions.
- **Editing `## Unreleased` in `CHANGELOG.md` directly still works** and is
  merged with the fragments at release time — it remains the right place to
  restructure pending entries, and the escape hatch for anything the
  fragment format can't express (e.g. an audience-qualified
  `### Breaking (hosts only)` heading, which `breaking` fragments will then
  join). Keep one `## Unreleased` heading — the release script refuses more
  than one, since only the first is ever cut.
- **Releases** (maintainers): `npm version <patch|minor|major>` does the
  whole cut — the `version` hook folds the pending fragments plus any
  entries filed directly under `Unreleased` into `## X.Y.Z — YYYY-MM-DD`
  (subsections emitted in `### Breaking` / `### Added` / `### Changed` /
  `### Fixed` order), deletes the consumed fragments, keeps a fresh empty
  `Unreleased` above, and refuses to release when there is nothing to
  release; npm then commits and tags. `git push --follow-tags` triggers CI,
  which builds and tests the tag, refuses a tag with no matching changelog
  section, and creates the GitHub release with that section as its notes.
  The package is not published to npm, so the tag and its GitHub release
  are the release. Version bumps are a maintainer release-time action, not
  part of feature PRs.

## Building and testing

```bash
npm ci                # strict: installs package-lock.json verbatim
npm run typecheck     # tsc --noEmit
npm test              # node --test via tsx, straight from the sources
npm run build         # tsc into dist/, which is what the bin runs
```

Push-time CI (`ci.yml`) typechecks, builds and tests every push and PR on
ubuntu and macos, on Node 20 (the `engines` floor) and 24. It installs with
`npm ci`, so a `package-lock.json` that is out of sync with `package.json`,
or that only carries one platform's native packages, fails the build.
Regenerate the lock from a clean tree (`rm -rf node_modules
package-lock.json && npm install`), not over an existing `node_modules`.
