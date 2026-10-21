"""Checks photo.js's privacy cleaning against real photos with hidden details.

    pip install pillow   (once)
    python3 tests/photo_test.py

Makes test photos stuffed with GPS location, camera model, comments and
other hidden details, runs them through photo.js (with Node), and checks with
an independent image library that:
  - the hidden details are gone,
  - the picture itself is identical, pixel for pixel (no quality loss),
  - colour profile and rotation are kept.
"""
import io, json, os, subprocess, sys, tempfile
from PIL import Image, ImageCms, PngImagePlugin

HERE = os.path.dirname(os.path.abspath(__file__))
CLI = os.path.join(HERE, "clean_photo_cli.mjs")
results = []
check = lambda cond, label: results.append(("PASS" if cond else "FAIL") + "  " + label)
tmp = tempfile.mkdtemp()
SECRETS = [b"SecretCam", b"Pixel 99 Pro", b"secret comment", b"Taman Tun", b"photoshop-ish"]


def picture(w=640, h=480, mode="RGB"):
    img = Image.new(mode, (w, h))
    px = img.load()
    for y in range(h):
        for x in range(w):
            v = ((x * 7) ^ (y * 13)) & 0xFF
            px[x, y] = (v, (x * 3) & 0xFF, (y * 5) & 0xFF) if mode == "RGB" else (v, (x * 3) & 0xFF, (y * 5) & 0xFF, (x + y) & 0xFF)
    return img


def private_exif(orientation=6):
    exif = Image.Exif()
    exif[0x0112] = orientation          # rotation
    exif[0x010F] = "SecretCam"          # make
    exif[0x0110] = "Pixel 99 Pro"       # model
    exif[0x0132] = "2026:10:21 18:00:00"
    gps = exif.get_ifd(0x8825)
    gps[1] = "N"; gps[2] = (3.0, 8.0, 51.0)       # Kuala Lumpur-ish
    gps[3] = "E"; gps[4] = (101.0, 41.0, 11.0)
    return exif


def clean(path):
    out = path + ".clean"
    r = subprocess.run(["node", CLI, path, out], capture_output=True, text=True, check=True)
    info = json.loads(r.stdout)
    data = open(out, "rb").read() if info.get("ok") else b""
    return info, data


def no_secrets(data):
    return not any(s in data for s in SECRETS) and b"GPS" not in data


srgb = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()

# ---- JPEG (baseline and progressive), with GPS, camera, comment, XMP, ICC, trailer ----
for progressive in (False, True):
    label = "progressive JPEG" if progressive else "JPEG"
    p = os.path.join(tmp, f"photo{'_p' if progressive else ''}.jpg")
    buf = io.BytesIO()
    picture().save(buf, "JPEG", quality=97, exif=private_exif(6).tobytes(), comment=b"secret comment",
                   icc_profile=srgb, progressive=progressive,
                   xmp=b'<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:Description photoshop:City="Taman Tun" photoshop-ish="1"/></x:xmpmeta>')
    raw = buf.getvalue() + b"SEFH....Pixel 99 Pro trailer data after the picture"
    open(p, "wb").write(raw)
    original = Image.open(io.BytesIO(raw))
    check(b"Taman Tun" in raw and b"SecretCam" in raw, f"{label}: test photo really contains location/camera details")

    info, data = clean(p)
    check(info.get("ok"), f"{label}: cleaned without errors ({info})")
    cleaned = Image.open(io.BytesIO(data))
    exif = cleaned.getexif()
    check(no_secrets(data), f"{label}: GPS, camera, XMP, comment and trailer are all gone")
    check(dict(exif) == {0x0112: 6}, f"{label}: only the rotation flag is left ({dict(exif)})")
    check(cleaned.info.get("icc_profile") == srgb, f"{label}: colour profile kept")
    check(cleaned.tobytes() == original.tobytes(), f"{label}: picture is identical pixel for pixel (no re-compression)")
    check(info["width"] == 480 and info["height"] == 640, f"{label}: reports the rotated size (480x640)")
    check(len(data) < len(raw), f"{label}: file got smaller, not bigger ({len(raw)} → {len(data)} bytes)")

