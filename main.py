# -*- coding: utf-8 -*-
"""壁纸工坊 - 程序入口
启动本地 HTTP 服务 + 定时切换线程，并在软件内置浏览器窗口（pywebview）中打开界面。
动态壁纸引擎在 webview 就绪后由 GUI 线程驱动。
pywebview 不可用时回退为系统浏览器打开。
"""
import os
import sys
import threading
import webbrowser

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import server as srv
from core import assets_gen, generate, scheduler


def main():
    httpd, port = srv.create_server()
    engine = srv.engine
    url = "http://127.0.0.1:%d" % port
    print("本地服务已启动：%s" % url)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    # 后台预生成内置精选壁纸（首启耗时，不阻塞窗口）
    threading.Thread(target=generate.generate_builtin, daemon=True).start()
    # 后台补全内置素材库（纹理/光斑/渐变/剪贴元素，幂等）
    threading.Thread(target=assets_gen.ensure_builtin_assets, daemon=True).start()

    sched = scheduler.Scheduler()
    sched.start()

    try:
        import webview

        webview.create_window(
            "桌面壁纸制作工具",
            url,
            width=1380,
            height=880,
            min_size=(1100, 680),
        )
        webview.start(engine.start_engine_loop)
    except Exception as exc:
        print("内置浏览器窗口启动失败：%s" % exc)
        print("已回退为系统浏览器打开：%s" % url)
        print("提示：动态壁纸依赖内置窗口引擎（WebView2），浏览器模式下动态壁纸不可用，"
              "请检查 WebView2 Runtime 后重试。")
        webbrowser.open(url)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
    finally:
        try:
            engine.stop_all()
        except Exception:
            pass
        sched.stop()
        try:
            httpd.shutdown()
            httpd.server_close()
        except OSError:
            pass
    print("已退出。")


if __name__ == "__main__":
    main()
