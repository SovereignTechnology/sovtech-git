{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { nixpkgs, ... }:
    let
      forAllSystems = nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
      perSystem = forAllSystems (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [
            (import ./nix/node-security-overlay.nix)
            (import ./nix/jdk-security-overlay.nix)
          ];
          config.allowUnfree = true;
          config.android_sdk.accept_license = true;
        };
        tools = import ./.ngit/nix/workflows/tools.nix { inherit pkgs; };
        caBundle = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";
        # Pin the v3.0.9 release.
        ngitGraspRevision = "053ee62610e0af37c73c1e3016d12cba4ab28e07";
        # The pinned repository contains Gitlinks without .gitmodules entries.
        # Nix 2.34 and 2.35 disagree about whether their empty directories are
        # retained in a flake Git input, producing different NAR hashes for the
        # same commit. fetchgit gives us a stable tracked-file checkout instead.
        ngitGraspSource = pkgs.fetchgit {
          url = "https://gitnostr.com/npub15qydau2hjma6ngxkl2cyar74wzyjshvl65za5k5rl69264ar2exs5cyejr/ngit-grasp.git";
          rev = ngitGraspRevision;
          hash = "sha256-5i4fRkCHy/bAlsPccK9qa9SwVVyVW6YQS64PVicotJQ=";
          fetchSubmodules = false;
        };
        # Keep these lock updates evaluable on every supported platform.
        ngitGraspCargoLock = let
          original = builtins.readFile "${ngitGraspSource}/Cargo.lock";
          old = [
            "name = \"rustls-webpki\"\nversion = \"0.103.15\""
            "f3c3cf1d8b1e7d4927e2d154c3fcb02979afb9939629c62cd9048d4f07b60ac2"
            "webpki-roots 1.0.9"
            "name = \"webpki-roots\"\nversion = \"1.0.9\""
            "7dcd9d09a39985f5344844e66b0c530a33843579125f23e21e9f0f220850f22a"
          ];
          updated = [
            "name = \"rustls-webpki\"\nversion = \"0.103.16\""
            "4443b1b6d39d7c663139942cc4558262562d2c84123bb6282ef177009ca8b281"
            "webpki-roots 1.0.11"
            "name = \"webpki-roots\"\nversion = \"1.0.11\""
            "f5f280bbb2b287bc8e7de7e3852945a0ff50d1bbcb5ed42b6c7a568c546df171"
          ];
        in assert builtins.all (entry: pkgs.lib.hasInfix entry original) old;
          builtins.toFile "ngit-grasp-Cargo.lock" (builtins.replaceStrings old updated original);
        ngit-grasp-pkg = pkgs.rustPlatform.buildRustPackage {
          pname = "ngit-grasp";
          version = "3.0.9";
          src = ngitGraspSource;
          NGIT_BUILD_REVISION = ngitGraspRevision;
          cargoLock.lockFile = ngitGraspCargoLock;
          postPatch = ''
            cp ${ngitGraspCargoLock} Cargo.lock
          '';
          cargoBuildFlags = [ "-p" "ngit-grasp" ];
          nativeBuildInputs = with pkgs; [ pkg-config git ];
          buildInputs = with pkgs; [ openssl ];
          # The upstream library tests require Git and other ambient state that
          # is unavailable in the build sandbox. The application integration suite
          # exercises the resulting binary instead.
          doCheck = false;
        };
        # Headless Chromium for browser automation (benchmarks/). The npm
        # playwright-core devDependency in package.json must be pinned to the
        # exact version of pkgs.playwright-driver so the browser revisions in
        # this bundle match what the library looks for.
        playwright-browsers = pkgs.playwright-driver.browsers.override {
          withFirefox = false;
          withWebkit = false;
        };
        android-sdk = pkgs.androidenv.composeAndroidPackages {
          platformVersions = [ "36" ];
          # Android Gradle Plugin 8.13 defaults to Build Tools 35.0.0. Include
          # that version explicitly because the Nix SDK is immutable and Gradle
          # cannot install its default version at build time.
          buildToolsVersions = [ "35.0.0" "36.0.0" ];
        };
        ci = import ./.ngit/nix/workflows {
          inherit pkgs system android-sdk ngit-grasp-pkg playwright-browsers;
        };
      in rec {
        ciCommands = ci.commands;
        packages = ci.packages;
        devShell = pkgs.mkShell {
          SSL_CERT_FILE = caBundle;
          GIT_SSL_CAINFO = caBundle;
          buildInputs = [
            tools.node
            tools.pnpm
            pkgs.jdk21
            android-sdk.androidsdk
            ngit-grasp-pkg
          ];
          # Point the e2e harness at the pinned ngit-grasp binary. Without this
          # the harness falls back to the sibling-clone heuristic
          # (../ngit-grasp/target/release/ngit-grasp), which is fine for local
          # dev but not reproducible in CI.
          shellHook = ''
            export NGIT_GRASP_BIN=${ngit-grasp-pkg}/bin/ngit-grasp
            export JAVA_HOME=${pkgs.jdk21}
            export ANDROID_HOME=${android-sdk.androidsdk}/libexec/android-sdk
            export ANDROID_SDK_ROOT="$ANDROID_HOME"
            # Capacitor only exposes telemetry as a per-machine CLI preference,
            # not a project config option. Enforce the opt-out whenever this
            # development shell is entered, once dependencies are installed.
            if [ -x node_modules/.bin/cap ]; then
              node_modules/.bin/cap telemetry off
            fi
            # AGP normally downloads aapt2 from Maven, but that binary is not
            # runnable on NixOS. Use the aapt2 packaged in the Nix SDK instead.
            export GRADLE_OPTS="''${GRADLE_OPTS:+$GRADLE_OPTS }-Dorg.gradle.project.android.aapt2FromMavenOverride=$ANDROID_HOME/build-tools/35.0.0/aapt2"

            if git rev-parse --git-dir >/dev/null 2>&1; then
              hooks_dir="$(git rev-parse --git-dir)/hooks"
              mkdir -p "$hooks_dir"
              hook="$hooks_dir/pre-push"
              if [ -f "$hook" ] && ! grep -q "gitworkshop generated pre-push hook" "$hook"; then
                echo "Leaving existing custom pre-push hook in place: $hook"
              else
                cat > "$hook" <<'EOF'
#!/bin/sh
# gitworkshop generated pre-push hook
set -eu

zero=0000000000000000000000000000000000000000
run_e2e=0

is_relevant_path() {
  case "$1" in
    e2e/*|vitest.e2e.config.ts|src/lib/git-*|src/lib/git-grasp-pool/*|src/lib/vendored/git-natural-api/*|src/hooks/useGitPool.ts|src/hooks/useGitExplorer.ts|src/pages/repo/RepoCodePage.tsx|src/components/MergePanel.tsx)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

check_range() {
  base="$1"
  tip="$2"
  for path in $(git diff --name-only "$base" "$tip"); do
    if is_relevant_path "$path"; then
      run_e2e=1
      return
    fi
  done
}

while read -r local_ref local_sha remote_ref remote_sha; do
  [ "$local_sha" = "$zero" ] && continue

  if [ "$remote_sha" = "$zero" ]; then
    upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
    if [ -n "$upstream" ]; then
      base="$(git merge-base "$local_sha" "$upstream" 2>/dev/null || true)"
      if [ -n "$base" ]; then
        check_range "$base" "$local_sha"
      else
        run_e2e=1
      fi
    else
      run_e2e=1
    fi
  else
    check_range "$remote_sha" "$local_sha"
  fi
done

if [ "$run_e2e" -eq 0 ]; then
  echo "Skipping e2e pre-push: no git/GRASP/e2e paths changed."
  exit 0
fi

if command -v pnpm >/dev/null 2>&1 && pnpm --version >/dev/null 2>&1; then
  pnpm run pre-push
else
  npm run pre-push
fi
EOF
                chmod +x "$hook"
              fi
            fi
          '';
        };

        devShells = {
          default = devShell;
          # Browser-benchmark shell (`nix develop .#bench`). Kept separate so
          # ordinary `nix develop` entries don't realise the ~1 GB Chromium
          # bundle that only `pnpm bench` needs.
          bench = pkgs.mkShell {
            SSL_CERT_FILE = caBundle;
            GIT_SSL_CAINFO = caBundle;
            buildInputs = [
              tools.node
              tools.pnpm
            ];
            # playwright-core downloads no browsers at install time; point it
            # at the Nix-provided bundle. Host-requirement validation checks
            # FHS paths that don't exist on NixOS, so skip it.
            PLAYWRIGHT_BROWSERS_PATH = playwright-browsers;
            PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "true";
          };
        };
      });
    in {
      packages = forAllSystems (system: perSystem.${system}.packages);
      devShell = forAllSystems (system: perSystem.${system}.devShell);
      devShells = forAllSystems (system: perSystem.${system}.devShells);
      ngit-ci.commands = forAllSystems (system: perSystem.${system}.ciCommands);
    };
}