# ---- JPEG that is already upright: no EXIF left at all ----
p = os.path.join(tmp, "upright.jpg")
picture().save(p, "JPEG", quality=95, exif=private_exif(1).tobytes())
info, data = clean(p)
check(info.get("ok") and b"Exif" not in data and no_secrets(data), "Upright JPEG: no EXIF block kept at all")

# ---- PNG with EXIF and text chunks ----
p = os.path.join(tmp, "shot.png")
meta = PngImagePlugin.PngInfo()
meta.add_text("Comment", "secret comment")
meta.add_itxt("Location", "Taman Tun")
original = picture(320, 200, "RGBA")
original.save(p, "PNG", pnginfo=meta, exif=private_exif(1).tobytes(), icc_profile=srgb)
raw = open(p, "rb").read()
info, data = clean(p)
cleaned = Image.open(io.BytesIO(data))
check(info.get("ok") and no_secrets(data) and b"eXIf" not in data and b"tEXt" not in data and b"iTXt" not in data, "PNG: text, location and EXIF chunks removed")
check(cleaned.tobytes() == Image.open(p).tobytes() and cleaned.mode == "RGBA", "PNG: picture identical, transparency kept")
check(cleaned.info.get("icc_profile") == srgb, "PNG: colour profile kept")

# ---- WebP with EXIF and XMP ----
for lossless in (False, True):
    label = "lossless WebP" if lossless else "WebP"
    p = os.path.join(tmp, f"pic{'_ll' if lossless else ''}.webp")
    picture(300, 220).save(p, "WEBP", quality=90, lossless=lossless, exif=private_exif(1).tobytes(),
                           xmp=b'<x:xmpmeta photoshop:City="Taman Tun"/>', icc_profile=srgb)
    info, data = clean(p)
    cleaned = Image.open(io.BytesIO(data)); cleaned.load()
    check(info.get("ok") and no_secrets(data) and b"EXIF" not in data and b"XMP " not in data, f"{label}: EXIF and XMP removed")
    check(cleaned.convert("RGB").tobytes() == Image.open(p).convert("RGB").tobytes(), f"{label}: picture identical")
    check(info["width"] == 300 and info["height"] == 220, f"{label}: size read correctly")

# ---- Animated GIF with a comment ----
p = os.path.join(tmp, "anim.gif")
frames = [picture(80, 60).convert("P"), picture(80, 60).rotate(90).convert("P")]
frames[0].save(p, "GIF", save_all=True, append_images=frames[1:], loop=0, duration=200, comment=b"secret comment")
info, data = clean(p)
cleaned = Image.open(io.BytesIO(data))
check(info.get("ok") and no_secrets(data), "GIF: comment removed")
check(getattr(cleaned, "n_frames", 1) == 2 and cleaned.info.get("loop") == 0, "GIF: still animated and still loops")

# ---- Unsupported and damaged files ----
p = os.path.join(tmp, "fake.heic")
open(p, "wb").write(b"\x00\x00\x00\x18ftypheic" + b"\x00" * 64)
info, _ = clean(p)
check(not info["ok"] and info["code"] == "unsupported", "HEIC is passed on to be converted, not sent raw")
p = os.path.join(tmp, "broken.jpg")
open(p, "wb").write(open(os.path.join(tmp, "photo.jpg"), "rb").read()[:3000])
info, _ = clean(p)
check(not info["ok"] and info["code"] == "damaged", "A cut-off JPEG is refused as damaged")

print("\n".join(results))
failed = sum(r.startswith("FAIL") for r in results)
print(f"\n{len(results) - failed} passed, {failed} failed")
sys.exit(1 if failed else 0)
