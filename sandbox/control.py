#!/usr/bin/env python3
"""Screen and input control for a botcage sandbox desktop.

A small HTTP API sitting next to Xvfb inside the container. The host app uses
/health to know the desktop is up; the bot's tools (slice B) use the rest to
look at the screen and act on it. Reachable only through the port botcage
publishes on the host loopback.
"""

import io
import json
import os
import subprocess
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(os.environ.get("CONTROL_PORT", "6081"))
ENV = {**os.environ, "DISPLAY": os.environ.get("DISPLAY", ":1")}
SHOT = "/tmp/botcage-shot.png"


def glide(x, y, steps=14):
    """Move the pointer through the space between, instead of teleporting.

    A single `mousemove` jumps: the pointer is at one place, then another, with
    nothing in between. Interpolating is also simply more correct — hover states,
    drag handles, menus that open on enter and canvas tools that track motion all
    need the intermediate events to behave the way they do for a person.
    """
    try:
        start = sh(["xdotool", "getmouselocation", "--shell"]).stdout
        at = dict(line.split("=", 1) for line in start.strip().splitlines() if "=" in line)
        x0, y0 = int(at.get("X", x)), int(at.get("Y", y))
    except Exception:
        x0, y0 = x, y

    for step in range(1, steps + 1):
        # Ease out, so it slows as it arrives rather than stopping dead.
        t = step / steps
        eased = 1 - (1 - t) * (1 - t)
        sh(["xdotool", "mousemove",
            str(int(x0 + (x - x0) * eased)), str(int(y0 + (y - y0) * eased))])
        time.sleep(0.008)


def sh(args, timeout=30):
    return subprocess.run(args, env=ENV, capture_output=True, text=True, timeout=timeout)


def screen_size():
    out = sh(["xdotool", "getdisplaygeometry"]).stdout.split()
    return (int(out[0]), int(out[1])) if len(out) == 2 else (0, 0)


def screenshot(width=None):
    sh(["scrot", "--overwrite", "--pointer", SHOT])
    with open(SHOT, "rb") as fh:
        data = fh.read()
    if not width:
        return data

    from PIL import Image

    img = Image.open(io.BytesIO(data))
    if img.width > width:
        height = round(img.height * width / img.width)
        img = img.resize((width, height), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


BUTTONS = {"left": "1", "middle": "2", "right": "3"}


def act(action, body):
    if action == "move":
        glide(int(body["x"]), int(body["y"]))
        return {"ok": True}

    if action == "click":
        button = BUTTONS.get(body.get("button", "left"), "1")
        glide(int(body["x"]), int(body["y"]))
        sh(["xdotool", "click", "--repeat", str(body.get("count", 1)), button])
        return {"ok": True}

    if action == "type":
        sh(["xdotool", "type", "--delay", "12", "--", body["text"]], timeout=180)
        return {"ok": True}

    if action == "key":
        # e.g. "ctrl+l", "Return", "alt+Tab"
        sh(["xdotool", "key", "--clearmodifiers", body["keys"]])
        return {"ok": True}

    if action == "scroll":
        amount = int(body.get("amount", 3))
        button = "4" if amount > 0 else "5"
        sh(["xdotool", "click", "--repeat", str(abs(amount)), button])
        return {"ok": True}

    if action == "exec":
        # Default to the folder shared with the user's machine, so work a bot
        # does without thinking about paths lands somewhere both sides can see.
        cwd = body.get("cwd") or os.path.expanduser("~/work")
        if not os.path.isdir(cwd):
            cwd = os.path.expanduser("~")
        done = subprocess.run(
            ["bash", "-lc", body["cmd"]],
            env=ENV, cwd=cwd, capture_output=True, text=True,
            timeout=body.get("timeout", 120),
        )
        return {"ok": done.returncode == 0, "code": done.returncode, "cwd": cwd,
                "stdout": done.stdout[-20000:], "stderr": done.stderr[-4000:]}

    raise KeyError(action)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):  # keep the container log quiet
        pass

    def _send(self, code, payload, content_type="application/json"):
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)
        try:
            if url.path == "/health":
                width, height = screen_size()
                return self._send(200, {"ok": True, "width": width, "height": height})
            if url.path == "/screenshot":
                query = parse_qs(url.query)
                width = int(query.get("width", [0])[0]) or None
                return self._send(200, screenshot(width), "image/png")
        except Exception as err:  # noqa: BLE001 — report, never crash the daemon
            return self._send(500, {"ok": False, "error": str(err)})
        self._send(404, {"ok": False, "error": "no such endpoint"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        action = urlparse(self.path).path.lstrip("/")
        try:
            return self._send(200, act(action, json.loads(raw or b"{}")))
        except KeyError:
            return self._send(404, {"ok": False, "error": f"no such action: {action}"})
        except Exception as err:  # noqa: BLE001
            return self._send(500, {"ok": False, "error": str(err)})


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
