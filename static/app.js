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
    brushCfg: { type: "pencil", size: 12, color: "#ff5e62", opacity: 0.8 }
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

  function cloneElements(list) {
    return (list || state.elements).map(function (el) {
      var c = Object.assign({}, el);
      if (c.points) c.points = c.points.map(function (p) { return { x: p.x, y: p.y }; });
      return c;
    });
  }

  function commit() {
    var last = state.history[state.historyIdx];
    if (last && JSON.stringify(last) === JSON.stringify(state.elements)) return;
    state.history = state.history.slice(0, state.historyIdx + 1);
    state.history.push(cloneElements());
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
    state.elements = cloneElements(state.history[state.historyIdx]);
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
    state.elements.push({
      id: uid(), kind: "emoji", emoji: ch, img: null,
      cx: state.baseW / 2, cy: state.baseH / 2,
      w: size, h: size, rot: 0, opacity: 1
    });
    state.selectedId = state.elements[state.elements.length - 1].id;
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
    state.elements.push(el);
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

  function loadAssets() {
    api("/api/assets").then(function (data) {
      assets = data.assets || [];
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
    grid.innerHTML = assets.map(function (it) {
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
      state.elements.push({
        id: uid(), kind: "image", emoji: null, img: img,
        cx: state.baseW / 2, cy: state.baseH / 2,
        w: w, h: h, rot: 0, opacity: 1
      });
      state.selectedId = state.elements[state.elements.length - 1].id;
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
    state.elements.forEach(function (el) { drawElement(ctx, el); });
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (drag && drag.snapX) drawGuide(drag.nx * state.scale, "v");
    if (drag && drag.snapY) drawGuide(drag.ny * state.scale, "h");
    var sel = getSelected();
    if (sel) drawHandles(sel);
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
    if (state.tool === "brush") { beginBrush(p); return; }

    if (sel) {
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
      el.text = this.value;
      remeasureText(el);
      render();
      clearTimeout(deb);
      deb = setTimeout(commit, 500);
    });
    $("#textFont").addEventListener("change", function () {
      var el = getSelected();
      if (!el) return;
      el.font = this.value;
      remeasureText(el);
      render(); commit();
    });
    $("#textColor").addEventListener("input", function () {
      var el = getSelected();
      if (!el) return;
      el.color = this.value;
      $("#textColorHex").textContent = this.value;
      render();
    });
    $("#textBold").addEventListener("change", function () {
      var el = getSelected();
      if (!el) return;
      el.bold = this.checked;
      remeasureText(el);
      render(); commit();
    });
    $("#textItalic").addEventListener("change", function () {
      var el = getSelected();
      if (!el) return;
      el.italic = this.checked;
      remeasureText(el);
      render(); commit();
    });
    $("#textLineHeight").addEventListener("input", function () {
      var el = getSelected();
      if (!el) return;
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
    state.elements.push(el);
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
    $("#layerCount").textContent = state.elements.length;
    $("#layerEmpty").hidden = state.elements.length > 0;
    var html = "";
    for (var i = state.elements.length - 1; i >= 0; i--) {
      var el = state.elements[i];
      var thumb;
      if (el.kind === "emoji") thumb = el.emoji;
      else if (el.kind === "text") thumb = '<span class="lay-ico t">T</span>';
      else if (el.kind === "brush") thumb = '<span class="lay-ico b" style="background:' + (el.color || "#fff") + '"></span>';
      else thumb = '<img src="/api/image/' + assetIdOf(el) + '" alt="">';
      html +=
        '<div class="layer-item' + (el.id === state.selectedId ? " active" : "") + '" data-id="' + el.id + '">' +
        '<span class="thumb">' + thumb + "</span>" +
        '<span class="name">' + layerName(el) + "</span>" +
        '<span class="ops">' +
        '<button data-act="up" title="上移一层">▲</button>' +
        '<button data-act="down" title="下移一层">▼</button>' +
        '<button data-act="del" class="del" title="删除">✕</button>' +
        "</span></div>";
    }
    list.innerHTML = html;
  }

  function layerName(el) {
    if (el.kind === "emoji") return "Emoji " + el.emoji;
    if (el.kind === "text") return "文字";
    if (el.kind === "brush") return "笔刷";
    return el.img && el.img.src ? el.img.src.split("/").pop() : "图片";
  }

  function assetIdOf(el) {
    // 通过已加载图片的 src 反查素材 id（形如 /api/image/xxxx）
    if (!el.img || !el.img.src) return "";
    var m = el.img.src.match(/\/api\/image\/([a-z0-9]+)/);
    return m ? m[1] : "";
  }

  $("#layerList").addEventListener("click", function (e) {
    var item = e.target.closest(".layer-item");
    if (!item) return;
    var id = item.dataset.id;
    var el = state.elements.find(function (it) { return it.id === id; });
    if (!el) return;
    var act = e.target.closest("button") && e.target.closest("button").dataset.act;
    var idx = state.elements.indexOf(el);
    if (act === "up") {
      commit();
      if (idx < state.elements.length - 1) {
        state.elements.splice(idx, 1);
        state.elements.splice(idx + 1, 0, el);
      }
    } else if (act === "down") {
      commit();
      if (idx > 0) {
        state.elements.splice(idx, 1);
        state.elements.splice(idx - 1, 0, el);
      }
    } else if (act === "del") {
      var btn = e.target.closest("button");
      if (btn.dataset.armed) {
        commit();
        state.elements.splice(idx, 1);
        if (state.selectedId === id) state.selectedId = null;
        btn.dataset.armed = "";
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
      render(); renderLayers(); updatePropsPanel();
      return;
    } else {
      select(id);
      return;
    }
    render(); renderLayers(); updatePropsPanel();
  });

  // 属性滑块
  function bindPropSlider(slider, label, apply) {
    slider.addEventListener("input", function () {
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
    state.elements.forEach(function (el) { drawElement(tc, el); });
    var mime = type === "jpg" ? "image/jpeg" : "image/png";
    var dataUrl = c.toDataURL(mime, 0.92);
    $("#exportPngBtn").disabled = true;
    api("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataUrl: dataUrl, filename: "wallpaper-" + state.baseW + "x" + state.baseH })
    }).then(function (d) {
      toast("已导出：" + d.path);
    }).catch(function () {
      toast("导出失败，请检查服务");
    }).then(function () {
      $("#exportPngBtn").disabled = false;
    });
  }

  // ==================== 动态壁纸（应用当前画布） ====================
  function serializeComposition() {
    return {
      bg: {
        type: state.bg.type, color: state.bg.color,
        grad1: state.bg.grad1, grad2: state.bg.grad2,
        angle: state.bg.angle, imageId: state.bg.imageId
      },
      baseW: state.baseW, baseH: state.baseH,
      elements: state.elements.map(function (el) {
        var o = {
          id: el.id, kind: el.kind,
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
      })
    };
  }

  function applyDynamic() {
    var btn = $("#dynApplyBtn");
    api("/api/dynamic/status").then(function (st) {
      if (st && st.status === "error") {
        toast("动态壁纸引擎异常：" + (st.message || "未知错误"));
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

    var el = getSelected();
    if (!el) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      commit();
      state.elements = state.elements.filter(function (it) { return it.id !== el.id; });
      state.selectedId = null;
      render(); renderLayers(); updatePropsPanel();
      return;
    }
    var step = e.shiftKey ? 10 : 1;
    if (e.key === "ArrowLeft") { e.preventDefault(); commit(); el.cx -= step; render(); renderLayers(); updatePropsPanel(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); commit(); el.cx += step; render(); renderLayers(); updatePropsPanel(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); commit(); el.cy -= step; render(); renderLayers(); updatePropsPanel(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); commit(); el.cy += step; render(); renderLayers(); updatePropsPanel(); }
  });

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
    initToolbar();
    initBgControls();
    initPanels();
    bindTextCtl();
    bindBrushCtl();
    updateCanvasSize();
    fitZoom();
    state.history.push(cloneElements());
    state.historyIdx = 0;
    render();
    updateHistoryButtons();
    loadAssets();
    window.addEventListener("resize", function () {
      if (state.scale >= 1) fitZoom();
    });
  }

  init();
})();
