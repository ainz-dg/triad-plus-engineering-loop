# GitHub Release to npm publishing

The release workflow publishes an already verified package only after a stable
GitHub Release has been published. It never creates a tag or Release, and a
failed or partially completed publication requires inspection rather than a
blind rerun.

## One-time npm Trusted Publisher setup

In npmjs.com settings for the existing `triad-plus` package, configure a
GitHub Actions Trusted Publisher with these exact, case-sensitive values:

- GitHub user/organization: `ainz-dg`
- Repository: `triad-plus-engineering-loop`
- Workflow filename: `release.yml` (filename only, not the
  `.github/workflows/` path)
- Environment: leave empty; the workflow does not use a GitHub Environment

The workflow uses Node 24 and pins npm to 11.5.1, which meets the npm Trusted
Publishing minimum. The `publish-npm` job alone receives `id-token: write`; the separate
Release-assets job alone receives `contents: write`. No npm token secret,
`NODE_AUTH_TOKEN`, or static-token fallback is used. Do not work around an OIDC
failure by adding a token.

npm requires a new Trusted Publisher configuration to complete its first
successful publish within two days. Configure it only when the owner is ready
to perform the first real release. The repository cannot inspect or prove the
account-side setting; it is verified only by a successful OIDC publication.

## Owner-controlled release procedure

1. Merge the reviewed release-preparation change only after an explicit owner
   GO and green checks on the exact merge commit.
2. Confirm `package.json` has the intended stable release version. The package
   version must equal the version in a canonical `vMAJOR.MINOR.PATCH` tag.
3. Create and publish the stable GitHub Release from the GitHub UI, targeting
   the current `main` commit. The Release must be authored by `ainz-dg`, be
   neither draft nor prerelease, and its tag must resolve to the current
   `main` SHA. The workflow rejects ambiguous branch targets and moved tags.
4. Publishing the Release starts `.github/workflows/release.yml`. For a
   `release` event GitHub sets `GITHUB_REF` to `refs/tags/<tag>` and
   `GITHUB_SHA` to the last commit in that tagged release. The workflow checks
   both values, checks out that immutable SHA, resolves the remote tag and
   current `main`, and verifies the Release metadata again before npm writes.
   GitHub's `published` activity can include prereleases, so the workflow
   explicitly rejects those before publication.
5. Wait for all jobs to finish. The gate rebuilds and tests, runs the package
   checks and `prepublishOnly`, then creates one verified tarball and SHA-256
   sidecar. The `publish-npm` job ends after publishing that exact artifact
   with provenance; it does not repack. A separate `verify-npm` job checks
   registry propagation and the exact integrity/shasum. Only after that job
   succeeds may asset upload and final published checks proceed.
   The existing Release receives only the matching `.tgz` and
   `.tgz.sha256` assets, and the final job verifies their API digests and
   downloaded bytes plus a registry install smoke test.

`workflow_dispatch` is a side-effect-free gate/build run on the exact current
`main` SHA. It has no publish mode and does not upload an artifact, publish to
npm, or modify a Release or tag. It rejects versions, tags, or Releases that
already exist. It cannot prove that npm OIDC is configured or simulate an OIDC
exchange. Do not use the previously recovered `v1.22.1` as a trigger test.

## Fail-closed behavior and recovery

- Only `release` with action `published` or the read-only dispatch path is
  accepted. Stable tag syntax, actor, package name/version, release metadata,
  tag SHA, target commit, checked-out commit, and current `main` must agree.
- An existing npm version, tag, or Release is a conflict. A tag is never moved;
  an immutable npm version is never replaced. Registry errors other than a
  confirmed E404 fail closed.
