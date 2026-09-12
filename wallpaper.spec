# -*- mode: python ; coding: utf-8 -*-
"""壁纸工坊 PyInstaller 打包配置（目录模式 onedir / 无控制台）

说明：
- contents_directory="." 关闭 _internal 子目录，恢复旧版平铺布局，
  使打包后所有模块 __file__ 解析到的目录与数据文件保持一致（exe 同级），
  与开发态（项目根目录）路径逻辑完全对齐，无需改业务代码。
- pythonnet 与 pywebview 均自带 PyInstaller 钩子（hook-clr.py /
  hook-webview.py），会自动收集 runtime DLL 与 js/lib 数据。
"""
from pathlib import Path

ROOT = Path(SPECPATH)

datas = [
    (str(ROOT / "static"), "static"),              # 前端页面/脚本/样式
    (str(ROOT / "wallpapers"), "wallpapers"),      # 内置壁纸 + 动态模板
    (str(ROOT / "assets" / "images"), "assets/images"),  # 内置素材库（免首启生成）
    (str(ROOT / "library.json"), "."),             # 素材清单（根目录）
]

hiddenimports = [
    "clr",                      # pythonnet：触发 hook-clr.py 收集 runtime DLL
    "pythonnet",
    "webview.platforms.winforms",     # Windows 默认 GUI 后端（WebView2）
    "webview.platforms.edgechromium",
]

excludes = [
    "tkinter",                  # 打包后目录选择走 PowerShell，tkinter 无需携带
    "PyQt5", "PyQt6", "PySide2", "PySide6",  # 非默认 GUI 后端，避免误打包
    "gtk", "cefpython3",
    "matplotlib", "IPython", "pytest",
]

a = Analysis(
    [str(ROOT / "main.py")],
    pathex=[str(ROOT)],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=excludes,
    noarchive=False,
    optimize=1,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="WallpaperMaker",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,               # 窗口模式（无控制台），日志重定向到 app.log
    disable_windowed_traceback=False,
    contents_directory=".",
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="WallpaperMaker",
    contents_directory=".",
)
