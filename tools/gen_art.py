#!/usr/bin/env python3
"""Generate GnomeEQ branding art (icon, logo, banner) with pycairo.

The art reuses the product's own visual language: the fader-and-knob motif from
icons/gnomeeq-symbolic.svg, and a bar spectrum whose heights are the actual
"Loudness" preset from lib/constants.js — so the branding is a picture of what
the thing really does rather than generic audio clip-art.

Outputs into ../assets/.  Run: python3 tools/gen_art.py
"""
import math
import os

import cairo

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(os.path.dirname(HERE), "assets")
os.makedirs(ASSETS, exist_ok=True)

# --- Palette: cool, dark, GNOME-adjacent ---
BG      = (0.043, 0.055, 0.078)   # #0b0e14
BG_TOP  = (0.075, 0.094, 0.129)
WHITE   = (0.925, 0.957, 0.980)   # #ecf4fa
ACCENT  = (0.310, 0.741, 0.984)   # #4fbdfb
ACCENT2 = (0.510, 0.400, 0.960)   # #8266f5
TRACK   = (0.290, 0.345, 0.420)
DIM     = (0.560, 0.627, 0.706)

# The ten band labels and the Loudness preset, mirroring lib/constants.js.
LABELS = ['20', '40', '80', '160', '315', '630', '1.25k', '2.5k', '5k',
          '10k', '20k']
LOUDNESS = [6, 5, 3, 1, -1, -2, -1, 1, 3, 5, 6]
GAIN_MAX = 12


def rgba(cr, c, a=1.0):
    cr.set_source_rgba(c[0], c[1], c[2], a)


def vgradient(cr, x, y, w, h, top, bottom):
    g = cairo.LinearGradient(x, y, x, y + h)
    g.add_color_stop_rgb(0, *top)
    g.add_color_stop_rgb(1, *bottom)
    cr.set_source(g)
    cr.rectangle(x, y, w, h)
    cr.fill()


def rounded(cr, x, y, w, h, r):
    r = min(r, w / 2, h / 2)
    cr.new_sub_path()
    cr.arc(x + w - r, y + r, r, -math.pi / 2, 0)
    cr.arc(x + w - r, y + h - r, r, 0, math.pi / 2)
    cr.arc(x + r, y + h - r, r, math.pi / 2, math.pi)
    cr.arc(x + r, y + r, r, math.pi, 3 * math.pi / 2)
    cr.close_path()


def faders(cr, x, y, w, h, values, knob_r, track_w, glow=True):
    """The icon motif at any size: vertical tracks with knobs at `values`
    (each -1..1, 0 = centre)."""
    n = len(values)
    step = w / n
    for i, v in enumerate(values):
        cx = x + step * (i + 0.5)
        rgba(cr, TRACK, 0.9)
        rounded(cr, cx - track_w / 2, y, track_w, h, track_w / 2)
        cr.fill()
        # Knob position: +1 at the top, -1 at the bottom.
        ky = y + (1 - (v + 1) / 2) * h
        ky = max(y + knob_r, min(y + h - knob_r, ky))
        # Trail from centre to knob, tinted by direction.
        mid = y + h / 2
        rgba(cr, ACCENT if v >= 0 else ACCENT2, 0.55)
        rounded(cr, cx - track_w / 2, min(mid, ky), track_w, abs(mid - ky),
                track_w / 2)
        cr.fill()
        if glow:
            g = cairo.RadialGradient(cx, ky, 0, cx, ky, knob_r * 2.6)
            col = ACCENT if v >= 0 else ACCENT2
            g.add_color_stop_rgba(0, col[0], col[1], col[2], 0.45)
            g.add_color_stop_rgba(1, col[0], col[1], col[2], 0.0)
            cr.set_source(g)
            cr.arc(cx, ky, knob_r * 2.6, 0, 2 * math.pi)
            cr.fill()
        rgba(cr, WHITE)
        rounded(cr, cx - knob_r * 1.5, ky - knob_r * 0.62,
                knob_r * 3, knob_r * 1.24, knob_r * 0.62)
        cr.fill()


def wordmark(cr, x, y, size, sub=None):
    cr.select_font_face("Cantarell", cairo.FONT_SLANT_NORMAL,
                        cairo.FONT_WEIGHT_BOLD)
    cr.set_font_size(size)
    # "Gnome" in white, "EQ" in the accent, so the name reads as a family
    # member rather than a monolith.
    a, b = "Gnome", "EQ"
    wa = cr.text_extents(a).x_advance
    rgba(cr, WHITE)
    cr.move_to(x, y)
    cr.show_text(a)
    rgba(cr, ACCENT)
    cr.move_to(x + wa, y)
    cr.show_text(b)
    total = wa + cr.text_extents(b).x_advance
    if sub:
        cr.select_font_face("Cantarell", cairo.FONT_SLANT_NORMAL,
                            cairo.FONT_WEIGHT_NORMAL)
        cr.set_font_size(size * 0.28)
        rgba(cr, DIM)
        cr.move_to(x + 2, y + size * 0.42)
        cr.show_text(sub)
    return total


def norm(gains):
    return [g / GAIN_MAX for g in gains]


def make_icon(path, size=512):
    surf = cairo.ImageSurface(cairo.FORMAT_ARGB32, size, size)
    cr = cairo.Context(surf)
    s = size / 512
    # Rounded dark tile so the icon stays legible on any backdrop.
    rounded(cr, 0, 0, size, size, 108 * s)
    cr.clip()
    vgradient(cr, 0, 0, size, size, BG_TOP, BG)
    faders(cr, 96 * s, 96 * s, 320 * s, 320 * s,
           [0.55, -0.35, 0.15], knob_r=30 * s, track_w=34 * s)
    surf.write_to_png(path)
    return path


