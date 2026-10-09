{ pkgs, system, android-sdk, ngit-grasp-pkg }:
let
  # Keep CI entry points in the root flake. Scripts never bootstrap tools from
  # a mutable channel, an action checkout, npm exec, or an inherited PATH.
  node = pkgs.nodejs_24;
  pnpm = pkgs.stdenvNoCC.mkDerivation {
    pname = "pnpm";
    version = "9.15.9";
    src = pkgs.fetchurl {
      url = "https://registry.npmjs.org/pnpm/-/pnpm-9.15.9.tgz";
      sha256 = "19r89bfc8ymcx7ffk4vdrh574487fffx19l689fkj1j4fsnsg1ng";
    };
    nativeBuildInputs = [ pkgs.makeWrapper ];
    installPhase = ''
      mkdir -p "$out/lib/pnpm" "$out/bin"
      cp -r . "$out/lib/pnpm/"
      makeWrapper ${node}/bin/node "$out/bin/pnpm" --add-flags "$out/lib/pnpm/bin/pnpm.cjs"
    '';
  };
  ngit = pkgs.stdenvNoCC.mkDerivation {
    pname = "ngit";
    version = "3.0.3";
    # Static musl release, pinned to the signed release asset's SHA-256.
    src = pkgs.fetchurl {
      urls = [
        "https://blossom.primal.net/d0022122370c8e3982fce0b4c185b060139fc1a74de1637e7c005ffffcaab024"
        "https://github.com/DanConwayDev/ngit-cli/releases/download/v3.0.3/ngit-v3.0.3-x86_64-unknown-linux-musl.tar.gz"
      ];
      sha256 = "d0022122370c8e3982fce0b4c185b060139fc1a74de1637e7c005ffffcaab024";
      name = "ngit-3.0.3.tar.gz";
    };
    sourceRoot = ".";
    installPhase = ''
      mkdir -p "$out/bin"
      find . -type f -name ngit -exec install -m755 {} "$out/bin/ngit" \;
      test -x "$out/bin/ngit"
    '';
    meta.platforms = [ "x86_64-linux" ];
  };
  # Nixpkgs patches the native libraries embedded in Gradle's JARs.
  gradle = pkgs.gradle-packages.mkGradle {
    version = "8.14.3";
    hash = "sha256-vXEQIhNJMGCVbsIp2Ua+7lcVjb2J0OYrkbyg+ixfNTE=";
    defaultJava = pkgs.jdk21;
  };
  netlify = pkgs.netlify-cli.overrideAttrs (final: previous: {
    version = "26.2.0";
    src = pkgs.fetchFromGitHub {
      owner = "netlify";
      repo = "cli";
      tag = "v26.2.0";
      sha256 = "1jkzmw801bq1hnj7rl1grmrcaqiqn33ld0rgn765ipdgh1711c22";
    };
    # Upstream's lock omits download metadata for some exact-version entries.
    # Restore them before both cache fetching and offline installation. The
    # vendored metadata and cache hash pin all bytes without resolving versions.
    postPatch = (previous.postPatch or "") + ''
      ${pkgs.python3}/bin/python ${./ci/repair-netlify-lock.py} ${./ci/netlify-lock-metadata.json}
    '';
    # overrideAttrs must also update the format expected by npmConfigHook.
    env = (previous.env or { }) // { NIX_NPM_FETCHER_VERSION = 2; };
    npmDeps = pkgs.fetchNpmDeps {
      inherit (final) src postPatch;
      fetcherVersion = 2;
      hash = "sha256-pZuZvYGANJ5S9BQLomTz9DKrGkahw2mzj8rrWFsn45c=";
    };
  });
  commonTools = with pkgs; [ bash coreutils findutils gnugrep gnused git cacert curl ];
  mkApp = name: extra: prelude:
    let app = pkgs.writeShellApplication {
      name = "gitworkshop-${name}";
      runtimeInputs = commonTools ++ extra;
      text = ''
        export SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt
        export GIT_SSL_CAINFO="$SSL_CERT_FILE"
        export CI=true
        ${prelude}
        ${builtins.readFile ./ci/common.sh}
        ${builtins.readFile (./ci + "/${name}.sh")}
      '';
    }; in { type = "app"; program = "${app}/bin/gitworkshop-${name}"; };
  androidEnvironment = ''
    # Java ignores HOME and TMPDIR; use the provider's disk-backed job scratch.
    # Keep every JVM (including Gradle daemons) and Android cache in job scratch.
    export JAVA_TOOL_OPTIONS="-Duser.home=\"$HOME\" -Djava.io.tmpdir=\"''${TMPDIR:-$HOME}\""
    export GRADLE_USER_HOME="$HOME/.gradle"
    export ANDROID_USER_HOME="$HOME/.android"
    export JAVA_HOME=${pkgs.jdk21}
    export ANDROID_HOME=${android-sdk.androidsdk}/libexec/android-sdk
    export ANDROID_SDK_ROOT="$ANDROID_HOME"
    export GRADLE_OPTS="-Dorg.gradle.project.android.aapt2FromMavenOverride=$ANDROID_HOME/build-tools/35.0.0/aapt2"
  '';
in rec {
  # These entry points intentionally target the fleet's Linux x86_64 providers.
  apps = pkgs.lib.optionalAttrs (system == "x86_64-linux") {
    ci-test = mkApp "test" [ node pnpm ngit-grasp-pkg ] ''
      export NGIT_GRASP_BIN=${ngit-grasp-pkg}/bin/ngit-grasp
    '';
    ci-android-lint = mkApp "android-lint" [ node pnpm gradle pkgs.jdk21 pkgs.unzip ] androidEnvironment;
    ci-android-unsigned = mkApp "android-unsigned" [ node pnpm gradle pkgs.jdk21 pkgs.unzip ] androidEnvironment;
    ci-android-sign = mkApp "android-sign" [ pkgs.jdk21 pkgs.unzip ] (androidEnvironment + ''
      export SIGN_ANDROID_SOURCE=${./ci/SignAndroid.java}
    '');
    ci-preview = mkApp "preview" [ ngit ] "";
    ci-netlify = mkApp "netlify" [ netlify ] "";
    ci-nsite = mkApp "nsite" [ ngit ] "";
    ci-release = mkApp "release" [ ngit ] "";
  };
  packages = pkgs.lib.optionalAttrs (system == "x86_64-linux") {
    ci-entrypoints = pkgs.linkFarm "gitworkshop-ci-entrypoints"
      (pkgs.lib.mapAttrsToList (name: app: { inherit name; path = app.program; }) apps);
    ci-pnpm = pnpm;
    ci-ngit = ngit;
    ci-netlify = netlify;
  };
}
