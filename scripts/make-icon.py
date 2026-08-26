#!/usr/bin/env python3
"""Draw botcage's app icon, and hand it to Tauri.

    python3 scripts/make-icon.py && pnpm tauri icon /tmp/botcage-icon.png

The mark is a bot's face — the same squircle head, dot eyes and soft smile the
roster is full of, in botcage blue. It is drawn twice on purpose and the two
have to agree: as an SVG in index.html for the sidebar, where it must take a
colour and scale to any size, and as pixels here, because an .icns is a stack
of bitmaps and no browser is involved in making one.

The proportions are the app's own, so if the face changes in styles.css this is
where the icon follows it:

    head      a squircle, corner radius 30% of its width   (--head squircle)
    eyes      44% down the head, radius 8.25% of its width
    mouth     63% down, a quarter of the width across
    ink       rgba(0, 0, 0, 0.72)                          (--ink)
    blue      #0a84ff                                      (--blue)

Needs Pillow. What it writes is a 1024px PNG with nothing behind the head:
on macOS the squircle is the icon's own shape, not something sitting on a tile.
"""

from PIL import Image, ImageDraw

SIZE = 1024
BLUE = (10, 132, 255, 255)
INK = (0, 0, 0, 184)
OUT = "/tmp/botcage-icon.png"


def main() -> None:
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 86% of the canvas: enough margin that the squircle is not clipped by a
    # dock badge or a rounded window corner, and not so much that it reads as
    # small beside every other icon in the dock.
    head = int(SIZE * 0.86)
    x0 = y0 = (SIZE - head) // 2
    d.rounded_rectangle(
        [x0, y0, x0 + head, y0 + head], radius=int(head * 0.30), fill=BLUE
    )

    eye_r = int(head * 0.0825)
    eye_y = y0 + int(head * 0.44)
    for side in (-1, 1):
        cx = x0 + head // 2 + side * int(head * 0.145)
        d.ellipse([cx - eye_r, eye_y - eye_r, cx + eye_r, eye_y + eye_r], fill=INK)

    # An arc rather than a curve with a fill: a smile is a stroke, and a filled
    # crescent reads as a mouth open in surprise at this size.
    smile_w = int(head * 0.26)
    smile_y = y0 + int(head * 0.63)
    cx = x0 + head // 2
    d.arc(
        [cx - smile_w, smile_y - smile_w // 2, cx + smile_w, smile_y + int(smile_w * 1.5)],
        start=25,
        end=155,
        fill=INK,
        width=int(head * 0.062),
    )

    img.save(OUT)
    print(f"wrote {OUT} — now: pnpm tauri icon {OUT}")
    print("then delete src-tauri/icons/android and ios, which this project does")
    print("not build: the phone app is the Expo one in mobile/.")


if __name__ == "__main__":
    main()
