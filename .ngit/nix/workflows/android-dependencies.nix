{ pkgs, node, pnpm, gradle, dependencies, android-sdk }:

# Fetch once; retain only Maven artifacts, not Gradle's machine-specific state.
pkgs.stdenvNoCC.mkDerivation {
  name = "gitworkshop-android-dependencies";
  src = pkgs.lib.fileset.toSource {
    root = ../../..;
    fileset = pkgs.lib.fileset.unions [
      ../../../android ../../../package.json ../../../pnpm-lock.yaml
      ../../../patches ../../../capacitor.config.ts ../../../version.properties
    ];
  };
  nativeBuildInputs = [ node pnpm gradle pkgs.jdk21 pkgs.zstd pkgs.cacert ];
  dontConfigure = true;
  dontFixup = true;
  outputHashMode = "recursive";
  outputHashAlgo = "sha256";
  outputHash = "sha256-tMGG0bjHNLTELK97tAA5fTjDhKocMvxJspXAFAbl4R0=";
  buildPhase = ''
    export HOME="$TMPDIR/home" GRADLE_USER_HOME="$TMPDIR/gradle"
    export JAVA_HOME=${pkgs.jdk21}
    export ANDROID_HOME=${android-sdk.androidsdk}/libexec/android-sdk
    export ANDROID_SDK_ROOT="$ANDROID_HOME"
    export JAVA_TOOL_OPTIONS="-Duser.home=$HOME -Djava.io.tmpdir=$TMPDIR"
    export GRADLE_OPTS="-Dorg.gradle.project.android.aapt2FromMavenOverride=$ANDROID_HOME/build-tools/35.0.0/aapt2"
    mkdir -p "$HOME" "$TMPDIR/pnpm-store" dist
    tar --zstd -xf ${dependencies}/pnpm-store.tar.zst -C "$TMPDIR/pnpm-store"
    chmod -R u+w "$TMPDIR/pnpm-store"
    pnpm install --offline --frozen-lockfile --store-dir "$TMPDIR/pnpm-store"
    printf '<html></html>\n' > dist/index.html
    pnpm exec cap telemetry off
    pnpm exec cap sync android
    cd android
    gradle --no-daemon --console=plain --max-workers="''${NIX_BUILD_CORES:-2}" \
      -PunsignedCiRelease=true lintDebug assembleRelease bundleRelease
  '';
  installPhase = ''
    mkdir -p "$out"
    cd "$GRADLE_USER_HOME/caches/modules-2/files-2.1"
    while IFS= read -r -d $'\0' file; do
      IFS=/ read -r group artifact version hash filename <<< "$file"
      destination="$out/''${group//.//}/$artifact/$version/$filename"
      mkdir -p "$(dirname "$destination")"
      if [[ -e $destination ]]; then
        cmp "$file" "$destination"
      else
        cp "$file" "$destination"
      fi
    done < <(find . -type f -printf '%P\0' | sort -z)
  '';
}
