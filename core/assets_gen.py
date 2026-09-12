# -*- coding: utf-8 -*-
"""内置素材库程序化生成：纹理 / 光斑 / 渐变卡片 / 剪贴元素
首次启动时写入 assets/images + assets/thumbs，并追加 library.json（source:"builtin"）。
幂等：已存在的 id 跳过，可重复调用。
"""
import json
import math
import random
import threading
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageOps

from . import generate

BASE = Path(__file__).resolve().parent.parent
IMAGES_DIR = BASE / "assets" / "images"
THUMBS_DIR = BASE / "assets" / "thumbs"
LIBRARY_FILE = BASE / "library.json"

SIZE = 512
THUMB_SIZE = 320
_gen_lock = threading.Lock()

# 精选配色（主色 / 亮色）
PALETTES = [
    ("金", (255, 200, 120), (255, 240, 205)),
    ("粉", (255, 120, 190), (255, 205, 230)),
    ("青", (80, 210, 255), (185, 245, 255)),
    ("紫", (160, 120, 255), (225, 205, 255)),
    ("薄荷", (80, 230, 180), (195, 255, 235)),
    ("珊瑚", (255, 140, 110), (255, 205, 185)),
    ("冰蓝", (120, 170, 255), (205, 225, 255)),
    ("柠檬", (255, 220, 90), (255, 245, 190)),
]


