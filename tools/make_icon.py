"""Draws assets/icon.ico: a lit keycap with a U on it. Needs Pillow."""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

SIZE = 512
ACCENT = (255, 139, 61)
BODY = (25, 27, 29)
CAP = (42, 45, 49)


def draw():
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    ImageDraw.Draw(img).rounded_rectangle((16, 16, SIZE - 16, SIZE - 16), radius=112, fill=BODY)

    glow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    ImageDraw.Draw(glow).rounded_rectangle((96, 96, SIZE - 96, SIZE - 96), radius=72, fill=ACCENT + (255,))
    glow = glow.filter(ImageFilter.GaussianBlur(34))
    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle((16, 16, SIZE - 16, SIZE - 16), radius=112, fill=255)
    img.paste(glow, (0, 0), Image.composite(glow.getchannel("A"), Image.new("L", (SIZE, SIZE), 0), mask))

    d = ImageDraw.Draw(img)
    d.rounded_rectangle((112, 112, SIZE - 112, SIZE - 112), radius=60, fill=CAP, outline=ACCENT, width=10)
    try:
        font = ImageFont.truetype("segoeuib.ttf", 210)
    except OSError:
        font = ImageFont.load_default(210)
    d.text((SIZE / 2, SIZE / 2 - 6), "U", font=font, fill=ACCENT, anchor="mm")
    return img


if __name__ == "__main__":
    out = Path(__file__).resolve().parent.parent / "assets"
    out.mkdir(exist_ok=True)
    icon = draw()
    icon.save(out / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    icon.resize((256, 256), Image.LANCZOS).save(out / "icon.png")
    print("wrote", out / "icon.ico")
