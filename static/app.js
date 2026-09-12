/* 桌面壁纸制作工具 - 画布编辑器
 * 功能：Emoji/图片素材、拖拽/缩放/旋转、图层管理、撤销重做、背景设置、导出
 */
(function () {
  "use strict";

  var $ = function (sel) { return document.querySelector(sel); };

  // ==================== 状态 ====================
  var SIZE_PRESETS = [
    ["1920x1080", "1920×1080 · 横屏"],
    ["2560x1440", "2560×1440 · 2K"],
    ["3840x2160", "3840×2160 · 4K"],
    ["1440x2560", "1440×2560 · 竖屏"],
    ["1080x1920", "1080×1920 · 手机"],
    ["1080x1080", "1080×1080 · 方形"]
  ];

  var state = {
    baseW: 1920,
    baseH: 1080,
    scale: 1,
    bg: { type: "solid", color: "#1a2a6c", grad1: "#ff9966", grad2: "#ff5e62", angle: 135, imageId: null, imageEl: null },
    elements: [],
    selectedId: null,
    history: [],
    historyIdx: -1,
    tool: "select",   // select / text / brush
    brushCfg: { type: "pencil", size: 12, color: "#ff5e62", opacity: 0.8 },
    // 图层：数组序 = 图层 z 序（后=上）；元素通过 el.layer 指向图层 id
    layers: [],
    activeLayerId: null
  };

  var HISTORY_LIMIT = 60;
  var drag = null; // {mode, id, ...}
  var dpr = window.devicePixelRatio || 1;
  var assets = [];
  var catActive = "all";
  var emojiFlat = [];
  var uploadBusy = false;

  var canvas = $("#canvas");
  var ctx = canvas.getContext("2d");

  // ==================== 工具函数 ====================
  function uid() { return "el" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  function lid() { return "layer" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  // ---------- 图层 helper ----------
  function layerById(id) {
    return state.layers.find(function (l) { return l.id === id; }) || state.layers[0] || null;
  }

  function layerIndex(id) {
    for (var i = 0; i < state.layers.length; i++) {
      if (state.layers[i].id === id) return i;
    }
    return -1;
  }

  function activeLayer() {
    return layerById(state.activeLayerId);
  }

  function cloneLayers(list) {
    return (list || state.layers).map(function (l) { return Object.assign({}, l); });
  }

  // 定位某图层在 elements 中连续块半开区间 [start, end)，未找到则 start=-1
  function layerRange(id) {
    var start = -1, end = -1;
    for (var i = 0; i < state.elements.length; i++) {
      if (state.elements[i].layer === id) {
        if (start === -1) start = i;
        end = i + 1;
      } else if (start !== -1) {
        break;
      }
    }
    return [start, end];
  }

  function elementsOfLayer(id) {
    var r = layerRange(id);
    return r[0] === -1 ? [] : state.elements.slice(r[0], r[1]);
  }

  function visibleElements() {
    return state.elements.filter(function (el) {
      var l = layerById(el.layer);
      return !l || l.visible !== false;
    });
  }

  // 新建元素进入活动图层：插入该层块末尾，保持"按层分组"不变量
  function addElementToLayer(el) {
    el.layer = activeLayer().id;
    var r = layerRange(el.layer);
    var at;
    if (r[0] !== -1) {
      at = r[1]; // 已有块：插入块末尾
    } else {
      // 空图层：插入到其下方所有非空图层元素之后
      at = 0;
      var idx = layerIndex(el.layer);
      for (var i = 0; i < idx; i++) {
        var br = layerRange(state.layers[i].id);
        if (br[0] !== -1) at = Math.max(at, br[1]);
      }
    }
    state.elements.splice(at, 0, el);
  }

  // 图层被锁定则禁止编辑/选择/拖拽/删除
  function layerLockedOf(elId) {
    var el = state.elements.find(function (it) { return it.id === elId; });
    var l = el && layerById(el.layer);
    return !!(l && l.locked);
  }

  // 确保至少存在一个默认图层，并为无 layer 归属的旧元素补全归属
  function ensureLayers() {
    if (!state.layers.length) {
      state.layers.push({ id: lid(), name: "图层 1", visible: true, locked: false });
    }
    if (!state.activeLayerId || !layerById(state.activeLayerId)) {
      state.activeLayerId = state.layers[state.layers.length - 1].id;
    }
    var hasLayer = {};
    state.layers.forEach(function (l) { hasLayer[l.id] = true; });
    state.elements.forEach(function (el) {
      if (!el.layer || !hasLayer[el.layer]) el.layer = state.activeLayerId;
    });
    // 归组不变量：按图层顺序重新排列元素（稳定排序，组内保持原序）
    var order = {};
    state.layers.forEach(function (l, i) { order[l.id] = i; });
    state.elements.sort(function (a, b) {
      return order[a.layer] - order[b.layer];
    });
  }

  function cloneElements(list) {
    return (list || state.elements).map(function (el) {
      var c = Object.assign({}, el);
      if (c.points) c.points = c.points.map(function (p) { return { x: p.x, y: p.y }; });
      return c;
    });
  }

  function commit() {
    var last = state.history[state.historyIdx];
    var snap = { elements: cloneElements(), layers: cloneLayers(), activeLayerId: state.activeLayerId };
    if (last && JSON.stringify(last) === JSON.stringify(snap)) return;
    state.history = state.history.slice(0, state.historyIdx + 1);
    state.history.push(snap);
    if (state.history.length > HISTORY_LIMIT) state.history.shift();
    state.historyIdx = state.history.length - 1;
    updateHistoryButtons();
  }

  function undo() {
    if (state.historyIdx <= 0) return;
    state.historyIdx--;
    restore();
  }

  function redo() {
    if (state.historyIdx >= state.history.length - 1) return;
    state.historyIdx++;
    restore();
  }

  function restore() {
    var snap = state.history[state.historyIdx];
    state.elements = cloneElements(snap.elements);
    state.layers = cloneLayers(snap.layers);
    state.activeLayerId = snap.activeLayerId;
    if (!state.layers.length) ensureLayers();
    render();
    renderLayers();
    updatePropsPanel();
    updateHistoryButtons();
  }

  function updateHistoryButtons() {
    $("#undoBtn").disabled = state.historyIdx <= 0;
    $("#redoBtn").disabled = state.historyIdx >= state.history.length - 1;
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("show"); }, 3400);
  }

  function getSelected() {
    return state.elements.find(function (el) { return el.id === state.selectedId; }) || null;
  }

  // ==================== 工具切换 ====================
  function setTool(name) {
    state.tool = name;
    document.querySelectorAll(".tool-btn").forEach(function (b) {
      b.classList.toggle("active", b.dataset.tool === name);
    });
    $("#canvas").style.cursor = name === "select" ? "default" : "crosshair";
    if ($("#brushCtl")) $("#brushCtl").hidden = name !== "brush";
    if (name !== "select") select(null);
  }

  // ==================== Emoji 库 ====================
  function buildEmojiIndex() {
    emojiFlat = [];
    EMOJI_GROUPS.forEach(function (g) {
      g.list.forEach(function (entry) {
        emojiFlat.push({ ch: entry[0], kw: entry[1].toLowerCase(), gid: g.id });
      });
    });
  }

  function buildCats() {
    var nav = $("#emojiCats");
    var html = '<button class="cat-chip active" data-cat="all">全部 ' + emojiFlat.length + "</button>";
    EMOJI_GROUPS.forEach(function (g) {
      html += '<button class="cat-chip" data-cat="' + g.id + '">' + g.name + " " + g.list.length + "</button>";
    });
    nav.innerHTML = html;
    nav.addEventListener("click", function (e) {
      var btn = e.target.closest(".cat-chip");
      if (!btn) return;
      catActive = btn.dataset.cat;
      nav.querySelectorAll(".cat-chip").forEach(function (c) { c.classList.toggle("active", c === btn); });
      renderEmojiGrid();
    });
  }

  function renderEmojiGrid() {
    var kw = $("#emojiSearch").value.trim().toLowerCase();
    var list = emojiFlat;
    if (catActive !== "all") list = list.filter(function (it) { return it.gid === catActive; });
    if (kw) {
      var tokens = kw.split(/\s+/);
      list = list.filter(function (it) {
        return tokens.every(function (t) { return it.kw.indexOf(t) !== -1; });
      });
    }
    var grid = $("#emojiGrid");
    grid.innerHTML = list.map(function (it) {
      return '<button class="emoji-cell" data-ch="' + it.ch + '" title="' + it.ch + '">' + it.ch + "</button>";
    }).join("");
    if (!list.length) grid.innerHTML = '<div class="empty-tip" style="grid-column:1/-1">没有匹配的表情</div>';
  }

  function addEmoji(ch) {
    var size = Math.max(80, Math.min(320, Math.round(state.baseW / 8)));
    var el = {
      id: uid(), kind: "emoji", emoji: ch, img: null,
      cx: state.baseW / 2, cy: state.baseH / 2,
      w: size, h: size, rot: 0, opacity: 1
    };
    addElementToLayer(el);
    state.selectedId = el.id;
    render(); renderLayers(); updatePropsPanel();
  }

  // ==================== 文字工具 ====================
  function remeasureText(el) {
    var lay = window.wm.wmMeasureText(ctx, el);
    el.w = Math.max(1, lay.w);
    el.h = Math.max(el.fontSize || 96, lay.h);
  }

  function addTextAt(p) {
    var el = {
      id: uid(), kind: "text",
      text: "双击编辑文本",
      font: "Microsoft YaHei",
      fontSize: 96,
      color: "#ffffff",
      align: "left",
      bold: false, italic: false,
      lineHeight: 1.2,
      cx: p.x, cy: p.y, rot: 0, opacity: 1, w: 1, h: 1
    };
    remeasureText(el);
    addElementToLayer(el);
    state.selectedId = el.id;
    setTool("select");
    render(); renderLayers(); updatePropsPanel();
    focusTextEditor();
  }

  // ==================== 图片素材库 ====================
  function api(path, opts) {
    return fetch(path, opts).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }

  function loadAssets(attempt) {
    attempt = attempt || 0;
    api("/api/assets").then(function (data) {
      assets = data.assets || [];
      if (!assets.length && attempt < 10) {
        // 内置素材仍在后台生成，稍后自动刷新
        $("#imgEmpty").hidden = false;
        $("#imgEmpty").textContent = "素材库生成中，稍后自动刷新…";
        setTimeout(function () { loadAssets(attempt + 1); }, 3000);
        return;
      }
      $("#imgEmpty").textContent = "还没有图片素材<br>点击上方「加入图片」导入本地图片";
      renderImgGrid();
      renderBgPick();
    }).catch(function () {
      $("#imgEmpty").hidden = false;
      $("#canvasHint").hidden = false;
      $("#canvasHint").textContent = "无法连接本地服务，请通过 http://127.0.0.1:8000 访问";
    });
  }

  function renderImgGrid() {
    var grid = $("#imgGrid");
    $("#imgEmpty").hidden = assets.length > 0;
    grid.innerHTML = assets.slice().sort(function (a, b) {
      return (a.cat || "").localeCompare(b.cat || "");
    }).map(function (it) {
      return (
        '<div class="img-card" data-id="' + it.id + '" title="' + it.name + '">' +
        '<div class="thumb"><img src="/api/thumb/' + it.id + '" alt=""></div>' +
        '<div class="meta"><span class="name">' + escapeHtml(it.name) + "</span>" +
        '<button class="mini del" data-act="del">✕</button></div></div>'
      );
    }).join("");
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var im = new Image();
      im.onload = function () { resolve(im); };
      im.onerror = reject;
      im.src = src;
    });
  }

  function addImageAsset(item) {
    loadImage("/api/image/" + item.id).then(function (img) {
      var w = Math.min(600, Math.max(120, Math.round(state.baseW / 3)));
      var h = Math.round((w * img.height) / img.width);
      var el = {
        id: uid(), kind: "image", emoji: null, img: img,
        cx: state.baseW / 2, cy: state.baseH / 2,
        w: w, h: h, rot: 0, opacity: 1
      };
      addElementToLayer(el);
      state.selectedId = el.id;
      render(); renderLayers(); updatePropsPanel();
    }).catch(function () { toast("图片加载失败"); });
  }

  function readFileAsDataURL(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  function makeThumb(dataUrl, max) {
    return loadImage(dataUrl).then(function (im) {
      var s = Math.min(1, max / Math.max(im.width, im.height));
      var c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(im.width * s));
      c.height = Math.max(1, Math.round(im.height * s));
      c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
      return c.toDataURL("image/png");
    });
  }

  function uploadFiles(files) {
    if (!files.length) return;
    if (uploadBusy) { toast("正在上传，请稍候"); return; }
    uploadBusy = true;
    $("#uploadBtn").textContent = "上传中…";
    var queue = Array.prototype.slice.call(files);
    var ok = 0, fail = 0;

    function next() {
      var file = queue.shift();
      if (!file) {
        uploadBusy = false;
        $("#uploadBtn").textContent = "＋ 加入图片";
        if (ok) toast("已加入 " + ok + " 张图片");
        if (fail) toast("有 " + fail + " 张图片处理失败");
        loadAssets();
        return;
      }
      readFileAsDataURL(file)
        .then(function (dataUrl) { return makeThumb(dataUrl, 220).then(function (thumb) { return { dataUrl: dataUrl, thumb: thumb }; }); })
        .then(function (d) {
          return api("/api/assets", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ dataUrl: d.dataUrl, thumbDataUrl: d.thumb, name: file.name })
          });
        })
        .then(function () { ok++; next(); })
        .catch(function () { fail++; next(); });
    }
    next();
  }

  // ==================== 画布渲染 ====================
  function updateCanvasSize() {
    canvas.width = Math.round(state.baseW * state.scale * dpr);
    canvas.height = Math.round(state.baseH * state.scale * dpr);
    canvas.style.width = Math.round(state.baseW * state.scale) + "px";
    canvas.style.height = Math.round(state.baseH * state.scale) + "px";
    $("#zoomLabel").textContent = Math.round(state.scale * 100) + "%";
  }

  function setZoom(z) {
    state.scale = Math.max(0.05, Math.min(4, z));
    updateCanvasSize();
    render();
  }

  function fitZoom() {
    var area = $("#canvasArea");
    var z = Math.min((area.clientWidth - 90) / state.baseW, (area.clientHeight - 90) / state.baseH);
    setZoom(Math.min(1, Math.max(0.05, z)));
  }

  function paintBackground(c, W, H) {
    window.wm.wmPaintBackground(c, state.bg, W, H);
  }

  function drawElement(c, el) {
    window.wm.wmDrawElement(c, el);
  }

  function render() {
    var cssW = canvas.width / dpr, cssH = canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.setTransform(state.scale * dpr, 0, 0, state.scale * dpr, 0, 0);
    paintBackground(ctx, state.baseW, state.baseH);
    visibleElements().forEach(function (el) { drawElement(ctx, el); });
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (drag && drag.snapX) drawGuide(drag.nx * state.scale, "v");
    if (drag && drag.snapY) drawGuide(drag.ny * state.scale, "h");
    var sel = getSelected();
    if (sel) drawHandles(sel);
    persistDraft();
  }

  function drawGuide(pos, dir) {
    ctx.strokeStyle = "#ff5e62";
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    if (dir === "v") { ctx.moveTo(pos, 0); ctx.lineTo(pos, canvas.height / dpr); }
    else { ctx.moveTo(0, pos); ctx.lineTo(canvas.width / dpr, pos); }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function handlePoints(el) {
    var s = state.scale;
    var a = (el.rot * Math.PI) / 180;
    var hw = (el.w / 2) * s, hh = (el.h / 2) * s;
    var cx = el.cx * s, cy = el.cy * s;
    var cos = Math.cos(a), sin = Math.sin(a);
    var pts = [];
    [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].forEach(function (p) {
      pts.push({ x: cx + p[0] * cos - p[1] * sin, y: cy + p[0] * sin + p[1] * cos });
    });
    var rhx = cx + (hh + 30 * s) * sin;
    var rhy = cy - (hh + 30 * s) * cos;
    var tcx = cx + hh * sin, tcy = cy - hh * cos;
    return { pts: pts, rot: { x: rhx, y: rhy }, top: { x: tcx, y: tcy } };
  }

  function drawHandles(el) {
    var h = handlePoints(el);
    ctx.strokeStyle = "#5b8cff";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    h.pts.forEach(function (p, i) {
      if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    });
    ctx.closePath();
    ctx.stroke();
    h.pts.forEach(function (p) {
      ctx.fillStyle = "#fff";
      ctx.fillRect(p.x - 4, p.y - 4, 8, 8);
      ctx.strokeRect(p.x - 4, p.y - 4, 8, 8);
    });
    ctx.strokeStyle = "#5b8cff";
    ctx.beginPath();
    ctx.moveTo(h.top.x, h.top.y);
    ctx.lineTo(h.rot.x, h.rot.y);
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(h.rot.x, h.rot.y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  function hitTest(px, py) {
    for (var i = state.elements.length - 1; i >= 0; i--) {
      var el = state.elements[i];
      // 隐藏/锁定图层的元素不可选中
      var l = layerById(el.layer);
      if (l && (l.visible === false || l.locked)) continue;
      var dx = px - el.cx, dy = py - el.cy;
      var a = (-el.rot * Math.PI) / 180;
      var lx = dx * Math.cos(a) - dy * Math.sin(a);
      var ly = dx * Math.sin(a) + dy * Math.cos(a);
      if (Math.abs(lx) <= el.w / 2 && Math.abs(ly) <= el.h / 2) return el;
    }
    return null;
  }

  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  // ==================== 指针交互 ====================
  function getPos(e) {
    var rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / state.scale,
      y: (e.clientY - rect.top) / state.scale
    };
  }

  canvas.addEventListener("pointerdown", function (e) {
    if (e.button !== 0) return;
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 合成事件等场景无活动指针 */ }
    var p = getPos(e);
    var sp = { x: p.x * state.scale, y: p.y * state.scale };
    var sel = getSelected();

    if (state.tool === "text") { addTextAt(p); return; }
    if (state.tool === "brush") {
      if (activeLayer().locked) { toast("当前图层已锁定，无法绘制"); return; }
      beginBrush(p); return;
    }

    if (sel) {
      if (layerLockedOf(sel.id)) { toast("图层已锁定，无法编辑元素"); return; }
      var h = handlePoints(sel);
      for (var i = 0; i < 4; i++) {
        if (dist(sp, h.pts[i]) < 10) {
          beginScale(sel, i, p);
          return;
        }
      }
      if (dist(sp, h.rot) < 12) {
        beginRotate(sel, p);
        return;
      }
    }

    var el = hitTest(p.x, p.y);
    if (el) {
      select(el.id);
      drag = {
        mode: "move", id: el.id,
        sx: p.x, sy: p.y, ox: el.cx, oy: el.cy,
        snapX: false, snapY: false
      };
    } else {
      select(null);
    }
  });

  function beginScale(el, ci, p) {
    var a = (-el.rot * Math.PI) / 180;
    var hw = el.w / 2, hh = el.h / 2;
    var off = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]][ci];
    var ox = el.cx + off[0] * Math.cos(a) - off[1] * Math.sin(a);
    var oy = el.cy + off[0] * Math.sin(a) + off[1] * Math.cos(a);
    var vx = p.x - ox, vy = p.y - oy;
    var lxs = vx * Math.cos(a) - vy * Math.sin(a);
    var lys = vx * Math.sin(a) + vy * Math.cos(a);
    drag = {
      mode: "scale", id: el.id, ci: ci,
      ox: ox, oy: oy, sw: el.w, sh: el.h,
      useW: Math.abs(lxs) >= Math.abs(lys)
    };
  }

  function beginRotate(el, p) {
    drag = {
      mode: "rotate", id: el.id, rot0: el.rot,
      a0: Math.atan2(p.y - el.cy, p.x - el.cx)
    };
  }

  canvas.addEventListener("pointermove", function (e) {
    if (!drag) return;
    var p = getPos(e);
    var el = state.elements.find(function (it) { return it.id === drag.id; });
    if (!el) return;
    // 图层在拖拽期间被锁定则放弃本次操作
    if (drag.mode !== "brush" && layerLockedOf(el.id)) {
      drag = null;
      toast("图层已锁定，无法编辑元素");
      return;
    }

    if (drag.mode === "brush") {
      var d = Math.hypot(p.x - drag.last.x, p.y - drag.last.y);
      if (d > 2 / state.scale && el.points.length < 2000) {
        el.points.push({
          x: Math.round(p.x * 10) / 10 - el.cx,
          y: Math.round(p.y * 10) / 10 - el.cy
        });
        drag.last = { x: p.x, y: p.y };
      }
      render();
      return;
    }

    if (drag.mode === "move") {
      var nx = drag.ox + (p.x - drag.sx);
      var ny = drag.oy + (p.y - drag.sy);
      var snap = 8 / state.scale;
      drag.snapX = Math.abs(nx - state.baseW / 2) < snap;
      drag.snapY = Math.abs(ny - state.baseH / 2) < snap;
      if (drag.snapX) nx = state.baseW / 2;
      if (drag.snapY) ny = state.baseH / 2;
      drag.nx = nx; drag.ny = ny;
      el.cx = nx; el.cy = ny;
    } else if (drag.mode === "scale") {
      var a = (-el.rot * Math.PI) / 180;
      var dx = p.x - drag.ox, dy = p.y - drag.oy;
      var lx = dx * Math.cos(a) - dy * Math.sin(a);
      var ly = dx * Math.sin(a) + dy * Math.cos(a);
      var k = drag.useW ? Math.abs(lx) / (drag.sw / 2) : Math.abs(ly) / (drag.sh / 2);
      k = Math.max(0.05, k);
      el.w = drag.sw * k;
      el.h = drag.sh * k;
    } else if (drag.mode === "rotate") {
      var ang = Math.atan2(p.y - el.cy, p.x - el.cx);
      var rot = drag.rot0 + ((ang - drag.a0) * 180) / Math.PI;
      el.rot = ((rot % 360) + 360) % 360;
    }
    render();
    updatePropsPanel();
  });

  function endDrag() {
    if (drag && drag.mode === "brush") {
      var el = state.elements.find(function (it) { return it.id === drag.id; });
      if (el) {
        finalizeBrush(el);
        commit();
        render();
        renderLayers();
        updatePropsPanel();
      }
    }
    drag = null;
  }

  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("pointerleave", function (e) {
    if (drag && !e.buttons) endDrag();
  });

  // 任何交互开始前先存档（历史快照）
  window.addEventListener("pointerdown", function () {
    if (!drag) commit();
  });

  // ==================== 选择与属性面板 ====================
  function select(id) {
    state.selectedId = id;
    var el = getSelected();
    if (el) state.activeLayerId = el.layer;
    render();
    renderLayers();
    updatePropsPanel();
  }

  function updatePropsPanel() {
    var el = getSelected();
    var sec = $("#propSection");
    if (!el) { sec.hidden = true; return; }
    sec.hidden = false;
    $("#textCtl").hidden = el.kind !== "text";
    if (el.kind === "text") {
      fillTextCtl(el);
      $("#propSize").value = el.fontSize;
      $("#propSizeVal").textContent = Math.round(el.fontSize);
      $("#propSizeLabel").textContent = "字号";
    } else if (el.kind === "brush") {
      $("#propSize").value = el.size;
      $("#propSizeVal").textContent = Math.round(el.size);
      $("#propSizeLabel").textContent = "粗细";
    } else {
      $("#propSize").value = el.w;
      $("#propSizeVal").textContent = Math.round(el.w);
      $("#propSizeLabel").textContent = el.kind === "emoji" ? "大小" : "宽度";
    }
    $("#propRot").value = Math.round(el.rot);
    $("#propRotVal").textContent = Math.round(el.rot) + "°";
    $("#propOpacity").value = Math.round(el.opacity * 100);
    $("#propOpacityVal").textContent = Math.round(el.opacity * 100) + "%";
  }

  function fillTextCtl(el) {
    $("#textContent").value = el.text;
    $("#textFont").value = el.font;
    $("#textColor").value = el.color;
    $("#textColorHex").textContent = el.color;
    $("#textLineHeight").value = Math.round(el.lineHeight * 100);
    $("#textLineHeightVal").textContent = Math.round(el.lineHeight * 100) + "%";
    $("#textBold").checked = !!el.bold;
    $("#textItalic").checked = !!el.italic;
    document.querySelectorAll("#textCtl [data-align]").forEach(function (b) {
      b.classList.toggle("active", b.dataset.align === el.align);
    });
  }

  function focusTextEditor() {
    var inp = $("#textContent");
    if (inp && !inp.hidden) {
      inp.focus();
      inp.select();
    }
  }

  function bindTextCtl() {
    var deb = null;
    $("#textContent").addEventListener("input", function () {
      var el = getSelected();
      if (!el) return;
      if (layerLockedOf(el.id)) return;
      el.text = this.value;
      remeasureText(el);
      render();
      clearTimeout(deb);
      deb = setTimeout(commit, 500);
    });
    $("#textFont").addEventListener("change", function () {
      var el = getSelected();
      if (!el) return;
      if (layerLockedOf(el.id)) { toast("图层已锁定，无法编辑元素"); return; }
      el.font = this.value;
      remeasureText(el);
      render(); commit();
    });
    $("#textColor").addEventListener("input", function () {
      var el = getSelected();
      if (!el) return;
      if (layerLockedOf(el.id)) return;
      el.color = this.value;
      $("#textColorHex").textContent = this.value;
      render();
    });
    $("#textBold").addEventListener("change", function () {
      var el = getSelected();
      if (!el) return;
      if (layerLockedOf(el.id)) { toast("图层已锁定，无法编辑元素"); return; }
      el.bold = this.checked;
      remeasureText(el);
      render(); commit();
    });
    $("#textItalic").addEventListener("change", function () {
      var el = getSelected();
      if (!el) return;
      if (layerLockedOf(el.id)) { toast("图层已锁定，无法编辑元素"); return; }
      el.italic = this.checked;
      remeasureText(el);
      render(); commit();
    });
    $("#textLineHeight").addEventListener("input", function () {
      var el = getSelected();
      if (!el) return;
      if (layerLockedOf(el.id)) return;
      el.lineHeight = parseInt(this.value, 10) / 100;
      $("#textLineHeightVal").textContent = this.value + "%";
      remeasureText(el);
      render();
    });
    $("#textLineHeight").addEventListener("pointerdown", commit);
    document.querySelectorAll("#textAlign [data-align]").forEach(function (b) {
      b.addEventListener("click", function () {
        var el = getSelected();
        if (!el) return;
        if (layerLockedOf(el.id)) { toast("图层已锁定，无法编辑元素"); return; }
        el.align = b.dataset.align;
        document.querySelectorAll("#textAlign [data-align]").forEach(function (x) {
          x.classList.toggle("active", x === b);
        });
        remeasureText(el);
        render(); commit();
      });
    });
  }

  // ==================== 绘制工具 ====================
  function beginBrush(p) {
    commit(); // 落笔前存档，便于逐笔撤销
    var cfg = state.brushCfg;
    var el = {
      id: uid(), kind: "brush",
      brush: cfg.type, size: cfg.size, color: cfg.color, opacity: cfg.opacity,
      cx: Math.round(p.x * 10) / 10, cy: Math.round(p.y * 10) / 10,
      points: [{ x: 0, y: 0 }], w: cfg.size, h: cfg.size, rot: 0
    };
    addElementToLayer(el);
    state.selectedId = el.id;
    drag = { mode: "brush", id: el.id, last: { x: p.x, y: p.y } };
    render(); renderLayers(); updatePropsPanel();
  }

  function finalizeBrush(el) {
    if (!el.points || !el.points.length) return;
    var minX = 0, minY = 0, maxX = 0, maxY = 0;
    el.points.forEach(function (pt) {
      if (pt.x < minX) minX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y > maxY) maxY = pt.y;
    });
    el.w = Math.max(el.size, maxX - minX + el.size);
    el.h = Math.max(el.size, maxY - minY + el.size);
  }

  function bindBrushCtl() {
    document.querySelectorAll("#brushType [data-brush]").forEach(function (b) {
      b.addEventListener("click", function () {
        state.brushCfg.type = b.dataset.brush;
        document.querySelectorAll("#brushType [data-brush]").forEach(function (x) {
          x.classList.toggle("active", x === b);
        });
      });
    });
    $("#brushSize").addEventListener("input", function () {
      state.brushCfg.size = parseInt(this.value, 10);
      $("#brushSizeVal").textContent = this.value;
    });
    $("#brushColor").addEventListener("input", function () {
      state.brushCfg.color = this.value;
      $("#brushColorHex").textContent = this.value;
    });
    $("#brushOpacity").addEventListener("input", function () {
      state.brushCfg.opacity = parseInt(this.value, 10) / 100;
      $("#brushOpacityVal").textContent = this.value + "%";
    });
  }

  function renderLayers() {
    var list = $("#layerList");
    $("#layerCount").textContent = state.layers.length;
    $("#layerEmpty").hidden = state.layers.length > 0;
    var html = "";
    // 图层列表自上而下 = 最上层在前
    for (var i = state.layers.length - 1; i >= 0; i--) {
      var l = state.layers[i];
      var cnt = elementsOfLayer(l.id).length;
      html +=
        '<div class="layer-item' +
        (l.id === state.activeLayerId ? " active" : "") +
        (l.visible === false ? " hidden" : "") +
        (l.locked ? " locked" : "") +
        '" data-id="' + l.id + '">' +
        '<button class="vis" data-act="vis" title="' + (l.visible === false ? "显示图层" : "隐藏图层") + '">' +
        (l.visible === false ? "🈲" : "👁") + "</button>" +
        '<span class="name" title="' + escapeHtml(l.name) + '">' + escapeHtml(l.name) + "</span>" +
        '<span class="cnt">' + cnt + "</span>" +
        '<span class="ops">' +
        '<button data-act="lock" title="' + (l.locked ? "解锁图层" : "锁定图层") + '">' + (l.locked ? "🔓" : "🔒") + "</button>" +
        '<button data-act="up" title="上移图层（Ctrl+Shift+]）">▲</button>' +
        '<button data-act="down" title="下移图层（Ctrl+Shift+[）">▼</button>' +
        '<button data-act="del" class="del" title="删除图层">✕</button>' +
        "</span></div>";
    }
    list.innerHTML = html;
  }

  // 激活图层：设为活动图层并选中该层最上层元素
  function activateLayer(id) {
    state.activeLayerId = id;
    var els = elementsOfLayer(id);
    state.selectedId = els.length ? els[els.length - 1].id : null;
    render(); renderLayers(); updatePropsPanel();
  }

  // 图层内移动元素 z 序（复用原能力：Ctrl+]/[）
  function moveElementInLayer(el, dir) {
    var els = elementsOfLayer(el.layer);
    var idx = els.indexOf(el);
    var target = dir === "up" ? idx + 1 : idx - 1;
    if (target < 0 || target >= els.length) return false;
    var block = layerRange(el.layer);
    var absIdx = block[0] + idx;
    var absTarget = block[0] + target;
    state.elements.splice(absIdx, 1);
    state.elements.splice(absTarget, 0, el);
    return true;
  }

  function createLayer(name) {
    var l = { id: lid(), name: name || ("图层 " + (state.layers.length + 1)), visible: true, locked: false };
    state.layers.push(l);
    state.activeLayerId = l.id;
    state.selectedId = null;
    commit();
    render(); renderLayers(); updatePropsPanel();
    return l;
  }

  function deleteLayer(id) {
    if (state.layers.length <= 1) { toast("至少保留一个图层"); return; }
    commit();
    var r = layerRange(id);
    if (r[0] !== -1) state.elements.splice(r[0], r[1] - r[0]);
    var idx = layerIndex(id);
    state.layers.splice(idx, 1);
    if (state.activeLayerId === id) {
      state.activeLayerId = state.layers[Math.max(0, Math.min(idx, state.layers.length - 1))].id;
    }
    if (state.selectedId && !state.elements.some(function (it) { return it.id === state.selectedId; })) {
      state.selectedId = null;
    }
    render(); renderLayers(); updatePropsPanel();
  }

  function moveLayer(id, dir) {
    var idx = layerIndex(id);
    var target = dir === "up" ? idx + 1 : idx - 1;
    if (target < 0 || target >= state.layers.length) return;
    commit();
    var l = state.layers[idx];
    state.layers.splice(idx, 1);
    state.layers.splice(target, 0, l);
    // 按新图层顺序重组元素（组内保持原序，维持归组不变量）
    var reordered = [];
    state.layers.forEach(function (ly) {
      elementsOfLayer(ly.id).forEach(function (el) { reordered.push(el); });
    });
    state.elements = reordered;
    render(); renderLayers(); updatePropsPanel();
  }

  function toggleLayerVis(id) {
    var l = layerById(id);
    if (!l) return;
    commit();
    l.visible = l.visible === false ? true : false;
    if (l.visible === false && state.activeLayerId === id) state.selectedId = null;
    render(); renderLayers(); updatePropsPanel();
  }

  function toggleLayerLock(id) {
    var l = layerById(id);
    if (!l) return;
    commit();
    l.locked = !l.locked;
    if (l.locked && state.activeLayerId === id) state.selectedId = null;
    render(); renderLayers(); updatePropsPanel();
  }

  function renameLayer(id, name) {
    var l = layerById(id);
    if (!l) return;
    name = (name || "").trim();
    if (!name) return;
    commit();
    l.name = name;
    render(); renderLayers();
  }

  $("#layerList").addEventListener("click", function (e) {
    var item = e.target.closest(".layer-item");
    if (!item) return;
    var id = item.dataset.id;
    var act = e.target.closest("button") && e.target.closest("button").dataset.act;
    if (!act) { activateLayer(id); return; }
    if (act === "vis") toggleLayerVis(id);
    else if (act === "lock") toggleLayerLock(id);
    else if (act === "up") moveLayer(id, "up");
    else if (act === "down") moveLayer(id, "down");
    else if (act === "del") {
      var btn = e.target.closest("button");
      if (btn.dataset.armed) {
        btn.dataset.armed = "";
        deleteLayer(id);
      } else {
        btn.dataset.armed = "1";
        btn.textContent = "确定?";
        setTimeout(function () {
          if (btn.dataset.armed) {
            btn.dataset.armed = "";
            btn.textContent = "✕";
          }
        }, 2200);
      }
    }
  });

  // 双击图层名称行内改名
  $("#layerList").addEventListener("dblclick", function (e) {
    var item = e.target.closest(".layer-item");
    if (!item) return;
    var id = item.dataset.id;
    var name = item.querySelector(".name");
    if (!name || item.querySelector("input.rename")) return;
    var l = layerById(id);
    if (!l) return;
    var inp = document.createElement("input");
    inp.className = "rename";
    inp.value = l.name;
    name.replaceWith(inp);
    inp.focus();
    inp.select();
    var finished = false;
    var done = function (save) {
      if (finished) return;
      finished = true;
      var v = inp.value;
      inp.replaceWith(name);
      if (save && v !== l.name) renameLayer(id, v);
      else renderLayers();
    };
    inp.addEventListener("blur", function () { done(true); });
    inp.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") { ev.preventDefault(); done(true); }
      else if (ev.key === "Escape") { ev.preventDefault(); done(false); }
    });
  });

  $("#layerAddBtn").addEventListener("click", function () {
    createLayer();
  });

  // 属性滑块
  function bindPropSlider(slider, label, apply) {
    slider.addEventListener("input", function () {
      var el = getSelected();
      if (!el) return;
      if (layerLockedOf(el.id)) { toast("图层已锁定，无法编辑元素"); return; }
      apply(parseInt(slider.value, 10));
      render();
      updatePropsPanel();
    });
    slider.addEventListener("pointerdown", commit);
  }
  bindPropSlider($("#propSize"), $("#propSizeVal"), function (v) {
    var el = getSelected();
    if (!el) return;
    if (el.kind === "emoji") { el.w = v; el.h = v; }
    else if (el.kind === "text") { el.fontSize = v; remeasureText(el); }
    else if (el.kind === "brush") { el.size = v; finalizeBrush(el); }
    else { var k = v / el.w; el.w = v; el.h = el.h * k; }
  });
  bindPropSlider($("#propRot"), $("#propRotVal"), function (v) {
    var el = getSelected();
    if (el) el.rot = v;
  });
  bindPropSlider($("#propOpacity"), $("#propOpacityVal"), function (v) {
    var el = getSelected();
    if (el) el.opacity = v / 100;
  });

  $("#propDelete").addEventListener("click", function () {
    var el = getSelected();
    if (!el) return;
    if (layerLockedOf(el.id)) { toast("图层已锁定，无法删除元素"); return; }
    var btn = this;
    if (btn.dataset.armed) {
      commit();
      state.elements = state.elements.filter(function (it) { return it.id !== el.id; });
      state.selectedId = null;
      btn.dataset.armed = "";
      btn.textContent = "删除该元素";
      render(); renderLayers(); updatePropsPanel();
    } else {
      btn.dataset.armed = "1";
      btn.textContent = "确认删除？";
      setTimeout(function () {
        if (btn.dataset.armed) {
          btn.dataset.armed = "";
          btn.textContent = "删除该元素";
        }
      }, 2200);
    }
  });

  // ==================== 背景设置 ====================
  function renderBgControls() {
    var t = state.bg.type;
    $("#bgSolidCtl").hidden = t !== "solid";
    $("#bgGradientCtl").hidden = t !== "gradient";
    $("#bgImageCtl").hidden = t !== "image";
    $("#bgType").value = t;
    if (t === "image") renderBgPick();
  }

  function renderBgPick() {
    var box = $("#bgImgPick");
    if (!assets.length) {
      box.innerHTML = '<p class="hint">图片库为空，请先在左侧「图片库」加入图片</p>';
      $("#bgImgClear").hidden = !state.bg.imageId;
      return;
    }
    box.innerHTML = assets.map(function (it) {
      return '<div class="item' + (it.id === state.bg.imageId ? " active" : "") + '" data-id="' + it.id + '" title="' + it.name + '">' +
        '<img src="/api/thumb/' + it.id + '" alt=""></div>';
    }).join("");
    $("#bgImgClear").hidden = !state.bg.imageId;
  }

  $("#bgImgPick").addEventListener("click", function (e) {
    var item = e.target.closest(".item");
    if (!item) return;
    var id = item.dataset.id;
    loadImage("/api/image/" + id).then(function (img) {
      state.bg.imageId = id;
      state.bg.imageEl = img;
      renderBgPick();
      render();
    }).catch(function () { toast("背景图加载失败"); });
  });

  $("#bgImgClear").addEventListener("click", function () {
    state.bg.imageId = null;
    state.bg.imageEl = null;
    renderBgPick();
    render();
  });

  // ==================== 导出 ====================
  function exportImage(type) {
    var c = document.createElement("canvas");
    c.width = state.baseW;
    c.height = state.baseH;
    var tc = c.getContext("2d");
    if (type === "jpg") {
      tc.fillStyle = "#fff";
      tc.fillRect(0, 0, c.width, c.height);
    }
    paintBackground(tc, c.width, c.height);
    visibleElements().forEach(function (el) { drawElement(tc, el); });
    var mime = type === "jpg" ? "image/jpeg" : "image/png";
    var dataUrl = c.toDataURL(mime, 0.92);
    $("#exportPngBtn").disabled = true;
    api("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataUrl: dataUrl, filename: "wallpaper-" + state.baseW + "x" + state.baseH })
    }).then(function (d) {
      if (d.ok) {
        toast("已导出：" + d.path);
      } else {
        var msg = d.error || "导出失败";
        if (d.suggestion) msg += "（" + d.suggestion + "）";
        toast(msg);
      }
    }).catch(function () {
      toast("导出失败，请检查服务");
    }).then(function () {
      $("#exportPngBtn").disabled = false;
    });
  }

  // ==================== 导出位置设置 ====================
  var exportCfg = { dir: null, defaultDir: "" };

  // 不抛错的请求：400 等错误也返回 JSON body，供 error/suggestion 展示
  function apiBody(path, opts) {
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () {
        return { ok: false, error: "服务响应异常（HTTP " + r.status + "）" };
      });
    });
  }

  function loadExportSettings() {
    api("/api/export/settings").then(function (d) {
      if (!d.ok) return;
      exportCfg = { dir: d.dir, defaultDir: d.default_dir };
      refreshExportPathBtn();
    }).catch(function () { /* 服务不可用时保持默认 */ });
  }

  function refreshExportPathBtn() {
    var btn = $("#exportPathBtn");
    if (exportCfg.dir) {
      btn.textContent = "📁 " + exportCfg.dir;
      btn.title = "导出位置：" + exportCfg.dir + "（点击修改）";
      btn.classList.add("has-path");
    } else {
      btn.textContent = "📁";
      btn.title = "设置导出位置（当前：默认目录）";
      btn.classList.remove("has-path");
    }
  }

  function openPathModal() {
    $("#pathStatus").textContent = "";
    $("#pathError").hidden = true;
    var custom = exportCfg.dir || "";
    if (custom) {
      document.querySelector('input[name="pathMode"][value="custom"]').checked = true;
      $("#pathCustom").hidden = false;
      $("#pathInput").value = custom;
    } else {
      document.querySelector('input[name="pathMode"][value="default"]').checked = true;
      $("#pathCustom").hidden = true;
      $("#pathInput").value = "";
    }
    $("#pathModal").hidden = false;
  }

  function setPathError(msg) {
    var el = $("#pathError");
    el.hidden = !msg;
    if (msg) el.textContent = msg;
  }

  $("#exportPathBtn").addEventListener("click", openPathModal);
  $("#pathClose").addEventListener("click", function () { $("#pathModal").hidden = true; });
  $("#pathCancelBtn").addEventListener("click", function () { $("#pathModal").hidden = true; });
  $("#pathModal").addEventListener("click", function (e) {
    if (e.target === this) $("#pathModal").hidden = true;
  });
  document.querySelectorAll('input[name="pathMode"]').forEach(function (r) {
    r.addEventListener("change", function () {
      $("#pathCustom").hidden = this.value !== "custom";
      setPathError("");
    });
  });

  $("#pathBrowseBtn").addEventListener("click", function () {
    setPathError("");
    $("#pathBrowseBtn").disabled = true;
    apiBody("/api/export/pick-dir", { method: "POST" }).then(function (d) {
      if (d.ok && d.dir) {
        $("#pathInput").value = d.dir;
      } else if (!d.ok) {
        setPathError(d.error || "无法打开目录选择器");
      }
      // d.dir 为空表示用户取消，静默关闭
    }).catch(function () {
      setPathError("无法连接服务，请确认本地服务已启动");
    }).then(function () {
      $("#pathBrowseBtn").disabled = false;
    });
  });

  $("#pathSaveBtn").addEventListener("click", function () {
    var mode = document.querySelector('input[name="pathMode"]:checked').value;
    var dir = mode === "custom" ? $("#pathInput").value : "";
    var autoCreate = $("#pathAutoCreate").checked;
    setPathError("");
    $("#pathSaveBtn").disabled = true;
    apiBody("/api/export/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dir: dir, autoCreate: autoCreate })
    }).then(function (d) {
      if (d.ok) {
        exportCfg.dir = d.dir || null;
        exportCfg.defaultDir = d.default_dir;
        refreshExportPathBtn();
        $("#pathStatus").textContent = d.message || "";
        if (!d.dir) {
          // 恢复默认：同步关闭自定义区域
          document.querySelector('input[name="pathMode"][value="default"]').checked = true;
          $("#pathCustom").hidden = true;
        }
      } else {
        setPathError((d.error || "保存失败") + (d.suggestion ? "；" + d.suggestion : ""));
      }
    }).catch(function () {
      setPathError("无法连接服务，请确认本地服务已启动");
    }).then(function () {
      $("#pathSaveBtn").disabled = false;
    });
  });

  // ==================== 动态壁纸（应用当前画布） ====================
  function serializeComposition() {
    return {
      bg: {
        type: state.bg.type, color: state.bg.color,
        grad1: state.bg.grad1, grad2: state.bg.grad2,
        angle: state.bg.angle, imageId: state.bg.imageId
      },
      baseW: state.baseW, baseH: state.baseH,
      layers: cloneLayers(),
      activeLayerId: state.activeLayerId,
      elements: state.elements.map(serializeElement)
    };
  }

  // ==================== 草稿持久化（localStorage） ====================
  var DRAFT_KEY = "wm_draft_v1";
  var draftTimer = null;

  function serializeElement(el) {
    var o = {
      id: el.id, kind: el.kind, layer: el.layer,
      cx: el.cx, cy: el.cy, w: el.w, h: el.h,
      rot: el.rot || 0, opacity: el.opacity == null ? 1 : el.opacity
    };
    if (el.kind === "emoji") o.emoji = el.emoji;
    else if (el.kind === "image") o.assetId = assetIdOf(el);
    else if (el.kind === "text") {
      o.text = el.text; o.font = el.font; o.fontSize = el.fontSize;
      o.color = el.color; o.align = el.align;
      o.bold = !!el.bold; o.italic = !!el.italic; o.lineHeight = el.lineHeight;
    } else if (el.kind === "brush") {
      o.brush = el.brush; o.size = el.size; o.color = el.color;
      o.points = (el.points || []).map(function (p) { return { x: p.x, y: p.y }; });
    }
    return o;
  }

  function persistDraft() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(function () {
      try {
        var draft = {
          bg: { type: state.bg.type, color: state.bg.color, grad1: state.bg.grad1, grad2: state.bg.grad2, angle: state.bg.angle, imageId: state.bg.imageId },
          baseW: state.baseW, baseH: state.baseH,
          layers: cloneLayers(),
          activeLayerId: state.activeLayerId,
          elements: state.elements.map(serializeElement)
        };
        localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
      } catch (err) { /* 存储不可用时静默忽略 */ }
    }, 600);
  }

  function loadDraft() {
    try {
      var raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      var d = JSON.parse(raw);
      if (!d || !d.elements) return;
      state.bg = Object.assign({}, state.bg, d.bg || {});
      state.baseW = d.baseW || state.baseW;
      state.baseH = d.baseH || state.baseH;
      state.layers = d.layers && d.layers.length
        ? d.layers.map(function (l) { return Object.assign({ visible: true, locked: false }, l); })
        : [];
      state.activeLayerId = d.activeLayerId || null;
      state.elements = (d.elements || []).map(function (o) {
        var el = Object.assign({}, o);
        if (o.kind === "image" && o.assetId) el.img = null; // 图片引用稍后异步恢复
        return el;
      });
      ensureLayers();
      // 异步恢复背景图与元素图片引用
      var jobs = [];
      if (state.bg.type === "image" && state.bg.imageId) {
        jobs.push(loadImage("/api/image/" + state.bg.imageId)
          .then(function (im) { state.bg.imageEl = im; }).catch(function () {}));
      }
      state.elements.forEach(function (el) {
        if (el.kind === "image" && el.assetId) {
          jobs.push(loadImage("/api/image/" + el.assetId)
            .then(function (im) { el.img = im; }).catch(function () {}));
        }
      });
      if (jobs.length) {
        Promise.all(jobs).then(function () {
          render(); renderLayers(); updatePropsPanel();
        });
      }
    } catch (err) {
      // 草稿损坏：回退空画布
    }
  }

  function applyDynamic() {
    var btn = $("#dynApplyBtn");
    api("/api/dynamic/status").then(function (st) {
      if (st && st.status === "error") {
        toast("动态壁纸引擎异常：" + (st.last_error || st.message || "未知错误"));
        return;
      }
      if (st && st.browser_fallback) {
        toast("当前为浏览器模式，动态壁纸不可用，请安装 WebView2 Runtime 后重启应用");
        return;
      }
      btn.disabled = true;
      btn.textContent = "应用中…";
      return api("/api/dynamic/composition", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comp: serializeComposition() })
      }).then(function () {
        return api("/api/dynamic/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ wallpaper: "custom" })
        });
      }).then(function (d) {
        if (!d.ok) toast(d.error || "动态壁纸启动失败");
        else toast("已应用为动态壁纸");
      }).catch(function () {
        toast("应用失败，请检查本地服务");
      }).then(function () {
        btn.disabled = false;
        btn.textContent = "▶ 应用为动态壁纸";
      });
    }).catch(function () {
      toast("无法获取动态引擎状态");
    });
  }

  // ==================== 键盘 ====================
  window.addEventListener("keydown", function (e) {
    if (document.body.dataset.page && document.body.dataset.page !== "editor") return;
    var tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "select" || tag === "textarea") return;

    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); return; }
    if (((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "z") || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y")) { e.preventDefault(); redo(); return; }

    // ---------- 图层快捷键 ----------
    var ctrl = e.ctrlKey || e.metaKey;
    var k = e.key.toLowerCase();
    if (ctrl && e.shiftKey && k === "n") { e.preventDefault(); createLayer(); return; }
    if (ctrl && e.shiftKey && e.key === "Delete") { e.preventDefault(); deleteLayer(state.activeLayerId); return; }
    if (ctrl && e.shiftKey && e.key === "]") { e.preventDefault(); moveLayer(state.activeLayerId, "up"); return; }
    if (ctrl && e.shiftKey && e.key === "[") { e.preventDefault(); moveLayer(state.activeLayerId, "down"); return; }
    if (ctrl && e.shiftKey && k === "h") { e.preventDefault(); toggleLayerVis(state.activeLayerId); return; }
    if (ctrl && e.shiftKey && k === "l") { e.preventDefault(); toggleLayerLock(state.activeLayerId); return; }
    if (e.key === "F2") { e.preventDefault(); startRenameActive(); return; }

    var el = getSelected();
    if (!el) return;
    // 元素层内 z 序调整（Ctrl+]/[），变更前存档以便撤销
    if (ctrl && e.key === "]") { e.preventDefault(); commit(); if (moveElementInLayer(el, "up")) { render(); renderLayers(); updatePropsPanel(); } return; }
    if (ctrl && e.key === "[") { e.preventDefault(); commit(); if (moveElementInLayer(el, "down")) { render(); renderLayers(); updatePropsPanel(); } return; }

    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      if (layerLockedOf(el.id)) { toast("图层已锁定，无法删除元素"); return; }
      commit();
      state.elements = state.elements.filter(function (it) { return it.id !== el.id; });
      state.selectedId = null;
      render(); renderLayers(); updatePropsPanel();
      return;
    }
    var step = e.shiftKey ? 10 : 1;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") {
      if (layerLockedOf(el.id)) { toast("图层已锁定，无法移动元素"); return; }
      if (e.key === "ArrowLeft") { e.preventDefault(); commit(); el.cx -= step; }
      else if (e.key === "ArrowRight") { e.preventDefault(); commit(); el.cx += step; }
      else if (e.key === "ArrowUp") { e.preventDefault(); commit(); el.cy -= step; }
      else if (e.key === "ArrowDown") { e.preventDefault(); commit(); el.cy += step; }
      render(); renderLayers(); updatePropsPanel();
    }
  });

  // F2 重命名活动图层：唤起面板行内编辑
  function startRenameActive() {
    var item = document.querySelector('#layerList .layer-item[data-id="' + state.activeLayerId + '"]');
    if (!item) return;
    var name = item.querySelector(".name");
    if (!name || item.querySelector("input.rename")) return;
    var l = layerById(state.activeLayerId);
    var inp = document.createElement("input");
    inp.className = "rename";
    inp.value = l.name;
    name.replaceWith(inp);
    inp.focus();
    inp.select();
    var finished = false;
    var done = function (save) {
      if (finished) return;
      finished = true;
      var v = inp.value;
      inp.replaceWith(name);
      if (save && v !== l.name) renameLayer(state.activeLayerId, v);
      else renderLayers();
    };
    inp.addEventListener("blur", function () { done(true); });
    inp.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") { ev.preventDefault(); done(true); }
      else if (ev.key === "Escape") { ev.preventDefault(); done(false); }
    });
  }

  // ==================== 工具栏绑定 ====================
  function buildSizeOptions() {
    var sel = $("#canvasSize");
    sel.innerHTML = SIZE_PRESETS.map(function (p) {
      return '<option value="' + p[0] + '">' + p[1] + "</option>";
    }).join("");
    sel.value = "1920x1080";
  }

  function setCanvasSize(w, h) {
    if (state.baseW === w && state.baseH === h) return;
    state.baseW = w;
    state.baseH = h;
    updateCanvasSize();
    fitZoom();
    render();
    toast("画布已切换为 " + w + "×" + h);
  }

  function initToolbar() {
    $("#canvasSize").addEventListener("change", function () {
      var v = this.value.split("x");
      setCanvasSize(parseInt(v[0], 10), parseInt(v[1], 10));
    });
    $("#btnSwap").addEventListener("click", function () {
      setCanvasSize(state.baseH, state.baseW);
      $("#canvasSize").value = state.baseW + "x" + state.baseH;
    });
    $("#selToolBtn").addEventListener("click", function () { setTool("select"); });
    $("#textToolBtn").addEventListener("click", function () { setTool("text"); });
    $("#brushToolBtn").addEventListener("click", function () { setTool("brush"); });
    $("#dynApplyBtn").addEventListener("click", applyDynamic);
    $("#bgType").addEventListener("change", function () {
      state.bg.type = this.value;
      if (this.value === "image") commit();
      renderBgControls();
      render();
    });
    $("#undoBtn").addEventListener("click", undo);
    $("#redoBtn").addEventListener("click", redo);
    $("#zoomInBtn").addEventListener("click", function () { setZoom(state.scale * 1.2); });
    $("#zoomOutBtn").addEventListener("click", function () { setZoom(state.scale / 1.2); });
    $("#zoomFitBtn").addEventListener("click", fitZoom);
    $("#exportPngBtn").addEventListener("click", function () { exportImage("png"); });
    $("#exportJpgBtn").addEventListener("click", function () { exportImage("jpg"); });
  }

  function initBgControls() {
    function bindColor(id, key, hexId) {
      var inp = $(id), hex = $(hexId);
      inp.addEventListener("input", function () {
        state.bg[key] = this.value;
        hex.textContent = this.value;
        render();
      });
    }
    bindColor("#bgColor", "color", "#bgColorHex");
    bindColor("#bgGrad1", "grad1", "#bgGrad1Hex");
    bindColor("#bgGrad2", "grad2", "#bgGrad2Hex");
    var ang = $("#bgGradAngle");
    ang.addEventListener("input", function () {
      state.bg.angle = parseInt(this.value, 10);
      $("#bgGradAngleVal").textContent = this.value + "°";
      render();
    });
  }

  // ==================== 素材面板绑定 ====================
  function initPanels() {
    document.querySelectorAll(".tab").forEach(function (t) {
      t.addEventListener("click", function () {
        document.querySelectorAll(".tab").forEach(function (x) { x.classList.toggle("active", x === t); });
        $("#emojiTab").classList.toggle("active", t.dataset.tab === "emoji");
        $("#imagesTab").classList.toggle("active", t.dataset.tab === "images");
      });
    });

    $("#emojiGrid").addEventListener("click", function (e) {
      var cell = e.target.closest(".emoji-cell");
      if (cell) addEmoji(cell.dataset.ch);
    });

    var debounce = null;
    $("#emojiSearch").addEventListener("input", function () {
      clearTimeout(debounce);
      debounce = setTimeout(renderEmojiGrid, 120);
    });

    $("#uploadBtn").addEventListener("click", function () { $("#fileInput").click(); });
    $("#fileInput").addEventListener("change", function () {
      uploadFiles(this.files);
      this.value = "";
    });

    $("#imgGrid").addEventListener("click", function (e) {
      var card = e.target.closest(".img-card");
      if (!card) return;
      var item = assets.find(function (a) { return a.id === card.dataset.id; });
      if (!item) return;
      var del = e.target.closest("[data-act=del]");
      if (del) {
        if (del.dataset.armed) {
          api("/api/assets/" + item.id, { method: "DELETE" }).then(function () {
            assets = assets.filter(function (a) { return a.id !== item.id; });
            if (state.bg.imageId === item.id) { state.bg.imageId = null; state.bg.imageEl = null; }
            renderImgGrid();
            renderBgPick();
            toast("已删除 " + item.name);
          }).catch(function () { toast("删除失败"); });
        } else {
          del.dataset.armed = "1";
          del.textContent = "确定?";
          setTimeout(function () {
            if (del.dataset.armed) { del.dataset.armed = ""; del.textContent = "✕"; }
          }, 2200);
        }
        return;
      }
      addImageAsset(item);
    });
  }

  // ==================== 初始化 ====================
  function init() {
    buildEmojiIndex();
    buildCats();
    renderEmojiGrid();
    buildSizeOptions();
    loadDraft();          // 恢复上次草稿（含图层状态），无则空画布
    ensureLayers();
    // 画布尺寸下拉同步草稿尺寸
    var sizeSel = $("#canvasSize");
    var preset = state.baseW + "x" + state.baseH;
    if (sizeSel.querySelector('option[value="' + preset + '"]')) sizeSel.value = preset;
    else {
      var opt = document.createElement("option");
      opt.value = preset;
      opt.textContent = preset + " · 草稿";
      sizeSel.appendChild(opt);
      sizeSel.value = preset;
    }
    initToolbar();
    initBgControls();
    renderBgControls();
    initPanels();
    bindTextCtl();
    bindBrushCtl();
    updateCanvasSize();
    fitZoom();
    state.history.push({ elements: cloneElements(), layers: cloneLayers(), activeLayerId: state.activeLayerId });
    state.historyIdx = 0;
    render();
    renderLayers();
    updateHistoryButtons();
    loadAssets();
    loadExportSettings();
    window.addEventListener("resize", function () {
      if (state.scale >= 1) fitZoom();
    });
  }

  init();
})();