def _load_library():
    try:
        return json.loads(LIBRARY_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []


def _save_library(items):
    LIBRARY_FILE.write_text(json.dumps(items, ensure_ascii=False, indent=2),
                            encoding="utf-8")


# ---------------- 纹理 ----------------
def _tex_noise(seed, dark, light):
    img = Image.effect_noise((SIZE, SIZE), random.Random(seed).uniform(16, 26))
    return ImageOps.colorize(img, dark, light)


def _tex_stripes(seed, c1, c2):
    rnd = random.Random(seed)
    img = Image.new("RGB", (SIZE, SIZE), c1)
    d = ImageDraw.Draw(img)
    gap = rnd.randint(26, 44)
    for x in range(0, SIZE + gap, gap):
        d.rectangle((x, 0, x + max(3, gap // 3), SIZE), fill=c2)
    return img.rotate(rnd.choice([15, 30, 45, 60]), resample=Image.BICUBIC,
                      fillcolor=c1)


def _tex_dots(seed, c1, c2):
    rnd = random.Random(seed)
    img = Image.new("RGB", (SIZE, SIZE), c1)
    d = ImageDraw.Draw(img)
    gap = rnd.randint(40, 64)
    r = rnd.randint(6, 12)
    for x in range(gap // 2, SIZE, gap):
        for y in range(gap // 2, SIZE, gap):
            d.ellipse((x - r, y - r, x + r, y + r), fill=c2)
    return img


def _tex_waves2(seed, c1, c2):
    img = Image.new("RGB", (SIZE, SIZE), c1)
    d = ImageDraw.Draw(img, "RGBA")
    for i, y in enumerate(range(0, SIZE + 60, 60)):
        col = c2 + (int(70 + 50 * (i % 2)),)
        pts = [(x, y + int(24 * math.sin(x / 60 + i))) for x in range(0, SIZE + 20, 20)]
        d.line(pts, fill=col, width=20)
    return img.filter(ImageFilter.GaussianBlur(2))


def _tex_grid(seed, c1, c2):
    rnd = random.Random(seed)
    img = Image.new("RGB", (SIZE, SIZE), c1)
    d = ImageDraw.Draw(img)
    g = rnd.randint(48, 72)
    for x in range(0, SIZE, g):
        d.line((x, 0, x, SIZE), fill=c2, width=2)
    for y in range(0, SIZE, g):
        d.line((0, y, SIZE, y), fill=c2, width=2)
    return img


def _tex_mesh(seed, c1, c2, c3):
    rnd = random.Random(seed)
    img = Image.new("RGB", (SIZE, SIZE), c1)
    d = ImageDraw.Draw(img, "RGBA")
    for _ in range(14):
        x, y = rnd.randint(0, SIZE), rnd.randint(0, SIZE)
        r = rnd.randint(60, 200)
        col = rnd.choice([c1, c2, c3]) + (int(40 + 60 * rnd.random()),)
        d.ellipse((x - r, y - r, x + r, y + r), fill=col)
    return img.filter(ImageFilter.GaussianBlur(rnd.randint(18, 36)))


# ---------------- 光斑 ----------------
def _bokeh(seed, base, colors):
    rnd = random.Random(seed)
    img = Image.new("RGB", (SIZE, SIZE), base)
    d = ImageDraw.Draw(img, "RGBA")
    for _ in range(60):
        x, y = rnd.randint(0, SIZE), rnd.randint(0, SIZE)
        r = rnd.randint(10, 70)
        col = rnd.choice(colors) + (int(28 + 70 * rnd.random()),)
        d.ellipse((x - r, y - r, x + r, y + r), fill=col)
        d.ellipse((x - r * 0.35, y - r * 0.35, x + r * 0.35, y + r * 0.35),
                  fill=(255, 255, 255, 30))
    return img.filter(ImageFilter.GaussianBlur(8))


# ---------------- 渐变卡片 ----------------
def _grad_card(seed, c1, c2, angle):
    return generate._gradient(SIZE, SIZE, c1, c2, angle=angle, noise=2)


# ---------------- 剪贴元素（透明 PNG） ----------------
def _star(d, cx, cy, R, r, n, color):
    pts = []
    for i in range(n * 2):
        rad = R if i % 2 == 0 else r
        a = -math.pi / 2 + i * math.pi / n
        pts.append((cx + math.cos(a) * rad, cy + math.sin(a) * rad))
    d.polygon(pts, fill=color)


def _clip(seed, color, shape):
    S = SIZE * 4  # 超采样抗锯齿
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx = cy = S // 2
    r = S * 0.34
    if shape == "star":
        _star(d, cx, cy, r, r * 0.45, 5, color)
    elif shape == "sparkle":
        _star(d, cx, cy, r, r * 0.14, 4, color)
    elif shape == "heart":
        rr = r * 0.5
        d.ellipse((cx - 2 * rr, cy - rr, cx, cy + rr), fill=color)
        d.ellipse((cx, cy - rr, cx + 2 * rr, cy + rr), fill=color)
        d.polygon([(cx - 2 * rr, cy), (cx + 2 * rr, cy), (cx, cy + 2.6 * rr)],
                  fill=color)
    elif shape == "arrow":
        d.polygon([(cx - r, cy - r * 0.55), (cx + r * 0.3, cy - r * 0.55),
                   (cx + r * 0.3, cy - r * 1.05), (cx + r * 1.15, cy),
                   (cx + r * 0.3, cy + r * 1.05), (cx + r * 0.3, cy + r * 0.55),
                   (cx - r, cy + r * 0.55)], fill=color)
    elif shape == "ring":
        d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=color,
                  width=int(S * 0.09))
    elif shape == "bolt":
        d.polygon([(cx + r * 0.25, cy - r * 1.05), (cx - r * 0.5, cy + r * 0.05),
                   (cx - r * 0.05, cy + r * 0.05), (cx - r * 0.3, cy + r * 1.05),
                   (cx + r * 0.5, cy - r * 0.05), (cx + r * 0.08, cy - r * 0.05)],
                  fill=color)
    elif shape == "check":
        d.line([(cx - r * 0.8, cy), (cx - r * 0.15, cy + r * 0.6),
                (cx + r * 0.9, cy - r * 0.7)], fill=color,
               width=int(S * 0.12), joint="curve")
    elif shape == "moon":
        m = Image.new("L", (S, S), 0)
        md = ImageDraw.Draw(m)
        md.ellipse((cx - r, cy - r, cx + r, cy + r), fill=255)
        md.ellipse((cx - r * 0.45, cy - r * 0.55, cx + r * 1.05, cy + r * 0.75),
                   fill=0)
        img.paste(color, (0, 0), m)
    elif shape == "plus":
        wd = r * 0.62
        d.rectangle((cx - wd / 2, cy - r, cx + wd / 2, cy + r), fill=color)
        d.rectangle((cx - r, cy - wd / 2, cx + r, cy + wd / 2), fill=color)
    elif shape == "diamond":
        d.polygon([(cx, cy - r), (cx + r * 0.7, cy), (cx, cy + r),
                   (cx - r * 0.7, cy)], fill=color)
    return img.resize((SIZE, SIZE), Image.LANCZOS)


# ---------------- 生成清单 ----------------
def _plan():
    items = []
    i = 0

    def add(cat, name, fn):
        nonlocal i
        i += 1
        items.append(("%s_%02d" % (cat, i), name, cat, fn))

    # 纹理 9 张
    add("texture", "星砂噪点", lambda: _tex_noise(11, (20, 24, 42), (120, 140, 190)))
    add("texture", "暖金噪点", lambda: _tex_noise(12, (40, 26, 12), (255, 205, 130)))
    add("texture", "薄荷噪点", lambda: _tex_noise(13, (12, 46, 36), (140, 235, 200)))
    add("texture", "斜纹蓝灰", lambda: _tex_stripes(21, (30, 36, 56), (90, 110, 160)))
    add("texture", "斜纹珊瑚", lambda: _tex_stripes(22, (52, 26, 24), (255, 150, 120)))
    add("texture", "圆点阵列", lambda: _tex_dots(31, (26, 30, 46), (110, 150, 230)))
    add("texture", "波浪纹理", lambda: _tex_waves2(41, (16, 44, 66), (90, 190, 240)))
    add("texture", "网格图纸", lambda: _tex_grid(51, (30, 36, 46), (120, 160, 210)))
    add("texture", "柔和色块", lambda: _tex_mesh(61, (24, 26, 48), (90, 120, 255), (255, 110, 190)))

    # 光斑 5 张
    add("bokeh", "霓虹光斑", lambda: _bokeh(71, (14, 10, 34),
                                             [(255, 90, 180), (80, 150, 255), (70, 255, 210)]))
    add("bokeh", "暖金光斑", lambda: _bokeh(72, (40, 26, 10),
                                             [(255, 190, 90), (255, 240, 200), (255, 150, 60)]))
    add("bokeh", "粉紫光斑", lambda: _bokeh(73, (30, 14, 46),
                                             [(255, 130, 220), (170, 120, 255), (255, 210, 240)]))
    add("bokeh", "冰蓝光斑", lambda: _bokeh(74, (8, 24, 48),
                                             [(120, 200, 255), (60, 140, 255), (200, 235, 255)]))
    add("bokeh", "薄荷光斑", lambda: _bokeh(75, (8, 34, 28),
                                             [(90, 235, 190), (160, 255, 220), (60, 190, 160)]))

    # 渐变卡片 6 张
    add("gradient", "蓝紫渐变卡", lambda: _grad_card(81, (30, 60, 170), (180, 120, 255), 135))
    add("gradient", "落日渐变卡", lambda: _grad_card(82, (255, 120, 90), (255, 200, 120), 45))
    add("gradient", "薄荷渐变卡", lambda: _grad_card(83, (20, 120, 100), (160, 255, 220), 160))
    add("gradient", "珊瑚渐变卡", lambda: _grad_card(84, (255, 90, 110), (255, 210, 150), 90))
    add("gradient", "深海渐变卡", lambda: _grad_card(85, (6, 24, 70), (90, 190, 255), 100))
    add("gradient", "金玫渐变卡", lambda: _grad_card(86, (200, 120, 60), (255, 230, 180), 60))

    # 剪贴元素 10 张（透明 PNG）
    shapes = [
        ("星形", "star", (255, 200, 90)),
        ("爱心", "heart", (255, 110, 160)),
        ("箭头", "arrow", (110, 200, 255)),
        ("圆环", "ring", (170, 140, 255)),
        ("闪电", "bolt", (255, 220, 90)),
        ("对勾", "check", (110, 235, 170)),
        ("弯月", "moon", (255, 235, 190)),
        ("火花", "sparkle", (255, 240, 160)),
        ("十字", "plus", (255, 150, 110)),
        ("菱形", "diamond", (140, 220, 255)),
    ]
    for j, (name, shape, color) in enumerate(shapes, 1):
        add("clip", name, (lambda s=shape, c=color, jj=j: _clip(90 + jj * 7, c, s)))

    return items


# ---------------- 入口 ----------------
def ensure_builtin_assets():
    """幂等：缺失的素材才生成。返回本次新增的 id 列表。"""
    with _gen_lock:
        IMAGES_DIR.mkdir(parents=True, exist_ok=True)
        THUMBS_DIR.mkdir(parents=True, exist_ok=True)
        items = _load_library()
        existing = {it.get("id") for it in items}
        added = []
        for aid, name, cat, fn in _plan():
            if aid in existing:
                continue
            img = fn()
            img.save(IMAGES_DIR / (aid + ".png"), "PNG")
            thumb = img.copy()
            thumb.thumbnail((THUMB_SIZE, THUMB_SIZE))
            thumb.convert("RGBA").save(THUMBS_DIR / (aid + ".png"), "PNG")
            items.append({
                "id": aid, "name": name, "file": aid + ".png",
                "thumb": aid + ".png", "ext": "png",
                "added": "内置", "source": "builtin", "cat": cat,
            })
            added.append(aid)
        if added:
            _save_library(items)
        return added
