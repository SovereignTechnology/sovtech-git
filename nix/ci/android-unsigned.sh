case "${NGIT_CI_WORKFLOW_PATH:-}" in
  .ngit/nix/workflows/android-rehearsal.yaml) test "${NGIT_CI_TRIGGER:-}" = manual ;;
esac
release_version
install_dependencies
copy_tested_site
step android-sync 'Sync tested web assets to Capacitor' pnpm exec cap sync android
step android-build 'Build unsigned APK and AAB' bash -c \
  'cd android && gradle --no-daemon --stacktrace -PunsignedCiRelease=true assembleRelease bundleRelease'
mkdir -p "${NGIT_CI_OUTPUT_DIR:?}/unsigned"
cp android/app/build/outputs/apk/release/app-release-unsigned.apk "$NGIT_CI_OUTPUT_DIR/unsigned/gitworkshop.apk"
cp android/app/build/outputs/bundle/release/app-release.aab "$NGIT_CI_OUTPUT_DIR/unsigned/gitworkshop.aab"
