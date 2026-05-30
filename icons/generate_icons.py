"""
Generate PWA PNG icons (192 & 512, plus maskable) from the MET pin design.
Drawn with Pillow at 4x supersample, then downscaled for smooth edges.

Design matches icon.svg: navy rounded square, red map-pin with navy dot,
"MET" wordmark — but laid out inside Android's maskable "safe zone" (center
~80%) so launchers that crop to a circle don't clip the pin or text.

Run:  python generate_icons.py
"""

from PIL import Image, ImageDraw, ImageFont
import os

BG   = (15, 52, 96)     # #0f3460 navy
RED  = (233, 69, 96)    # #e94560
TEXT = (234, 234, 234)  # #eaeaea

HERE = os.path.dirname(os.path.abspath(__file__))


def load_font(px):
    for name in ("arialbd.ttf", "Arialbd.ttf", "DejaVuSans-Bold.ttf"):
        try:
            return ImageFont.truetype(name, px)
        except OSError:
            continue
    # Last resort: PIL's bundled bold
    return ImageFont.truetype("DejaVuSans-Bold.ttf", px)


def draw_icon(size, maskable=True):
    """Render the icon at `size` px. Supersampled 4x internally."""
    SS = 4
    S = size * SS
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Background: full-bleed for maskable; rounded corners for "any".
    if maskable:
        d.rectangle([0, 0, S, S], fill=BG)
    else:
        r = int(S * 0.16)
        d.rounded_rectangle([0, 0, S, S], radius=r, fill=BG)

    cx = S / 2

    # Pin geometry (kept within center ~80% safe zone)
    pin_cy = S * 0.40
    pin_r  = S * 0.16
    dot_r  = S * 0.065

    # Pin head
    d.ellipse([cx - pin_r, pin_cy - pin_r, cx + pin_r, pin_cy + pin_r], fill=RED)
    # Pin tail (triangle)
    tail_tip_y = S * 0.66
    tail_w     = pin_r * 0.95
    d.polygon([(cx, tail_tip_y),
               (cx - tail_w, pin_cy + pin_r * 0.55),
               (cx + tail_w, pin_cy + pin_r * 0.55)], fill=RED)
    # Inner dot
    d.ellipse([cx - dot_r, pin_cy - dot_r, cx + dot_r, pin_cy + dot_r], fill=BG)

    # MET wordmark, centered inside safe zone
    font = load_font(int(S * 0.155))
    text = "MET"
    bbox = d.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    tx = cx - tw / 2 - bbox[0]
    ty = S * 0.80 - th / 2 - bbox[1]
    d.text((tx, ty), text, font=font, fill=TEXT)

    return img.resize((size, size), Image.LANCZOS)


def main():
    # "any" purpose — rounded corners, used in browser/tab/splash
    draw_icon(192, maskable=False).save(os.path.join(HERE, "icon-192.png"))
    draw_icon(512, maskable=False).save(os.path.join(HERE, "icon-512.png"))
    # "maskable" purpose — full-bleed, content in safe zone, for Android home screen
    draw_icon(192, maskable=True).save(os.path.join(HERE, "icon-192-maskable.png"))
    draw_icon(512, maskable=True).save(os.path.join(HERE, "icon-512-maskable.png"))
    print("Wrote icon-192.png, icon-512.png, icon-192-maskable.png, icon-512-maskable.png")


if __name__ == "__main__":
    main()
