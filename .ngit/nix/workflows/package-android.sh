mkdir -p "${NGIT_CI_OUTPUT_DIR:?}/unsigned"
cp android/app/build/outputs/apk/release/app-release-unsigned.apk "$NGIT_CI_OUTPUT_DIR/unsigned/gitworkshop.apk"
cp android/app/build/outputs/bundle/release/app-release.aab "$NGIT_CI_OUTPUT_DIR/unsigned/gitworkshop.aab"
