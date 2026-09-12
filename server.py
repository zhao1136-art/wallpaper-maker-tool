# -*- coding: utf-8 -*-
"""壁纸工坊 - 本地 HTTP 服务
职责：静态资源托管 + 素材库 API + 壁纸中心 API + 系统壁纸控制 + 动态壁纸引擎托管
仅依赖 Python 标准库 + Pillow（F 盘安装）。
"""
import base64
import io
import json
import time
import uuid
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote

from PIL import Image

from core import assets_gen, config, dynamic, generate, scheduler, win32

BASE = Path(__file__).resolve().parent
STATIC_DIR = BASE / "static"
ASSETS_DIR = BASE / "assets"
IMAGES_DIR = ASSETS_DIR / "images"
THUMBS_DIR = ASSETS_DIR / "thumbs"
EXPORTS_DIR = ASSETS_DIR / "exports"
LIBRARY_FILE = BASE / "library.json"
WALLPAPERS_DIR = BASE / "wallpapers"
DYN_DIR = WALLPAPERS_DIR / "dyn"
THUMB_CACHE = WALLPAPERS_DIR / ".thumbs"
CUSTOM_COMP = DYN_DIR / "custom.json"

MAX_UPLOAD = 64 * 1024 * 1024  # 64MB
THUMB_SIZE = 320

# 开发者分享壁纸（123 云盘），点击导航入口时用系统浏览器打开
DEV_SHARE_URL = "https://1846300398.share.123pan.cn/123pan/KhL6Td-b2RyH"

engine = None  # DynamicEngine 实例，由 create_server 创建


def ensure_dirs():
    for d in (IMAGES_DIR, THUMBS_DIR, EXPORTS_DIR, DYN_DIR, THUMB_CACHE):
        d.mkdir(parents=True, exist_ok=True)
    if not LIBRARY_FILE.exists():
        LIBRARY_FILE.write_text("[]", encoding="utf-8")
    generate.ensure_dirs()
    # 幂等补全内置素材库（纹理/光斑/渐变卡/剪贴元素），缺失才生成
    assets_gen.ensure_builtin_assets()


def load_library():
    try:
        return json.loads(LIBRARY_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []


def save_library(items):
    LIBRARY_FILE.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")


def parse_data_url(data_url):
    if not data_url or "," not in data_url:
        return None, None
    header, payload = data_url.split(",", 1)
    mime = header[header.find(":") + 1: header.find(";")] if ";" in header else ""
    ext_map = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp",
               "image/gif": "gif", "image/bmp": "bmp"}
    ext = ext_map.get(mime, "png")
    try:
        return base64.b64decode(payload), ext
    except Exception:
        return None, None


def safe_name(name):
    name = (name or "").strip()
    name = "".join(ch for ch in name if ch not in '<>:"/\\|?*').strip()
    return name or "wallpaper"


def decode_to_file(data_url, suffix):
    content, _ = parse_data_url(data_url)
    if content is None:
        return None
    # verify() 会关闭文件指针，校验后需从新缓冲重新打开
    buf = io.BytesIO(content)
    try:
        with Image.open(buf) as im:
            im.verify()
    except Exception:
        return None
    return Image.open(io.BytesIO(content))


