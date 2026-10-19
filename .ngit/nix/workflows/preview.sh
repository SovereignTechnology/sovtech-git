test "${NGIT_CI_TRIGGER:-}" = pull_request
copy_site
rm dist/_redirects
ngit account create --name 'GitWorkshop PR preview' --offline --local --secret-storage file --json
preview_npub=$(git config --local --get nostr.npub)
case "$preview_npub" in npub1*) ;; *) echo 'Preview identity missing' >&2; exit 1;; esac
ngit nsite publish dist --no-config --fallback index.html \
  --blossom-server https://blossom.primal.net \
  --blossom-server https://blossom.ditto.pub \
  --relay wss://relay.nsite.lol --relay wss://nos.lol \
  --relay wss://relay.primal.net --relay wss://nsite.run \
  --concurrency 12 --defaults --json
preview_url="https://$preview_npub.nsite.cloud/"
deadline=$((SECONDS + 120))
until curl --fail --silent --show-error --max-time 15 --output /dev/null "$preview_url"; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    printf 'Preview manifest unavailable at %s\n' "$preview_url" >&2
    exit 1
  fi
  sleep 5
done
printf '%s\n' "$preview_url" > "${NGIT_CI_OUTPUT_DIR:?}/nsite-preview.txt"
