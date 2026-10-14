require_main
copy_tested_site
rm dist/_redirects
finish_publication ngit nsite publish dist \
  --nbunksec-file "${NGIT_CI_SECRETS_DIR:?}/NGIT_PUBLISHER_NBUNKSEC" \
  --concurrency 12 --defaults --json
