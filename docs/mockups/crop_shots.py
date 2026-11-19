import sys
from PIL import Image

for path in sys.argv[1:]:
    image = Image.open(path).convert("RGB")
    width, height = image.size
    background = image.getpixel((2, 2))
    pixels = image.load()
    left, top, right, bottom = width, height, 0, 0
    for y in range(height):
        for x in range(width):
            red, green, blue = pixels[x, y]
            if abs(red - background[0]) + abs(green - background[1]) + abs(blue - background[2]) > 8:
                if x < left: left = x
                if y < top: top = y
                if x > right: right = x
                if y > bottom: bottom = y
    if right <= left or bottom <= top:
        continue
    pad = 14
    box = (max(0, left - pad), max(0, top - pad), min(width, right + 1 + pad), min(height, bottom + 1 + pad))
    image.crop(box).save(path)
    print(path.split("/")[-1], "->", box[2] - box[0], "x", box[3] - box[1])
