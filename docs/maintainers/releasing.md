# GitHub Actions release guide

This guide describes the owner-controlled release path for Triad+. A release
workflow run does not replace review or owner approval.

## Prerequisites

1. Merge the release-preparation PR only after independent review and an
   explicit owner GO. Confirm CI is green on the exact merge commit.
2. In npmjs.com settings for the existing triad-plus package, add a GitHub
   Actions Trusted Publisher with these exact, case-sensitive values:
   - user: ainz-dg
   - repository: triad-plus-engineering-loop
   - workflow filename: release.yml (filename only, not the .github/workflows/
     path)
   - environment name: leave empty; this workflow does not use a GitHub
     Environment
3. In the Trusted Publisher's allowed actions, enable direct npm publish.
   Allowing only npm stage publish is not sufficient for this workflow.
4. Verify the npm owner account's 2FA and package publishing settings. Do not
   create an npm token or add NPM_TOKEN/NODE_AUTH_TOKEN secrets.

The release workflow uses `actions/setup-node@v7`. Its official migration
notes remove the dummy `NODE_AUTH_TOKEN` fallback; npm Trusted Publishing uses
OIDC and does not require that environment variable. Do not add a fake or
static token to work around authentication errors.

npm requires a new Trusted Publisher configuration to complete its first
successful publish within two days. Configure it only when the owner is ready
to perform the first real release; do not configure it weeks in advance. This
repository cannot inspect or prove the account-side Trusted Publisher setting
from a pull request. The workflow's confirmation input is an operator
attestation, not evidence that npm has accepted OIDC.

## Run a dry-run

After the workflow is present on the default branch:

1. Open **Actions → Release v1.22.1 → Run workflow** and select main.
2. Set version to 1.22.1, copy the exact full SHA shown for main into
   **Expected main commit**, and leave mode at dry-run.
3. Leave **Trusted Publisher configured** unchecked. Inspect the run's gate
   results, package SHA-256, npm integrity/shasum, and isolated package smoke.

The dry-run reads npm/GitHub state and builds/tests an ephemeral runner package.
It does not publish to npm, upload a release artifact, create a Git tag, or
create a GitHub Release. It cannot prove that npm OIDC is configured or
simulate a successful OIDC exchange.

## Publish after approval

Only after independent Albedo review of the exact PR and a new explicit owner
GO:

1. Confirm the merged release-preparation commit is still the exact main
   head and has green CI.
2. If this is the first Trusted Publisher use, configure it in npm immediately
   before proceeding so the two-day validation window is available.
3. Run the workflow on main with version 1.22.1 and that exact full commit
   SHA as the GitHub account ainz-dg. Select publish and check
   **Trusted Publisher configured** only after verifying the settings above.
   The workflow rejects publish dispatches by other GitHub actors; selecting
   publish as ainz-dg is the explicit owner GO.
4. Let the workflow publish the already-verified archive to npm first. Only
   after npm accepts it does a separate job create tag v1.22.1 and the
   GitHub Release. The release has exactly two assets:
   triad-plus-1.22.1.tgz and triad-plus-1.22.1.tgz.sha256.
5. Confirm the final job reports each outcome separately: npm version and
   integrity, Git tag commit, GitHub Release assets/digests, and package smoke
   installed from the npm registry.

The workflow rejects an existing npm version, tag, or GitHub Release. It never
moves a tag or replaces an immutable version.

## Failure and recovery

- A failed gate prevents the npm-publish job from starting. Fix the cause in a
  reviewed change, then repeat a dry-run.
- A missing or mismatched Trusted Publisher causes npm OIDC authentication to
  fail. There is no static-token fallback; do not work around this with an npm
  token.
- npm versions are immutable. If npm accepted the package but a later step
  failed, do **not** rerun the publish path. The version guard will stop a
  retry. Inspect npm view for triad-plus@1.22.1, including version,
  dist.integrity and dist.shasum, compare it to the original successful run's
  recorded archive metadata, and recover only the missing Git tag/Release
  manually from that run's verified artifact and exact commit. If the
  published digest does not match, or an existing tag points elsewhere, stop
  for owner review; never republish or move the tag.
- If tag or Release creation partially succeeds, stop and inspect the tag SHA,
  release assets, and their digests before doing anything else. Do not rerun
  publication or overwrite assets.

## Scope

This release workflow is manual and standalone. It has no tag/push/schedule
trigger, auto-merge, publish-on-merge, reusable workflow caller, or code path
that changes the product runtime. Dry-run is the default. The npm Trusted
Publisher is configured manually on npmjs.com and is not claimed as verified
until the first real OIDC publication succeeds.
