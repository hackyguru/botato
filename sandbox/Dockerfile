# A bot's computer: a throwaway Linux desktop reachable over VNC-in-WebSocket.
#
# Multi-arch by construction (debian bookworm-slim publishes amd64 + arm64), so
# the same image is the bot's desktop on Linux, macOS, and Windows hosts.
# Chromium rather than Chrome: Google ships no linux-arm64 Chrome build.
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:1 \
    SCREEN=1440x900x24 \
    HOME=/home/bot \
    LANG=C.UTF-8

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash ca-certificates tzdata sudo \
      fonts-dejavu-core fonts-liberation fonts-noto-core fonts-noto-color-emoji \
      xvfb x11vnc x11-utils x11-xserver-utils xdotool scrot \
      openbox tint2 xterm dbus-x11 xdg-utils \
      python3 python3-pil \
      chromium \
      pcmanfm mousepad \
      git curl wget nano less unzip jq \
    && (apt-get install -y --no-install-recommends websockify \
        || apt-get install -y --no-install-recommends python3-websockify) \
    && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /usr/local/bin/botcage-entrypoint
COPY browser.sh /usr/local/bin/browser
COPY control.py /usr/local/lib/botcage/control.py
COPY brand.py /usr/local/lib/botcage/brand.py
COPY tint2rc /etc/xdg/tint2/tint2rc
RUN chmod +x /usr/local/bin/botcage-entrypoint /usr/local/bin/browser \
    && useradd -m -u 1000 -s /bin/bash bot \
    # Root inside its own throwaway container, so a bot can apt-install what it
    # needs. The container is the security boundary, not this user.
    && echo 'bot ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/bot \
    && chmod 0440 /etc/sudoers.d/bot \
    # Xvfb runs unprivileged and cannot create this itself.
    && mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

USER bot
WORKDIR /home/bot

# 6080 = VNC over WebSocket (the panel), 6081 = input/screen control API.
EXPOSE 6080 6081

ENTRYPOINT ["/usr/local/bin/botcage-entrypoint"]
