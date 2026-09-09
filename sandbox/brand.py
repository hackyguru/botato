#!/usr/bin/env python3
"""Draw this bot's desktop wallpaper.

Generated per container at boot rather than shipped as a static asset, so each
bot's screen carries its own name and accent colour — and so a glance at a
screenshot tells you whose machine you are looking at, and that it is a botato
sandbox rather than someone's real desktop.
"""

import os

from PIL import Image, ImageDraw, ImageFilter, ImageFont

FONT_DIR = "/usr/share/fonts/truetype/dejavu"
BOLD = f"{FONT_DIR}/DejaVuSans-Bold.ttf"
REGULAR = f"{FONT_DIR}/DejaVuSans.ttf"

BACKDROP = (11, 11, 14)
WORDMARK = (232, 232, 234)
SUBDUED = (120, 120, 130)


def font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.load_default()


def parse_screen(value):
    try:
        width, height = value.split("x")[:2]
        return int(width), int(height)
    except (ValueError, IndexError):
        return 1440, 900


def parse_color(value):
    value = (value or "").lstrip("#")
    if len(value) != 6:
        return (10, 132, 255)
    try:
        return tuple(int(value[i : i + 2], 16) for i in (0, 2, 4))
    except ValueError:
        return (10, 132, 255)


def glow(size, accent):
    """A soft off-centre wash of the accent colour, so the screen isn't flat black."""
    w, h = size
    layer = Image.new("L", (w // 4, h // 4), 0)
    draw = ImageDraw.Draw(layer)
    draw.ellipse((-w // 16, h // 12, w // 3, h // 2), fill=70)
    draw.ellipse((w // 4, h // 5, int(w * 0.62), int(h * 0.66)), fill=36)
    layer = layer.filter(ImageFilter.GaussianBlur(w // 40)).resize((w, h), Image.BILINEAR)
    return Image.composite(Image.new("RGB", (w, h), accent), Image.new("RGB", (w, h), BACKDROP), layer)


def watermark(size, text):
    """Diagonal repeating wordmark, faint enough to read as texture."""
    w, h = size
    tile = Image.new("L", (w * 2, h * 2), 0)
    draw = ImageDraw.Draw(tile)
    label = font(BOLD, 26)
    step_x, step_y = 340, 190
    for row, y in enumerate(range(0, h * 2, step_y)):
        offset = (row % 2) * (step_x // 2)
        for x in range(-step_x, w * 2, step_x):
            draw.text((x + offset, y), text, font=label, fill=16)
    return tile.rotate(-30, resample=Image.BICUBIC).crop(
        (w // 2, h // 2, w // 2 + w, h // 2 + h)
    )


def cage_mark(draw, box, accent):
    """The app's mark: a rounded cage with two bars."""
    x0, y0, x1, y1 = box
    stroke = max(4, (x1 - x0) // 22)
    draw.rounded_rectangle(box, radius=(x1 - x0) // 4, outline=accent, width=stroke)
    inset_y = (y1 - y0) * 0.24
    for fraction in (0.36, 0.64):
        bar_x = x0 + (x1 - x0) * fraction
        draw.line((bar_x, y0 + inset_y, bar_x, y1 - inset_y), fill=accent, width=stroke)


def build():
    width, height = parse_screen(os.environ.get("SCREEN", "1440x900x24"))
    accent = parse_color(os.environ.get("BOT_COLOR"))
    bot = (os.environ.get("BOT_NAME") or "").strip()

    canvas = glow((width, height), accent)
    canvas.paste(
        Image.new("RGB", (width, height), WORDMARK),
        (0, 0),
        watermark((width, height), "botato"),
    )

    draw = ImageDraw.Draw(canvas)
    mark = min(width, height) // 7
    centre_x, centre_y = width // 2, int(height * 0.42)
    cage_mark(draw, (centre_x - mark // 2, centre_y - mark // 2,
                     centre_x + mark // 2, centre_y + mark // 2), accent)

    title = font(BOLD, max(28, width // 30))
    draw.text((centre_x, centre_y + mark * 0.85), bot or "botato",
              font=title, fill=WORDMARK, anchor="mm")

    caption = font(REGULAR, max(14, width // 82))
    subtitle = "sandboxed desktop · botato" if bot else "sandboxed desktop"
    draw.text((centre_x, centre_y + mark * 0.85 + max(28, width // 30) * 1.15),
              subtitle, font=caption, fill=SUBDUED, anchor="mm")

    target = os.path.expanduser("~/.cache/botato/wallpaper.png")
    os.makedirs(os.path.dirname(target), exist_ok=True)
    canvas.save(target)
    print(target)


if __name__ == "__main__":
    build()
