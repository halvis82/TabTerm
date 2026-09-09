#!/usr/bin/env python3
"""
The macOS app icon, every size, from the 1024 master.

Run by hand when the artwork changes, not part of the build: it needs Pillow, which nothing else
here does, and the output is committed.

    python3 scripts/build-icons.py && iconutil -c icns assets/TabTerm.iconset -o assets/TabTerm.icns

The master is 844px of artwork centered in a 1024 black square. The artwork already carries the
macOS squircle curve; the black square around it does not, which is what reads as square corners
anywhere the background is not also black. So the black is dropped and the artwork's own shape
becomes the icon's edge, then the whole thing is inset again to leave the margin the macOS icon
grid expects.

This deliberately does not touch the extension icons. Those are the blue >_ marks, which are their
own design and read better on a tab strip at 16px than this artwork does.
"""
from PIL import Image, ImageDraw, ImageEnhance

SRC = 'assets/source/master-1024.png'
BOX = (90, 88, 934, 933)          # the artwork inside the black padding
RADIUS = 0.22                     # the curve the artwork already has, and macOS uses
INSET = 0.09                      # the margin the macOS icon grid expects
BRIGHTNESS, SATURATION = 1.22, 1.08

art = Image.open(SRC).convert('RGBA').crop(BOX).resize((1024, 1024), Image.LANCZOS)
art = ImageEnhance.Color(ImageEnhance.Brightness(art).enhance(BRIGHTNESS)).enhance(SATURATION)

mask = Image.new('L', (1024, 1024), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, 1023, 1023], radius=int(1024 * RADIUS), fill=255)
tight = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
tight.paste(art, (0, 0), mask)

side = int(1024 * (1 - INSET * 2))
icon = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
icon.paste(tight.resize((side, side), Image.LANCZOS), ((1024 - side) // 2,) * 2)
icon.save('assets/source/derived-app-1024.png')

for n, name in [(16, '16x16'), (32, '16x16@2x'), (32, '32x32'), (64, '32x32@2x'), (128, '128x128'),
                (256, '128x128@2x'), (256, '256x256'), (512, '256x256@2x'), (512, '512x512'),
                (1024, '512x512@2x')]:
    icon.resize((n, n), Image.LANCZOS).save(f'assets/TabTerm.iconset/icon_{name}.png')

print('  assets/TabTerm.iconset written; run iconutil to pack it')
