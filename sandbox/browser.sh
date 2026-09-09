#!/bin/sh
# The desktop's browser. Which engine depends on the bot: BROWSER_ENGINE picks
# it, so two bots can present as different browsers instead of one build wearing
# different window sizes.
#
# Chromium's own sandbox needs privileges the container does not have; the
# container is the sandbox here.

# The window is not the screen, and a real person's is rarely maximised.
GEOM="${BROWSER_WINDOW:-1400x860}"
WIDTH="${GEOM%x*}"
HEIGHT="${GEOM#*x}"

case "${BROWSER_ENGINE:-chromium}" in
  firefox)
    # Firefox takes its advertised language from a pref rather than a flag, so
    # the profile has to carry it or it announces en-US whatever the machine is.
    PROFILE="$HOME/.mozilla/botato"
    mkdir -p "$PROFILE"
    if [ -n "${BROWSER_LANG:-}" ]; then
      printf 'user_pref("intl.accept_languages", "%s,%s");\n' \
        "$BROWSER_LANG" "${BROWSER_LANG%%-*}" > "$PROFILE/user.js"
    fi
    exec firefox-esr \
      --profile "$PROFILE" \
      --window-size "$WIDTH,$HEIGHT" \
      "$@"
    ;;
  *)
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
      --window-size="$WIDTH,$HEIGHT" \
      ${BROWSER_LANG:+--lang="$BROWSER_LANG"} \
      ${BROWSER_LANG:+--accept-lang="$BROWSER_LANG,${BROWSER_LANG%%-*}"} \
      "$@"
    ;;
esac
