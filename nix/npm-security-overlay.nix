# Remove the bundled dependency replacements once upstream npm includes them.
final: previous:
let
  npm = previous.stdenvNoCC.mkDerivation {
    pname = "npm";
    version = "11.21.1";
    src = previous.fetchurl {
      url = "https://registry.npmjs.org/npm/-/npm-11.21.1.tgz";
      hash = "sha256-3XfEjrhF9IVsLNujR8+1K9h3omVaHqSP8MR5bj353Xs=";
    };
    nativeBuildInputs = [ previous.makeWrapper ];
    # Keep nixpkgs' buildNpmPackage integration when replacing bundled npm.
    patches = [
      (previous.path + "/pkgs/development/web/nodejs/node-npm-build-npm-package-logic.patch")
    ];
    patchFlags = [ "-p3" ];
    postPatch = let
      undici = previous.fetchurl {
        url = "https://registry.npmjs.org/undici/-/undici-6.29.1.tgz";
        hash = "sha256-KcS44LLYbLh5VXHBlZASzgV6FOz9NIWDNfR8MedwoE8=";
      };
      ipAddress = previous.fetchurl {
        url = "https://registry.npmjs.org/ip-address/-/ip-address-10.7.4.tgz";
        hash = "sha256-+eHQ3TacAC9Ddwxu41lCyAeOdtCAoeGOiRE+74ZfJv8=";
      };
    in ''
      rm -r node_modules/undici node_modules/ip-address
      mkdir node_modules/undici node_modules/ip-address
      tar -xzf ${undici} --strip-components=1 -C node_modules/undici
      tar -xzf ${ipAddress} --strip-components=1 -C node_modules/ip-address
    '' + previous.lib.optionalString previous.stdenv.hostPlatform.isDarwin ''
      # Preserve the bundled node-gyp sandbox fallback from the Node recipe.
      sed -n '/^--- a\/deps\/npm\//,$p' \
        ${previous.path}/pkgs/development/web/nodejs/gyp-patches-set-fallback-value-for-CLT-darwin.patch \
        | patch -p3
    '';
    installPhase = ''
      runHook preInstall
      mkdir -p "$out/lib/node_modules/npm" "$out/bin"
      cp -r . "$out/lib/node_modules/npm/"
      makeWrapper ${final.nodejs-slim_24}/bin/node "$out/bin/npm" \
        --add-flags "$out/lib/node_modules/npm/bin/npm-cli.js"
      makeWrapper ${final.nodejs-slim_24}/bin/node "$out/bin/npx" \
        --add-flags "$out/lib/node_modules/npm/bin/npx-cli.js"
      mkdir -p "$out/share/bash-completion/completions"
      ln -s "$out/lib/node_modules/npm/lib/utils/completion.sh" \
        "$out/share/bash-completion/completions/npm"
      for directory in "$out/lib/node_modules/npm/man/"*; do
        mkdir -p "$out/share/man/$(basename "$directory")"
        for page in "$directory"/*; do
          ln -rs "$page" "$out/share/man/$(basename "$directory")"
        done
      done
      runHook postInstall
    '';
    postFixup = ''
      HOST_PATH=${final.nodejs-slim_24}/bin patchShebangs --host "$out"
    '';
    meta = previous.nodejs_24.meta // {
      description = "npm CLI with compatible bundled dependency security fixes";
      homepage = "https://github.com/npm/cli";
      license = previous.lib.licenses.artistic2;
    };
  };
in {
  # Replace only the full distribution's npm output, retaining the compiled
  # Node runtime, native libraries, headers and certificate configuration.
  nodejs_24 = previous.nodejs_24.override {
    nodejs-slim = final.nodejs-slim_24 // { inherit npm; };
  };
}
