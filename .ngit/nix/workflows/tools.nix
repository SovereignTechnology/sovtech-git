{ pkgs }:
let
  node = pkgs.nodejs_24;
  pnpm = pkgs.stdenvNoCC.mkDerivation {
    pname = "pnpm";
    version = "9.15.9";
    src = pkgs.fetchurl {
      url = "https://registry.npmjs.org/pnpm/-/pnpm-9.15.9.tgz";
      sha256 = "19r89bfc8ymcx7ffk4vdrh574487fffx19l689fkj1j4fsnsg1ng";
    };
    passthru.nodejs-slim = node;
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
      ${pkgs.nodejs_24}/bin/node ${./repair-netlify-lock.cjs} ${./netlify-lock-metadata.json}
    '';
    # overrideAttrs must also update the format expected by npmConfigHook.
    env = (previous.env or { }) // { NIX_NPM_FETCHER_VERSION = 2; };
    npmDeps = pkgs.fetchNpmDeps {
      inherit (final) src postPatch;
      fetcherVersion = 2;
      hash = "sha256-pZuZvYGANJ5S9BQLomTz9DKrGkahw2mzj8rrWFsn45c=";
    };
  });
  # Only dependency inputs affect this cache, not application source changes.
  dependencies = pkgs.fetchPnpmDeps {
    pname = "gitworkshop";
    inherit pnpm;
    nativeBuildInputs = [ node ];
    src = pkgs.lib.fileset.toSource {
      root = ../../..;
      fileset = pkgs.lib.fileset.unions [
        ../../../package.json ../../../pnpm-lock.yaml
      ];
    };
    fetcherVersion = 3;
    hash = "sha256-MN87EhjmVPJjhK8w2Osgg9390mFgomBVg5fANX5t2bQ=";
  };
in {
  inherit node pnpm ngit gradle netlify dependencies;
}
