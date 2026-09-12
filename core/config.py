# -*- coding: utf-8 -*-
"""全局配置：JSON 持久化，线程安全读写"""
import json
import threading
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
CONFIG_FILE = BASE / "config.json"

DEFAULTS = {
    "wallpaper": {
        "mode": "fit",          # fit/span/fill/center/stretch
        "current": None,        # 当前壁纸文件相对路径
        "lock": None,           # 当前锁屏壁纸
    },
    "scheduler": {
        "enabled": False,
        "interval_min": 30,
        "order": "random",      # random/sequence
        "source": "builtin",    # builtin/user/all
        "last_switch": None,
    },
    "dynamic": {
        "enabled": False,
        "per_monitor": True,    # 每屏独立（同一张时自动跨屏）
        "click_through": True,  # 点击穿透（无交互）
        "fps": 30,
    },
    "power_save": {
        "fullscreen_pause": True,   # 全屏应用时暂停
        "battery_pause": True,      # 电池供电时暂停
    },
}

_lock = threading.Lock()


def ensure():
    if not CONFIG_FILE.exists():
        save(DEFAULTS)


def load():
    ensure()
    try:
        data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        data = {}
    merged = json.loads(json.dumps(DEFAULTS))
    _deep_merge(merged, data)
    return merged


def save(data):
    CONFIG_FILE.write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def get(path=None):
    with _lock:
        data = load()
        if not path:
            return data
        node = data
        for key in path.split("."):
            node = node.get(key)
            if node is None:
                return None
        return node


def set(path, value):
    with _lock:
        data = load()
        keys = path.split(".")
        node = data
        for key in keys[:-1]:
            node = node.setdefault(key, {})
        node[keys[-1]] = value
        save(data)
    return True


def _deep_merge(base, extra):
    for k, v in extra.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            _deep_merge(base[k], v)
        else:
            base[k] = v