def wallpaper_thumb(item):
    """生成/获取壁纸缩略图，返回 (bytes, mime) 或 None"""
    path = generate.resolve(item["file"])
    if not path:
        return None
    cache = THUMB_CACHE / ("%s-%s.jpg" % (item["source"], path.stem))
    if cache.exists():
        return cache.read_bytes()
    try:
        img = Image.open(path).convert("RGB")
        img.thumbnail((THUMB_SIZE, THUMB_SIZE), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=82)
        cache.write_bytes(buf.getvalue())
        return buf.getvalue()
    except OSError:
        return None


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def log_message(self, fmt, *args):
        print("[%s] %s" % (time.strftime("%H:%M:%S"), fmt % args))

    def _send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_bytes(self, content, mime, status=200):
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def _read_json(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            if length > MAX_UPLOAD:
                return None
            raw = self.rfile.read(length)
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return None

    # ---------- GET ----------
    def do_GET(self):
        path = unquote(self.path.split("?", 1)[0])

        if path.startswith("/api/image/"):
            self._serve_asset(path, IMAGES_DIR, "file")
            return
        if path.startswith("/api/thumb/"):
            self._serve_asset(path, THUMBS_DIR, "thumb", "image/png")
            return

        # 壁纸库原图
        if path.startswith("/api/wallpaper/image/"):
            rel = path[len("/api/wallpaper/image/"):]
            item = {"file": rel}
            p = generate.resolve(rel)
            if p:
                mime = "image/png" if p.suffix.lower() == ".png" else "image/jpeg"
                self._send_bytes(p.read_bytes(), mime)
                return
            self.send_response(404)
            self.end_headers()
            return

        # 壁纸库缩略图
        if path.startswith("/api/wallpaper/thumb/"):
            rel = path[len("/api/wallpaper/thumb/"):]
            data = wallpaper_thumb({"file": rel, "source": rel.split("/", 1)[0]})
            if data:
                self._send_bytes(data, "image/jpeg")
                return
            self.send_response(404)
            self.end_headers()
            return

        # 壁纸库列表
        if path == "/api/wallpaper/library":
            self._send_json({"ok": True, "items": generate.list_library(),
                             "generated": len(generate._plan())})
            return

        # 动态壁纸模板列表
        if path == "/api/dynamic/templates":
            infos = {
                "aurora": ("极光", "飘动的极光光带与流星"),
                "starfield": ("星空", "静谧的星空银河"),
                "waves": ("波浪", "月光下的海浪"),
                "clock": ("时钟", "实时桌面数字时钟"),
                "custom": ("我的画布", "编辑器当前画布的动态版"),
            }
            items = []
            for f in sorted(DYN_DIR.glob("*.html")):
                name = f.stem
                title, desc = infos.get(name, (name, "动态壁纸"))
                items.append({"name": name, "title": title, "desc": desc,
                              "file": "dyn/%s.html" % name})
            self._send_json({"ok": True, "templates": items})
            return

        # 动态壁纸模板
        if path.startswith("/dyn/"):
            rel = path[len("/dyn/"):]
            target = (DYN_DIR / rel).resolve()
            if not target.suffix:
                target = (DYN_DIR / (rel + ".html")).resolve()
            if str(target).startswith(str(DYN_DIR.resolve())) and target.is_file():
                mime = "text/html" if target.suffix == ".html" else "text/javascript"
                self._send_bytes(target.read_bytes(), mime)
                return
            self.send_response(404)
            self.end_headers()
            return

        if path == "/api/assets":
            self._send_json({"ok": True, "assets": load_library()})
            return
        if path == "/api/config":
            self._send_json({"ok": True, "config": config.load()})
            return
        if path == "/api/dynamic/status":
            self._send_json({"ok": True, **engine.snapshot()})
            return

        if path == "/api/dynamic/composition":
            if CUSTOM_COMP.exists():
                try:
                    data = json.loads(CUSTOM_COMP.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    data = None
            else:
                data = None
            self._send_json({"ok": True, "comp": data})
            return

        super().do_GET()

    def _serve_asset(self, path, base_dir, key, mime=None):
        item_id = path.rsplit("/", 1)[-1]
        for item in load_library():
            if item.get("id") == item_id:
                f = base_dir / item[key]
                if f.exists():
                    if not mime:
                        mime = ("image/png" if item.get("ext") == "png"
                                else ("image/jpeg" if item.get("ext") == "jpg"
                                      else "image/webp"))
                    self._send_bytes(f.read_bytes(), mime)
                    return
        self.send_response(404)
        self.end_headers()

    # ---------- POST ----------
    def do_POST(self):
        path = unquote(self.path.split("?", 1)[0])

        if path == "/api/assets":
            self._upload_asset()
            return

        if path == "/api/export":
            self._export()
            return

        # 壁纸中心
        if path == "/api/wallpaper/generate":
            items = generate.generate_builtin()
            self._send_json({"ok": True, "items": items,
                             "library": generate.list_library()})
            return

        if path == "/api/wallpaper/set":
            self._set_wallpaper()
            return

        if path == "/api/wallpaper/lock":
            self._set_lock()
            return

        if path == "/api/wallpaper/next":
            ok, msg, item = scheduler.switch_once()
            self._send_json({"ok": ok, "message": msg,
                             "item": item and item["file"]})
            return

        if path == "/api/wallpaper/import":
            data = self._read_json()
            if not data or not data.get("dataUrl"):
                self._send_json({"ok": False, "error": "无效的上传数据"}, 400)
                return
            content, ext = parse_data_url(data["dataUrl"])
            if content is None:
                self._send_json({"ok": False, "error": "图片解码失败"}, 400)
                return
            fname = "user-%d-%s.%s" % (int(time.time() * 1000) % 1000000,
                                       safe_name(data.get("name", "img"))[:20], ext)
            target = generate.USER_DIR / fname
            target.write_bytes(content)
            self._send_json({"ok": True,
                             "item": {"file": "user/%s" % fname, "name": target.stem,
                                      "source": "user"}})
            return

        if path == "/api/wallpaper/search":
            data = self._read_json()
            if not data or not data.get("dataUrl"):
                self._send_json({"ok": False, "error": "无检索图片"}, 400)
                return
            img = decode_to_file(data["dataUrl"], ".png")
            if img is None:
                self._send_json({"ok": False, "error": "图片解码失败"}, 400)
                return
            tmp = ASSETS_DIR / ("_search_tmp.png")
            img.save(tmp, "PNG")
            results = generate.find_similar(str(tmp))
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass
            self._send_json({"ok": True, "results": results})
            return

        # 配置
        if path == "/api/config":
            data = self._read_json()
            if not data or not isinstance(data.get("updates"), dict):
                self._send_json({"ok": False, "error": "参数错误"}, 400)
                return
            for key, value in data["updates"].items():
                config.set(key, value)
            self._send_json({"ok": True, "config": config.load()})
            return

        # 打开开发者分享壁纸（系统浏览器）
        if path == "/api/open/dev-wallpapers":
            try:
                webbrowser.open(DEV_SHARE_URL)
            except Exception:
                pass
            self._send_json({"ok": True, "url": DEV_SHARE_URL})
            return

        # 动态壁纸
        if path == "/api/dynamic/composition":
            data = self._read_json()
            comp = (data or {}).get("comp")
            if not isinstance(comp, dict):
                self._send_json({"ok": False, "error": "组合数据无效"}, 400)
                return
            CUSTOM_COMP.write_text(json.dumps(comp, ensure_ascii=False, indent=2),
                                   encoding="utf-8")
            self._send_json({"ok": True})
            return

        if path == "/api/dynamic/start":
            if engine.browser_fallback:
                self._send_json({"ok": False,
                                 "error": "当前为浏览器模式回退，动态壁纸不可用，"
                                          "请安装 WebView2 Runtime 后重启应用"})
                return
            # 等待内置窗口引擎就绪（webview 启动初期 _thread 尚未创建）
            deadline = time.time() + 15
            while (engine._thread is None or not engine._thread.is_alive()):
                if time.time() > deadline:
                    self._send_json({"ok": False,
                                     "error": "动态壁纸引擎未就绪：" +
                                              (engine.message or "未检测到 WebView2，可能处于浏览器回退模式")})
                    return
                time.sleep(0.5)
            data = self._read_json() or {}
            if data.get("click_through") is not None:
                config.set("dynamic.click_through", bool(data["click_through"]))
            if data.get("per_monitor") is not None:
                config.set("dynamic.per_monitor", bool(data["per_monitor"]))
            config.set("dynamic.enabled", True)
            engine.request("start", wallpaper=data.get("wallpaper") or "aurora",
                           per_monitor=config.get("dynamic.per_monitor"))
            self._send_json({"ok": True})
            return

        if path == "/api/dynamic/stop":
            config.set("dynamic.enabled", False)
            engine.request("stop")
            self._send_json({"ok": True})
            return

        self._send_json({"ok": False, "error": "接口不存在"}, 404)

    def _upload_asset(self):
        data = self._read_json()
        if not data or not data.get("dataUrl"):
            self._send_json({"ok": False, "error": "无效的上传数据"}, 400)
            return
        content, ext = parse_data_url(data["dataUrl"])
        thumb, _ = parse_data_url(data.get("thumbDataUrl") or data["dataUrl"])
        if content is None:
            self._send_json({"ok": False, "error": "图片解码失败"}, 400)
            return
        item_id = uuid.uuid4().hex[:12]
        original_name = safe_name(data.get("name", "image")) + "." + ext
        orig_file = IMAGES_DIR / (item_id + "." + ext)
        thumb_file = THUMBS_DIR / (item_id + ".png")
        orig_file.write_bytes(content)
        if thumb:
            thumb_file.write_bytes(thumb)
        item = {
            "id": item_id, "name": original_name, "file": orig_file.name,
            "thumb": thumb_file.name, "ext": ext,
            "added": time.strftime("%Y-%m-%d %H:%M:%S"),
        }
        items = load_library()
        items.append(item)
        save_library(items)
        self._send_json({"ok": True, "asset": item})

    def _export(self):
        data = self._read_json()
        if not data or not data.get("dataUrl"):
            self._send_json({"ok": False, "error": "无导出数据"}, 400)
            return
        content, ext = parse_data_url(data["dataUrl"])
        if content is None:
            self._send_json({"ok": False, "error": "导出数据解码失败"}, 400)
            return
        filename = safe_name(data.get("filename", "wallpaper"))
        if ext == "jpeg":
            ext = "jpg"
        out_file = EXPORTS_DIR / ("%s-%s.%s" % (filename, time.strftime("%Y%m%d-%H%M%S"), ext))
        out_file.write_bytes(content)
        self._send_json({"ok": True, "path": str(out_file)})

    def _set_wallpaper(self):
        data = self._read_json()
        if not data or not data.get("file"):
            self._send_json({"ok": False, "error": "缺少壁纸文件"}, 400)
            return
        mode = data.get("mode") or config.get("wallpaper.mode")
        config.set("wallpaper.mode", mode)
        path = generate.resolve(data["file"])
        if not path:
            self._send_json({"ok": False, "error": "壁纸文件不存在"}, 404)
            return
        target = path
        if mode == "span":
            target = generate.build_span_image(str(path), win32.get_monitors())
        engine.stop_sync()  # 先停动态壁纸，避免其窗口盖住新设置的静态壁纸
        ok, msg = win32.set_static_wallpaper(str(target), mode)
        if ok:
            config.set("wallpaper.current", data["file"])
        self._send_json({"ok": ok, "message": msg})

    def _set_lock(self):
        data = self._read_json()
        if not data or not data.get("file"):
            self._send_json({"ok": False, "error": "缺少壁纸文件"}, 400)
            return
        path = generate.resolve(data["file"])
        if not path:
            self._send_json({"ok": False, "error": "壁纸文件不存在"}, 404)
            return
        ok, msg = win32.set_lock_screen(str(path))
        if ok:
            config.set("wallpaper.lock", data["file"])
        self._send_json({"ok": ok, "message": msg})

    # ---------- DELETE ----------
    def do_DELETE(self):
        path = unquote(self.path.split("?", 1)[0])
        if path.startswith("/api/assets/"):
            item_id = path.rsplit("/", 1)[-1]
            items = load_library()
            rest = [it for it in items if it.get("id") != item_id]
            if len(rest) == len(items):
                self._send_json({"ok": False, "error": "素材不存在"}, 404)
                return
            for it in items:
                if it.get("id") == item_id:
                    for f in (IMAGES_DIR / it["file"], THUMBS_DIR / it["thumb"]):
                        try:
                            f.unlink(missing_ok=True)
                        except OSError:
                            pass
            save_library(rest)
            self._send_json({"ok": True})
            return
        if path.startswith("/api/wallpaper/library/"):
            rel = path[len("/api/wallpaper/library/"):]
            p = generate.resolve(rel)
            if p and p.is_file() and str(p).startswith(str(generate.USER_DIR.resolve())):
                try:
                    p.unlink()
                    cache = THUMB_CACHE / ("%s-%s.jpg" % (rel.split("/", 1)[0], p.stem))
                    cache.unlink(missing_ok=True)
                except OSError as exc:
                    self._send_json({"ok": False, "error": str(exc)}, 500)
                    return
                self._send_json({"ok": True})
                return
            self._send_json({"ok": False, "error": "仅支持删除用户壁纸"}, 404)
            return
        self._send_json({"ok": False, "error": "接口不存在"}, 404)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def create_server(port=8000, max_tries=10):
    global engine
    ensure_dirs()
    config.ensure()
    for p in range(port, port + max_tries):
        try:
            httpd = ThreadingHTTPServer(("127.0.0.1", p), Handler)
            engine = dynamic.DynamicEngine("http://127.0.0.1:%d" % p)
            return httpd, p
        except OSError:
            continue
    raise RuntimeError("无法找到可用端口（%d-%d）" % (port, port + max_tries - 1))
