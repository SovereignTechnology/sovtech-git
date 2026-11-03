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
  gradle = (pkgs.gradle-packages.mkGradle {
    version = "8.14.6";
    hash = "sha256-eYjtBxsqB5AOLscV/KFcarcrzm20M68wH6f6fpQHvSQ=";
    defaultJava = pkgs.jdk21;
  }).overrideAttrs (previous: {
    # Preserve Gradle's module classpath filename while replacing the library.
    # Remove this replacement when the distribution bundles patched Guava.
    installPhase = previous.installPhase + ''
      test -f "$gradleLibexec/lib/guava-33.4.6-jre.jar"
      cp ${pkgs.fetchurl {
        url = "https://repo.maven.apache.org/maven2/com/google/guava/guava/33.7.2-jre/guava-33.7.2-jre.jar";
        hash = "sha256-tTCUIlf7k1+LLPql+Otb1ZxVX9jo0BuM6YkS4HfqYGw=";
      }} "$gradleLibexec/lib/guava-33.4.6-jre.jar"
    '';
  });
  # Only dependency inputs affect this cache, not application source changes.
  dependencies = pkgs.fetchPnpmDeps {
    pname = "gitworkshop";
    inherit pnpm;
    nativeBuildInputs = [ node ];
    src = pkgs.lib.fileset.toSource {
      root = ../../..;
      fileset = pkgs.lib.fileset.unions [
        ../../../package.json ../../../pnpm-lock.yaml ../../../pnpm-workspace.yaml
        ../../../patches ../../../scripts/apply-pnpm-patches.mjs
      ];
    };
    fetcherVersion = 3;
    hash = "sha256-m0iCbsj+/MsmHCufI6ZWMYJ9Q0iBf1TpY2Znyb5JxTQ=";
  };
in {
  inherit node pnpm ngit gradle dependencies;
}
