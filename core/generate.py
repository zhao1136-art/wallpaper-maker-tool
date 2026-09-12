# -*- coding: utf-8 -*-
"""壁纸生成与检索：程序化精选壁纸 / 跨屏拼接 / dHash 以图搜图（Pillow）"""
import json
import math
import random
import threading
import time
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

BASE = Path(__file__).resolve().parent.parent
WALLPAPERS_DIR = BASE / "wallpapers"
BUILTIN_DIR = WALLPAPERS_DIR / "builtin"
USER_DIR = WALLPAPERS_DIR / "user"
CACHE_DIR = BASE / "assets" / "wallpaper_cache"
MANIFEST_FILE = BUILTIN_DIR / "manifest.json"

W, H = 1920, 1080
PRIMARY = "rgb(91,140,255)"

_generate_lock = threading.Lock()


def ensure_dirs():
    for d in (BUILTIN_DIR, USER_DIR, CACHE_DIR):
        d.mkdir(parents=True, exist_ok=True)


# ---------------- 生成器 ----------------

def _gradient(w, h, c1, c2, angle=0, noise=0.0):
    """线性渐变 + 可选噪点/暗角。
    先在小尺寸（1/4，像素量约 1/16）逐像素计算，再 LANCZOS 放大：
    线性渐变放大视觉无差，噪点在放大后转为细颗粒，首启生成显著提速。
    """
    sw = max(2, w // 4)
    sh = max(2, h // 4)
    a = math.radians(angle)
    img = Image.new("RGB", (sw, sh))
    px = img.load()
    dx, dy = math.cos(a), math.sin(a)
    L = abs(dx) * sw / 2 + abs(dy) * sh / 2
    cx, cy = sw / 2, sh / 2
    rnd = random.Random(7)  # 固定种子，保证噪点可复现
    for y in range(sh):
        for x in range(sw):
            t = ((x - cx) * dx + (y - cy) * dy) / L + 0.5
            t = max(0.0, min(1.0, t))
            r = int(c1[0] + (c2[0] - c1[0]) * t)
            g = int(c1[1] + (c2[1] - c1[1]) * t)
            b = int(c1[2] + (c2[2] - c1[2]) * t)
            if noise:
                n = rnd.randint(-noise, noise)
                px[x, y] = (max(0, min(255, r + n)),
                            max(0, min(255, g + n)),
                            max(0, min(255, b + n)))
            else:
                px[x, y] = (r, g, b)
    if (sw, sh) != (w, h):
        img = img.resize((w, h), Image.LANCZOS)
    return img


def _vignette(img, strength=90):
    w, h = img.size
    mask = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(mask)
    d.ellipse((-w * 0.35, -h * 0.35, w * 1.35, h * 1.35), fill=strength)
    mask = mask.filter(ImageFilter.GaussianBlur(w / 6))
    black = Image.new("RGB", (w, h), (8, 10, 16))
    img = Image.composite(black, img, mask)
    return img


def _aurora(w, h, palette):
    img = Image.new("RGB", (w, h), palette[0])
    d = ImageDraw.Draw(img, "RGBA")
    rnd = random.Random(7)
    for i in range(9):
        y = h * (0.15 + 0.72 * i / 8)
        amp = h * (0.06 + 0.05 * rnd.random())
        col = palette[1 + i % (len(palette) - 1)] + (int(70 + 40 * rnd.random()),)
        pts = []
        for x in range(0, w + 80, 60):
            yy = y + math.sin(x / (w * 0.12) + i) * amp + rnd.uniform(-20, 20)
            pts.append((x, yy))
        d.line(pts, fill=col, width=int(h * 0.05))
    img = img.filter(ImageFilter.GaussianBlur(26))
    img = Image.blend(img, Image.new("RGB", (w, h), palette[0]), 0.25)
    return img


def _stars(w, h, count=520, glow=True):
    rnd = random.Random(3)
    img = Image.new("RGB", (w, h), (6, 8, 18))
    d = ImageDraw.Draw(img, "RGBA")
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    dl = ImageDraw.Draw(layer)
    for _ in range(count):
        x, y = rnd.randint(0, w), rnd.randint(0, int(h * 0.85))
        r = rnd.choice([1, 1, 1, 2, 2, 3])
        br = rnd.randint(140, 255)
        dl.ellipse((x - r, y - r, x + r, y + r), fill=(br, br, min(255, br + 30), 255))
    if glow:
        layer = layer.filter(ImageFilter.GaussianBlur(1.2))
    img = Image.alpha_composite(img.convert("RGBA"), layer).convert("RGB")
    # 银河横带
    d = ImageDraw.Draw(img, "RGBA")
    for i in range(60):
        y = int(h * 0.3) + int(30 * math.sin(i / 6))
        a = 8
        d.ellipse((i * (w / 60), y - 6, i * (w / 60) + 90, y + 6),
                  fill=(150, 160, 200, a))
    img = Image.blend(img, Image.new("RGB", (w, h), (20, 24, 48)), 0.12)
    return img


def _waves(w, h, c1, c2):
    img = Image.new("RGB", (w, h), c2)
    d = ImageDraw.Draw(img, "RGBA")
    for i, yy in enumerate(range(0, h + 90, 90)):
        col = c1 + (int(60 + 40 * (i % 3)),)
        pts = [(x, yy + int(46 * math.sin(x / 240 + i * 1.3))) for x in range(0, w + 40, 40)]
        d.line(pts, fill=col, width=34)
    return img.filter(ImageFilter.GaussianBlur(3))


def _mountains(w, h, palette):
    rnd = random.Random(5)
    img = Image.new("RGB", (w, h), palette[0])
    d = ImageDraw.Draw(img)
    for layer_i, base in enumerate(palette[1:]):
        y0 = h * (0.45 + layer_i * 0.17)
        pts = [(0, h)]
        x = 0
        while x <= w:
            pts.append((x, y0 - rnd.randint(40, 140) - layer_i * 30))
            x += rnd.randint(120, 240)
        pts.append((w, h))
        d.polygon(pts, fill=base)
    # 太阳
    sun_r = 46
    d.ellipse((w * 0.62 - sun_r, h * 0.36 - sun_r, w * 0.62 + sun_r, h * 0.36 + sun_r),
              fill=(255, 214, 150))
    img = img.filter(ImageFilter.GaussianBlur(0.6))
    return img


def _shapes(w, h, palette, style="grid"):
    rnd = random.Random(9)
    img = Image.new("RGB", (w, h), palette[0])
    d = ImageDraw.Draw(img)
    if style == "grid":
        gap = 180
        for gx in range(0, w + gap, gap):
            for gy in range(0, h + gap, gap):
                col = rnd.choice(palette[1:])
                r = rnd.randint(30, 90)
                x = gx + rnd.randint(0, gap) - gap // 2
                y = gy + rnd.randint(0, gap) - gap // 2
                kind = rnd.random()
                if kind < 0.5:
                    d.ellipse((x - r, y - r, x + r, y + r), fill=col)
                elif kind < 0.75:
                    d.polygon([(x, y - r), (x + r, y), (x, y + r), (x - r, y)], fill=col)
                else:
                    d.rectangle((x - r, y - r, x + r, y + r), fill=col)
    else:
        for _ in range(26):
            x, y = rnd.randint(0, w), rnd.randint(0, h)
            r = rnd.randint(60, 240)
            col = rnd.choice(palette[1:]) + (int(90 + 60 * rnd.random()),)
            d.ellipse((x - r, y - r, x + r, y + r), fill=col)
        img = img.filter(ImageFilter.GaussianBlur(1))
    img = _vignette(img, 70)
    return img


def _bokeh(w, h, palette):
    rnd = random.Random(11)
    img = Image.new("RGB", (w, h), palette[0])
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer, "RGBA")
    for _ in range(70):
        x, y = rnd.randint(0, w), rnd.randint(0, h)
        r = rnd.randint(8, 46)
        col = rnd.choice(palette[1:]) + (int(30 + 50 * rnd.random()),)
        d.ellipse((x - r, y - r, x + r, y + r), fill=col)
        d.ellipse((x - r * 0.4, y - r * 0.4, x + r * 0.4, y + r * 0.4),
                  fill=(255, 255, 255, 26))
    img = Image.alpha_composite(img.convert("RGBA"), layer).convert("RGB")
    img = img.filter(ImageFilter.GaussianBlur(6))
    return img


# 生成清单：名称 + 生成函数 + 调色板
def _plan():
    return [
        ("极夜蓝紫渐变", _gradient, (16, 20, 60), {"c1": (10, 14, 48), "c2": (86, 66, 168), "angle": 135, "noise": 5}),
        ("落日橙粉渐变", _gradient, (255, 120, 90), {"c1": (255, 120, 90), "c2": (255, 94, 98), "angle": 45, "noise": 4}),
        ("森林青绿渐变", _gradient, (12, 60, 52), {"c1": (12, 60, 52), "c2": (46, 160, 128), "angle": 160, "noise": 4}),
        ("冰川蓝渐变", _gradient, (30, 80, 160), {"c1": (30, 80, 160), "c2": (140, 210, 240), "angle": 90, "noise": 4}),
        ("暗夜红渐变", _gradient, (60, 8, 30), {"c1": (60, 8, 30), "c2": (200, 40, 80), "angle": 120, "noise": 5}),
        ("暖阳金黄渐变", _gradient, (255, 170, 60), {"c1": (255, 170, 60), "c2": (255, 220, 130), "angle": 60, "noise": 3}),
        ("深海蓝渐变", _gradient, (4, 20, 60), {"c1": (4, 20, 60), "c2": (30, 90, 170), "angle": 100, "noise": 4}),
        ("玫瑰粉紫渐变", _gradient, (120, 40, 90), {"c1": (120, 40, 90), "c2": (255, 140, 190), "angle": 150, "noise": 4}),
        ("极光青绿", _aurora, (6, 24, 44), {"palette": [(6, 24, 44), (40, 220, 170), (70, 180, 255), (160, 90, 255)]}),
        ("极光粉紫", _aurora, (20, 10, 40), {"palette": [(20, 10, 40), (255, 90, 190), (140, 80, 255), (60, 200, 255)]}),
        ("极光琥珀", _aurora, (24, 16, 8), {"palette": [(24, 16, 8), (255, 160, 60), (255, 220, 120), (200, 80, 40)]}),
        ("星空银河", _stars, (8, 12, 30), {"count": 620}),
        ("星云紫蓝", _stars, (16, 10, 46), {"count": 420}),
        ("深夜繁星", _stars, (4, 6, 14), {"count": 820}),
        ("碧海波浪", _waves, (20, 60, 90), {"c1": (20, 80, 130), "c2": (10, 30, 60)}),
        ("珊瑚粉浪", _waves, (255, 120, 150), {"c1": (255, 120, 150), "c2": (40, 24, 60)}),
        ("薄荷波浪", _waves, (120, 220, 200), {"c1": (120, 220, 200), "c2": (16, 60, 70)}),
        ("暮色山峦", _mountains, (20, 24, 60), {"palette": [(20, 24, 60), (60, 46, 110), (120, 70, 140), (200, 110, 120), (255, 170, 130)]}),
        ("雪岭晨光", _mountains, (40, 60, 90), {"palette": [(40, 60, 90), (90, 120, 160), (160, 190, 210), (240, 245, 250)]}),
        ("沙漠山丘", _mountains, (90, 50, 30), {"palette": [(90, 50, 30), (150, 90, 50), (210, 140, 80), (255, 200, 130)]}),
        ("几何圆点", _shapes, (18, 22, 34), {"palette": [(18, 22, 34), (90, 140, 255), (255, 90, 150), (70, 220, 180)], "style": "grid"}),
        ("几何拼图", _shapes, (16, 14, 30), {"palette": [(16, 14, 30), (255, 180, 60), (60, 200, 255), (200, 90, 255)], "style": "grid"}),
        ("光晕粒子", _shapes, (10, 12, 30), {"palette": [(10, 12, 30), (60, 100, 255), (120, 200, 255), (200, 120, 255)], "style": "bokeh"}),
        ("霓虹光斑", _bokeh, (12, 8, 30), {"palette": [(12, 8, 30), (255, 60, 160), (60, 140, 255), (60, 255, 200)]}),
        ("暖金光斑", _bokeh, (40, 24, 10), {"palette": [(40, 24, 10), (255, 190, 90), (255, 240, 200)]}),
    ]


def generate_builtin(force=False):
    """生成全部内置精选壁纸（幂等）。返回生成的条目列表"""
    with _generate_lock:
        return _generate_builtin_locked(force)


def _generate_builtin_locked(force=False):
    ensure_dirs()
    plan = _plan()
    items = []
    manifest = {}
    if MANIFEST_FILE.exists():
        try:
            manifest = json.loads(MANIFEST_FILE.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            manifest = {}
    for i, (name, fn, _default, kwargs) in enumerate(plan):
        fname = "%02d-%s.png" % (i + 1, name)
        target = BUILTIN_DIR / fname
        if target.exists() and not force:
            items.append({"file": fname, "name": name, "source": "builtin"})
            continue
        img = fn(W, H, **kwargs)
        img.save(target, "PNG", optimize=True)
        items.append({"file": fname, "name": name, "source": "builtin"})
        manifest[fname] = {"name": name, "kind": "generated"}
    MANIFEST_FILE.write_text(json.dumps(manifest, ensure_ascii=False, indent=2),
                             encoding="utf-8")
    return items


# ---------------- 壁纸库 ----------------

def list_library():
    """壁纸库条目：[{file, name, source, size}]（不含缩略图标记）"""
    ensure_dirs()
    items = []
    for source, d in (("builtin", BUILTIN_DIR), ("user", USER_DIR)):
        for f in sorted(d.glob("*.*")):
            if f.suffix.lower() not in (".png", ".jpg", ".jpeg", ".webp", ".bmp"):
                continue
            items.append({
                "file": "%s/%s" % (source, f.name),
                "name": f.stem,
                "source": source,
                "size": f.stat().st_size,
            })
    return items


def resolve(path):
    """把 'builtin/xx.png' 相对路径解析为绝对路径"""
    rel = Path(path)
    if rel.is_absolute():
        return rel if rel.exists() else None
    for base in (BASE, WALLPAPERS_DIR):
        cand = base / path
        if cand.exists():
            return cand
    return None


def import_to_library(src_path):
    """复制用户图片到 user 目录，返回条目"""
    ensure_dirs()
    src = Path(src_path)
    if not src.exists():
        return None
    ext = src.suffix.lower() or ".png"
    target = USER_DIR / ("user-%d%s" % (int(time.time() * 1000) % 1000000, ext))
    target.write_bytes(src.read_bytes())
    return {"file": "user/%s" % target.name, "name": target.stem, "source": "user"}


# ---------------- 跨屏拼接 ----------------

def build_span_image(image_path, monitors, cache_name="span.png"):
    """将单张图片 cover-fit 拼接到虚拟桌面尺寸，返回缓存文件绝对路径"""
    ensure_dirs()
    img = Image.open(image_path).convert("RGB")
    min_l = min(m["left"] for m in monitors)
    min_t = min(m["top"] for m in monitors)
    vw = max(m["right"] for m in monitors) - min_l
    vh = max(m["bottom"] for m in monitors) - min_t
    canvas = Image.new("RGB", (vw, vh), (10, 12, 18))
    ir = img.width / img.height
    cr = vw / vh
    if ir > cr:
        dw, dh = vw, int(vw / ir)
    else:
        dh, dw = vh, int(vh * ir)
    img = img.resize((dw, dh), Image.LANCZOS)
    canvas.paste(img, ((vw - dw) // 2, (vh - dh) // 2))
    out = CACHE_DIR / cache_name
    canvas.save(out, "PNG")
    return out


# ---------------- dHash 以图搜图 ----------------

def _dhash(img, size=8):
    gray = img.convert("L").resize((size + 1, size), Image.LANCZOS)
    bits = []
    for y in range(size):
        for x in range(size):
            bits.append(1 if gray.getpixel((x, y)) > gray.getpixel((x + 1, y)) else 0)
    return int("".join(str(b) for b in bits), 2)


def _hamming(a, b):
    return bin(a ^ b).count("1")


def find_similar(query_path, top=8, threshold=16):
    """对壁纸库做以图搜图，返回 [{file,name,dist}] 按相似度升序"""
    try:
        q = _dhash(Image.open(query_path).convert("RGB"))
    except OSError:
        return []
    results = []
    for item in list_library():
        p = resolve(item["file"])
        if not p:
            continue
        try:
            d = _hamming(q, _dhash(Image.open(p).convert("RGB")))
        except OSError:
            continue
        results.append({"file": item["file"], "name": item["name"],
                        "dist": d, "source": item["source"]})
    results.sort(key=lambda r: r["dist"])
    return [r for r in results if r["dist"] <= threshold][:top]
