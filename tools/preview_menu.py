#!/usr/bin/env python3
"""Render a mock of the panel menu's band rows, light and dark side by side.

Why this exists: the live shell caches ESM modules, so every styling tweak
otherwise costs a full nested-shell restart. This draws the same geometry and
colours the stylesheet uses, so a palette can be judged in a second. It is a
design aid, NOT a screenshot of the product — never present its output as one.

Run: python3 tools/preview_menu.py  ->  assets/../scratchpad preview path printed
"""
import os
import sys

import cairo

# Keep in step with lib/constants.js GROUPS and stylesheet.css.
BANDS = [
    ("20",    "subbass"),  ("40",    "subbass"),
    ("80",    "bass"),     ("160",   "bass"),
    ("315",   "lowermids"),
    ("630",   "midrange"), ("1.25k", "midrange"),
    ("2.5k",  "uppermids"),
    ("5k",    "treble"),   ("10k",   "treble"), ("20k", "treble"),
]

GROUP_COLORS = {
    "subbass":   (0.827, 0.184, 0.184),   # #d32f2f deep red
    "bass":      (0.961, 0.486, 0.000),   # #f57c00 orange
    "lowermids": (0.984, 0.753, 0.176),   # #fbc02d amber
    "midrange":  (0.263, 0.627, 0.278),   # #43a047 green
    "uppermids": (0.012, 0.608, 0.898),   # #039be5 blue
    "treble":    (0.494, 0.341, 0.761),   # #7e57c2 violet
}

BG_ALPHA = 0.13
BAR_ALPHA = 0.55

THEMES = {
    "dark":  {"bg": (0.208, 0.208, 0.208), "fg": (1, 1, 1),
              "track": (1, 1, 1, 0.22), "knob": (1, 1, 1)},
    "light": {"bg": (0.976, 0.965, 0.957), "fg": (0.10, 0.10, 0.10),
              "track": (0, 0, 0, 0.20), "knob": (0.20, 0.20, 0.20)},
}

ROW_H, W, PAD = 38, 430, 10
GAINS = [0.75, 0.71, 0.63, 0.54, 0.46, 0.42, 0.46, 0.54, 0.63, 0.71, 0.75]


def rounded(cr, x, y, w, h, r):
    r = min(r, w / 2, h / 2)
    import math
    cr.new_sub_path()
    cr.arc(x + w - r, y + r, r, -math.pi / 2, 0)
    cr.arc(x + w - r, y + h - r, r, 0, math.pi / 2)
    cr.arc(x + r, y + h - r, r, math.pi / 2, math.pi)
    cr.arc(x + r, y + r, r, math.pi, 3 * math.pi / 2)
    cr.close_path()


def draw_theme(cr, theme, x0, y0):
    t = THEMES[theme]
    cr.set_source_rgb(*t["bg"])
    cr.rectangle(x0, y0, W, ROW_H * len(BANDS) + PAD * 2)
    cr.fill()

    for i, ((label, group), val) in enumerate(zip(BANDS, GAINS)):
        y = y0 + PAD + i * ROW_H
        col = GROUP_COLORS[group]

        cr.set_source_rgba(*col, BG_ALPHA)
        rounded(cr, x0 + 6, y + 2, W - 12, ROW_H - 4, 6)
        cr.fill()
        cr.set_source_rgba(*col, BAR_ALPHA)
        rounded(cr, x0 + 6, y + 6, 3, ROW_H - 12, 1.5)
        cr.fill()

        cr.select_font_face("Cantarell", cairo.FONT_SLANT_NORMAL,
                            cairo.FONT_WEIGHT_NORMAL)
        cr.set_font_size(13)
        cr.set_source_rgba(*t["fg"], 0.85)
        cr.move_to(x0 + 20, y + ROW_H / 2 + 4)
        cr.show_text(label)

        sx, sw = x0 + 74, W - 74 - 62
        cr.set_source_rgba(*t["track"])
        rounded(cr, sx, y + ROW_H / 2 - 2, sw, 4, 2)
        cr.fill()
        kx = sx + val * sw
        cr.set_source_rgb(*t["knob"])
        cr.arc(kx, y + ROW_H / 2, 7, 0, 6.2832)
        cr.fill()

        db = (val - 0.5) * 24
        txt = "0" if abs(db) < 0.05 else f"{'+' if db > 0 else ''}{db:.1f}"
        cr.set_source_rgba(*t["fg"], 0.6)
        cr.set_font_size(13)
        tw = cr.text_extents(txt).x_advance
        cr.move_to(x0 + W - 16 - tw, y + ROW_H / 2 + 4)
        cr.show_text(txt)


def main(out):
    h = ROW_H * len(BANDS) + PAD * 2
    surf = cairo.ImageSurface(cairo.FORMAT_ARGB32, W * 2 + 24, h)
    cr = cairo.Context(surf)
    cr.set_source_rgb(0.5, 0.5, 0.5)
    cr.paint()
    draw_theme(cr, "dark", 0, 0)
    draw_theme(cr, "light", W + 24, 0)
    surf.write_to_png(out)
    print(out)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "menu-preview.png")
