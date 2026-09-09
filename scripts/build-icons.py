"""
Every icon size, from the 1024 master.

The master is 844px of artwork centered in a 1024 black square. The artwork already carries the
macOS squircle curve; the black square around it does not, which is what reads as "square corners"
anywhere the background is not also black. So the black is dropped and the artwork's own shape
becomes the icon's edge.

Two shapes come out of this, because the two jobs differ. A macOS app icon is expected to leave a
margin inside its canvas, and sits at 128px and up. A favicon is 16px on a tab strip and needs
every pixel it can get.
"""
from PIL import Image, ImageDraw, ImageEnhance

SRC = 'assets/source/master-1024.png'
BOX = (90, 88, 934, 933)          # the artwork inside the black padding
RADIUS = 0.22                     # the curve the artwork already has, and macOS uses
BRIGHTNESS, SATURATION = 1.22, 1.08

art = Image.open(SRC).convert('RGBA').crop(BOX)
art = art.resize((1024, 1024), Image.LANCZOS)
art = ImageEnhance.Color(ImageEnhance.Brightness(art).enhance(BRIGHTNESS)).enhance(SATURATION)

mask = Image.new('L', (1024, 1024), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, 1023, 1023], radius=int(1024 * RADIUS), fill=255)
tight = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
tight.paste(art, (0, 0), mask)
tight.save('assets/source/derived-tight-1024.png')

# The macOS canvas: the same shape, inset to leave the margin the platform's grid expects.
INSET = 0.09
side = int(1024 * (1 - INSET * 2))
padded = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
padded.paste(tight.resize((side, side), Image.LANCZOS), ((1024 - side) // 2,) * 2)
padded.save('assets/source/derived-app-1024.png')

for n in (16, 32, 48, 128):
    tight.resize((n, n), Image.LANCZOS).save(f'extension/public/icon{n}.png')

for n, name in [(16,'16x16'),(32,'16x16@2x'),(32,'32x32'),(64,'32x32@2x'),(128,'128x128'),
                (256,'128x128@2x'),(256,'256x256'),(512,'256x256@2x'),(512,'512x512'),(1024,'512x512@2x')]:
    padded.resize((n, n), Image.LANCZOS).save(f'assets/TabTerm.iconset/icon_{name}.png')

print('  extension + favicon: artwork edge to edge')
print('  app icon:            same shape, 9% margin for the macOS grid')
