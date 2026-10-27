{ pkgs }:
let
  node = pkgs.nodejs_24;
  pnpm = pkgs.stdenvNoCC.mkDerivation {
    pname = "pnpm";
    version = "10.34.9";
    src = pkgs.fetchurl {
      url = "https://registry.npmjs.org/pnpm/-/pnpm-10.34.9.tgz";
      hash = "sha256-foqUYQjnuqsRnlHSfCTWF4tGVFQiZD28keNOLx7jLg8=";
    };
    passthru.nodejs-slim = node;
    nativeBuildInputs = [ pkgs.makeWrapper ];
    installPhase = ''
      mkdir -p "$out/lib/pnpm" "$out/bin"
      cp -r . "$out/lib/pnpm/"
      makeWrapper ${node}/bin/node "$out/bin/pnpm" --add-flags "$out/lib/pnpm/bin/pnpm.cjs"
    '';
  };
  ngit = pkgs.rustPlatform.buildRustPackage rec {
    pname = "ngit";
    version = "3.0.4";
    src = pkgs.fetchFromGitHub {
      owner = "DanConwayDev";
      repo = "ngit-cli";
      rev = "71a63ef5cee474275deb4a47ce571b9a2abd2706";
      hash = "sha256-GwuaGF6PS8EAfisfMMbwiQUoyE63b34pPFKHzPJ6p7o=";
    };
    cargoLock.lockFile = "${src}/Cargo.lock";
    nativeBuildInputs = [ pkgs.pkg-config ];
    buildInputs = [ pkgs.openssl pkgs.libssh2 pkgs.dbus ];
    # Keep TLS and SSH on Nixpkgs' patched native libraries.
    OPENSSL_NO_VENDOR = 1;
    LIBSSH2_SYS_USE_PKG_CONFIG = 1;
    # Upstream integration tests need Git fixtures and local relay services.
    doCheck = false;
    meta.platforms = [ "x86_64-linux" ];
  };
  # Nixpkgs patches the native libraries embedded in Gradle's JARs.
  gradle = pkgs.gradle-packages.mkGradle {
    version = "8.14.6";
    hash = "sha256-eYjtBxsqB5AOLscV/KFcarcrzm20M68wH6f6fpQHvSQ=";
    defaultJava = pkgs.jdk21;
  };
  netlify = (pkgs.netlify-cli.override { nodejs = node; }).overrideAttrs (final: previous: {
    version = "27.14.2";
    src = pkgs.fetchFromGitHub {
      owner = "netlify";
      repo = "cli";
      tag = "v27.14.2";
      sha256 = "sha256-j0ULbsyKpk5eQ5fnVkVW78lB/EculuPmsOkBs1oHAVg=";
    };
    # Keep the security updates narrow until upstream refreshes its lockfile.
    patches = (previous.patches or [ ]) ++ [ ./netlify-security.patch ];
    # Upstream's lock omits download metadata for some exact-version entries.
    # Restore them before both cache fetching and offline installation. The
    # vendored metadata and cache hash pin all bytes without resolving versions.
    postPatch = (previous.postPatch or "") + ''
      ${pkgs.nodejs_24}/bin/node ${./repair-netlify-lock.cjs} ${./netlify-lock-metadata.json}
    '';
    # overrideAttrs must also update the format expected by npmConfigHook.
    env = (previous.env or { }) // { NIX_NPM_FETCHER_VERSION = 2; };
    npmDeps = pkgs.fetchNpmDeps {
      inherit (final) src patches postPatch;
      fetcherVersion = 2;
      hash = "sha256-30iSjkHfYo59MuZTWrMtjYDEj5fJQQyjui7m2W7vNzI=";
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
        ../../../patches ../../../scripts/apply-pnpm-patches.mjs
      ];
    };
    fetcherVersion = 3;
    hash = "sha256-m0iCbsj+/MsmHCufI6ZWMYJ9Q0iBf1TpY2Znyb5JxTQ=";
  };
in {
  inherit node pnpm ngit gradle netlify dependencies;
}
