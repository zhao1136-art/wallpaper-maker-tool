# -*- coding: utf-8 -*-
"""Windows 系统控制：壁纸设置 / 锁屏 / 显示器 / 全屏检测 / 电池 / WorkerW
仅依赖 ctypes 与 winreg 标准库。
"""
import ctypes
import ctypes.wintypes as wt
import winreg

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

SPI_SETDESKWALLPAPER = 0x0014
SPIF_UPDATEINIFILE = 0x01
SPIF_SENDCHANGE = 0x02
HWND_BOTTOM = 1
SWP_NOSIZE = 0x0001
SWP_NOMOVE = 0x0002
SWP_NOACTIVATE = 0x0010
SWP_SHOWWINDOW = 0x0040
GWL_EXSTYLE = -20
WS_EX_LAYERED = 0x00080000
WS_EX_TRANSPARENT = 0x00000020
SMTO_NORMAL = 0x0000


class RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


def get_monitors():
    """返回显示器列表：[{left,top,right,bottom,primary}]，逻辑坐标（虚拟桌面）"""
    out = []

    @ctypes.WINFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p,
                        ctypes.POINTER(RECT), ctypes.c_void_p)
    def _cb(_hmon, _hdc, lprect, _lparam):
        r = lprect.contents
        out.append({"left": r.left, "top": r.top, "right": r.right, "bottom": r.bottom})
        return 1

    user32.EnumDisplayMonitors(None, None, _cb, None)
    primary = _get_primary_index(out)
    for i, m in enumerate(out):
        m["primary"] = i == primary
    return out


def _get_primary_index(out):
    # 通过 GetSystemMetrics 主屏宽高反推主屏索引
    sm_cx = user32.GetSystemMetrics(0)
    sm_cy = user32.GetSystemMetrics(1)
    for i, m in enumerate(out):
        if m["right"] - m["left"] == sm_cx and m["bottom"] - m["top"] == sm_cy:
            return i
    return 0


def virtual_desktop():
    """虚拟桌面逻辑尺寸 (w, h)"""
    w = user32.GetSystemMetrics(78)   # SM_CXVIRTUALSCREEN
    h = user32.GetSystemMetrics(79)   # SM_CYVIRTUALSCREEN
    return w, h


# ---------- 静态壁纸 ----------

_WALLPAPER_STYLES = {
    "center": ("0", "0"),    # 居中
    "stretch": ("2", "0"),   # 拉伸
    "fit": ("6", "0"),       # 适应
    "fill": ("10", "0"),     # 填充
    "span": ("22", "0"),     # 跨屏
}


def set_static_wallpaper(image_path, mode="fit"):
    """设置系统桌面壁纸。返回 (ok, message)"""
    import os
    p = os.path.abspath(image_path)
    if not os.path.exists(p):
        return False, "壁纸文件不存在"
    style, tile = _WALLPAPER_STYLES.get(mode, _WALLPAPER_STYLES["fit"])
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                            r"Control Panel\Desktop", 0, winreg.KEY_SET_VALUE) as key:
            winreg.SetValueEx(key, "Wallpaper", 0, winreg.REG_SZ, p)
            winreg.SetValueEx(key, "WallpaperStyle", 0, winreg.REG_SZ, style)
            winreg.SetValueEx(key, "TileWallpaper", 0, winreg.REG_SZ, tile)
    except OSError as exc:
        return False, "注册表写入失败：%s" % exc
    result = user32.SystemParametersInfoW(
        SPI_SETDESKWALLPAPER, 0, p, SPIF_UPDATEINIFILE | SPIF_SENDCHANGE)
    return bool(result), ("已设置为桌面壁纸" if result else "系统接口调用失败")


# ---------- 锁屏壁纸 ----------

def set_lock_screen(image_path):
    """设置 Windows 锁屏壁纸（需管理员权限写入策略注册表）"""
    import os
    p = os.path.abspath(image_path)
    if not os.path.exists(p):
        return False, "壁纸文件不存在"
    try:
        with winreg.CreateKeyEx(winreg.HKEY_LOCAL_MACHINE,
                                r"SOFTWARE\Policies\Microsoft\Windows\Personalization",
                                0, winreg.KEY_SET_VALUE) as key:
            winreg.SetValueEx(key, "LockScreenImage", 0, winreg.REG_SZ, p)
    except PermissionError:
        return False, "需要管理员权限：请右键以管理员身份运行本软件后再试"
    except OSError as exc:
        return False, "锁屏设置失败：%s" % exc
    return True, "锁屏壁纸已设置（重启或注销后生效）"


