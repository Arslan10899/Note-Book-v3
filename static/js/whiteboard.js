/* Interactive whiteboard (P1): infinite canvas, pan/zoom, freehand pen,
   rect/circle shapes, sticky notes, text, JSON persistence + autosave. */

(function () {
  "use strict";

  const MAX_ZOOM = 3;
  const MIN_ZOOM = 0.25;
  const PEN_COLOR = "#e11d48";
  const PEN_WIDTH = 3;
  const SHAPE_FILL = "#fffaf0";
  const STICKY_FILL = "#ffe599";
  const STICKY_SIZE = { w: 170, h: 150 };
  const RECT_SIZE = { w: 200, h: 120 };
  const CIRCLE_SIZE = 160;

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));

  let booted = false;
  let active = false;
  let loadedOnce = false;

  const state = {
    view: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    drawings: [],
    edges: [],
    tool: "select",
    selected: null,
  };

  // Gesture bookkeeping (only one active at a time)
  const g = {
    kind: null,            // 'pan' | 'pen' | 'shape' | 'node' 
    start: { x: 0, y: 0 }, // client coords on mousedown
    view: { x: 0, y: 0 },  // view at gesture start (pan)
    node: null,            // node being dragged
    from: { x: 0, y: 0 },  // world coords on mousedown
    nodeFrom: { x: 0, y: 0 },
    preview: null,         // draft element during draw
    shapeType: null,
  };

  let saveTimer = null;
  let saving = false;

  // ---------- id / helpers ----------

  function nextId() {
    return "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

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

  function applyView() {
    const V = state.view;
    const w = $("#wb-world");
    if (!w) return;
    w.style.transform = "translate(" + V.x + "px, " + V.y + "px) scale(" + V.zoom + ")";
    const zl = $("#wb-zoom-label");
    if (zl) zl.textContent = Math.round(V.zoom * 100) + "%";
  }

  function maxZ() {
    return state.nodes.reduce(function (m, n) { return Math.max(m, n.z || 0); }, 0);
  }

  function strokePathD(points) {
    if (!points || !points.length) return "";
    var d = "M" + points[0][0].toFixed(1) + "," + points[0][1].toFixed(1);
    for (var i = 1; i < points.length; i++) d += "L" + points[i][0].toFixed(1) + "," + points[i][1].toFixed(1);
    return d;
  }

  // ---------- rendering ----------

  function makeNodeEl(n) {
    const el = document.createElement("div");
    el.className = "wb-node wb-" + n.type + (n.id === state.selected ? " selected" : "");
    el.dataset.id = n.id;
    el.style.left = n.x + "px";
    el.style.top = n.y + "px";
    el.style.zIndex = n.z || 0;
    if (n.type === "rect" || n.type === "circle") {
      el.style.width = Math.max(40, n.w) + "px";
      el.style.height = Math.max(40, n.h) + "px";
      el.style.background = n.color || SHAPE_FILL;
      if (n.type === "circle") el.style.borderRadius = "50%";
    } else if (n.type === "sticky") {
      el.style.width = Math.max(60, n.w) + "px";
      el.style.height = Math.max(60, n.h) + "px";
      el.style.background = n.color || STICKY_FILL;
    } else if (n.type === "text") {
      el.style.width = (n.w && n.w > 0) ? n.w + "px" : "auto";
      el.style.height = n.h ? n.h + "px" : "auto";
    }
    return el;
  }

  function render() {
    const box = $("#wb-nodes");
    box.innerHTML = "";
    state.nodes
      .slice()
      .sort(function (a, b) { return (a.z || 0) - (b.z || 0); })
      .forEach(function (n) {
        const el = makeNodeEl(n);
        if (n.type === "sticky" || n.type === "text") {
          const inner = document.createElement("div");
          inner.className = "wb-node-text";
          inner.contentEditable = "true";
          inner.setAttribute("spellcheck", "false");
          inner.textContent = n.text || "";
          if (n.type === "text") el.appendChild(inner);
          else el.appendChild(inner);
        }
        box.appendChild(el);
      });

    const ink = $("#wb-ink");
    ink.innerHTML = "";
    state.drawings.forEach(function (d) {
      if (!d.points || d.points.length < 2) return;
      const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("d", strokePathD(d.points));
      p.setAttribute("fill", "none");
      p.setAttribute("stroke", d.color || PEN_COLOR);
      p.setAttribute("stroke-width", d.width || PEN_WIDTH);
      p.setAttribute("stroke-linecap", "round");
      p.setAttribute("stroke-linejoin", "round");
      p.setAttribute("vector-effect", "non-scaling-stroke");
      ink.appendChild(p);
    });

    const edges = $("#wb-edges");
    edges.innerHTML = "";

    const empty = $("#wb-empty");
    if (empty) empty.classList.toggle("hidden", state.nodes.length + state.drawings.length > 0);

    applyView();
  }

  // ---------- status / save ----------

  function setStatus(txt, kind) {
    const s = $("#wb-status");
    if (!s) return;
    s.textContent = txt;
    s.dataset.kind = kind || "idle";
  }

  function toast(msg, kind) {
    if (window.toast) window.toast(msg, kind);
  }

  function serialize() {
    return JSON.stringify({
      view: state.view,
      nodes: state.nodes.map(function (n) { return { id: n.id, type: n.type, x: n.x, y: n.y, w: n.w, h: n.h, z: n.z, color: n.color, text: n.text }; }),
      edges: state.edges,
      drawings: state.drawings.map(function (d) { return { id: d.id, color: d.color, width: d.width, points: d.points }; }),
    });
  }

  function doSave() {
    saving = true;
    return fetch("/api/whiteboard", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: JSON.parse(serialize()) }),
    })
      .then(function (r) {
        if (!r.ok) throw new Error("save failed");
        return r.json();
      })
      .then(function () {
        saving = false;
        const t = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        setStatus("Saved " + t, "ok");
        return true;
      })
      .catch(function (e) {
        saving = false;
        setStatus("Save failed", "err");
        return false;
      });
  }

  function scheduleSave() {
    setStatus("Saving…", "busy");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { doSave(); }, 700);
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
        state.view = { x: Number(v.x) || 0, y: Number(v.y) || 0, zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(v.zoom) || 1)) };
        state.selected = null;
        render();
        setStatus(res.updated_at ? "Loaded" : "Empty board", "ok");
        return true;
      })
      .catch(function () {
        setStatus("Load failed", "err");
        return false;
      });
  }

  // ---------- gestures ----------

  function endGesture() {
    g.kind = null;
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    document.body.style.cursor = "";
  }

  function beginGesture() {
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  function selectTool(t) {
    state.tool = t;
    state.selected = null;
    $$(".wb-tool[data-wb-tool]").forEach(function (b) { b.classList.toggle("active", b.dataset.wbTool === t); });
    const stage = $("#wb-stage");
    if (stage) {
      stage.style.cursor =
        t === "pan" ? "grab"
        : (t === "pen" || t === "rect" || t === "circle") ? "crosshair"
        : t === "text" ? "text"
        : "default";
    }
    render();
  }

  function bringToFront(n) {
    n.z = maxZ() + 1;
  }

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
    scheduleSave();
    editNode(state.nodes[state.nodes.length - 1]);
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
      color: "",
      text: "",
    };
    state.nodes.push(n);
    render();
    editNode(n);
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
    const node = state.nodes.find(function (n) { return n.id === el.dataset.id; });
    if (!node) return;
    const inner = el.querySelector(".wb-node-text");
    node.text = inner ? inner.textContent || "" : "";
    if (node.type === "text") {
      node.w = Math.max(80, el.scrollWidth + 10);
      node.h = Math.max(22, el.scrollHeight);
      render();
    }
    scheduleSave();
  }

  function deleteNode(n) {
    state.nodes = state.nodes.filter(function (x) { return x.id !== n.id; });
    state.edges = state.edges.filter(function (e) { return e.fromId !== n.id && e.toId !== n.id; });
    if (state.selected === n.id) state.selected = null;
    render();
    scheduleSave();
  }

  // ---------- interaction: stage pointer ----------

  function onDown(e) {
    if (!active) return;
    if (e.button !== 0 && e.button !== 1) return;
    const r = stageRect();
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

    // Select tool: clicking a node selects & drags it
    if (state.tool === "select") {
      // Keep caret clicks inside editable nodes working (no drag from there)
      if (e.target.closest('[contenteditable="true"]')) return;
      const el = e.target.closest(".wb-node");
      if (el) {
        const n = state.nodes.find(function (x) { return x.id === el.dataset.id; });
        if (n) {
          state.selected = n.id;
          bringToFront(n);
          render(); // re-render (also re-binds elements), then grab fresh node element
          const nel = $("#wb-nodes [data-id='" + n.id + "']");
          if (nel) nel.classList.add("dragging");
          g.kind = "node";
          g.start = { x: cx, y: cy };
          g.from = toWorld(cx, cy);
          g.nodeFrom = { x: n.x, y: n.y };
          g.node = n;
          beginGesture();
        }
      } else {
        state.selected = null;
        render();
      }
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
      const d = {
        id: nextId(),
        color: PEN_COLOR,
        width: PEN_WIDTH,
        points: [[w.x, w.y]],
      };
      state.drawings.push(d);
      render();
      g.kind = "pen";
      g.ink = d;
      beginGesture();
      return;
    }

    if (state.tool === "rect" || state.tool === "circle") {
      e.preventDefault();
      state.selected = null;
      const pre = document.createElement("div");
      pre.className = "wb-preview wb-preview-" + state.tool;
      pre.style.left = w.x + "px";
      pre.style.top = w.y + "px";
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
      return;
    }

    if (g.kind === "pen" && g.ink) {
      g.ink.points.push([w.x, w.y]);
      const last = $("#wb-ink path:last-of-type");
      if (last) last.setAttribute("d", strokePathD(g.ink.points));
      return;
    }

    if (g.kind === "shape" && g.preview) {
      const x = Math.min(g.from.x, w.x);
      const y = Math.min(g.from.y, w.y);
      const h = Math.abs(w.x - g.from.x);
      const v = Math.abs(w.y - g.from.y);
      g.preview.style.left = x + "px";
      g.preview.style.top = y + "px";
      g.preview.style.width = Math.max(8, h) + "px";
      g.preview.style.height = Math.max(8, v) + "px";
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
      scheduleSave();
      return;
    }

    if (g.kind === "pen") {
      if (g.ink && g.ink.points.length < 3) {
        // single click = dot
        g.ink.points.push([g.ink.points[0][0] + 0.01, g.ink.points[0][1] + 0.01]);
      }
      endGesture();
      render();
      scheduleSave();
      return;
    }

    if (g.kind === "shape") {
      const x = Math.min(g.from.x, w.x);
      const y = Math.min(g.from.y, w.y);
      const h = Math.abs(w.x - g.from.x);
      const v = Math.abs(w.y - g.from.y);
      if (h > 8 || v > 8) {
        const type = g.shapeType;
        const dim = type === "circle" ? CIRCLE_SIZE : RECT_SIZE;
        const nw = h > 8 ? h : dim.w;
        const nh = v > 8 ? v : dim.h;
        state.nodes.push({
          id: nextId(),
          type: type,
          x: x,
          y: y,
          w: nw,
          h: nh,
          z: maxZ() + 1,
          color: SHAPE_FILL,
          text: "",
        });
        if (type === "circle") {
          // force perfect circle for circle tool
          const s = Math.max(nw, nh);
          const last = state.nodes[state.nodes.length - 1];
          last.w = s;
          last.h = s;
        }
        scheduleSave();
      }
      endGesture();
      render();
      return;
    }

    if (g.kind === "pan") {
      endGesture();
      scheduleSave();
      return;
    }
  }

  // ---------- zoom / fit ----------

  function zoomBy(factor, cx, cy) {
    const V = state.view;
    let rz = stageRect();
    const px = cx !== undefined ? cx : rz.left + rz.width / 2;
    const py = cy !== undefined ? cy : rz.top + rz.height / 2;
    const wx = (px - rz.left - V.x) / V.zoom;
    const wy = (py - rz.top - V.y) / V.zoom;
    const nz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, V.zoom * factor));
    V.x = px - rz.left - wx * nz;
    V.y = py - rz.top - wy * nz;
    V.zoom = nz;
    applyView();
  }

  function fitToScreen() {
    const r = stageRect();
    const nodes = state.nodes;
    if (!nodes.length && !state.drawings.length) {
      state.view = { x: 40, y: 40, zoom: 1 };
      applyView();
      return;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    nodes.forEach(function (n) {
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.x + (n.w || 80) > maxX) maxX = n.x + (n.w || 80);
      if (n.y + (n.h || 40) > maxY) maxY = n.y + (n.h || 40);
    });
    state.drawings.forEach(function (d) {
      (d.points || []).forEach(function (p) {
        if (p[0] < minX) minX = p[0];
        if (p[1] < minY) minY = p[1];
        if (p[0] > maxX) maxX = p[0];
        if (p[1] > maxY) maxY = p[1];
      });
    });
    if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 400; maxY = 300; }
    const bw = maxX - minX || 200;
    const bh = maxY - minY || 150;
    const zoom = Math.min(1.5, Math.min((r.width - 60) / bw, (r.height - 60) / bh));
    state.view.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
    state.view.x = (r.width - bw * state.view.zoom) / 2 - minX * state.view.zoom;
    state.view.y = (r.height - bh * state.view.zoom) / 2 - minY * state.view.zoom;
    applyView();
  }

  // ---------- keyboard ----------

  function onKey(e) {
    if (!active) return;
    const viewEl = $("#view-whiteboard");
    if (!viewEl || viewEl.classList.contains("hidden")) return;
    const tag = (e.target.tagName || "").toLowerCase();
    const editable = tag === "input" || tag === "textarea" || (e.target.isContentEditable);
    if (editable) return;

    const tools = { v: "select", h: "pan", p: "pen", r: "rect", c: "circle", s: "sticky", t: "text" };
    const key = e.key.toLowerCase();
    if (tools[key]) {
      selectTool(tools[key]);
      return;
    }

    if (e.key === "Delete" || e.key === "Backspace") {
      if (state.selected) {
        const n = state.nodes.find(function (x) { return x.id === state.selected; });
        if (n) {
          e.preventDefault();
          deleteNode(n);
        }
      }
      return;
    }

    if (e.key === "Escape") {
      if (state.selected) { state.selected = null; render(); }
      else selectTool("select");
    }
  }

  function onWheel(e) {
    if (!active) return;
    const viewEl = $("#view-whiteboard");
    if (!viewEl || viewEl.classList.contains("hidden")) return;
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX, e.clientY);
    scheduleSave();
  }

  function onNodeBlur(e) {
    const el = e.target.closest(".wb-node");
    if (el && document.activeElement !== el) {
      commitTextContent(el);
      state.selected = null;
      render();
    }
  }

  // ---------- init ----------

  function bind() {
    const stage = $("#wb-stage");
    stage.addEventListener("mousedown", onDown);
    stage.addEventListener("wheel", onWheel, { passive: false });

    const nodesBox = $("#wb-nodes");
    nodesBox.addEventListener("focusout", onNodeBlur, true);
    nodesBox.addEventListener("mousedown", function (e) {
      // prevent native drag/text selection on node chrome, but let
      // caret placement inside contenteditable surfaces work normally
      if (e.target.closest(".wb-node") && !e.target.closest('[contenteditable="true"]')) {
        e.preventDefault();
      }
    });
    nodesBox.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && e.target.isContentEditable) {
        const host = e.target.closest(".wb-node");
        if (host && host.classList.contains("wb-text")) {
          e.preventDefault();
          e.target.blur();
        }
      }
    });

    document.addEventListener("keydown", onKey);

    $$(".wb-tool[data-wb-tool]").forEach(function (b) {
      b.addEventListener("click", function () { selectTool(b.dataset.wbTool); });
    });
    $("#wb-zoom-in").addEventListener("click", function () { zoomBy(1.2); scheduleSave(); });
    $("#wb-zoom-out").addEventListener("click", function () { zoomBy(1 / 1.2); scheduleSave(); });
    $("#wb-fit").addEventListener("click", fitToScreen);
    $("#wb-save").addEventListener("click", function () {
      doSave().then(function (ok) {
        if (ok) toast("Whiteboard saved");
        else toast("Could not save whiteboard", "error");
      });
    });
    $("#wb-clear").addEventListener("click", function () {
      const reset = function () {
        state.nodes = [];
        state.drawings = [];
        state.edges = [];
        state.view = { x: 40, y: 40, zoom: 1 };
        state.selected = null;
        render();
        scheduleSave();
        toast("Board cleared");
      };
      if (window.confirmDialog) window.confirmDialog("Clear the entire whiteboard? This cannot be undone.", reset);
      else if (window.confirm("Clear the entire whiteboard? This cannot be undone.")) reset();
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