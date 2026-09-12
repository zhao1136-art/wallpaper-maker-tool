# -*- coding: utf-8 -*-
"""动态壁纸引擎：将 HTML 壁纸渲染到桌面后台（WorkerW 宿主）
- 每显示器一个透明无边框窗口，重定向进 WorkerW（桌面图标之下）
- 点击穿透 / 交互模式切换
- 节能模式：全屏应用 / 电池供电时暂停渲染
"""
import queue
import threading
import time

from . import config, win32


class DynamicEngine:
    def __init__(self, base_url):
        """base_url: 形如 http://127.0.0.1:8000"""
        self.base_url = base_url.rstrip("/")
        self.q = queue.Queue()
        self.windows = []      # [{win, hwnd, monitor}]
        self.host = None       # WorkerW 宿主 hwnd
        self.wallpaper = None  # 当前动态壁纸模板名
        self.paused = False
        self.status = "idle"   # idle/starting/running/fallback/error
        self.message = ""
        self._stop = threading.Event()
        self._thread = None
        self._watch = None
        self._lock = threading.Lock()

    # ---------- 外部命令入口（任意线程调用） ----------
    def request(self, cmd, **kw):
        self.q.put({"cmd": cmd, **kw})

    def start_engine_loop(self):
        """在 webview.start(func) 的 func 线程中调用，驱动命令队列"""
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()
        self._watch = threading.Thread(target=self._watch_loop, daemon=True)
        self._watch.start()

    def _loop(self):
        while not self._stop.is_set():
            try:
                req = self.q.get(timeout=0.5)
            except queue.Empty:
                continue
            try:
                self._handle(req)
            except Exception as exc:
                import traceback
                traceback.print_exc()
                self.status = "error"
                self.message = str(exc)

    def _handle(self, req):
        cmd = req["cmd"]
        if cmd == "start":
            self._start_wallpaper(req)
        elif cmd == "stop":
            self._stop_wallpaper()

    # ---------- 启动/停止 ----------
    def _start_wallpaper(self, req):
        import webview
        with self._lock:
            self._stop_wallpaper_locked()
            name = req.get("wallpaper") or "aurora"
            self.wallpaper = name
            url = "%s/dyn/%s" % (self.base_url, name)
            per_monitor = req.get("per_monitor", config.get("dynamic.per_monitor"))
            print("[dynamic] start", name, url)
            self.host = win32.find_workerw()
            print("[dynamic] workerw host:", self.host)
            monitors = win32.get_monitors()
            print("[dynamic] monitors:", monitors)

            if per_monitor and len(monitors) > 1:
                targets = [{"monitor": m, "x": m["left"], "y": m["top"],
                            "w": m["right"] - m["left"], "h": m["bottom"] - m["top"]}
                           for m in monitors]
            else:
                m = monitors[0]
                x0 = min(mm["left"] for mm in monitors)
                y0 = min(mm["top"] for mm in monitors)
                x1 = max(mm["right"] for mm in monitors)
                y1 = max(mm["bottom"] for mm in monitors)
                targets = [{"monitor": m, "x": x0, "y": y0,
                            "w": x1 - x0, "h": y1 - y0}]

            for i, t in enumerate(targets):
                # 动态壁纸整屏覆盖，无需透明窗口（透明会触发 winforms 的 Show/Hide hack，
                # 导航事件未触发时窗口会一直隐藏），改用不透明背景。
                win = webview.create_window(
                    "wallpaper-dyn-%d" % i, url,
                    x=t["x"], y=t["y"], width=t["w"], height=t["h"],
                    frameless=True, transparent=False, on_top=False,
                    background_color="#0a0f1e", shadow=False, focus=False,
                    easy_drag=False, text_select=False)
                self.windows.append({"win": win, "monitor": t, "hwnd": None})

            # 等待页面加载，检测 WebView2 初始化失败（失败时窗口为空白但状态会误报 running）
            loaded_ok = 0
            for w in self.windows:
                try:
                    if w["win"].events.loaded.wait(15):
                        loaded_ok += 1
                except Exception:
                    pass
            if loaded_ok == 0:
                self._stop_wallpaper_locked()
                self.status = "error"
                self.message = "WebView2 页面加载失败，请检查 WebView2 Runtime 或网络连接"
                print("[dynamic] status -> error:", self.message)
                return
            time.sleep(0.3)
            self._attach_hosts()
            click = config.get("dynamic.click_through")
            self._apply_click_through(click)
            self.status = "running" if self.host else "fallback"
            self.message = ("WorkerW 宿主" if self.host else "未找到 WorkerW，回退为置底窗口")
            if loaded_ok < len(self.windows):
                self.message += "（%d/%d 屏加载成功）" % (loaded_ok, len(self.windows))
            print("[dynamic] status ->", self.status, self.message)
            self._apply_pause(False)

    def _stop_wallpaper(self):
        with self._lock:
            self._stop_wallpaper_locked()

    def _stop_wallpaper_locked(self):
        for w in self.windows:
            try:
                w["win"].destroy()
            except Exception:
                pass
        self.windows = []
        self.wallpaper = None
        self.status = "idle"
        self.message = ""

    def _attach_hosts(self):
        for w in self.windows:
            hwnd = win32.get_native_hwnd(w["win"])
            for _ in range(10):
                if hwnd:
                    break
                time.sleep(0.3)
                hwnd = win32.get_native_hwnd(w["win"])
            w["hwnd"] = hwnd
            print("[dynamic] win hwnd:", hwnd)
            if hwnd:
                # 定位到目标显示器（reparent 会打乱坐标，重设一次）
                t = w["monitor"]
                win32.set_window_rect(hwnd, t["x"], t["y"], t["w"], t["h"])
                if self.host:
                    win32.reparent_to(hwnd, self.host)
                    print("[dynamic] reparented to", self.host)

    def _apply_click_through(self, enable):
        for w in self.windows:
            if w["hwnd"]:
                win32.set_click_through(w["hwnd"], enable)

    def _apply_pause(self, paused):
        for w in self.windows:
            try:
                w["win"].evaluate_js(
                    "window.__wmSetPaused && window.__wmSetPaused(%s)"
                    % str(paused).lower())
            except Exception:
                pass

    # ---------- 节能监控 ----------
    def _should_pause(self):
        ps = config.get("power_save")
        if ps["fullscreen_pause"] and win32.is_fullscreen_foreground():
            return True
        if ps["battery_pause"] and win32.power_status()["on_battery"]:
            return True
        return False

    def _watch_loop(self):
        while not self._stop.is_set():
            time.sleep(2)
            if self.status not in ("running", "fallback"):
                continue
            pause = self._should_pause()
            if pause != self.paused:
                self.paused = pause
                self._apply_pause(pause)

    # ---------- 状态 ----------
    def snapshot(self):
        return {
            "status": self.status,
            "message": self.message,
            "paused": self.paused,
            "windows": len(self.windows),
            "host": bool(self.host),
            "wallpaper": self.wallpaper,
            "enabled": config.get("dynamic.enabled"),
        }

    def stop_all(self):
        self._stop.set()
        self._stop_wallpaper()

    def stop_sync(self):
        """同步停止所有动态壁纸窗口（任意线程可调用，设静态壁纸前先停）"""
        self._stop_wallpaper()
