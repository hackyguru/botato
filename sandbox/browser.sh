#!/bin/sh
# Chromium's own sandbox needs privileges the container doesn't have; the
# container is the sandbox here.
# No --disable-gpu: without it Chromium falls back to SwiftShader, so WebGL
# works and canvas/map/chart-heavy sites render instead of breaking.
exec chromium \
  --no-sandbox \
  --disable-dev-shm-usage \
  --no-first-run \
  --no-default-browser-check \
  --password-store=basic \
  --disable-session-crashed-bubble \
  --hide-crash-restore-bubble \
  --window-size=1400,860 \
  ${BROWSER_LANG:+--lang="$BROWSER_LANG"} \
  "$@"
