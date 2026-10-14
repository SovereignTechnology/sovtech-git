require_main
copy_tested_site
export NETLIFY_AUTH_TOKEN NETLIFY_SITE_ID
NETLIFY_AUTH_TOKEN=$(cat "${NGIT_CI_SECRETS_DIR:?}/NETLIFY_AUTH_TOKEN")
NETLIFY_SITE_ID=$(cat "$NGIT_CI_SECRETS_DIR/NETLIFY_SITE_ID")
: "${NETLIFY_AUTH_TOKEN:?}" "${NETLIFY_SITE_ID:?}"
finish_publication netlify deploy --prod --no-build --dir=dist --message="ngit nix ${NGIT_CI_COMMIT_SHA:?}"