- npm propagation uses a ten-minute time budget, checking every 15 seconds
  only while the exact version is temporarily absent (confirmed E404/No match).
  Probe latency consumes the budget; npm internal fetch retries are disabled
  and each request has at most 30 seconds or the remaining budget.
  `REGISTRY_BUDGET_MS` (1..600000) and `REGISTRY_DELAY_MS` (1..budget) allow
  shorter controlled checks in `verify-registry`. A visible version with the
  wrong `dist.integrity` or
  `dist.shasum`, or any non-404 registry error, stops immediately. A timeout
  reports `WAITING/NOT YET VISIBLE` and fails; it never falls back to publish.
  `npm view --prefer-online` forces cache freshness checks
  ([npm config](https://docs.npmjs.com/cli/v11/using-npm/config/#prefer-online)).
  No evidence requires a costly cache purge, so recovery does not clear it.
- The GitHub Release is already public before npm publication begins. This is
  deliberately non-atomic: if npm rejects OIDC or a later job fails, the
  public Release remains. The workflow does not create a second Release or tag.
- Existing Release assets are never overwritten. Missing expected assets may
  be uploaded only after npm succeeds; unexpected assets or digest conflicts
  stop the job. If npm accepted the package but a later step failed, do not
  rerun publication. Use the standalone verification procedure below. Stop for
  owner review on any mismatch; never republish or move a tag.
- A Release created by a workflow using `GITHUB_TOKEN` generally will not
  trigger another workflow. Publish the owner-approved Release through the
  GitHub UI so this workflow receives the normal `published` event.

## Verification-only recovery after npm accepted a version

**Rerunning all, failed, or individual jobs in `release.yml` is forbidden for
recovery after npm accepted a version.** This includes `verify-npm` and
`gh run rerun --job`: dependency/rerun behavior is not a recovery contract.
Use only `.github/workflows/release-recovery.yml`, after its reviewed code has
landed on `main`. It has `contents: read` and `actions: read`, no OIDC grant,
no npm credentials, no package writes, and no dependency on a publisher.
It never rebuilds, repacks, installs, uploads, or overwrites anything remotely.

For the historical propagation failure, the exact approved inputs are:

```sh
gh workflow run release-recovery.yml \
  --repo ainz-dg/triad-plus-engineering-loop --ref main \
  -f release_tag=v1.22.3 \
  -f expected_commit=7327d8df957931e07d6ba76305f2f27e4dffe76c \
  -f original_run_id=42388541647
```

Only `ainz-dg` may dispatch from canonical `main`. Supply a stable tag, full
lowercase release SHA and original run ID; hashes are never caller inputs.
The recovery script executes from the dispatch SHA, checks the historical
commit is in `origin/main`, and never executes historical source or package
code. Unlike publication, recovery allows `main` to have advanced.

Identity is bound to GitHub's authenticated read APIs: the original completed
`release.yml` release run, repository, owner, tag, SHA and first attempt must
agree. The original gate and publish preflight must have succeeded, as must
the exact `npm publish` step (even when its containing historical job failed).
The current stable Release must be owner-authored, target `main` or the exact
SHA, and have been published no later than the original run; the remote tag
must still resolve to that SHA. This rejects a later replacement Release.

The original gate logs must identify the exact immutable artifact ID and ZIP
SHA-256. The artifact API must bind it to the source run/repository/SHA/tag;
its downloaded ZIP is hashed locally and must match both the API and those
logs. Only the original archive and SHA-256 sidecar are accepted. The gate's
archive digest and the successful publisher's logged expected SHA-256,
sidecar SHA-256, SHA-512 integrity and SHA-1 shasum must all match the actual
bytes. The archive's package identity is read without installing it.
Existing Release assets must match API digests **and** downloaded bytes.
Registry `version`, `dist.integrity` and `dist.shasum` are compared with the
original archive, never regenerated bytes or caller assertions.

This is checksummed evidence, not a newly signed release or a replacement for
npm provenance. Its trust boundary includes GitHub's API/log/artifact storage,
reviewed code on `main`, and the authorized repository owner. Artifact digest
metadata is documented by [GitHub's artifact API](https://docs.github.com/en/rest/actions/artifacts).
Missing/expired artifacts, deleted logs, missing hashes, conflicting evidence,
a rerun source (`run_attempt != 1`), incomplete API results, or any unexpected
npm error are `BLOCKED/MISMATCH`; there is no fallback to Release downloads,
registry tarballs, rebuilding, or publishing. Formats changed by upstream
GitHub/npm may also require a separately reviewed verifier update.

Results appear in logs and the Actions summary:

- `VERIFIED`: registry identity matches the original exact archive. The report
  also lists missing Release assets; verified npm does not imply assets exist.
- `WAITING/NOT YET VISIBLE`: only temporary E404/No match; bounded expiry fails
  the recovery run. A later invocation of **this workflow** is safe.
- `BLOCKED/MISMATCH`: stop for owner inspection; no further recovery writes.

The historical v1.22.3 run remains **failed**. A successful new verification
neither changes that conclusion nor modifies the old run, tag, Release,
artifact, or npm version. Repeating verification cannot publish a second copy.

## Separately authorized manual asset recovery

Missing assets require separate owner authorization. After a successful
verification, an authorized maintainer may download the **same original run
artifact ID**, validate its ZIP and all byte hashes against the original logs,
and upload only the names reported missing. For example, after inspecting
those original bytes (not after repacking):

```sh
# Run only with separate owner authorization, from the verified artifact directory.
# Omit either path if that asset already exists. Never add --clobber.
gh release upload v1.22.3 \
  ./triad-plus-1.22.3.tgz ./triad-plus-1.22.3.tgz.sha256 \
  --repo ainz-dg/triad-plus-engineering-loop
```

Recheck Release ID, tag SHA and existing asset digests immediately before the
upload. Stop on any conflict; do not replace assets. Download and hash the
resulting assets, then repeat the standalone verification. This manual path
is outside the read-only workflow and does not make the historical run green.

## Scope

This workflow is not a general CI trigger: it has no push, pull-request, or
schedule publishing path, no auto-merge, and no tag or Release creation. It
does not change Triad+ runtime behavior. A published Release is the explicit
owner-controlled authorization point; the final npm write remains guarded by
the exact verified artifact and npm OIDC.
