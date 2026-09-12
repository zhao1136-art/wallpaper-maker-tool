/* 壁纸工坊 - 壁纸中心 & 设置页
 * 功能：页面切换、动态壁纸启停、壁纸库管理（生成/导入/删除/设为壁纸/锁屏/切换）、
 *       以图搜图、定时切换与节能配置
 */
(function () {
  "use strict";

  var $ = function (sel) { return document.querySelector(sel); };
  var library = [];
  var templates = [];
  var dynPoll = null;
  var dynStatus = null;

  // ==================== 工具函数 ====================
  var toastTimer = null;
  function toast(msg) {
    var t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("show"); }, 3400);
  }

  function api(path, opts) {
    return fetch(path, opts).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function readFileAsDataURL(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  // ==================== 页面切换 ====================
  function switchPage(name) {
    if (document.body.dataset.page === name) return;
    document.body.dataset.page = name;
    document.querySelectorAll(".page-tab").forEach(function (b) {
      b.classList.toggle("active", b.dataset.page === name);
    });
    var id = "page" + name[0].toUpperCase() + name.slice(1);
    document.querySelectorAll(".page").forEach(function (p) {
      p.classList.toggle("active", p.id === id);
    });
    if (name === "editor") {
      stopDynPoll();
      window.dispatchEvent(new Event("resize"));
    } else if (name === "wallpaper") {
      loadConfig(true);
      loadTemplates();
      loadLibrary();
      startDynPoll();
    } else if (name === "settings") {
      stopDynPoll();
      loadConfig(false);
    }
  }

  document.querySelectorAll(".page-tab").forEach(function (btn) {
    btn.addEventListener("click", function () { switchPage(btn.dataset.page); });
  });

  // 开发者分享壁纸：优先本地接口用系统浏览器打开，失败时应用内新窗口兜底
  var DEV_SHARE_URL = "https://1846300398.share.123pan.cn/123pan/KhL6Td-b2RyH";
  $("#devShareBtn").addEventListener("click", function () {
    api("/api/open/dev-wallpapers", { method: "POST" }).then(function (d) {
      if (!d.ok) window.open(d.url || DEV_SHARE_URL, "_blank");
    }).catch(function () {
      window.open(DEV_SHARE_URL, "_blank");
    });
  });

  // ==================== 动态壁纸模板 ====================
  function loadTemplates() {
    api("/api/dynamic/templates").then(function (d) {
      templates = d.templates || [];
      renderTemplates();
    }).catch(function () {});
  }

  function renderTemplates() {
    var box = $("#dynCards");
    $("#dynNone").hidden = templates.length > 0;
    box.innerHTML = templates.map(function (t) {
      return (
        '<div class="dyn-card" data-name="' + t.name + '">' +
        '<div class="preview"><iframe src="/dyn/' + t.name + '" sandbox="allow-scripts allow-same-origin"></iframe></div>' +
        '<div class="meta"><span class="name">' + escapeHtml(t.title) + "</span></div>" +
        '<div class="meta"><span class="desc">' + escapeHtml(t.desc) + "</span></div>" +
        '<div class="ops"><button class="btn ghost" data-act="start">启用</button></div>' +
        "</div>"
      );
    }).join("");
  }

  $("#dynCards").addEventListener("click", function (e) {
    var btn = e.target.closest("[data-act]");
    if (!btn) return;
    var card = e.target.closest(".dyn-card");
    if (!card) return;
    var name = card.dataset.name;
    if (btn.dataset.act === "start") {
      btn.disabled = true;
      btn.textContent = "启动中…";
      api("/api/dynamic/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallpaper: name })
      }).then(function (d) {
        if (!d.ok) {
          toast(d.error || "动态壁纸启动失败");
          btn.disabled = false;
          btn.textContent = "启用";
          return;
        }
        toast("已启用动态壁纸：" + name);
        refreshDynStatus(true);
      }).catch(function () {
        toast("动态壁纸启动失败");
        btn.disabled = false;
        btn.textContent = "启用";
      });
    } else if (btn.dataset.act === "stop") {
      api("/api/dynamic/stop", { method: "POST" }).then(function () {
        toast("已停止动态壁纸");
        refreshDynStatus(true);
      }).catch(function () { toast("停止失败"); });
    }
  });

  // ==================== 动态引擎状态 ====================
  function renderDynStatus(st) {
    dynStatus = st;
    var el = $("#dynStatus");
    if (!st || st.status === "idle") {
      el.hidden = true;
    } else {
      el.hidden = false;
      el.classList.remove("running", "paused");
      if (st.status === "running" || st.status === "fallback") {
        el.classList.add(st.paused ? "paused" : "running");
        el.textContent = (st.paused ? "⏸ 动态壁纸已暂停（节能）" : "● 动态壁纸运行中") +
          (st.windows > 0 ? " · " + st.windows + " 屏" : "");
      } else {
        el.textContent = "⚠ " + (st.message || "动态壁纸异常");
      }
    }
    document.querySelectorAll(".dyn-card").forEach(function (card) {
      card.classList.toggle("running", st && st.status !== "idle" && card.dataset.name === st.wallpaper);
      var btn = card.querySelector("[data-act]");
      if (!btn) return;
      var running = st && st.status !== "idle" && card.dataset.name === st.wallpaper;
      btn.dataset.act = running ? "stop" : "start";
      btn.textContent = running ? "停止" : "启用";
      btn.disabled = false;
      btn.classList.toggle("primary", running);
    });
  }

  function refreshDynStatus(silent) {
    api("/api/dynamic/status").then(function (d) {
      renderDynStatus(d);
    }).catch(function () {
      if (!silent) toast("无法获取动态壁纸状态");
    });
  }

  function startDynPoll() {
    stopDynPoll();
    refreshDynStatus();
    dynPoll = setInterval(function () { refreshDynStatus(true); }, 3000);
  }
  function stopDynPoll() {
    if (dynPoll) { clearInterval(dynPoll); dynPoll = null; }
  }

  // ==================== 壁纸库 ====================
  function loadLibrary() {
    api("/api/wallpaper/library").then(function (d) {
      library = d.items || [];
      renderLibrary();
    }).catch(function () {
      $("#wpEmpty").hidden = false;
      $("#wpEmpty").textContent = "无法连接本地服务，请通过 http://127.0.0.1:8000 访问";
    });
  }

  function renderLibrary() {
    $("#libCount").textContent = library.length;
    $("#wpEmpty").hidden = library.length > 0;
    $("#wpGrid").innerHTML = library.map(function (it) {
      var del = it.source === "user"
        ? '<button class="btn ghost danger" data-act="del">删除</button>' : "";
      return (
        '<div class="wp-card" data-file="' + it.file + '">' +
        '<div class="thumb"><img src="/api/wallpaper/thumb/' + it.file + '" loading="lazy" alt=""></div>' +
        '<div class="meta"><span class="badge ' + it.source + '">' +
        (it.source === "builtin" ? "内置" : "用户") + "</span>" +
        '<span class="name">' + escapeHtml(it.name) + "</span></div>" +
        '<div class="ops">' +
        '<button class="btn primary" data-act="set">设为壁纸</button>' +
        '<button class="btn ghost" data-act="lock">锁屏</button>' + del +
        "</div></div>"
      );
    }).join("");
  }

  function setWallpaper(file, mode) {
    return api("/api/wallpaper/set", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: file, mode: mode })
    });
  }

  $("#wpGrid").addEventListener("click", function (e) {
    var card = e.target.closest(".wp-card");
    if (!card) return;
    var file = card.dataset.file;
    var btn = e.target.closest("[data-act]");
    var mode = $("#wpMode").value;
    if (!btn) {
      setWallpaper(file, mode).then(function (d) {
        toast(d.message || (d.ok ? "已设置壁纸" : "设置失败"));
        if (!d.ok) return;
        refreshDynStatus(true);
      }).catch(function () { toast("设置失败，请检查本地服务"); });
      return;
    }
    if (btn.dataset.act === "set") {
      setWallpaper(file, mode).then(function (d) {
        toast(d.message || (d.ok ? "已设置壁纸" : "设置失败"));
        if (!d.ok) return;
        loadConfig(true);
      }).catch(function () { toast("设置失败，请检查本地服务"); });
    } else if (btn.dataset.act === "lock") {
      api("/api/wallpaper/lock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: file })
      }).then(function (d) {
        toast(d.message || (d.ok ? "锁屏壁纸已设置" : "设置失败"));
      }).catch(function () { toast("锁屏设置失败"); });
    } else if (btn.dataset.act === "del") {
      if (btn.dataset.armed) {
        api("/api/wallpaper/library/" + file, { method: "DELETE" }).then(function () {
          library = library.filter(function (it) { return it.file !== file; });
          renderLibrary();
          toast("已删除壁纸");
        }).catch(function () { toast("删除失败"); });
      } else {
        btn.dataset.armed = "1";
        btn.textContent = "确定?";
        setTimeout(function () {
          if (btn.dataset.armed) { btn.dataset.armed = ""; btn.textContent = "删除"; }
        }, 2200);
      }
    }
  });

  // 生成精选壁纸
  $("#genBtn").addEventListener("click", function () {
    var btn = this;
    btn.disabled = true;
    btn.textContent = "生成中…（首次约需 1 分钟）";
    api("/api/wallpaper/generate", { method: "POST" }).then(function (d) {
      toast("已生成 " + (d.items || []).length + " 张精选壁纸");
      loadLibrary();
    }).catch(function () {
      toast("生成失败，请检查本地服务");
    }).then(function () {
      btn.disabled = false;
      btn.textContent = "✦ 生成精选壁纸";
    });
  });

  // 导入图片到壁纸库
  $("#importBtn").addEventListener("click", function () { $("#wpFileInput").click(); });
  $("#wpFileInput").addEventListener("change", function () {
    var files = Array.prototype.slice.call(this.files);
    this.value = "";
    if (!files.length) return;
    var ok = 0, fail = 0;
    function next() {
      var f = files.shift();
      if (!f) {
        if (ok) toast("已导入 " + ok + " 张壁纸");
        if (fail) toast("有 " + fail + " 张导入失败");
        loadLibrary();
        return;
      }
      readFileAsDataURL(f).then(function (dataUrl) {
        return api("/api/wallpaper/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dataUrl: dataUrl, name: f.name })
        });
      }).then(function () { ok++; next(); })
        .catch(function () { fail++; next(); });
    }
    next();
  });

  // 立即切换
  $("#nextBtn").addEventListener("click", function () {
    api("/api/wallpaper/next", { method: "POST" }).then(function (d) {
      toast(d.message || (d.ok ? "已切换壁纸" : "切换失败"));
      if (d.ok) loadConfig(true);
    }).catch(function () { toast("切换失败，请检查本地服务"); });
  });

  // 显示模式（即时保存，用于后续设置）
  $("#wpMode").addEventListener("change", function () {
    saveConfig({ "wallpaper.mode": this.value });
    toast("默认显示模式已更新");
  });

  // ==================== 以图搜图 ====================
  function openSearch() {
    $("#searchModal").hidden = false;
    $("#searchResults").innerHTML = "";
    $("#searchBusy").hidden = true;
  }
  $("#searchBtn").addEventListener("click", openSearch);
  $("#searchClose").addEventListener("click", function () { $("#searchModal").hidden = true; });
  $("#searchModal").addEventListener("click", function (e) {
    if (e.target === this) $("#searchModal").hidden = true;
  });

  $("#searchDrop").addEventListener("click", function () { $("#searchFile").click(); });
  $("#searchFile").addEventListener("change", function () {
    if (this.files && this.files[0]) runSearch(this.files[0]);
    this.value = "";
  });
  $("#searchDrop").addEventListener("dragover", function (e) {
    e.preventDefault();
    this.classList.add("drag");
  });
  $("#searchDrop").addEventListener("dragleave", function () { this.classList.remove("drag"); });
  $("#searchDrop").addEventListener("drop", function (e) {
    e.preventDefault();
    this.classList.remove("drag");
    if (e.dataTransfer.files && e.dataTransfer.files[0]) runSearch(e.dataTransfer.files[0]);
  });

  function runSearch(file) {
    var drop = $("#searchDrop");
    drop.textContent = "读取中…";
    readFileAsDataURL(file).then(function (dataUrl) {
      drop.textContent = "点击选择或拖入图片";
      $("#searchBusy").hidden = false;
      $("#searchResults").innerHTML = "";
      return api("/api/wallpaper/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataUrl: dataUrl })
      });
    }).then(function (d) {
      $("#searchBusy").hidden = true;
      var res = d.results || [];
      if (!res.length) {
        $("#searchResults").innerHTML = '<div class="empty-tip" style="grid-column:1/-1">没有找到相似的壁纸，试试其他图片</div>';
        return;
      }
      $("#searchResults").innerHTML = res.map(function (r) {
        return (
          '<div class="search-item" data-file="' + r.file + '">' +
          '<div class="thumb"><img src="/api/wallpaper/thumb/' + r.file + '" alt=""></div>' +
          '<div class="meta"><span class="name">' + escapeHtml(r.name) + "</span>" +
          '<span class="dist">相似 ' + (100 - r.dist * 4) + "%</span></div>" +
          "</div>"
        );
      }).join("");
    }).catch(function () {
      drop.textContent = "点击选择或拖入图片";
      $("#searchBusy").hidden = true;
      $("#searchResults").innerHTML = '<div class="empty-tip" style="grid-column:1/-1">检索失败，请检查本地服务</div>';
    });
  }

  $("#searchResults").addEventListener("click", function (e) {
    var item = e.target.closest(".search-item");
    if (!item) return;
    var file = item.dataset.file;
    var mode = $("#wpMode").value;
    setWallpaper(file, mode).then(function (d) {
      toast(d.message || (d.ok ? "已设置壁纸" : "设置失败"));
      if (d.ok) {
        loadConfig(true);
        $("#searchModal").hidden = true;
      }
    }).catch(function () { toast("设置失败"); });
  });

  // ==================== 配置 ====================
  function saveConfig(updates) {
    return api("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ updates: updates })
    }).catch(function () { toast("配置保存失败"); });
  }

  function loadConfig(forCenter) {
    api("/api/config").then(function (d) {
      var cfg = d.config || {};
      if (forCenter) {
        $("#wpMode").value = (cfg.wallpaper && cfg.wallpaper.mode) || "fit";
        return;
      }
      var s = cfg.scheduler || {}, ps = cfg.power_save || {}, dy = cfg.dynamic || {};
      $("#schedEnabled").checked = !!s.enabled;
      $("#schedInterval").value = s.interval_min || 30;
      $("#schedOrder").value = s.order || "random";
      $("#schedSource").value = s.source || "builtin";
      $("#psFull").checked = !!ps.fullscreen_pause;
      $("#psBattery").checked = !!ps.battery_pause;
      $("#dynPerMonitor").checked = !!dy.per_monitor;
      $("#dynClick").checked = !!dy.click_through;
      $("#defMode").value = (cfg.wallpaper && cfg.wallpaper.mode) || "fit";
      $("#curWall").textContent = (cfg.wallpaper && cfg.wallpaper.current) || "无";
    }).catch(function () {
      toast("无法加载配置，请检查本地服务");
    });
  }

  function bindSetting(id, key, transform) {
    $(id).addEventListener("change", function () {
      var v = this.type === "checkbox" ? this.checked
        : transform ? transform(this.value) : this.value;
      saveConfig((function (o) { o[key] = v; return o; })({}));
    });
  }
  bindSetting("#schedEnabled", "scheduler.enabled");
  bindSetting("#schedInterval", "scheduler.interval_min", function (v) {
    return Math.max(1, Math.min(1440, parseInt(v, 10) || 30));
  });
  bindSetting("#schedOrder", "scheduler.order");
  bindSetting("#schedSource", "scheduler.source");
  bindSetting("#psFull", "power_save.fullscreen_pause");
  bindSetting("#psBattery", "power_save.battery_pause");
  bindSetting("#dynPerMonitor", "dynamic.per_monitor");
  bindSetting("#dynClick", "dynamic.click_through");
  bindSetting("#defMode", "wallpaper.mode");

  // ==================== 初始化 ====================
  document.body.dataset.page = "editor";
  loadConfig(true);
})();
