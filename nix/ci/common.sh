# Shared runtime boundary: provider variables and secrets are read only when
# executing an app, after Nix has realised its closure.
step() {
  local id="$1" label="$2"
  shift 2
  if [ -n "${NGIT_CI_STEP:-}" ]; then
    "$NGIT_CI_STEP" "$id" "$label" "$@"
  else
    "$@"
  fi
}

install_dependencies() {
  step install 'Install locked dependencies' pnpm install --frozen-lockfile
  pnpm exec cap telemetry off
}

require_main() {
  test "${NGIT_CI_TRIGGER:-}" = push
  test "${NGIT_CI_REF:-}" = refs/heads/main
}

release_version() {
  # This is repository-owned data from the exact allocated checkout.
  APP_VERSION=$(sed -n 's/^APP_VERSION=//p' version.properties)
  test -n "$APP_VERSION"
  if [ "${NGIT_CI_REF_TYPE:-}" = tag ]; then
    test "${NGIT_CI_REF_NAME:-}" = "v$APP_VERSION" || {
      echo "Release tag does not match version.properties" >&2
      exit 1
    }
  else
    test "${NGIT_CI_TRIGGER:-}" = manual
  fi
}

copy_tested_site() {
  cp -R "${NGIT_CI_INPUTS:?}/test/artifacts/web-dist" dist
  chmod -R u+w dist
  test -f dist/index.html
}
