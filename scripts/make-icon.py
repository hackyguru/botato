"""Draw botcage's app icon, and hand it to Tauri.

    python3 scripts/make-icon.py && pnpm tauri icon /tmp/botcage-icon.png

The mark is a bot's head: an antenna, two ears, and the app's own dot eyes and
soft smile. The first version was a blue squircle with a face in it, which is
every chat application's icon and said nothing about this one — the antenna is
what makes the silhouette recognisable at sixteen pixels, and sixteen pixels is
the size that decides whether a mark works.

It is drawn twice on purpose and the two have to agree: as an SVG in index.html
for the sidebar, where it must take a colour and any size, and as pixels here,
because an .icns is a stack of bitmaps and no browser is involved in making one.

The face inside it keeps the roster's proportions, so if a bot's face changes
in styles.css this is where the icon follows it:

    eyes      44% down the head
    mouth     64% down, about a fifth of the width across
    ink       rgba(0, 0, 0, 0.72)                          (--ink)
    blue      #0a84ff                                      (--blue)

Needs Pillow. What it writes is a 1024px PNG with nothing behind the head: on
macOS the shape is the icon's own, not something sitting on a tile.
"""

from PIL import Image, ImageDraw

SIZE = 1024
BLUE = (10, 132, 255, 255)
DEEP = (0, 92, 190, 255)
INK = (0, 0, 0, 200)
OUT = "/tmp/botcage-icon.png"


def main() -> None:
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 62% of the canvas for the head, leaving room for the antenna above it and
    # the ears either side — the parts that give the silhouette its shape.
    w = int(SIZE * 0.62)
    x = (SIZE - w) // 2
    y = (SIZE - w) // 2 + int(w * 0.09)

    stem = int(w * 0.055)
    d.rounded_rectangle(
        [x + w // 2 - stem // 2, y - int(w * 0.17), x + w // 2 + stem // 2, y + int(w * 0.08)],
        radius=stem // 2,
        fill=DEEP,
    )
    bead = int(w * 0.075)
    d.ellipse(
        [x + w // 2 - bead, y - int(w * 0.17) - bead, x + w // 2 + bead, y - int(w * 0.17) + bead],
        fill=BLUE,
    )

    # Level with the eyes, and small: ears that widen the outline turn a head
    # into a television.
    ew, eh = int(w * 0.10), int(w * 0.26)
    for sx in (x - int(ew * 0.55), x + w - int(ew * 0.45)):
        d.rounded_rectangle([sx, y + int(w * 0.34), sx + ew, y + int(w * 0.34) + eh],
                            radius=ew // 2, fill=DEEP)

    d.rounded_rectangle([x, y, x + w, y + w], radius=int(w * 0.30), fill=BLUE)

    r = int(w * 0.095)
    ey = y + int(w * 0.44)
    for side in (-1, 1):
        cx = x + w // 2 + side * int(w * 0.175)
        d.ellipse([cx - r, ey - r, cx + r, ey + r], fill=INK)

    # An arc rather than a filled crescent: a smile is a stroke, and a filled
    # one reads as a mouth open in surprise at this size.
    sw = int(w * 0.22)
    sy = y + int(w * 0.64)
    cx = x + w // 2
    d.arc([cx - sw, sy - sw // 2, cx + sw, sy + int(sw * 1.5)],
          start=25, end=155, fill=INK, width=int(w * 0.058))

    img.save(OUT)
    print(f"wrote {OUT} — now: pnpm tauri icon {OUT}")
    print("then delete src-tauri/icons/android and ios, which this project does")
    print("not build: the phone app is the Expo one in mobile/.")


if __name__ == "__main__":
    main()
