# -*- coding: utf-8 -*-
"""API 冒烟测试：启动纯服务（不弹窗），逐项验证壁纸中心/设置/动态接口"""
import io
import json
import sys
import threading
import time
import urllib.request

sys.path.insert(0, r"G:\wallpaper-maker")

import server as srv
from PIL import Image

BASE = "http://127.0.0.1:8123"
FAIL = []


def req(method, path, body=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method,
                               headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(r, timeout=180) as resp:
        return resp.status, json.loads(resp.read().decode("utf-8"))


def check(name, cond, extra=""):
    print(("PASS  " if cond else "FAIL  ") + name + ("  " + str(extra) if extra else ""))
    if not cond:
        FAIL.append(name)


httpd, port = srv.create_server(port=8123)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
print("server on", port)

# 1. 动态模板列表
st, d = req("GET", "/api/dynamic/templates")
check("templates list", st == 200 and d["ok"] and len(d["templates"]) >= 4,
      [t["name"] for t in d.get("templates", [])])

# 2. 壁纸库（应含刚生成的 25 张内置）
st, d = req("GET", "/api/wallpaper/library")
check("library 25 builtin", st == 200 and len(d["items"]) >= 25, "count=%d" % len(d.get("items", [])))
lib_file = d["items"][0]["file"] if d.get("items") else "builtin/01-xxx.png"

# 3. 中文名缩略图（URL 编码）
import urllib.parse
thumb_url = "/api/wallpaper/thumb/" + urllib.parse.quote(lib_file, safe="/")
st, d = req("GET", thumb_url) if False else (None, None)
with urllib.request.urlopen(BASE + thumb_url, timeout=30) as resp:
    thumb = resp.read()
check("chinese thumb", len(thumb) > 1000, "%d bytes" % len(thumb))

# 4. 配置读取
st, d = req("GET", "/api/config")
check("config read", st == 200 and d["ok"] and d["config"].get("scheduler"))

# 5. 配置写入
st, d = req("POST", "/api/config", {"updates": {"scheduler.interval_min": 45}})
check("config write", st == 200 and d["ok"] and d["config"]["scheduler"]["interval_min"] == 45)
req("POST", "/api/config", {"updates": {"scheduler.interval_min": 30}})

# 6. 导入用户壁纸（用一张小图）
img = Image.new("RGB", (320, 180), (60, 120, 200))
buf = io.BytesIO()
img.save(buf, "PNG")
import base64
data_url = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
st, d = req("POST", "/api/wallpaper/import", {"dataUrl": data_url, "name": "smoke-test"})
check("import user wallpaper", st == 200 and d["ok"], d.get("item"))
user_file = d["item"]["file"] if d.get("ok") else None

# 7. 以图搜图
st, d = req("POST", "/api/wallpaper/search", {"dataUrl": data_url})
check("search similar", st == 200 and d["ok"] and "results" in d, "hits=%d" % len(d.get("results", [])))

# 8. 删除用户壁纸
if user_file:
    st, d = req("DELETE", "/api/wallpaper/library/" + urllib.parse.quote(user_file, safe="/"))
    check("delete user wallpaper", st == 200 and d["ok"])

# 9. 动态状态（未启动应为 idle）
st, d = req("GET", "/api/dynamic/status")
check("dynamic status idle", st == 200 and d["status"] == "idle", d.get("status"))

# 10. 静态页面可访问
with urllib.request.urlopen(BASE + "/", timeout=10) as resp:
    html = resp.read().decode("utf-8")
check("index served", "pageWallpaper" in html and "pageSettings" in html, "%d bytes" % len(html))
with urllib.request.urlopen(BASE + "/wallpaper.js", timeout=10) as resp:
    js = resp.read().decode("utf-8")
check("wallpaper.js served", "switchPage" in js, "%d bytes" % len(js))

# 11. 动态模板页面可访问
with urllib.request.urlopen(BASE + "/dyn/waves", timeout=10) as resp:
    wv = resp.read().decode("utf-8")
check("dyn waves served", "__wmSetPaused" in wv)

print("\n==== %d failures ====" % len(FAIL))
for f in FAIL:
    print(" -", f)
httpd.shutdown()
httpd.server_close()
sys.exit(1 if FAIL else 0)
