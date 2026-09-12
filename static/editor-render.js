/* 壁纸工坊 - 共享渲染核心
 * 无状态纯函数，供编辑器（app.js）、导出、动态壁纸模板（custom.html）复用，
 * 保证三端渲染一致。函数挂到 window.wm* 命名空间。
 */
(function () {
  "use strict";

  var NS = {};

  // ---------- 背景绘制 ----------
  function wmPaintBackground(c, bg, W, H) {
    if (!bg) return;
    if (bg.type === "solid") {
      c.fillStyle = bg.color;
      c.fillRect(0, 0, W, H);
    } else if (bg.type === "gradient") {
      var a = ((bg.angle || 0) * Math.PI) / 180;
      var dx = Math.cos(a), dy = Math.sin(a);
      var L = Math.abs(dx) * W / 2 + Math.abs(dy) * H / 2;
      var g = c.createLinearGradient(W / 2 - dx * L, H / 2 - dy * L,
                                     W / 2 + dx * L, H / 2 + dy * L);
      g.addColorStop(0, bg.grad1);
      g.addColorStop(1, bg.grad2);
      c.fillStyle = g;
      c.fillRect(0, 0, W, H);
    } else if (bg.type === "image") {
      var im = bg.imageEl || bg._img;
      if (im && im.width) {
        var ir = im.width / im.height, cr = W / H;
        var dw, dh;
        if (ir > cr) { dw = W; dh = W / ir; } else { dh = H; dw = H * ir; }
        c.drawImage(im, (W - dw) / 2, (H - dh) / 2, dw, dh);
      } else {
        c.fillStyle = "#1a1d24";
        c.fillRect(0, 0, W, H);
      }
    }
  }

  // ---------- 文本测量 ----------
  function wmMeasureText(c, el) {
    var fs = el.fontSize || 96;
    var style = (el.italic ? "italic " : "") + (el.bold ? "bold " : "") +
                fs + "px " + (el.font || "sans-serif");
    c.font = style;
    var text = String(el.text == null ? "" : el.text);
    var lines = text.split("\n");
    var w = 0, widths = [];
    for (var i = 0; i < lines.length; i++) {
      var m = c.measureText(lines[i]);
      widths.push(m.width);
      if (m.width > w) w = m.width;
    }
    var lh = fs * (el.lineHeight || 1.2);
    return { font: style, lines: lines, widths: widths, w: w, h: lines.length * lh, lh: lh };
  }

  // ---------- 元素绘制 ----------
  function wmDrawElement(c, el, anim) {
    if (!el) return;
    var alpha = anim && anim.alpha != null ? anim.alpha : 1;
    var dx = anim && anim.dx ? anim.dx : 0;
    var dy = anim && anim.dy ? anim.dy : 0;
    c.save();
    c.globalAlpha = (el.opacity == null ? 1 : el.opacity) * alpha;
    c.translate(el.cx + dx, el.cy + dy);
    c.rotate((el.rot || 0) * Math.PI / 180);
    if (anim && anim.glow && (el.kind === "text" || el.kind === "emoji")) {
      c.shadowColor = "rgba(120,170,255,0.6)";
      c.shadowBlur = anim.glow;
    }
    if (el.kind === "emoji") wmDrawEmoji(c, el);
    else if (el.kind === "image") wmDrawImage(c, el);
    else if (el.kind === "text") wmDrawText(c, el);
    else if (el.kind === "brush") wmDrawBrush(c, el);
    c.restore();
  }

  function wmDrawEmoji(c, el) {
    c.font = (el.w || 80) + "px 'Segoe UI Emoji','Apple Color Emoji','Noto Color Emoji','Twemoji Mozilla',sans-serif";
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText(el.emoji || "", 0, 0);
  }

  function wmDrawImage(c, el) {
    var im = el.img || el._img;
    if (im && im.width) {
      c.drawImage(im, -el.w / 2, -el.h / 2, el.w, el.h);
    } else {
      c.fillStyle = "rgba(255,255,255,0.12)";
      c.fillRect(-el.w / 2, -el.h / 2, el.w, el.h);
    }
  }

  function wmDrawText(c, el) {
    var lay = wmMeasureText(c, el);
    c.font = lay.font;
    c.textBaseline = "middle";
    c.fillStyle = el.color || "#ffffff";
    var align = el.align || "left";
    var x0 = align === "center" ? 0 : (align === "right" ? el.w / 2 : -el.w / 2);
    c.textAlign = align === "center" ? "center" : (align === "right" ? "right" : "left");
    var y0 = -lay.h / 2 + lay.lh / 2;
    for (var i = 0; i < lay.lines.length; i++) {
      c.fillText(lay.lines[i], x0, y0 + i * lay.lh);
    }
  }

  function _polyline(c, pts) {
    c.beginPath();
    c.moveTo(pts[0].x, pts[0].y);
    for (var i = 1; i < pts.length; i++) c.lineTo(pts[i].x, pts[i].y);
    c.stroke();
  }

  function _dot(c, p, r) {
    c.beginPath();
    c.arc(p.x, p.y, r, 0, 6.2831853);
    c.fill();
  }

  // 喷枪确定性随机（seeded PRNG），保证编辑/导出/动态三端逐点一致
  function _mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function wmDrawBrush(c, el) {
    var pts = el.points || [];
    var n = pts.length;
    if (!n) return;
    var size = el.size || 8;
    c.lineCap = "round";
    c.lineJoin = "round";
    if (el.brush === "pencil") {
      c.strokeStyle = el.color;
      c.lineWidth = Math.max(1, size);
      if (n === 1) { c.fillStyle = el.color; _dot(c, pts[0], Math.max(1, size) / 2); }
      else _polyline(c, pts);
    } else if (el.brush === "marker") {
      c.globalAlpha *= 0.45;
      c.strokeStyle = el.color;
      c.lineWidth = size * 2.2;
      if (n === 1) { c.fillStyle = el.color; _dot(c, pts[0], size * 1.1); }
      else _polyline(c, pts);
    } else if (el.brush === "highlighter") {
      c.globalAlpha *= 0.28;
      c.strokeStyle = el.color;
      c.lineWidth = size * 3.5;
      if (n === 1) { c.fillStyle = el.color; _dot(c, pts[0], size * 1.75); }
      else _polyline(c, pts);
    } else if (el.brush === "spray") {
      var seed = wmHash(el.id || "spray") >>> 0;
      var baseAlpha = c.globalAlpha;
      for (var i = 0; i < n; i++) {
        var rnd = _mulberry32((seed + i * 2654435761) >>> 0);
        for (var k = 0; k < 12; k++) {
          var ang = rnd() * 6.2831853;
          var r = rnd() * size * 0.6;
          c.globalAlpha = baseAlpha * (0.25 + rnd() * 0.5);
          c.fillStyle = el.color;
          _dot(c, { x: pts[i].x + Math.cos(ang) * r, y: pts[i].y + Math.sin(ang) * r },
               size * 0.13 + 0.8);
        }
      }
    }
  }

  // ---------- 工具 ----------
  function wmHash(str) {
    var h = 2166136261 >>> 0;
    var s = String(str);
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  NS.wmPaintBackground = wmPaintBackground;
  NS.wmMeasureText = wmMeasureText;
  NS.wmDrawElement = wmDrawElement;
  NS.wmDrawEmoji = wmDrawEmoji;
  NS.wmDrawImage = wmDrawImage;
  NS.wmDrawText = wmDrawText;
  NS.wmDrawBrush = wmDrawBrush;
  NS.wmHash = wmHash;

  window.wm = NS;
})();
