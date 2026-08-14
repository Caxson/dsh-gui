#!/usr/bin/env python3
"""Convert a generated source image into a macOS app icon PNG.

Takes the full-bleed source (any size, RGB or RGBA), resizes it to 1024x1024
and applies the standard macOS rounded-corner mask (smooth, ~22.4% radius)
so the icon looks native in the Dock, Finder and DMG volume.

Usage: process-icon.py <source> <output>
"""

import sys
from PIL import Image, ImageDraw

SRC, OUT = sys.argv[1], sys.argv[2]
SIZE = 1024
RADIUS = int(SIZE * 0.224)  # ~229px, macOS Big Sur+ icon corner ratio

img = Image.open(SRC).convert("RGBA")
img = img.resize((SIZE, SIZE), Image.LANCZOS)

# Supersampled rounded-rect mask for smooth edges.
SS = 4
mask = Image.new("L", (SIZE * SS, SIZE * SS), 0)
draw = ImageDraw.Draw(mask)
draw.rounded_rectangle(
    [0, 0, SIZE * SS - 1, SIZE * SS - 1],
    radius=RADIUS * SS,
    fill=255,
)
mask = mask.resize((SIZE, SIZE), Image.LANCZOS)

img.putalpha(mask)
img.save(OUT, "PNG")
print(f"wrote {OUT} ({SIZE}x{SIZE}, rounded, alpha)")
