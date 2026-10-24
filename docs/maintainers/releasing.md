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
Publishing minimum. The npm job alone receives `id-token: write`; the separate
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
   sidecar. The npm job publishes that exact artifact with provenance; it does
   not repack. The existing Release receives only the matching `.tgz` and
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
- npm propagation is checked with bounded retries only while the exact version
  is temporarily absent. A visible version with the wrong `dist.integrity` or
  `dist.shasum`, or any non-404 registry error, stops immediately. A timeout
  instructs the owner to recover manually and not republish.
- The GitHub Release is already public before npm publication begins. This is
  deliberately non-atomic: if npm rejects OIDC or a later job fails, the
  public Release remains. The workflow does not create a second Release or tag.
- Existing Release assets are never overwritten. Missing expected assets may
  be uploaded only after npm succeeds; unexpected assets or digest conflicts
  stop the job. If npm accepted the package but a later step failed, do not
  rerun publication. Compare the original archive's integrity and shasum with
  `npm view`, inspect the existing tag and Release, and recover only missing
  verified assets from that run's artifact. Stop for owner review on any
  mismatch; never republish or move a tag.
- A Release created by a workflow using `GITHUB_TOKEN` generally will not
  trigger another workflow. Publish the owner-approved Release through the
  GitHub UI so this workflow receives the normal `published` event.

## Scope

This workflow is not a general CI trigger: it has no push, pull-request, or
schedule publishing path, no auto-merge, and no tag or Release creation. It
does not change Triad+ runtime behavior. A published Release is the explicit
owner-controlled authorization point; the final npm write remains guarded by
the exact verified artifact and npm OIDC.
