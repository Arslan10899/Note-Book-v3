/* Interactive whiteboard (v2): manual-save only. Pen/marker/pencil/highlighter,
   color picker, many shapes, sticky/text/images/tables, Excalidraw-style
   connector edges with draggable + magnetizable endpoints. */

(function () {
  "use strict";

  const MAX_ZOOM = 3;
  const MIN_ZOOM = 0.2;
  const STICKY_FILL = "#ffe599";
  const STICKY_SIZE = { w: 170, h: 150 };
  const TEXT_COLOR = null; // null = theme foreground
  const IMAGE_MAX_W = 520;
  const IMAGE_MAX_H = 340;

  const STROKES = {
    pen:         { label: "Pen",         width: 2.6, opacity: 1.0 },
    marker:      { label: "Marker",      width: 7,   opacity: 0.6 },
    pencil:      { label: "Pencil",      width: 1.6, opacity: 0.85 },
    highlighter: { label: "Highlighter", width: 18,  opacity: 0.35 },
  };

  const PALETTE = [
    "#111827", "#6b7280", "#dc2626", "#ea580c",
    "#d97706", "#eab308", "#65a30d", "#16a34a",
    "#0d9488", "#0891b2", "#2563eb", "#4f46e5",
    "#7c3aed", "#c026d3", "#db2777", "#64748b",
  ];

  const SHAPES = ["rect", "ellipse", "triangle", "diamond", "star", "hexagon", "arrow", "line"];

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));

  let booted = false;
  let active = false;
  let loadedOnce = false;
  let dirty = false;

  const state = {
    view: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    drawings: [],
    edges: [],
    tool: "select",
    stroke: "pen",
    color: "#111827",
    selected: null,   // node id
    edgeSel: null,    // edge id
  };

  const g = {
    kind: null,       // pan | pen | shape | node | resize | connector | edgeEnd
    start: { x: 0, y: 0 },
    view: { x: 0, y: 0 },
    node: null,
    from: { x: 0, y: 0 },
    nodeFrom: { x: 0, y: 0 },
    sizeFrom: null,
    preview: null,
    shapeType: null,
    ink: null,
    inkEl: null,
    edge: null,
    which: null,
    startP: { x: 0, y: 0 },
  };

  // ---------- helpers ----------

  function nextId() {
    return "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function nodeById(id) {
    return state.nodes.find((n) => n.id === id);
  }

  function edgeById(id) {
    return state.edges.find((e) => e.id === id);
  }

  function center(n) {
    return { x: n.x + (n.w || 80) / 2, y: n.y + (n.h || 40) / 2 };
  }

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function stageRect() {
    return $("#wb-stage").getBoundingClientRect();
  }

  function toWorld(cx, cy) {
    const r = stageRect();
    return {
      x: (cx - r.left - state.view.x) / state.view.zoom,
      y: (cy - r.top - state.view.y) / state.view.zoom,
    };
  }

  function toScreen(p) {
    const V = state.view;
    return { x: p.x * V.zoom + V.x, y: p.y * V.zoom + V.y };
  }

  function boxIntersect(cx, cy, hw, hh, dx, dy) {
    if (dx === 0 && dy === 0) return { x: cx, y: cy };
    const sx = dx !== 0 ? hw / Math.abs(dx) : Infinity;
    const sy = dy !== 0 ? hh / Math.abs(dy) : Infinity;
    const t = Math.min(sx, sy);
    return { x: cx + dx * t, y: cy + dy * t };
  }

  function strokePathD(points) {
    if (!points || !points.length) return "";
    let d = "M" + points[0][0].toFixed(1) + "," + points[0][1].toFixed(1);
    for (let i = 1; i < points.length; i++) d += "L" + points[i][0].toFixed(1) + "," + points[i][1].toFixed(1);
    return d;
  }

  function maxZ() {
    return state.nodes.reduce((m, n) => Math.max(m, n.z || 0), 0);
  }

  // ---------- rendering ----------

  function currentBrush() {
    return STROKES[state.stroke] || STROKES.pen;
  }

  function makeTableNode(n) {
    const tbl = document.createElement("table");
    tbl.className = "wb-table";
    (n.rows || []).forEach(function (row) {
      const tr = document.createElement("tr");
      row.forEach(function (cellTxt) {
        const td = document.createElement("td");
        const c = document.createElement("div");
        c.className = "wb-cell";
        c.contentEditable = "true";
        c.setAttribute("spellcheck", "false");
        c.textContent = cellTxt || "";
        td.appendChild(c);
        tr.appendChild(td);
      });
      tbl.appendChild(tr);
    });
    return tbl;
  }

  function makeNodeEl(n) {
    const el = document.createElement("div");
    el.className = "wb-node wb-" + (n.type || "rect") + (n.id === state.selected ? " selected" : "");
    el.dataset.id = n.id;
    el.style.left = n.x + "px";
    el.style.top = n.y + "px";
    el.style.zIndex = n.z || 0;
    el.style.width = Math.max(24, n.w || 80) + "px";
    el.style.height = Math.max(24, n.h || 40) + "px";

    const type = n.type || "rect";

    if (type === "sticky") {
      el.style.background = n.color || STICKY_FILL;
      el.style.width = Math.max(60, n.w) + "px";
      el.style.height = Math.max(60, n.h) + "px";
      const inner = document.createElement("div");
      inner.className = "wb-node-text";
      inner.contentEditable = "true";
      inner.setAttribute("spellcheck", "false");
      inner.textContent = n.text || "";
      el.appendChild(inner);
    } else if (type === "text") {
      el.style.width = n.w && n.w > 0 ? n.w + "px" : "auto";
      el.style.height = "auto";
      const inner = document.createElement("div");
      inner.className = "wb-node-text";
      inner.contentEditable = "true";
      inner.setAttribute("spellcheck", "false");
      inner.textContent = n.text || "";
      if (n.color) inner.style.color = n.color;
      el.appendChild(inner);
    } else if (type === "image") {
      const img = document.createElement("img");
      img.className = "wb-node-img";
      img.src = n.src || "";
      img.alt = "";
      img.draggable = false;
      el.appendChild(img);
    } else if (type === "table") {
      el.appendChild(makeTableNode(n));
    } else if (type === "line") {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("width", "100%");
      svg.setAttribute("height", "100%");
      svg.setAttribute("overflow", "visible");
      const ln = document.createElementNS("http://www.w3.org/2000/svg", "line");
      ln.setAttribute("x1", 0);
      ln.setAttribute("y1", 0);
      ln.setAttribute("x2", n.w || 80);
      ln.setAttribute("y2", n.h || 40);
      ln.setAttribute("stroke", n.color || state.color);
      ln.setAttribute("stroke-width", 2.5);
      ln.setAttribute("stroke-linecap", "round");
      svg.appendChild(ln);
      el.appendChild(svg);
    } else if (SHAPES.indexOf(type) !== -1) {
      el.style.background = n.color || state.color;
      if (type === "ellipse") el.style.borderRadius = "50%";
    } else {
      el.style.background = n.color || state.color;
    }
    return el;
  }

  function renderEdges() {
    const svg = $("#wb-edges");
    if (!svg) return;

    const ns = "http://www.w3.org/2000/svg";
    const defs = document.createElementNS(ns, "defs");
    const marker = document.createElementNS(ns, "marker");
    marker.setAttribute("id", "wb-arrow");
    marker.setAttribute("viewBox", "0 0 10 10");
    marker.setAttribute("refX", "8");
    marker.setAttribute("refY", "5");
    marker.setAttribute("markerWidth", "7");
    marker.setAttribute("markerHeight", "7");
    marker.setAttribute("orient", "auto-start-reverse");
    const arrowPath = document.createElementNS(ns, "path");
    arrowPath.setAttribute("d", "M0,0 L10,5 L0,10 z");
    arrowPath.setAttribute("fill", "context-stroke");
    marker.appendChild(arrowPath);
    defs.appendChild(marker);

    svg.innerHTML = "";
    svg.appendChild(defs);

    state.edges.forEach(function (e) {
      const pts = edgePts(e);
      const d = "M" + pts.f.x.toFixed(1) + "," + pts.f.y.toFixed(1) + " L" + pts.t.x.toFixed(1) + "," + pts.t.y.toFixed(1);

      const hit = document.createElementNS(ns, "path");
      hit.setAttribute("d", d);
      hit.setAttribute("fill", "none");
      hit.setAttribute("stroke", "transparent");
      hit.setAttribute("stroke-width", "14");
      hit.setAttribute("stroke-linecap", "round");
      hit.setAttribute("class", "wb-edge-hit");
      hit.dataset.eid = e.id;

      const vis = document.createElementNS(ns, "path");
      vis.setAttribute("d", d);
      vis.setAttribute("fill", "none");
      vis.setAttribute("stroke", e.color || state.color);
      vis.setAttribute("stroke-width", state.edgeSel === e.id ? 3.2 : 2.2);
      vis.setAttribute("stroke-linecap", "round");
      vis.setAttribute("vector-effect", "non-scaling-stroke");
      vis.setAttribute("marker-end", "url(#wb-arrow)");
      if (state.edgeSel === e.id) vis.setAttribute("class", "wb-edge-sel");

      svg.appendChild(hit);
      svg.appendChild(vis);
    });
  }

  function render() {
    const box = $("#wb-nodes");
    box.innerHTML = "";
    state.nodes
      .slice()
      .sort((a, b) => (a.z || 0) - (b.z || 0))
      .forEach((n) => box.appendChild(makeNodeEl(n)));

    renderEdges();

    const ink = $("#wb-ink");
    ink.innerHTML = "";
    state.drawings.forEach(function (d) {
      const pts = d.points || [];
      if (pts.length < 2) return;
      const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("d", strokePathD(pts));
      p.setAttribute("fill", "none");
      p.setAttribute("stroke", d.color || state.color);
      p.setAttribute("stroke-width", d.width || STROKES.pen.width);
      p.setAttribute("opacity", d.opacity != null ? d.opacity : 1);
      p.setAttribute("stroke-linecap", "round");
      p.setAttribute("stroke-linejoin", "round");
      p.setAttribute("vector-effect", "non-scaling-stroke");
      ink.appendChild(p);
    });

    const empty = $("#wb-empty");
    if (empty) empty.classList.toggle("hidden", state.nodes.length + state.drawings.length > 0);

    applyView();
    syncLayout();
  }

  // ---------- selection overlay (screen-space, zoom-stable) ----------

  function syncLayout() {
    const sb = $("#wb-selbox");
    const hd = $("#wb-handle");
    const ep1 = $("#wb-ep1");
    const ep2 = $("#wb-ep2");
    if (!sb) return;

    if (state.selected) {
      const n = nodeById(state.selected);
      if (n) {
        const a = toScreen({ x: n.x, y: n.y });
        const bw = (n.w || 80) * state.view.zoom;
        const bh = (n.h || 40) * state.view.zoom;
        sb.classList.remove("hidden");
        sb.style.left = a.x + "px";
        sb.style.top = a.y + "px";
        sb.style.width = Math.max(20, bw) + "px";
        sb.style.height = Math.max(20, bh) + "px";
        hd.classList.remove("hidden");
        hd.style.left = (a.x + Math.max(20, bw)) + "px";
        hd.style.top = (a.y + Math.max(20, bh)) + "px";
      } else {
        state.selected = null;
        syncLayout();
        return;
      }
      ep1.classList.add("hidden");
      ep2.classList.add("hidden");
      return;
    }

    if (state.edgeSel) {
      const e = edgeById(state.edgeSel);
      if (e) {
        const pts = edgePts(e);
        sb.classList.add("hidden");
        hd.classList.add("hidden");
        positionEp(ep1, pts.f);
        positionEp(ep2, pts.t);
        ep1.classList.remove("hidden");
        ep2.classList.remove("hidden");
        return;
      } else {
        state.edgeSel = null;
      }
    }
    sb.classList.add("hidden");
    hd.classList.add("hidden");
    ep1.classList.add("hidden");
    ep2.classList.add("hidden");
  }

  function positionEp(el, p) {
    const s = toScreen(p);
    el.style.left = s.x + "px";
    el.style.top = s.y + "px";
  }

  // ---------- edges geometry ----------

  function resolveEnd(ep) {
    if (ep && ep.node) {
      const n = nodeById(ep.node);
      if (n) {
        if (ep.x != null && ep.y != null) return { x: ep.x, y: ep.y };
        return center(n);
      }
      return { x: ep.x || 0, y: ep.y || 0 };
    }
    return { x: (ep && ep.x) || 0, y: (ep && ep.y) || 0 };
  }

  function edgePts(e) {
    const f = resolveEnd(e.from);
    const t = resolveEnd(e.to);
    if (e.from && e.from.node) {
      const n = nodeById(e.from.node);
      if (n && e.from.x == null && e.from.y == null) {
        const c = center(n);
        const p = boxIntersect(c.x, c.y, (n.w || 80) / 2, (n.h || 40) / 2, t.x - c.x, t.y - c.y);
        f.x = p.x; f.y = p.y;
      }
    }
    if (e.to && e.to.node) {
      const n = nodeById(e.to.node);
      if (n && e.to.x == null && e.to.y == null) {
        const c = center(n);
        const p = boxIntersect(c.x, c.y, (n.w || 80) / 2, (n.h || 40) / 2, f.x - c.x, f.y - c.y);
        t.x = p.x; t.y = p.y;
      }
    }
    return { f: f, t: t };
  }

  function nodeAt(p) {
    // topmost node under a world point
    for (let i = state.nodes.length - 1; i >= 0; i--) {
      const n = state.nodes[i];
      if (p.x >= n.x && p.x <= n.x + (n.w || 80) && p.y >= n.y && p.y <= n.y + (n.h || 40)) return n;
    }
    return null;
  }

  // ---------- status / save (manual only) ----------

  function setStatus(txt, kind) {
    const s = $("#wb-status");
    if (!s) return;
    s.textContent = txt;
    s.dataset.kind = kind || "idle";
  }

  function toast(msg, kind) {
    if (window.toast) window.toast(msg, kind);
  }

  function markDirty() {
    dirty = true;
    setStatus("Unsaved", "warn");
  }

  function serialize() {
    return {
      view: state.view,
      nodes: state.nodes.map(function (n) {
        const o = { id: n.id, type: n.type, x: n.x, y: n.y, w: n.w, h: n.h, z: n.z, color: n.color, text: n.text };
        if (n.type === "image") o.src = n.src;
        if (n.type === "image" && n.w0 && n.h0) { o.w0 = n.w0; o.h0 = n.h0; }
        if (n.type === "table") o.rows = n.rows;
        return o;
      }),
      edges: state.edges.map(function (e) {
        return { id: e.id, from: e.from, to: e.to, color: e.color, width: e.width };
      }),
      drawings: state.drawings.map(function (d) { return { id: d.id, color: d.color, width: d.width, opacity: d.opacity, points: d.points }; }),
    };
  }

  function doSave() {
    setStatus("Saving…", "busy");
    return fetch("/api/whiteboard", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: serialize() }),
    })
      .then(function (r) {
        if (!r.ok) throw new Error("save failed");
        return r.json();
      })
      .then(function () {
        dirty = false;
        const t = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        setStatus("Saved " + t, "ok");
        return true;
      })
      .catch(function () {
        setStatus("Save failed", "err");
        return false;
      });
  }

  // ---------- load ----------

  function load() {
    setStatus("Loading…", "busy");
    return fetch("/api/whiteboard", { method: "GET", headers: { "Content-Type": "application/json" } })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("load failed")); })
      .then(function (res) {
        const d = res.data || {};
        state.nodes = Array.isArray(d.nodes) ? d.nodes : [];
        state.drawings = Array.isArray(d.drawings) ? d.drawings : [];
        state.edges = Array.isArray(d.edges) ? d.edges : [];
        const v = d.view || {};
        state.view = { x: Number(v.x) || 0, y: Number(v.y) || 0, zoom: clamp(Number(v.zoom) || 1, MIN_ZOOM, MAX_ZOOM) };
        state.selected = null;
        state.edgeSel = null;
        dirty = false;
        render();
        setStatus(res.updated_at ? "Loaded" : "Empty board", "ok");
        return true;
      })
      .catch(function () {
        setStatus("Load failed", "err");
        return false;
      });
  }

  // ---------- toolbar / brushes / color / shapes ----------

  function closePops() {
    $$(".wb-popout").forEach(function (p) { p.classList.add("hidden"); });
  }

  function togglePop(id) {
    const p = $("#" + id);
    if (p.classList.contains("hidden")) {
      closePops();
      p.classList.remove("hidden");
    } else {
      p.classList.add("hidden");
    }
  }

  function renderSwatches() {
    const wrap = $("#wb-swatches");
    wrap.innerHTML = "";
    PALETTE.forEach(function (c) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "wb-swatch" + (c === state.color ? " active" : "");
      b.style.background = c;
      b.dataset.color = c;
      b.addEventListener("click", function () { applyColor(c); });
      wrap.appendChild(b);
    });
  }

  function applyColor(c) {
    state.color = c;
    $("#wb-color-dot").style.background = c;
    $("#wb-color-picker").value = c;
    renderSwatches();
    if (state.selected) {
      const n = nodeById(state.selected);
      if (n && SHAPES.indexOf(n.type) !== -1) {
        n.color = c;
        render();
        markDirty();
        return;
      }
    }
    if (state.edgeSel) {
      const e = edgeById(state.edgeSel);
      if (e) { e.color = c; renderEdges(); syncLayout(); markDirty(); return; }
    }
    setStatus("Color: " + c, "warn");
  }

  function selectTool(t) {
    state.tool = t;
    state.selected = null;
    state.edgeSel = null;
    $$(".wb-tool[data-wb-tool]").forEach(function (b) { b.classList.toggle("active", b.dataset.wbTool === t); });
    $$("#wb-shapes-pop .wb-opt").forEach(function (b) { b.classList.toggle("active", b.dataset.wbTool === t); });
    const stage = $("#wb-stage");
    if (stage) {
      stage.style.cursor =
        t === "pan" ? "grab"
        : (t === "pen" || t === "connector" || SHAPES.indexOf(t) !== -1) ? "crosshair"
        : t === "text" ? "text"
        : "default";
    }
    render();
  }

  function setBrush(name, activatePen) {
    state.stroke = name;
    const b = currentBrush();
    const btn = $("#wb-pen-tool");
    if (btn) btn.title = "Stroke: " + b.label + " (P)";
    $("#wb-stroke-pop").querySelectorAll(".wb-opt").forEach(function (o) {
      o.classList.toggle("active", o.dataset.brush === name);
    });
    if (activatePen) selectTool("pen");
  }

  // ---------- node creation ----------

  function commitSticky(w) {
    state.nodes.push({
      id: nextId(),
      type: "sticky",
      x: w.x - STICKY_SIZE.w / 2,
      y: w.y - STICKY_SIZE.h / 2,
      w: STICKY_SIZE.w,
      h: STICKY_SIZE.h,
      z: maxZ() + 1,
      color: STICKY_FILL,
      text: "",
    });
    render();
    editNode(state.nodes[state.nodes.length - 1]);
    markDirty();
  }

  function commitText(w) {
    const n = {
      id: nextId(),
      type: "text",
      x: w.x,
      y: w.y - 12,
      w: 0,
      h: 0,
      z: maxZ() + 1,
      color: state.color === TEXT_COLOR ? null : state.color,
      text: "",
    };
    if (n.color === "#111827") n.color = "";
    state.nodes.push(n);
    render();
    editNode(n);
    markDirty();
  }

  function commitTable(w) {
    const rows = [["", "", ""], ["", "", ""], ["", "", ""]];
    state.nodes.push({
      id: nextId(),
      type: "table",
      x: w.x - 150,
      y: w.y - 85,
      w: 300,
      h: 170,
      z: maxZ() + 1,
      rows: rows,
    });
    render();
    markDirty();
  }

  function editNode(n) {
    const el = $("#wb-nodes [data-id='" + n.id + "']");
    if (!el) return;
    const inner = el.querySelector(".wb-node-text");
    setTimeout(function () {
      if (inner) {
        inner.focus();
        const sel = window.getSelection();
        if (sel && sel.rangeCount) sel.selectAllChildren(inner);
      }
    }, 10);
  }

  function commitTextContent(el) {
    const n = nodeById(el.dataset.id);
    if (!n) return;
    const inner = el.querySelector(".wb-node-text");
    n.text = inner ? inner.textContent || "" : "";
    if (n.type === "text") {
      n.w = Math.max(80, el.scrollWidth + 10);
      n.h = Math.max(24, el.scrollHeight);
      render();
    }
    markDirty();
  }

  function commitTableContent(el) {
    const n = nodeById(el.dataset.id);
    if (!n) return;
    const rows = [];
    el.querySelectorAll("tr").forEach(function (tr) {
      const row = [];
      tr.querySelectorAll(".wb-cell").forEach(function (c) { row.push(c.textContent || ""); });
      rows.push(row);
    });
    n.rows = rows;
    n.w = Math.max(80, el.scrollWidth + 6);
    n.h = Math.max(60, el.scrollHeight + 6);
    markDirty();
  }

  // ---------- image import ----------

  function readImageFile(file) {
    return new Promise(function (resolve, reject) {
      const rd = new FileReader();
      rd.onload = function () {
        const im = new Image();
        im.onload = function () {
          let w = im.width, h = im.height;
          const scale = Math.max(w / (IMAGE_MAX_W * 2), h / (IMAGE_MAX_H * 2));
          if (scale > 1) { w = Math.round(w / scale); h = Math.round(h / scale); }
          const cv = document.createElement("canvas");
          cv.width = w; cv.height = h;
          cv.getContext("2d").drawImage(im, 0, 0, w, h);
          const isPng = /png/i.test(file.type);
          resolve(cv.toDataURL(isPng ? "image/png" : "image/jpeg", isPng ? undefined : 0.82));
        };
        im.onerror = function () { reject(new Error("image")); };
        im.src = rd.result;
      };
      rd.onerror = function () { reject(new Error("read")); };
      rd.readAsDataURL(file);
    });
  }

  function addImage(src) {
    const im = new Image();
    im.onload = function () {
      const V = state.view;
      const r = stageRect();
      const cx = (r.width / 2 - V.x) / V.zoom;
      const cy = (r.height / 2 - V.y) / V.zoom;
      let w = im.width, h = im.height;
      const s = Math.min(IMAGE_MAX_W / w, IMAGE_MAX_H / h, 1);
      w = Math.round(w * s); h = Math.round(h * s);
      const n = {
        id: nextId(),
        type: "image",
        x: cx - w / 2,
        y: cy - h / 2,
        w: Math.round(w),
        h: Math.round(h),
        w0: Math.round(w),
        h0: Math.round(h),
        z: maxZ() + 1,
        src: src,
      };
      state.nodes.push(n);
      state.selected = n.id;
      selectTool("select");
      render();
      markDirty();
      toast("Image added");
    };
    im.src = src;
  }

  // ---------- gestures ----------

  function endGesture() {
    g.kind = null;
    g.node = null;
    g.preview = null;
    g.ink = null;
    g.inkEl = null;
    g.edge = null;
    g.sizeFrom = null;
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    document.body.style.cursor = "";
  }

  function beginGesture() {
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  function onDown(e) {
    if (!active) return;
    if (e.button !== 0 && e.button !== 1) return;
    const cx = e.clientX;
    const cy = e.clientY;

    // Middle mouse always pans
    if (e.button === 1) {
      e.preventDefault();
      g.kind = "pan";
      g.view = { x: state.view.x, y: state.view.y };
      g.start = { x: cx, y: cy };
      beginGesture();
      return;
    }

    const handle = e.target.closest(".wb-handle");
    if (handle) {
      e.preventDefault();
      const n = nodeById(state.selected);
      if (n) startResize(n, { x: cx, y: cy }, e);
      return;
    }

    const ep = e.target.closest(".wb-ep");
    if (ep && state.edgeSel) {
      e.preventDefault();
      startEdgeEndDrag(ep.dataset.which, { x: cx, y: cy }, e);
      return;
    }

    if (state.tool === "select") {
      if (e.target.closest('[contenteditable="true"]')) return;
      const el = e.target.closest(".wb-node");
      if (el) {
        const n = nodeById(el.dataset.id);
        if (n) {
          state.selected = n.id;
          state.edgeSel = null;
          bringToFront(n);
          render();
          const nel = $("#wb-nodes [data-id='" + n.id + "']");
          if (nel) nel.classList.add("dragging");
          g.kind = "node";
          g.start = { x: cx, y: cy };
          g.from = toWorld(cx, cy);
          g.nodeFrom = { x: n.x, y: n.y };
          g.node = n;
          beginGesture();
        }
        return;
      }
      const eHit = e.target.closest(".wb-edge-hit");
      if (eHit) {
        state.edgeSel = eHit.dataset.eid;
        state.selected = null;
        render();
        return;
      }
      state.selected = null;
      state.edgeSel = null;
      render();
      return;
    }

    const w = toWorld(cx, cy);

    if (state.tool === "pan") {
      e.preventDefault();
      g.kind = "pan";
      g.view = { x: state.view.x, y: state.view.y };
      g.start = { x: cx, y: cy };
      beginGesture();
      return;
    }

    if (state.tool === "pen") {
      e.preventDefault();
      const br = currentBrush();
      const d = {
        id: nextId(),
        color: state.color,
        width: br.width,
        opacity: br.opacity,
        points: [[w.x, w.y]],
      };
      state.drawings.push(d);
      render();
      const ink = $("#wb-ink");
      const stroke = document.createElementNS("http://www.w3.org/2000/svg", "path");
      stroke.setAttribute("d", strokePathD(d.points));
      stroke.setAttribute("fill", "none");
      stroke.setAttribute("stroke", d.color);
      stroke.setAttribute("stroke-width", d.width);
      stroke.setAttribute("opacity", d.opacity);
      stroke.setAttribute("stroke-linecap", "round");
      stroke.setAttribute("stroke-linejoin", "round");
      stroke.setAttribute("vector-effect", "non-scaling-stroke");
      ink.appendChild(stroke);
      g.kind = "pen";
      g.ink = d;
      g.inkEl = stroke;
      beginGesture();
      return;
    }

    if (state.tool === "line") {
      e.preventDefault();
      const ns = "http://www.w3.org/2000/svg";
      const svgPre = document.createElementNS(ns, "line");
      svgPre.id = "wb-line-preview";
      svgPre.setAttribute("stroke", state.color);
      svgPre.setAttribute("stroke-width", "2.5");
      svgPre.setAttribute("stroke-linecap", "round");
      svgPre.setAttribute("stroke-dasharray", "6 5");
      svgPre.setAttribute("x1", w.x);
      svgPre.setAttribute("y1", w.y);
      svgPre.setAttribute("x2", w.x);
      svgPre.setAttribute("y2", w.y);
      $("#wb-edges").appendChild(svgPre);
      g.kind = "lineDrag";
      g.shapeType = "line";
      g.from = { x: w.x, y: w.y };
      g.preview = svgPre;
      beginGesture();
      return;
    }

    if (SHAPES.indexOf(state.tool) !== -1) {
      e.preventDefault();
      state.selected = null;
      state.edgeSel = null;
      const pre = document.createElement("div");
      pre.className = "wb-preview wb-preview-" + state.tool + (state.tool === "ellipse" ? " wb-preview-round" : "");
      pre.style.left = w.x + "px";
      pre.style.top = w.y + "px";
      pre.style.background = state.color;
      if (state.tool === "line") pre.style.background = "transparent";
      $("#wb-nodes").appendChild(pre);
      g.kind = "shape";
      g.shapeType = state.tool;
      g.from = { x: w.x, y: w.y };
      g.preview = pre;
      beginGesture();
      return;
    }

    if (state.tool === "sticky") {
      e.preventDefault();
      commitSticky(w);
      return;
    }

    if (state.tool === "text") {
      e.preventDefault();
      commitText(w);
      return;
    }

    if (state.tool === "table") {
      e.preventDefault();
      commitTable(w);
      return;
    }

    if (state.tool === "image") {
      e.preventDefault();
      $("#wb-image-input").click();
      return;
    }

    if (state.tool === "connector") {
      e.preventDefault();
      const fromNode = nodeAt(w);
      g.kind = "connector";
      g.shapeType = "connector";
      g.startP = { x: w.x, y: w.y };
      g.from = { x: w.x, y: w.y };
      g.connFromNode = fromNode ? fromNode.id : null;
      g.connTo = { x: w.x, y: w.y };
      beginGesture();
      drawConnectorPreview();
      return;
    }
  }

  function drawConnectorPreview() {
    const svg = $("#wb-edges");
    let p = svg.querySelector("#wb-edge-preview");
    if (!p) {
      const ns = "http://www.w3.org/2000/svg";
      p = document.createElementNS(ns, "path");
      p.id = "wb-edge-preview";
      p.setAttribute("fill", "none");
      p.setAttribute("stroke", state.color);
      p.setAttribute("stroke-width", 2.2);
      p.setAttribute("stroke-linecap", "round");
      p.setAttribute("stroke-dasharray", "6 5");
      p.setAttribute("vector-effect", "non-scaling-stroke");
      svg.appendChild(p);
    }
    const f = g.connFromNode ? center(nodeById(g.connFromNode)) : g.from;
    const t = g.connTo;
    p.setAttribute("d", "M" + f.x.toFixed(1) + "," + f.y.toFixed(1) + " L" + t.x.toFixed(1) + "," + t.y.toFixed(1));
  }

  function startResize(n, startClient, e) {
    g.kind = "resize";
    g.node = n;
    g.start = { x: startClient.x, y: startClient.y };
    g.from = toWorld(startClient.x, startClient.y);
    g.sizeFrom = { x: n.x, y: n.y, w: n.w || 80, h: n.h || 40 };
    beginGesture();
  }

  function startEdgeEndDrag(which, startClient, e) {
    const edge = edgeById(state.edgeSel);
    if (!edge) return;
    g.kind = "edgeEnd";
    g.edge = edge;
    g.which = which;
    g.start = { x: startClient.x, y: startClient.y };
    g.from = toWorld(startClient.x, startClient.y);
    const pts = edgePts(edge);
    const cur = which === "from" ? pts.f : pts.t;
    g.nodeFrom = { x: cur.x, y: cur.y };
    beginGesture();
  }

  function onMove(e) {
    if (!active || !g.kind) return;
    const cx = e.clientX;
    const cy = e.clientY;

    if (g.kind === "pan") {
      state.view.x = g.view.x + (cx - g.start.x);
      state.view.y = g.view.y + (cy - g.start.y);
      document.body.style.cursor = "grabbing";
      applyView();
      return;
    }

    const w = toWorld(cx, cy);

    if (g.kind === "node" && g.node) {
      g.node.x = g.nodeFrom.x + (w.x - g.from.x);
      g.node.y = g.nodeFrom.y + (w.y - g.from.y);
      const el = $("#wb-nodes [data-id='" + g.node.id + "']");
      if (el) {
        el.style.left = g.node.x + "px";
        el.style.top = g.node.y + "px";
      }
      renderEdges();
      syncLayout();
      return;
    }

    if (g.kind === "resize" && g.node && g.sizeFrom) {
      const n = g.node;
      const ow = Math.max(24, g.sizeFrom.w + (w.x - g.from.x));
      const oh = Math.max(24, g.sizeFrom.h + (w.y - g.from.y));
      let nw = ow, nh = oh;
      if (n.type === "image" && n.w0 && n.h0) {
        const r = n.h0 / n.w0;
        nw = ow;
        nh = ow * r;
      }
      n.w = nw;
      n.h = nh;
      const el = $("#wb-nodes [data-id='" + n.id + "']");
      if (el) {
        el.style.width = nw + "px";
        el.style.height = nh + "px";
      }
      renderEdges();
      syncLayout();
      return;
    }

    if (g.kind === "pen" && g.ink) {
      g.ink.points.push([w.x, w.y]);
      if (g.inkEl) g.inkEl.setAttribute("d", strokePathD(g.ink.points));
      return;
    }

    if (g.kind === "shape" && g.preview) {
      const x = Math.min(g.from.x, w.x);
      const y = Math.min(g.from.y, w.y);
      const h = Math.abs(w.x - g.from.x);
      const v = Math.abs(w.y - g.from.y);
      g.preview.style.left = x + "px";
      g.preview.style.top = y + "px";
      g.preview.style.width = Math.max(12, h) + "px";
      g.preview.style.height = Math.max(12, v) + "px";
      return;
    }

    if (g.kind === "lineDrag" && g.preview) {
      g.preview.setAttribute("x1", g.from.x);
      g.preview.setAttribute("y1", g.from.y);
      g.preview.setAttribute("x2", w.x);
      g.preview.setAttribute("y2", w.y);
      return;
    }

    if (g.kind === "connector") {
      g.connTo = { x: w.x, y: w.y };
      drawConnectorPreview();
      return;
    }

    if (g.kind === "edgeEnd" && g.edge) {
      const hit = nodeAt(w);
      const ep = g.edge[g.which];
      if (hit) {
        ep.node = hit.id;
        ep.x = null;
        ep.y = null;
      } else {
        ep.node = null;
        ep.x = w.x;
        ep.y = w.y;
      }
      renderEdges();
      syncLayout();
      return;
    }
  }

  function onUp(e) {
    if (!active || !g.kind) return;
    const w = toWorld(e.clientX, e.clientY);

    if (g.kind === "node" && g.node) {
      const el = $("#wb-nodes [data-id='" + g.node.id + "']");
      if (el) el.classList.remove("dragging");
      endGesture();
      markDirty();
      render();
      return;
    }

    if (g.kind === "resize" && g.node) {
      endGesture();
      markDirty();
      render();
      return;
    }

    if (g.kind === "pen") {
      if (g.ink && g.ink.points.length < 3) {
        g.ink.points.push([g.ink.points[0][0] + 0.01, g.ink.points[0][1] + 0.01]);
      }
      endGesture();
      render();
      markDirty();
      return;
    }

    if (g.kind === "lineDrag") {
      const h = Math.abs(w.x - g.from.x);
      const v = Math.abs(w.y - g.from.y);
      if (h > 10 || v > 10) {
        state.nodes.push({
          id: nextId(),
          type: "line",
          x: Math.min(g.from.x, w.x),
          y: Math.min(g.from.y, w.y),
          w: Math.max(10, h),
          h: Math.max(10, v),
          z: maxZ() + 1,
          color: state.color,
          text: "",
        });
      }
      endGesture();
      render();
      markDirty();
      return;
    }

    if (g.kind === "shape") {
      const x = Math.min(g.from.x, w.x);
      const y = Math.min(g.from.y, w.y);
      const h = Math.abs(w.x - g.from.x);
      const v = Math.abs(w.y - g.from.y);
      const type = g.shapeType;
      if (h > 10 || v > 10) {
        state.nodes.push({
          id: nextId(),
          type: type,
          x: x,
          y: y,
          w: Math.max(24, h),
          h: Math.max(24, v),
          z: maxZ() + 1,
          color: state.color,
          text: "",
        });
        markDirty();
      }
      endGesture();
      render();
      markDirty();
      return;
    }

    if (g.kind === "connector") {
      const dist = Math.hypot(w.x - g.from.x, w.y - g.from.y);
      const toNode = nodeAt(w);
      const fromNode = g.connFromNode ? nodeById(g.connFromNode) : nodeAt(g.from);
      endGesture();
      if (dist > 12 && !(fromNode && toNode === fromNode)) {
        const e = {
          id: nextId(),
          from: fromNode ? { node: fromNode.id, x: null, y: null } : { node: null, x: g.from.x, y: g.from.y },
          to: toNode ? { node: toNode.id, x: null, y: null } : { node: null, x: w.x, y: w.y },
          color: state.color,
          width: 2.2,
        };
        state.edges.push(e);
        state.edgeSel = e.id;
        markDirty();
      }
      render();
      return;
    }

    if (g.kind === "edgeEnd" && g.edge) {
      endGesture();
      markDirty();
      render();
      return;
    }

    if (g.kind === "pan") {
      endGesture();
      return;
    }
  }

  // ---------- zoom / fit / clear ----------

  function zoomBy(factor, cx, cy) {
    const V = state.view;
    const r = stageRect();
    const px = cx !== undefined ? cx : r.left + r.width / 2;
    const py = cy !== undefined ? cy : r.top + r.height / 2;
    const wx = (px - r.left - V.x) / V.zoom;
    const wy = (py - r.top - V.y) / V.zoom;
    const nz = clamp(V.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    V.x = px - r.left - wx * nz;
    V.y = py - r.top - wy * nz;
    V.zoom = nz;
    applyView();
  }

  function applyView() {
    const V = state.view;
    const w = $("#wb-world");
    if (!w) return;
    w.style.transform = "translate(" + V.x + "px, " + V.y + "px) scale(" + V.zoom + ")";
    const zl = $("#wb-zoom-label");
    if (zl) zl.textContent = Math.round(V.zoom * 100) + "%";
    syncLayout();
  }

  function fitToScreen() {
    const r = stageRect();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    function add(p) { if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y; }

    state.nodes.forEach(function (n) {
      add({ x: n.x, y: n.y });
      add({ x: n.x + (n.w || 80), y: n.y + (n.h || 40) });
    });
    state.drawings.forEach(function (d) {
      (d.points || []).forEach(function (p) { add({ x: p[0], y: p[1] }); });
    });
    state.edges.forEach(function (e) {
      const pts = edgePts(e);
      add(pts.f); add(pts.t);
    });
    if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 400; maxY = 300; }
    const bw = maxX - minX || 200;
    const bh = maxY - minY || 150;
    const zoom = Math.min(1.5, Math.min((r.width - 60) / bw, (r.height - 60) / bh));
    state.view.zoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    state.view.x = (r.width - bw * state.view.zoom) / 2 - minX * state.view.zoom;
    state.view.y = (r.height - bh * state.view.zoom) / 2 - minY * state.view.zoom;
    applyView();
  }

  function deleteSelected() {
    if (state.selected) {
      const n = nodeById(state.selected);
      if (n) {
        state.nodes = state.nodes.filter(function (x) { return x.id !== n.id; });
        state.edges = state.edges.filter(function (e) { return (e.from && e.from.node) === n.id || (e.to && e.to.node) === n.id; });
        state.selected = null;
        render();
        markDirty();
      }
    } else if (state.edgeSel) {
      state.edges = state.edges.filter(function (e) { return e.id !== state.edgeSel; });
      state.edgeSel = null;
      render();
      markDirty();
    }
  }

  function clearBoard() {
    state.nodes = [];
    state.drawings = [];
    state.edges = [];
    state.view = { x: 40, y: 40, zoom: 1 };
    state.selected = null;
    state.edgeSel = null;
    render();
    markDirty();
    toast("Board cleared");
  }

  // ---------- keyboard ----------

  function onKey(e) {
    const viewEl = $("#view-whiteboard");
    if (!viewEl || viewEl.classList.contains("hidden")) return;
    const tag = (e.target.tagName || "").toLowerCase();
    const editable = tag === "input" || tag === "textarea" || e.target.isContentEditable;
    if (editable) return;

    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === "s") {
      e.preventDefault();
      doSave();
      return;
    }
    if (ctrl) return;

    const tools = { v: "select", h: "pan", p: "pen", l: "connector", s: "sticky", t: "text", i: "image", u: "table" };
    const key = e.key.toLowerCase();
    if (tools[key] && !e.altKey) {
      closePops();
      selectTool(tools[key]);
      return;
    }

    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      deleteSelected();
      return;
    }

    if (e.key === "Escape") {
      if (!$("#wb-stroke-pop").classList.contains("hidden") || !$("#wb-color-pop").classList.contains("hidden") || !$("#wb-shapes-pop").classList.contains("hidden")) {
        closePops();
        return;
      }
      if (state.selected || state.edgeSel) {
        state.selected = null;
        state.edgeSel = null;
        syncLayout();
      } else {
        selectTool("select");
      }
    }
  }

  function onWheel(e) {
    if (!active) return;
    const viewEl = $("#view-whiteboard");
    if (!viewEl || viewEl.classList.contains("hidden")) return;
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX, e.clientY);
  }

  function onNodeBlur(e) {
    const host = e.target.closest(".wb-node");
    if (!host) return;
    if (host.classList.contains("wb-table")) {
      commitTableContent(host);
      return;
    }
    if (e.target.closest(".wb-cell")) return;
    commitTextContent(host);
  }

  // ---------- init ----------

  function bind() {
    const stage = $("#wb-stage");
    stage.addEventListener("mousedown", onDown);
    stage.addEventListener("wheel", onWheel, { passive: false });

    $("#wb-nodes").addEventListener("focusout", onNodeBlur, true);
    $("#wb-nodes").addEventListener("mousedown", function (e) {
      if (e.target.closest(".wb-node") && !e.target.closest('[contenteditable="true"]')) {
        e.preventDefault();
      }
    });

    $("#wb-ep1").dataset.which = "from";
    $("#wb-ep2").dataset.which = "to";

    document.addEventListener("keydown", onKey);
    document.addEventListener("click", function (e) {
      if (!e.target.closest(".wb-pop-cur") && !e.target.closest(".wb-popout")) closePops();
    });

    $$(".wb-tool[data-wb-tool]").forEach(function (b) {
      b.addEventListener("click", function () {
        closePops();
        selectTool(b.dataset.wbTool);
      });
    });

    $("#wb-stroke-btn").addEventListener("click", function (e) { e.stopPropagation(); togglePop("wb-stroke-pop"); });
    $("#wb-color-btn").addEventListener("click", function (e) { e.stopPropagation(); togglePop("wb-color-pop"); });
    $("#wb-shapes-btn").addEventListener("click", function (e) { e.stopPropagation(); togglePop("wb-shapes-pop"); });

    $$("#wb-stroke-pop .wb-opt").forEach(function (o) {
      o.addEventListener("click", function () {
        setBrush(o.dataset.brush, true);
        closePops();
      });
    });
    $$("#wb-shapes-pop .wb-opt").forEach(function (o) {
      o.addEventListener("click", function () {
        closePops();
        selectTool(o.dataset.wbTool);
      });
    });

    renderSwatches();
    $("#wb-color-dot").style.background = state.color;
    $("#wb-color-picker").value = state.color;
    setBrush(state.stroke, false);
    $("#wb-color-picker").addEventListener("input", function (e) { applyColor(e.target.value); });

    const fileInput = $("#wb-image-input");
    fileInput.addEventListener("change", function () {
      const f = fileInput.files && fileInput.files[0];
      if (f) {
        setStatus("Reading image…", "busy");
        readImageFile(f)
          .then(function (src) { addImage(src); fileInput.value = ""; })
          .catch(function () { setStatus("Image failed", "err"); fileInput.value = ""; });
      }
    });

    $("#wb-zoom-in").addEventListener("click", function () { zoomBy(1.2); });
    $("#wb-zoom-out").addEventListener("click", function () { zoomBy(1 / 1.2); });
    $("#wb-fit").addEventListener("click", fitToScreen);
    $("#wb-save").addEventListener("click", function () {
      doSave().then(function (ok) {
        toast(ok ? "Board saved" : "Could not save board", ok ? undefined : "error");
      });
    });
    $("#wb-clear").addEventListener("click", function () {
      const run = function () { closePops(); clearBoard(); };
      if (window.confirmDialog) window.confirmDialog("Clear the entire whiteboard? This cannot be undone.", run);
      else if (window.confirm("Clear the entire whiteboard? This cannot be undone.")) run();
    });

    booted = true;
  }

  window.WB = {
    enter: function () {
      active = true;
      if (!booted) bind();
      if (!loadedOnce) {
        load().then(function () { loadedOnce = true; });
      }
    },
    leave: function () { active = false; },
  };
})();