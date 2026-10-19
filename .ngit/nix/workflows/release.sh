# Authorized manual replay is a build/sign rehearsal, never publication.
if [ "${NGIT_CI_TRIGGER:-}" = manual ]; then
  echo 'Manual Android release rehearsal: publication skipped.'
  exit 0
fi
test "${NGIT_CI_TRIGGER:-}" = push
test "${NGIT_CI_REF_TYPE:-}" = tag
release_version
# Provider checkouts contain the allocated commit, but no tag objects. Fetch
# only the reviewed tag; a mirror may supply objects but cannot change the
# commit authorized by the signed allocation.
release_ref="refs/tags/$NGIT_CI_REF_NAME"
git check-ref-format "$release_ref"
timeout 120 git fetch --no-tags --force \
  https://gitnostr.com/npub15qydau2hjma6ngxkl2cyar74wzyjshvl65za5k5rl69264ar2exs5cyejr/gitworkshop.git \
  "$release_ref:$release_ref"
test "$(git rev-parse "$release_ref^{commit}")" = "${NGIT_CI_COMMIT_SHA:?}" || {
  echo 'Fetched release tag does not match the signed allocation commit.' >&2
  exit 1
}
reported_version=$(cat "${NGIT_CI_INPUTS:?}/android-sign/outputs/version")
test "$reported_version" = "$APP_VERSION"
cp -R "$NGIT_CI_INPUTS/android-sign/artifacts/signed" release-artifacts
test -f "release-artifacts/gitworkshop-android-v$APP_VERSION.apk"
if [ "${APP_VERSION#*-}" != "$APP_VERSION" ]; then
  prerelease="${APP_VERSION#*-}"
  channel="${prerelease%%[.+]*}"
else
  channel=main
fi
finish_publication ngit release publish "$APP_VERSION" --manifest .ngit/release.yaml \
  --channel "$channel" --tag "$NGIT_CI_REF_NAME" --commit "${NGIT_CI_COMMIT_SHA:?}" \
  --nbunksec-file "${NGIT_CI_SECRETS_DIR:?}/NGIT_PUBLISHER_NBUNKSEC" \
  --defaults --json
