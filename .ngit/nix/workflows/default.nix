{ pkgs, system, android-sdk, ngit-grasp-pkg, playwright-browsers }:
let
  inherit (import ./tools.nix { inherit pkgs; }) node pnpm ngit gradle dependencies;
  android-dependencies = import ./android-dependencies.nix {
    inherit pkgs node pnpm gradle dependencies android-sdk;
  };
  command = name: tools: script: pkgs.writeShellApplication {
    name = "gitworkshop-${name}";
    runtimeInputs = (with pkgs; [ bash coreutils findutils gnugrep gnused git cacert curl ]) ++ tools;
    text = ''
      export SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt
      export GIT_SSL_CAINFO="$SSL_CERT_FILE"
      export CI=true
      ${builtins.readFile ./common.sh}
      ${script}
    '';
  };
  web = name: command name [ node pnpm ];
  android = name: script: command name [ node pnpm gradle pkgs.jdk21 pkgs.unzip ] ''
    # Java ignores HOME/TMPDIR; keep JVM and Android state in writable scratch.
    export JAVA_TOOL_OPTIONS="-Duser.home=\"$HOME\" -Djava.io.tmpdir=\"''${TMPDIR:-$HOME}\""
    export GRADLE_USER_HOME="$HOME/.gradle" ANDROID_USER_HOME="$HOME/.android"
    export JAVA_HOME=${pkgs.jdk21}
    export ANDROID_HOME=${android-sdk.androidsdk}/libexec/android-sdk
    export ANDROID_SDK_ROOT="$ANDROID_HOME"
    export GRADLE_OPTS="-Dorg.gradle.project.android.aapt2FromMavenOverride=$ANDROID_HOME/build-tools/35.0.0/aapt2"
    ${script}
  '';
in {
  commands = pkgs.lib.optionalAttrs (system == "x86_64-linux") {
    install = command "install" [ node pnpm pkgs.gnutar pkgs.zstd ] ''
      store="''${TMPDIR:-$HOME}/pnpm-store"
      mkdir -p "$store"
      tar --zstd -xf ${dependencies}/pnpm-store.tar.zst -C "$store"
      chmod -R u+w "$store"
      pnpm install --offline --frozen-lockfile --store-dir "$store"
      pnpm exec cap telemetry off
    '';
    ci = {
      test = {
        npm-lock = web "npm-lock" "npm ci --dry-run --ignore-scripts --offline";
        format = web "format" "pnpm exec prettier --check --log-level warn .";
        check = web "check" "pnpm exec tsc --noEmit";
        lint = web "lint" "pnpm exec eslint";
        unit = web "unit" "pnpm exec vitest run --reporter=dot --silent";
        build = web "build" ''
          pnpm build
          cp -R dist "''${NGIT_CI_OUTPUT_DIR:?}/dist"
        '';
        e2e = web "e2e" ''
          export NGIT_GRASP_BIN=${ngit-grasp-pkg}/bin/ngit-grasp
          test -x "$NGIT_GRASP_BIN"
          pnpm test:e2e
        '';
        publication-policy = command "publication-policy" [ pkgs.diffutils ]
          "bash ${./.}/test-policy.sh";
      };
      android-lint = {
        sync = android "android-sync" "pnpm android:sync";
        lint = android "android-lint" ''
          export NGIT_CI_MAVEN_REPOSITORY=${android-dependencies}
          cd android
          gradle --offline --init-script ${./offline-maven.gradle} --no-daemon --console=plain --stacktrace lintDebug
        '';
        signing = android "signing-test" "bash ${./.}/test-signing.sh";
        package = command "package-android-web" [] ''
          cp -R dist "''${NGIT_CI_OUTPUT_DIR:?}/dist"
        '';
      };
    };
    benchmark.browser.replay = web "benchmark-replay" ''
      export PLAYWRIGHT_BROWSERS_PATH=${playwright-browsers}
      export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true
      pnpm build
      trap 'mkdir -p "$NGIT_CI_OUTPUT_DIR/replay"; cp -R perf-reports/pagination-performance/. "$NGIT_CI_OUTPUT_DIR/replay/"' EXIT
      node benchmarks/ci-replay.mjs
    '';
    preview.preview.publish = command "preview" [ ngit ] (builtins.readFile ./preview.sh);
    production = {
      nsite.publish = command "nsite" [ ngit ] (builtins.readFile ./nsite.sh);
    };
    android-release = {
      android-unsigned = {
        sync = android "android-sync-tested" ''
          release_version
          copy_site ci.android-lint android-web-dist
          pnpm exec cap sync android
        '';
        compile = android "android-compile" ''
          release_version
          export NGIT_CI_MAVEN_REPOSITORY=${android-dependencies}
          cd android
          gradle --offline --init-script ${./offline-maven.gradle} --no-daemon --console=plain --stacktrace -PunsignedCiRelease=true assembleRelease bundleRelease
        '';
        package = command "package-android" [] (builtins.readFile ./package-android.sh);
      };
      android-sign = android "android-sign" ''
        export SIGN_ANDROID_SOURCE=${./SignAndroid.java}
        ${builtins.readFile ./android-sign.sh}
      '';
      release.publish = command "release" [ ngit ] (builtins.readFile ./release.sh);
    };
  };
  packages = pkgs.lib.optionalAttrs (system == "x86_64-linux") {
    inherit node pnpm ngit;
    e2e-server = ngit-grasp-pkg;
    ci-dependencies = pkgs.linkFarm "gitworkshop-web-dependencies" [
      { name = "pnpm-store"; path = dependencies; }
      { name = "node"; path = node; }
      { name = "pnpm"; path = pnpm; }
    ];
    android-dependencies = pkgs.linkFarm "gitworkshop-android-toolchain" [
      { name = "maven"; path = android-dependencies; }
      { name = "gradle"; path = gradle; }
      { name = "sdk"; path = android-sdk.androidsdk; }
      { name = "jdk"; path = pkgs.jdk21; }
    ];
  };
}