def make_logo(path, w=1280, h=380):
    surf = cairo.ImageSurface(cairo.FORMAT_ARGB32, w, h)
    cr = cairo.Context(surf)
    # Self-contained tile: the logo has to survive GitHub's light theme too.
    rounded(cr, 0, 0, w, h, 44)
    cr.clip()
    vgradient(cr, 0, 0, w, h, BG_TOP, BG)
    faders(cr, 90, 92, 250, 196, [0.55, -0.35, 0.15], knob_r=21, track_w=24)
    wordmark(cr, 400, 218, 132, "11-band system equalizer")
    surf.write_to_png(path)
    return path


def _spectrum(cr, left, right, base_y, span, labels=True, label_size=22):
    """The Loudness preset drawn as a gain spectrum around a 0 dB line."""
    bw = (right - left) / len(LOUDNESS)
    for i, gain in enumerate(LOUDNESS):
        x = left + i * bw
        frac = gain / GAIN_MAX
        bh = abs(frac) * span
        col = ACCENT if gain >= 0 else ACCENT2
        y = base_y - bh if gain >= 0 else base_y
        grad = cairo.LinearGradient(0, base_y - span, 0, base_y + span * 0.4)
        grad.add_color_stop_rgba(0, *col, 0.95)
        grad.add_color_stop_rgba(1, *col, 0.35)
        cr.set_source(grad)
        rounded(cr, x + bw * 0.16, y, bw * 0.68, max(bh, 5), 7)
        cr.fill()
        if labels:
            cr.select_font_face("Cantarell", cairo.FONT_SLANT_NORMAL,
                                cairo.FONT_WEIGHT_NORMAL)
            cr.set_font_size(label_size)
            rgba(cr, DIM, 0.85)
            tw = cr.text_extents(LABELS[i]).x_advance
            cr.move_to(x + bw / 2 - tw / 2, base_y + span * 0.30 + label_size)
            cr.show_text(LABELS[i])
    # The 0 dB reference, so the bars read as gain rather than as a bar chart.
    rgba(cr, TRACK, 0.8)
    cr.set_line_width(2)
    cr.set_dash([7, 7])
    cr.move_to(left, base_y)
    cr.line_to(right, base_y)
    cr.stroke()
    cr.set_dash([])


def make_banner(path, w=1280, h=640):
    surf = cairo.ImageSurface(cairo.FORMAT_ARGB32, w, h)
    cr = cairo.Context(surf)
    vgradient(cr, 0, 0, w, h, BG_TOP, BG)

    g = cairo.RadialGradient(w * 0.5, h * 0.78, 0, w * 0.5, h * 0.78, w * 0.60)
    g.add_color_stop_rgba(0, *ACCENT, 0.20)
    g.add_color_stop_rgba(1, *ACCENT, 0.0)
    cr.set_source(g)
    cr.rectangle(0, 0, w, h)
    cr.fill()

    # Mark + wordmark on one baseline, tagline under it. Kept tight so the
    # composition does not leave a dead band across the middle.
    faders(cr, 96, 150, 132, 118, [0.55, -0.35, 0.15], knob_r=13, track_w=15)
    wordmark(cr, 262, 250, 126, None)
    cr.select_font_face("Cantarell", cairo.FONT_SLANT_NORMAL,
                        cairo.FONT_WEIGHT_NORMAL)
    cr.set_font_size(34)
    rgba(cr, DIM)
    cr.move_to(266, 300)
    cr.show_text("Equalize everything, from the top bar.")

    _spectrum(cr, 96, w - 96, base_y=470, span=125)
    surf.write_to_png(path)
    return path


def make_social(path, w=1280, h=640):
    """GitHub social preview / OG image. GitHub crops to 1280x640 and scales
    down hard in feeds, so this variant keeps everything inside a generous
    safe margin and sets the type larger than the banner."""
    surf = cairo.ImageSurface(cairo.FORMAT_ARGB32, w, h)
    cr = cairo.Context(surf)
    vgradient(cr, 0, 0, w, h, BG_TOP, BG)

    g = cairo.RadialGradient(w * 0.5, h * 0.5, 0, w * 0.5, h * 0.5, w * 0.66)
    g.add_color_stop_rgba(0, *ACCENT, 0.16)
    g.add_color_stop_rgba(1, *ACCENT, 0.0)
    cr.set_source(g)
    cr.rectangle(0, 0, w, h)
    cr.fill()

    faders(cr, 150, 168, 150, 132, [0.55, -0.35, 0.15], knob_r=15, track_w=17)
    wordmark(cr, 342, 290, 150, None)
    cr.select_font_face("Cantarell", cairo.FONT_SLANT_NORMAL,
                        cairo.FONT_WEIGHT_NORMAL)
    cr.set_font_size(40)
    rgba(cr, DIM)
    cr.move_to(346, 348)
    cr.show_text("11-band system equalizer for GNOME")

    _spectrum(cr, 150, w - 150, base_y=486, span=92, label_size=20)
    surf.write_to_png(path)
    return path


if __name__ == "__main__":
    for p in (make_icon(os.path.join(ASSETS, "icon.png")),
              make_logo(os.path.join(ASSETS, "logo.png")),
              make_banner(os.path.join(ASSETS, "banner.png")),
              make_social(os.path.join(ASSETS, "social-preview.png"))):
        print("wrote", os.path.relpath(p, os.path.dirname(HERE)))
