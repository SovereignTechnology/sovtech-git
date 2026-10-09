release_version
umask 077
signing_dir=$(mktemp -d)
trap 'rm -rf "$signing_dir"' EXIT
base64 --decode "${NGIT_CI_SECRETS_DIR:?}/ANDROID_KEYSTORE_BASE64" > "$signing_dir/keystore.jks"
input="${NGIT_CI_INPUTS:?}/android-unsigned/artifacts/unsigned"
release_dir="${NGIT_CI_OUTPUT_DIR:?}/release-artifacts"
mkdir -p "$release_dir"
# zipalign must precede APK signing. The JVM reads alias/password from files;
# even the alias never becomes an operating-system process argument.
"$ANDROID_HOME/build-tools/35.0.0/zipalign" -P 16 -f 4 "$input/gitworkshop.apk" "$signing_dir/aligned.apk"
java --class-path "$ANDROID_HOME/build-tools/35.0.0/lib/apksigner.jar" \
  "$SIGN_ANDROID_SOURCE" "$signing_dir/keystore.jks" "$NGIT_CI_SECRETS_DIR" \
  "$signing_dir/aligned.apk" "$input/gitworkshop.aab" "$release_dir" "$APP_VERSION" || {
  echo 'Android signing failed; check the granted keystore and key credentials.' >&2
  exit 1
}
"$ANDROID_HOME/build-tools/35.0.0/apksigner" verify --verbose "$release_dir/gitworkshop-android-v$APP_VERSION.apk"
jarsigner -verify "$release_dir/gitworkshop-android-v$APP_VERSION.aab"
printf '%s\n' "$APP_VERSION" > "$NGIT_CI_OUTPUT_DIR/version.txt"
