# Native Nix CI

Everything specific to CI lives in `.ngit/nix/workflows/`: YAML workflows,
`default.nix` commands, pinned tools in `tools.nix`, and helper scripts. The
root flake imports that directory and exports `ngit-ci.commands.<system>`.
GitHub mirror workflows are independent.

## Read the workflow, find the command

Commands follow **workflow → job → step**. For example, `ci.yaml`'s `test`
job lists `format`, which resolves to `ci.test.format`. Its `install` step
uses the shared top-level command. A single-command job such as
`production.nsite` needs no `run:` field. The Android rehearsal borrows
release steps explicitly, for example `run: android-release.android-unsigned.compile`.
Run individual commands locally with, for example,
`nix run .#ngit-ci.commands.x86_64-linux.ci.test.format`.

`ci.yaml` owns the checks. The test job starts with a pure `dependencies`
build that publishes the pnpm dependency store. Android lint can start as soon
as that step's publication attempt finishes, through
`needs: [test#dependencies]`. Meanwhile, the test job builds and caches its
GRASP `e2e-server`, then validates the npm lockfile, installs dependencies and
builds the website. The build step snapshots `web-dist`; its upload overlaps
formatting, TypeScript, ESLint, unit tests, GRASP integration tests and publication
guards. The Android job runs lint and synthetic signing checks. Each operation
is a native step with its own status; no shell script reports hidden steps. Steps share the checkout and writable
job state, while each command establishes its own process environment.

## Cache dependencies, check the current source

The `ci-dependencies` Nix package caches the pnpm store using only
`package.json`, `pnpm-lock.yaml`, and `patches/`. Its fixed hash verifies the
downloaded dependency contents, including the prepared JavaScript for the
pinned Git signer plugin. Source-only changes reuse that package from
the provider's Nix cache when populated. Each job restores it and runs
`pnpm install --offline --frozen-lockfile`; a missing dependency fails instead
of silently accessing the registry. Checks and application builds still run
against the allocated checkout.

On a confirmed-maintainer push, these successful build steps can populate the
provider's trusted cache before tests finish. Each cache-producing build belongs
to the job that uses it; there is no separate tooling job or aggregate build of
every workflow command. Android waits only for the shared npm dependencies,
not the GRASP server or unrelated publisher tooling. Each job realizes its own
command closures.

Ordinary PR jobs read the trusted cache and, when enabled by the provider, an
isolated cache for the same PR revision. PR data normally expires after one hour
and may be evicted sooner under pressure. Publication is best effort: a cache
miss rebuilds, and a later test failure does not invalidate completed pure
builds. Artifact publication is required for consumers: preview waits for the
website build and its upload; production and release wait for all CI checks.

A cold run can spend most of its time in the leading dependency and GRASP
server builds. Offline npm installation does not mean those Nix outputs were
already cached. Use the step timings and provider cache-publication messages
to distinguish compilation from installation or checks. Low disk headroom may
skip cache publication even when the build succeeds; artifact-upload failure
instead fails the producer and skips consumers of that artifact.

After changing dependencies, set the hash in `tools.nix` to
`pkgs.lib.fakeHash`, run `nix build .#ci-dependencies`, and replace it with the
reported hash. Keep both npm and pnpm lockfiles current as described in
`AGENTS.md`.

Pinned Node, pnpm, Java, Gradle, Android SDK, ngit and publisher tools also
come from Nix closures. Gradle dependencies still resolve at runtime: Android
builds are not hermetic until their transitive dependencies are locked and
verified. JVM, Gradle and Android homes and temporary files use writable job
scratch, including Java's explicit home/tmp overrides.

## Check once, publish the resulting artifacts

Production, release and rehearsal declare `needs-workflows: {ci: ci.yaml}`
to wait for all CI checks. Preview uses a narrower dependency:

```yaml
needs-workflows:
  ci: { file: ci.yaml, wait: referenced }
jobs:
  preview:
    needs: [ci.test#build]
    public-outputs:
      nsite_preview: nsite-preview.txt
```

The `build` step declares `web-dist` under its own `artifacts` mapping.
Preview starts once that step succeeds and its artifact upload completes,
while the test job continues. Its `copy_site` helper reads
`$NGIT_CI_INPUTS/ci.test/artifacts/web-dist`; `#build` selects the producing
step without changing the input directory. Production receives the same
immutable artifact through `needs: [ci.test]`, after all checks pass.
An upload failure prevents preview; a later test failure fails CI but does
not retract an already published preview. Successful CI can be reused at the
same peeled commit.

| Workflow                 | Trigger              | Result                                  |
| ------------------------ | -------------------- | --------------------------------------- |
| `ci.yaml`                | Push or pull request | Checks and web artifacts                |
| `preview.yaml`           | Pull request         | Disposable nsite preview                |
| `production.yaml`        | Push to `main`       | Netlify and production nsite            |
| `android-release.yaml`   | Tag `v*`             | Unsigned build, signing, NIP-82 release |
| `android-rehearsal.yaml` | Manual               | Build and sign without publishing       |

The test job produces the ordinary website. Android lint builds the versioned
website and emits a separate artifact; Android compilation consumes those
exact files before building the APK/AAB. Site publishers consume the ordinary
website without rebuilding it. Directory artifacts use archive transport;
provider artifact limits must accommodate the site and APK/AAB files.

Publishing workflows use `reuse: never`, so rollback pushes publish again.
Production destinations have separate concurrency groups with
`cancel-in-progress: false`. Production and release publishers allow ten
minutes after cancellation: before publication they can stop, but once the
publisher starts their TERM handler waits for it to finish. Force or the
grace deadline can still kill the job; ordinary steps need not wait that long.

## Secrets and publication guards

Grant credentials only to the jobs that use them:

- Netlify: `NETLIFY_AUTH_TOKEN`, `NETLIFY_SITE_ID`.
- Production nsite and release: `NGIT_PUBLISHER_NBUNKSEC`.
- Android signing: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`,
  `ANDROID_KEY_ALIAS`.

Commands read secret files only at execution time, after Nix realization.
Compilation gets no keystore. Signing aligns the APK, signs APK/AAB, verifies
both, and removes its private temporary keystore on exit. Passwords and aliases
never appear in process arguments. The AAB remains a CI artifact; the exact
signed APK is published using `.ngit/release.yaml` and its Zapstore settings.

Production commands require a signed push to `main`. Release requires a tag
matching `version.properties`, fetches that tag with a bounded timeout, and
checks its peeled commit against the allocation. Manual release replay skips
publication; use the rehearsal workflow to avoid requesting publisher secrets.
PR previews use a disposable identity and no repository secrets, then verify
gateway availability before reporting the signed preview URL.

## Local validation

Build an individual command without executing it, for example
`nix build .#ngit-ci.commands.x86_64-linux.production.netlify`.
Use `nix build .#ci-dependencies .#e2e-server` for the test job's pure
build steps. Do not run publishing or signing commands merely to validate
their definitions.
`bash .ngit/nix/workflows/test-policy.sh` exercises publication guards with
stub tools. `nix develop --command bash .ngit/nix/workflows/test-signing.sh`
checks real APK/AAB signing using synthetic credentials. The pre-commit hook
validates the application; CI runs both script checks as explicit steps.
Android execution additionally needs Maven access.

Netlify's upstream lock omits some registry metadata. The pinned
`netlify-lock-metadata.json` and `repair-netlify-lock.cjs` restore missing fields
without changing versions. Update the metadata and dependency hash together
when updating Netlify. This uses the existing Node toolchain, not Python.