# ---------- 前台/全屏检测 ----------

def foreground_rect():
    hwnd = user32.GetForegroundWindow()
    shell = user32.GetShellWindow()
    if not hwnd or hwnd == shell:
        return None
    rect = RECT()
    if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
        return None
    return rect


def is_fullscreen_foreground():
    rect = foreground_rect()
    if rect is None:
        return False
    for m in get_monitors():
        if (rect.left <= m["left"] and rect.top <= m["top"]
                and rect.right >= m["right"] and rect.bottom >= m["bottom"]):
            return True
    return False


# ---------- 电源状态 ----------

class SYSTEM_POWER_STATUS(ctypes.Structure):
    _fields_ = [
        ("ACLineStatus", ctypes.c_byte),
        ("BatteryFlag", ctypes.c_byte),
        ("BatteryLifePercent", ctypes.c_byte),
        ("SystemStatusFlag", ctypes.c_byte),
        ("BatteryLifeTime", ctypes.c_ulong),
        ("BatteryFullLifeTime", ctypes.c_ulong),
    ]


def power_status():
    sps = SYSTEM_POWER_STATUS()
    if kernel32.GetSystemPowerStatus(ctypes.byref(sps)):
        return {
            "on_battery": sps.ACLineStatus == 0,
            "percent": sps.BatteryLifePercent,
        }
    return {"on_battery": False, "percent": 100}


# ---------- WorkerW 动态壁纸宿主 ----------

def find_workerw():
    """找到动态壁纸宿主窗口。
    经典算法：向 Progman 发送 0x052C 创建 WorkerW；
    枚举 WorkerW，含有 SHELLDLL_DefView 子窗口的是图标层，其兄弟窗口是壁纸宿主。
    返回宿主 HWND；找不到时回退 Progman。"""
    progman = user32.FindWindowW("Progman", None)
    if not progman:
        return None
    result = ctypes.c_ulong()
    user32.SendMessageTimeoutW(progman, 0x052C, 0, 0, SMTO_NORMAL, 1000,
                               ctypes.byref(result))

    workers = []

    @ctypes.WINFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p)
    def _cb(hwnd, _lparam):
        buf = ctypes.create_unicode_buffer(64)
        user32.GetClassNameW(hwnd, buf, 64)
        if buf.value == "WorkerW":
            workers.append(hwnd)
        return 1

    user32.EnumWindows(_cb, None)
    for hwnd in workers:
        if user32.FindWindowExW(hwnd, None, "SHELLDLL_DefView", None):
            # 该 WorkerW 持有图标层，跳过
            continue
        return hwnd
    return progman


def reparent_to(hwnd, parent):
    """将窗口重定向到宿主窗口并置于底层"""
    if not hwnd or not parent:
        return False
    user32.SetParent(hwnd, parent)
    user32.SetWindowPos(hwnd, HWND_BOTTOM, 0, 0, 0, 0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW)
    return True


def set_click_through(hwnd, enable):
    """切换窗口点击穿透（WS_EX_TRANSPARENT | WS_EX_LAYERED）"""
    if not hwnd:
        return
    ex = user32.GetWindowLongPtrW(hwnd, GWL_EXSTYLE)
    if enable:
        ex |= WS_EX_LAYERED | WS_EX_TRANSPARENT
    else:
        ex &= ~(WS_EX_LAYERED | WS_EX_TRANSPARENT)
    user32.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex)


def get_native_hwnd(window):
    """从 pywebview 窗口对象提取 HWND。
    winforms/WebView2：window.native 是 BrowserView(Form)，句柄在其 .Handle(IntPtr)。
    """
    native = getattr(window, "native", None)
    if native is None:
        return None
    hwnd = getattr(native, "Handle", None)
    if hwnd is None:
        return None
    try:
        return int(hwnd)
    except (TypeError, ValueError):
        try:
            return hwnd.ToInt32()
        except Exception:
            return None


def set_window_rect(hwnd, left, top, width, height):
    user32.MoveWindow(hwnd, int(left), int(top), int(width), int(height), True)
