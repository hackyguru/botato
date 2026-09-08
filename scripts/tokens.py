"""Write both apps' palettes from design/tokens.json.

    python3 scripts/tokens.py            # rewrite both
    python3 scripts/tokens.py --check    # fail if either is stale

The laptop reads CSS custom properties and the phone reads a TypeScript object,
so the same eighteen colours were written out twice by hand and drifted a value
at a time: the hairline was 0.08 on one and 0.09 on the other, there were three
greens between them, and the sheet's own background was not a token anywhere.

Neither file is edited by hand any more. The CSS block lives between two
markers in styles.css — everything outside them is left alone — and theme.ts is
written whole, comment and all.

--check is for CI, and for the moment somebody edits the generated file instead
of the source and wonders why the other screen did not change.
"""

import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
TOKENS = ROOT / "design" / "tokens.json"
CSS = ROOT / "src" / "styles.css"
THEME = ROOT / "mobile" / "src" / "theme.ts"

OPEN = "/* --- palette: written by scripts/tokens.py from design/tokens.json --- */"
CLOSE = "/* --- end palette --- */"


def css_block(t: dict) -> str:
    """The `:root` rule, in the order the source lists things."""
    out = [OPEN, ":root {"]

    for name, spec in t["layout"].items():
        if name == "_":
            continue
        if spec.get("note"):
            out.append(f"  /* {spec['note']} */")
        out.append(f"  --{name}: {spec['value']};")
    out.append("")

    for name, spec in t["colour"].items():
        if spec.get("note"):
            out.append(f"  /* {spec['note']} */")
        out.append(f"  --{name}: {spec['value']};")
    out.append("")

    for name, value in t["shadow"].items():
        out.append(f"  --shadow{'' if name == 'sheet' else '-' + name}: {value};")
    out.append("")

    for name, value in t["space"].items():
        if name != "_":
            out.append(f"  --space-{name}: {value}px;")
    out.append("")

    for name, value in t["radius"].items():
        out.append(f"  --radius-{name}: {value}px;")
    out.append("")

    for name, value in t["type"].items():
        if name != "_":
            out.append(f"  --type-{name}: {value}px;")
    out.append("")

    for name, value in t["row"].items():
        if name != "_":
            out.append(f"  --row-{name}: {value}px;")
    out.append("")

    out.append(f"  --font: {t['font']['sans']};")
    out.append(f"  --mono: {t['font']['mono']};")
    out.append("}")
    out.append(CLOSE)
    return "\n".join(out)


def theme_file(t: dict) -> str:
    """`T`, and the numbers beside it. React Native has no cascade, so what the
    stylesheet gets as a variable this gets as a property."""
    colour = t["colour"]

    def rn(name: str) -> str:
        return colour[name]["value"].replace(", ", ",")

    lines = [
        "/**",
        " * The palette, the spacing and the type.",
        " *",
        " * Written by scripts/tokens.py from design/tokens.json — the same source the",
        " * laptop's stylesheet is written from, so the two screens cannot drift apart",
        " * a colour at a time the way they were doing. Edit the source, run the script.",
        " */",
        "",
        "export const T = {",
    ]
    # The names the phone already uses, mapped to the shared source. Renaming
    # them across the app would be a hundred-line diff for no pixels.
    same = [
        ("bg", "bg"), ("panel", "panel"), ("field", "field"),
        ("bubbleBot", "field"), ("bubbleMe", "raised"), ("raised", "raised"),
        ("fill1", "fill-1"), ("fill2", "fill-2"), ("fill3", "fill-3"),
        ("line", "line"), ("text", "text"), ("text2", "text-2"), ("text3", "text-3"),
        ("onAccent", "on-accent"), ("onBlue", "on-blue"),
        ("link", "link"), ("blue", "blue"),
        ("green", "green"), ("amber", "amber"), ("red", "red"),
    ]
    for prop, token in same:
        lines.append(f'  {prop}: "{rn(token)}",')
    lines.append(f'  mono: "{t["font"]["mono-phone"]}",')
    lines.append("};")
    lines.append("")

    lines.append("/** Gaps, by name. */")
    lines.append("export const S = {")
    for name, value in t["space"].items():
        if name == "_":
            continue
        lines.append(f"  {name.replace('-p', 'P').replace('-', '')}: {value},")
    lines.append("};")
    lines.append("")

    lines.append("/** Corners. */")
    lines.append("export const R = {")
    for name, value in t["radius"].items():
        lines.append(f"  {name.replace('-', '')}: {value},")
    lines.append("};")
    lines.append("")

    lines.append("/** Sizes. A screen that needs an eighth has a problem the type cannot fix. */")
    lines.append("export const F = {")
    for name, value in t["type"].items():
        if name == "_":
            continue
        lines.append(f"  {name.replace('-s', 'S').replace('-', '')}: {value},")
    lines.append("};")
    lines.append("")

    lines.append("/** What a bot can be. Not a scale — these are people, not levels. */")
    swatches = ", ".join(f'"{c}"' for c in t["swatches"]["value"])
    lines.append(f"export const COLORS = [{swatches}];")
    lines.append("")
    return "\n".join(lines)


def main() -> None:
    t = json.loads(TOKENS.read_text())
    check = "--check" in sys.argv

    css = CSS.read_text()
    if OPEN in css:
        head, rest = css.split(OPEN, 1)
        _, tail = rest.split(CLOSE, 1)
    else:
        # First run: the hand-written :root goes, and the generated one takes
        # its place at the top of the file.
        at = css.index(":root {")
        end = css.index("\n}", at) + 2
        head, tail = css[:at], css[end:]
    wanted_css = head + css_block(t) + tail
    wanted_theme = theme_file(t)

    stale = [
        name
        for name, now, want in (
            ("src/styles.css", css, wanted_css),
            ("mobile/src/theme.ts", THEME.read_text(), wanted_theme),
        )
        if now != want
    ]

    if check:
        for name in stale:
            print(f"stale: {name} — run python3 scripts/tokens.py")
        sys.exit(1 if stale else 0)

    CSS.write_text(wanted_css)
    THEME.write_text(wanted_theme)
    print("wrote src/styles.css and mobile/src/theme.ts" if stale else "already current")


if __name__ == "__main__":
    main()
