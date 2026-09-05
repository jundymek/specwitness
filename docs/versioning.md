# Versioning and release plan

What SpecWitness's version number means, and how releases reach npm.

> **Nothing has been published yet.** `specwitness` is not on the npm registry. This
> document is the plan the first publish will follow, written before it happens so that
> the first release is a decision rather than an improvisation. Publishing is an
> owner-only action.

## Current state

| | |
| --- | --- |
| **Version** | `0.1.0` |
| **Published** | no — the name is unclaimed on npm |
| **Package contents** | `dist/cli.js`, `dist/cli.js.map`, `package.json`, `README.md`, `templates/config.yaml`, `templates/.gitkeep` — **6 files, ~855 kB packed, 2.9 MB unpacked** |
| **Node floor** | `>=22.13` (ADR-007) |

Verified with `npm publish --dry-run`, which is run on every CI build by
`scripts/pack-smoke.sh` alongside a real pack-install-and-run of the tarball.

`README.md` is in that list even though `files` names only `dist` and `templates`: npm
always includes the readme, the licence, the changelog and `package.json` regardless of
the allow-list. That is npm's rule rather than a setting of ours, and it is why the
packaging check allows those four by name.

The **file count** is the number worth checking; the packed size is approximate on purpose,
because it moves by a kilobyte every time this repository's README is edited. If the count
changes, something changed about what ships — run `./scripts/pack-smoke.sh`, which asserts
it rather than reporting it.

---

## Semver, and what "pre-1.0" means here

SpecWitness follows [semantic versioning](https://semver.org/). While the major version is
`0`, semver's own rule applies: **anything may change in a minor release**. That is honest
about where the product is, but it is not much use to a harness that has to keep working,
so the project adds two commitments on top.

### The two things a harness may rely on before 1.0

A harness integrating SpecWitness branches on two surfaces, and both are treated as
contracts from `0.1.0` onward rather than from `1.0.0`:

1. **The exit-code table.** `0` PASS · `1` FAIL · `2` NEEDS_HUMAN · `3` infra · `64` usage.
   These are frozen. A change to what any of these five codes means is a **major** version
   bump, at `0.x` as much as after `1.0` — which in practice means it will not happen,
   because `1.0` would come first.
2. **The run-document schema.** `result.json` and `--json` carry a `schemaVersion`, and it
   evolves **additively**: new optional keys may appear in a minor release; an existing key
   never changes meaning or type, and none is removed. A breaking shape change bumps
   `schemaVersion`, and the old shape stays readable.

Everything else — human-readable terminal output, the wording of `ERROR:`/`HINT:` lines,
internal module layout, which stage does what — may change in a minor release without
notice. **Do not parse the human output.** That is what `--json` is for.

### What bumps what

| Change | Bump |
| --- | --- |
| A new command, or a new optional flag | **minor** (`0.2.0`) |
| A new optional key in the run document | **minor**, `schemaVersion` unchanged |
| A bug fix, a corrected message, a doc change | **patch** (`0.1.1`) |
| Raising the Node floor | **minor** while `0.x`; **major** after `1.0` |
| Removing or renaming a flag; changing a default | **minor** while `0.x` — and it goes in the release notes as a breaking change regardless |
| Changing what an exit code means | **major** |
| A breaking change to the run-document shape | **major**, and `schemaVersion` is bumped |

**Because a `0.x` minor may legitimately break things, the release notes carry an explicit
`BREAKING:` section whenever one does.** A harness pinning `specwitness` should pin an
exact version or a tilde range (`~0.1.0`), never a caret range, until `1.0`.

---

## Dist-tags

npm serves `npm install specwitness` from whatever the `latest` tag points at. SpecWitness
uses two tags.

| Tag | What it points at | Who should use it |
| --- | --- | --- |
| **`latest`** | The newest release considered fit for someone else's project. | Everyone, by default. |
| **`next`** | A pre-release being validated — typically by dogfooding it on a real epic. | The author, and anyone deliberately testing an unreleased build. |

### The rule

> **A version reaches `latest` only after it has gated a real epic.**

That is the whole point of the `next` tag for this product. SpecWitness's own claim is that
it catches defects other gates miss; a build that has never run against a real epic has not
demonstrated that, and publishing it as `latest` would ask users to trust an untested
claim.

So the sequence for any release with meaningful change is:

```bash
# 1. Publish the candidate under `next` only. `latest` does not move.
npm publish --tag next

# 2. Install it deliberately and use it to gate a real epic.
npm install -D specwitness@next

# 3. Only once that has happened, promote the exact version.
npm dist-tag add specwitness@0.2.0 latest
```

**Promotion moves a tag; it never republishes.** The bytes that were validated under `next`
are the bytes that become `latest` — republishing would make the promoted artifact a
different one from the tested artifact.

### Pre-release version strings

A candidate published under `next` carries a semver prerelease identifier:

```
0.2.0-next.1
```

npm treats a prerelease as older than its release, so `0.2.0-next.1` will never be
installed by someone asking for `^0.1.0` or `latest`. That is the safety property, and it
is why the identifier is part of the version rather than only part of the tag.

`tests/unit/packaging.test.ts` asserts the version is one of the **two** shapes this plan
describes — `MAJOR.MINOR.PATCH`, or that followed by `-next.<n>` — and nothing else. So a
release branch carrying `0.2.0-next.1` passes the test suite (step 1 of the checklist
below requires it to), while a version with build metadata or some other prerelease tag,
which no rule here says how to publish, fails.

### The first publish

`0.1.0` is the first, and it is a special case: it goes to **`next` only**, and `latest`
is not set at all until the tool has gated a real epic (Epic 7's dogfooding run). A package
with no `latest` tag makes `npm install specwitness` fail loudly rather than hand someone
an unvalidated build — which is the correct answer at that moment.

---

## What reaching 1.0 would require

Recorded so the number means something when it arrives, rather than being chosen by mood:

- The tool has gated **real** epics, and the dogfooding report answers the product
  hypothesis with evidence.
- The exit codes and the run-document schema have been consumed by a harness in anger and
  have not needed to change.
- No known defect can cause an infra failure to be reported as a product FAIL.
- The corpus proves the four-way outcome separation with zero misclassifications.
- Windows is either supported or explicitly declared out of scope for 1.x.

---

## Release checklist

For whoever performs a release. **None of this is automated, deliberately** — publishing is
an owner action.

1. `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && pnpm build`
   — all green.
2. `./scripts/pack-smoke.sh` — packs, installs the tarball into a clean directory, runs the
   binary, asserts the tarball contains `dist/` and `templates/` only, and runs
   `npm publish --dry-run`.
3. Confirm CI is green on **both** `ubuntu-latest` and `macos-latest`.
4. Bump the version; write release notes, with a `BREAKING:` section if anything broke.
5. Tag the commit.
6. `npm publish --tag next`.
7. Install from `next` and gate a real epic with it.
8. Only then: `npm dist-tag add specwitness@<version> latest`.

**Step 7 is not a formality and is not skippable.** It is the step that makes the version
number mean something.
