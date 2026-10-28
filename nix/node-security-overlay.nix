# Remove this override once nixpkgs supplies Node >=24.22.1 with its native fixes.
final: previous:
let
  # Node links these libraries dynamically in nixpkgs; updating its bundled
  # sources alone would leave the older system libraries in use.
  nodeLibraries = final // {
    brotli = previous.brotli.overrideAttrs (old: {
      patches = (old.patches or [ ]) ++ [
        (previous.fetchurl {
          url = "https://github.com/google/brotli/commit/0ed4268a4401abcb4472096340477cf4af7d1a2b.patch?full_index=1";
          hash = "sha256-1vliUJAAIj3vcGKVgim9CEV+XgMuftDR2U+3kLBUsfw=";
        })
      ];
    });
    c-ares = previous.c-ares.overrideAttrs (_: {
      version = "1.34.9";
      src = previous.fetchurl {
        url = "https://github.com/c-ares/c-ares/releases/download/v1.34.9/c-ares-1.34.9.tar.gz";
        hash = "sha256-k2S3ChLrWaBoMPtIjZNX+QEA3/DZiyPqNZOhg9Q+by8=";
      };
    });
  };
in {
  nodejs-slim_24 = (previous.nodejs-slim_24.override {
    callPackage = previous.lib.callPackageWith nodeLibraries;
  }).overrideAttrs (updated: old: {
    version = "24.22.1";
    passthru = old.passthru // {
      tests = old.passthru.tests // {
        version = previous.testers.testVersion {
          package = updated.finalPackage;
          version = "v${updated.version}";
        };
      };
    };
    src = previous.fetchurl {
      url = "https://nodejs.org/dist/v24.22.1/node-v24.22.1.tar.xz";
      hash = "sha256-T1N5eWKAza6wwvNY/QS2oWzE+336g7WoyRqdljtDUjE=";
    };
  });
}
