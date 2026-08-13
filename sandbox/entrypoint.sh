#!/usr/bin/env bash
# Bring up the desktop, then the two ways in: WebSocket VNC and the control API.
set -euo pipefail

: "${SCREEN:=1440x900x24}"
: "${START_BROWSER:=1}"
export DISPLAY=:1

# The desktop is wherever the user is: a UTC clock on a machine in another
# timezone makes every timestamp a bot writes wrong, and makes the browser
# disagree with its own IP.
if [ -n "${TZ:-}" ] && [ -f "/usr/share/zoneinfo/$TZ" ]; then
  sudo ln -sfn "/usr/share/zoneinfo/$TZ" /etc/localtime 2>/dev/null || true
  echo "$TZ" | sudo tee /etc/timezone >/dev/null 2>&1 || true
fi

mkdir -p "$HOME/Desktop" "$HOME/Downloads" "$HOME/work"

# ~/work is the folder shared with the user's machine; make it reachable from the
# GUI with a double-click instead of only from a shell.
[ -e "$HOME/Desktop/work" ] || ln -sfn "$HOME/work" "$HOME/Desktop/work"

# A stopped container keeps its filesystem, so the previous run's X lock is
# still here on restart and Xvfb refuses to start ("server is already active
# for display 1"). Clear it before every boot.
rm -f /tmp/.X1-lock /tmp/.X11-unix/X1 2>/dev/null || true

# The home volume outlives the container, and Chromium's singleton lock records
# the hostname that took it. A recreated container has a new hostname, so a
# carried-over lock makes Chromium refuse to start.
rm -f "$HOME/.config/chromium/Singleton"{Lock,Socket,Cookie} 2>/dev/null || true

Xvfb :1 -screen 0 "$SCREEN" -nolisten tcp &
XVFB=$!
for _ in $(seq 1 100); do
  xdpyinfo >/dev/null 2>&1 && break
  sleep 0.2
done
if ! xdpyinfo >/dev/null 2>&1; then
  # Exit rather than wait forever: a dead desktop should look like a stopped
  # container, not a running one serving nothing.
  echo "botcage: display :1 never came up" >&2
  exit 1
fi

xsetroot -solid "#101014"

# No VNC password: the port is published on the host loopback only, and the
# container is the only thing behind it.
x11vnc -display :1 -forever -shared -nopw -quiet -noxdamage -rfbport 5900 &
VNC=$!

if command -v websockify >/dev/null 2>&1; then
  websockify --heartbeat=30 0.0.0.0:6080 127.0.0.1:5900 &
else
  python3 -m websockify --heartbeat=30 0.0.0.0:6080 127.0.0.1:5900 &
fi
WEBSOCKIFY=$!

python3 /usr/local/lib/botcage/control.py &
CONTROL=$!

# Session apps, not infrastructure: the bot (or the user) may close these, and
# the desktop must survive it.
openbox &

# Without a desktop manager, openbox leaves the root window bare and anything
# saved to ~/Desktop is invisible — files appear to vanish. pcmanfm draws the
# icons and the wallpaper.
WALLPAPER="$(python3 /usr/local/lib/botcage/brand.py 2>/dev/null || true)"
mkdir -p "$HOME/.config/pcmanfm/default"
cat > "$HOME/.config/pcmanfm/default/desktop-items-0.conf" <<CONF
[*]
wallpaper_mode=stretch
wallpaper_common=1
wallpaper=$WALLPAPER
desktop_bg=#0b0b0e
desktop_fg=#e8e8ea
desktop_shadow=#000000
show_wm_menu=0
CONF

pcmanfm --desktop --profile default >/dev/null 2>&1 &

# The config is read at startup, but setting it again over the CLI is what makes
# a regenerated wallpaper take effect on an existing profile.
if [ -n "$WALLPAPER" ]; then
  ( sleep 2; pcmanfm --set-wallpaper="$WALLPAPER" --wallpaper-mode=stretch >/dev/null 2>&1 ) &
fi

tint2 -c /etc/xdg/tint2/tint2rc >/dev/null 2>&1 &
if [ "$START_BROWSER" = "1" ]; then
  browser about:blank >/dev/null 2>&1 &
fi

# Shut down promptly when docker asks: bash defers signals until the current
# foreground command returns, so idle in `wait` rather than in `sleep` — or
# `docker stop` times out and SIGKILLs the desktop mid-write.
trap 'exit 0' TERM INT

# Supervise only the pieces the desktop cannot live without. Anything else
# exiting — a closed browser window, a crashed panel — is a normal day.
while :; do
  for pid in "$XVFB" "$VNC" "$WEBSOCKIFY" "$CONTROL"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "botcage: core service (pid $pid) exited; stopping" >&2
      exit 1
    fi
  done
  sleep 1 &
  wait $! || true
done
