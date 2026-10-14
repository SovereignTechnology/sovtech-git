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

`ci.yaml` owns the checks: npm fallback-lockfile validation, formatting,
TypeScript, ESLint, unit tests, web compilation, mandatory GRASP integration
tests, publication guards, Android lint and synthetic signing. Each operation is a native step with its own status;
no shell script reports hidden steps. Steps share the checkout and writable
job state, while each command establishes its own process environment.

## Cache dependencies, check the current source

The `ci-dependencies` Nix package caches the pnpm store using only
`package.json`, `pnpm-lock.yaml`, and `patches/`. Its fixed hash verifies the
downloaded dependency contents, including the prepared JavaScript for the
pinned Git signer plugin. Source-only changes reuse that package from
the provider's Nix cache. Each job restores it and runs
`pnpm install --offline --frozen-lockfile`; a missing dependency fails instead
of silently accessing the registry. Checks and application builds still run
against the allocated checkout.

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

Preview, production, release and rehearsal workflows declare
`needs-workflows: {ci: ci.yaml}`. Successful CI can be reused at the same
peeled commit; failed prerequisites prevent publication. Publisher jobs use
`needs` to receive the exact prerequisite artifacts.

| Workflow                 | Trigger              | Result after CI passes                  |
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

`nix build .#ci-entrypoints` realizes all command closures, including publisher
tools, without executing them; PRs also run this check. Do not run publishing
or signing commands merely to validate their definitions.
`bash .ngit/nix/workflows/test-policy.sh` exercises publication guards with
stub tools. `nix develop --command bash .ngit/nix/workflows/test-signing.sh`
checks real APK/AAB signing using synthetic credentials. The pre-commit hook
validates the application; CI runs both script checks as explicit steps.
Android execution additionally needs Maven access.

Netlify's upstream lock omits some registry metadata. The pinned
`netlify-lock-metadata.json` and `repair-netlify-lock.cjs` restore missing fields
without changing versions. Update the metadata and dependency hash together
when updating Netlify. This uses the existing Node toolchain, not Python.
