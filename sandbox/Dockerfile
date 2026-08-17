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
      bash ca-certificates tzdata sudo iptables \
      fonts-dejavu-core fonts-liberation fonts-noto-core fonts-noto-color-emoji \
      xvfb x11vnc x11-utils x11-xserver-utils xdotool scrot \
      openbox tint2 xterm dbus-x11 xdg-utils \
      python3 python3-pil \
      # A desktop with no audio device at all is unusual; a null sink gives the
      # browser something ordinary to enumerate without any hardware.
      pulseaudio \
      chromium \
      # A second engine, so two bots can be genuinely different browsers rather
      # than the same build with different window sizes. Gecko differs from Blink
      # in canvas rasterisation, font metrics, JS behaviour and TLS handshake —
      # none of which spoofing can honestly reproduce. Costs ~253MB.
      firefox-esr \
      pcmanfm mousepad \
      git curl wget nano less unzip jq \
    && (apt-get install -y --no-install-recommends websockify \
        || apt-get install -y --no-install-recommends python3-websockify) \
    && rm -rf /var/lib/apt/lists/*

# The GitHub CLI is not in Debian's archive. Take the release tarball rather
# than adding a third-party apt source, and pin it so an image rebuild is
# reproducible. Both architectures the base image publishes are covered.
ARG GH_VERSION=2.97.0
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64|arm64) ;; \
      *) echo "no gh build for $arch" >&2; exit 1 ;; \
    esac; \
    cd /tmp; \
    curl -fsSL -o gh.tgz \
      "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${arch}.tar.gz"; \
    tar -xzf gh.tgz; \
    install -m 0755 "gh_${GH_VERSION}_linux_${arch}/bin/gh" /usr/local/bin/gh; \
    rm -rf /tmp/gh.tgz "/tmp/gh_${GH_VERSION}_linux_${arch}"; \
    HOME=/root gh --version

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
    && mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix \
    # An earlier build stage may have created files here as root; the named
    # volume copies this tree verbatim, so a wrong owner here is a home the bot
    # cannot write to for the life of that volume.
    && chown -R bot:bot /home/bot

USER bot
WORKDIR /home/bot

# 6080 = VNC over WebSocket (the panel), 6081 = input/screen control API.
EXPOSE 6080 6081

ENTRYPOINT ["/usr/local/bin/botcage-entrypoint"]
