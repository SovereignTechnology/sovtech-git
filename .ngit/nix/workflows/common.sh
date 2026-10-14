# Shared runtime helpers; secrets are read only during command execution.
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
  cp -R "${NGIT_CI_INPUTS:?}/${1:-ci.test}/artifacts/${2:-web-dist}" dist
  chmod -R u+w dist
  test -f dist/index.html
}

# Once publication begins, ordinary cancellation waits within the job's grace.
finish_publication() {
  if [[ -n ${NGIT_CI_CANCEL_FILE:-} && -e $NGIT_CI_CANCEL_FILE ]]; then
    echo 'Cancelled before publication began' >&2
    return 143
  fi
  local interrupted=0 status pid
  trap 'interrupted=1; echo "Shutdown requested; waiting for publication to finish" >&2' TERM
  "$@" &
  pid=$!
  while :; do
    interrupted=0
    if wait "$pid"; then status=0; else status=$?; fi
    (( interrupted )) || break
  done
  trap - TERM
  return "$status"
}
