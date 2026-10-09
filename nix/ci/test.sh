# Android's footer embeds the release version; compile it in the tested site
# so the Android source-build job can consume those exact assets.
case "${NGIT_CI_WORKFLOW_PATH:-}" in
  .ngit/nix/workflows/android-release.yaml|.ngit/nix/workflows/android-rehearsal.yaml)
    release_version
    export APP_RELEASE_VERSION="$APP_VERSION"
    ;;
esac
step npm-lock 'Verify npm fallback lockfile' npm ci --dry-run --ignore-scripts
install_dependencies
step test 'Typecheck, lint, format, unit tests and web build' pnpm test
# A missing binary must fail CI, never silently skip every integration suite.
test -x "$NGIT_GRASP_BIN"
step e2e 'Git and GRASP integration tests' pnpm test:e2e
cp -R dist "${NGIT_CI_OUTPUT_DIR:?}/dist"
