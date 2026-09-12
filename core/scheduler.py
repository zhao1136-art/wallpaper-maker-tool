# -*- coding: utf-8 -*-
"""定时切换：后台线程按配置轮换壁纸（顺序/随机）"""
import random
import threading
import time

from . import config, generate, win32

_lock = threading.Lock()


def pick_next():
    """按当前配置从壁纸库选下一张，返回条目 dict 或 None"""
    cfg = config.get("scheduler")
    source = cfg["source"]
    items = [i for i in generate.list_library()
             if source == "all" or i["source"] == source]
    if not items:
        return None
    current = config.get("wallpaper.current")
    if cfg["order"] == "sequence":
        idx = next((i for i, it in enumerate(items) if it["file"] == current), -1)
        return items[(idx + 1) % len(items)]
    pool = [i for i in items if i["file"] != current] or items
    return random.choice(pool)


def switch_once():
    """立即切换一次，返回 (ok, message, item)"""
    with _lock:
        item = pick_next()
        if not item:
            return False, "壁纸库为空，请先在壁纸中心导入", None
        path = generate.resolve(item["file"])
        if not path:
            return False, "壁纸文件不存在", None
        ok, msg = win32.set_static_wallpaper(str(path), config.get("wallpaper.mode"))
        if ok:
            config.set("wallpaper.current", item["file"])
            config.set("scheduler.last_switch", time.time())
        return ok, msg, item


class Scheduler(threading.Thread):
    """常驻线程：每 10 秒检查一次是否到点切换"""

    def __init__(self):
        super().__init__(daemon=True, name="wallpaper-scheduler")
        self._stop = threading.Event()

    def run(self):
        while not self._stop.wait(10):
            try:
                cfg = config.get("scheduler")
                if not cfg["enabled"]:
                    continue
                interval = max(1, int(cfg["interval_min"])) * 60
                last = config.get("scheduler.last_switch")
                now = time.time()
                if last is None or (now - last) >= interval:
                    ok, msg, _item = switch_once()
                    if not ok:
                        # 空库等原因：自动停用定时，避免空转
                        if "壁纸库为空" in msg:
                            config.set("scheduler.enabled", False)
            except Exception as exc:  # 绝不因单次异常中断线程
                print("[scheduler] %s" % exc)

    def stop(self):
        self._stop.set()
