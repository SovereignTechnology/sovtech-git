#!/usr/bin/env bash
# Synthetic test credentials only; no release or publication occurs.
set -euo pipefail
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/inputs/android-unsigned/artifacts/unsigned" "$fixture/secrets" "$fixture/output"
printf '%s' changeit > "$fixture/secrets/ANDROID_KEYSTORE_PASSWORD"
printf '%s' fixture > "$fixture/secrets/ANDROID_KEY_ALIAS"
keytool -genkeypair -keystore "$fixture/key.jks" -storetype JKS -storepass changeit -keypass changeit -alias fixture -keyalg RSA -dname CN=Fixture -validity 1 >/dev/null 2>&1
base64 "$fixture/key.jks" > "$fixture/secrets/ANDROID_KEYSTORE_BASE64"
printf '%s\n' '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="dev.gitworkshop.fixture" android:versionCode="1" android:versionName="0.0.1"><uses-sdk android:minSdkVersion="24"/><application android:label="Fixture"/></manifest>' > "$fixture/AndroidManifest.xml"
"$ANDROID_HOME/build-tools/35.0.0/aapt2" link -I "$ANDROID_HOME/platforms/android-36/android.jar" --manifest "$fixture/AndroidManifest.xml" -o "$fixture/inputs/android-unsigned/artifacts/unsigned/gitworkshop.apk"
cp "$fixture/inputs/android-unsigned/artifacts/unsigned/gitworkshop.apk" "$fixture/inputs/android-unsigned/artifacts/unsigned/gitworkshop.aab"
unset NGIT_CI_REF_TYPE NGIT_CI_REF_NAME NGIT_CI_STEP
export NGIT_CI_TRIGGER=manual NGIT_CI_INPUTS="$fixture/inputs" NGIT_CI_SECRETS_DIR="$fixture/secrets" NGIT_CI_OUTPUT_DIR="$fixture/output"
export SIGN_ANDROID_SOURCE="$PWD/nix/ci/SignAndroid.java"
(
  source nix/ci/common.sh
  source nix/ci/android-sign.sh
)
test "$(find "$fixture/output" -type f | wc -l)" -eq 3
printf '%s\n' 'Synthetic APK and AAB signing passed.'
