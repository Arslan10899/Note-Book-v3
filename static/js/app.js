const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const state = {
  tasks: [],
  notes: [],
  pages: [],
  routines: [],
  view: "dashboard",
  taskFilter: "all",
  noteQuery: "",
  deepSearch: false,
  user: null,
  activeTag: "",
  editingId: null,
  editorKind: "note",
  currentPageId: null,
  returnTo: null,
  schedWd: (new Date().getDay() + 6) % 7,
  calY: new Date().getFullYear(),
  calM: new Date().getMonth(),
};

let HOLIDAYS = {};

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const VIEW_TITLES = { dashboard: "Dashboard", tasks: "Tasks", notes: "Notes", pages: "Pages", schedule: "Schedule", calendar: "Calendar", settings: "Settings" };

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function stripHtml(html, max = 140) {
  const s = String(html || "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
  return max ? s.slice(0, max) : s;
}

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function relTime(stamp) {
  if (!stamp) return "";
  const then = parseStampUTC(stamp);
  if (!then || isNaN(then)) return "";
  const mins = Math.floor((Date.now() - then.getTime()) / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  return then.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// Server stores naive UTC stamps ("YYYY-MM-DD HH:MM:SS") — interpret them as UTC
function parseStampUTC(s) {
  if (!s) return null;
  let str = String(s).trim().replace(" ", "T");
  if (!/[zZ]$|[+-]\d{2}:?\d{2}$/.test(str)) str += "Z";
  return new Date(str);
}

// Absolute local date: "Aug 24, 2026" (year dropped when current year)
function fmtStampShort(s) {
  const d = parseStampUTC(s);
  if (!d || isNaN(d)) return "";
  const opts = { month: "short", day: "numeric" };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString("en-US", opts);
}

// Absolute local date+time: "Aug 24, 2026, 3:45 PM"
function fmtStampFull(s) {
  const d = parseStampUTC(s);
  if (!d || isNaN(d)) return "";
  return d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function toast(msg, type = "success") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  $("#toast-root").appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transition = "opacity .25s";
    setTimeout(() => el.remove(), 260);
  }, 2800);
}

async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: opts.body && !(opts.body instanceof FormData) ? { "Content-Type": "application/json" } : undefined,
    ...opts,
  });
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith("/api/auth/")) {
      location.reload();
      throw new Error("Signed out");
    }
    let msg = res.statusText;
    try {
      msg = (await res.json()).error || msg;
    } catch (e) {}
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  return res.json();
}

function openDialog(html) {
  closeDialog();
  $("#dialog-root").innerHTML = `
    <div class="dialog-backdrop" data-close-dialog></div>
    <div class="dialog-panel">${html}</div>
  `;
  $("#dialog-root").querySelector("[data-close-dialog]").addEventListener("mousedown", closeDialog);
}

function closeDialog() {
  $("#dialog-root").innerHTML = "";
}

function confirmDialog(message, onOk, okLabel = "Delete") {
  openDialog(`
    <div class="flex items-start gap-3">
      <div class="mt-0.5 rounded-full bg-destructive/15 p-2 text-destructive">
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
      </div>
      <div>
        <h3 class="text-base font-semibold">${message}</h3>
        <p class="mt-1 text-sm text-muted-foreground">This action cannot be undone.</p>
      </div>
    </div>
    <div class="mt-5 flex justify-end gap-2">
      <button type="button" class="btn btn-outline" id="confirm-cancel">Cancel</button>
      <button type="button" class="btn btn-destructive" id="confirm-ok">${okLabel}</button>
    </div>
  `);
  $("#confirm-cancel").addEventListener("click", closeDialog);
  $("#confirm-ok").addEventListener("click", async () => {
    closeDialog();
    await onOk();
  });
}

function applyTheme(theme) {
  localStorage.setItem("theme", theme);
  document.documentElement.classList.toggle("dark", theme === "dark");
  syncThemeUI();
}

function syncThemeUI() {
  const dark = document.documentElement.classList.contains("dark");
  $("#icon-moon")?.classList.toggle("hidden", !dark);
  $("#icon-sun")?.classList.toggle("hidden", dark);
  $("#sb-icon-moon")?.classList.toggle("hidden", !dark);
  $("#sb-icon-sun")?.classList.toggle("hidden", dark);
  const label = $("#theme-label");
  if (label) label.textContent = dark ? "Dark mode" : "Light mode";
}

function setRoute(h) {
  try {
    history.replaceState(null, "", h);
  } catch (e) {}
}

function currentRouteSegs() {
  return location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
}

async function switchView(name) {
  // View-only accounts are limited to Dashboard, Notes & Pages
  if (state.user?.role === "user" && ["tasks", "schedule", "calendar", "settings"].includes(name)) {
    name = "dashboard";
    toast("Your account can only view Dashboard, Notes & Pages", "info");
  }
  state.view = name;
  if (name !== "pages" && !$("#notes-editor-wrap").classList.contains("hidden")) {
    // Leaving while an editor is open: wait for pending changes to reach the
    // server BEFORE the target view refetches, so fresh data is guaranteed.
    await flushPendingSave();
    hideImgToolbar();
    hideColHandle();
    setEditorOverlay(false);
    $("#notes-editor-wrap").classList.add("hidden");
  }
  if (name !== "pages") {
    state.returnTo = null;
    state.currentPageId = null;
  }
  switchViewShell(name);
  setRoute("#/" + name);
  document.body.classList.remove("sidebar-open");
  if (name === "dashboard") loadDashboard();
  else if (name === "tasks") loadTasks();
  else if (name === "notes") showNotesList();
  else if (name === "pages") showPagesList();
  else if (name === "schedule") loadSchedule();
  else if (name === "calendar") {
    HOLIDAYS = buildHolidaysForYear(state.calY);
    renderCalendar();
  }
}

function switchViewShell(name) {
  $$(".view").forEach((v) => v.classList.add("hidden"));
  $(`#view-${name}`)?.classList.remove("hidden");
  $$(".nav-link").forEach((n) => n.classList.toggle("active", n.dataset.view === name));
  $("#page-title").textContent = VIEW_TITLES[name] || name;
  document.body.classList.remove("sidebar-open");
}

function loadAll() {
  invalidateSearchIndex();
  return Promise.all([
    api("/api/tasks").then((d) => (state.tasks = d)),
    api("/api/notes").then((d) => (state.notes = d)),
    api("/api/pages").then((d) => (state.pages = d)),
    api("/api/routines").then((d) => (state.routines = d)),
  ]);
}

let selectedEditorImg = null;
let colResizeCtx = null;
let savedRange = null;

function saveSelection() {
  const sel = window.getSelection();
  if (sel.rangeCount > 0 && $("#note-content-input")?.contains(sel.getRangeAt(0).commonAncestorContainer)) {
    savedRange = sel.getRangeAt(0).cloneRange();
  }
}

function restoreSelection() {
  if (!savedRange) return;
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(savedRange);
}

function exec(cmd, val = null) {
  const ed = $("#note-content-input");
  const sel = window.getSelection();
  if (!(sel.anchorNode && ed.contains(sel.anchorNode))) restoreSelection();
  if (!ed.contains(window.getSelection().anchorNode)) return;
  ed.focus({ preventScroll: true });
  if (cmd === "foreColor" || cmd === "hiliteColor" || cmd === "fontName" || cmd === "fontSize") {
    try { document.execCommand("styleWithCSS", false, true); } catch (err) {}
  }
  document.execCommand(cmd, false, val);
  markDirty();
  syncToolbarState();
}

function currentNote() {
  return state.notes.find((n) => n.id === state.editingId) || null;
}

function markDirty() {
  const st = $("#save-state");
  st.textContent = "Saving...";
  clearTimeout(markDirty._t);
  markDirty._t = setTimeout(() => {
    markDirty._t = null;
    saveNote();
  }, 1200);
}

// Flush any pending autosave exactly once, then clear the handle so stale
// timers can never fire saveNote again after the editor context is gone.
// Returns the save promise so callers can wait for the server write to land.
function flushPendingSave() {
  if (!markDirty._t) return Promise.resolve();
  clearTimeout(markDirty._t);
  markDirty._t = null;
  return saveNote();
}

// Flush pending autosave when the tab is hidden/closed so no keystrokes are lost
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushPendingSave();
});
window.addEventListener("beforeunload", (e) => {
  if (markDirty._t) {
    flushPendingSave();
    e.preventDefault();
    e.returnValue = "";
  }
});

async function saveNote() {
  const doc = currentNote();
  const title = ($("#note-title-input").value || "").trim() || "Untitled";
  const content = $("#note-content-input").innerHTML;
  const body = { title, content, tags: $("#note-tags-input").value };
  try {
    let saved;
    if (doc) {
      saved = await api(`/api/notes/${doc.id}`, { method: "PUT", body: JSON.stringify(body) });
      Object.assign(doc, saved);
    } else {
      // Safety guard: never create a new note from a stale autosave fired
      // after the editor has already been closed.
      if ($("#editor-overlay")?.classList.contains("hidden")) {
        $("#save-state").textContent = "";
        return;
      }
      saved = await api("/api/notes", { method: "POST", body: JSON.stringify(body) });
      state.notes.unshift(saved);
      state.editingId = saved.id;
    }
    invalidateSearchIndex();
    $("#save-state").textContent = `Saved ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  } catch (e) {
    $("#save-state").textContent = "";
    toast(e.message, "error");
  }
}

function parkEditor(dest = "notes") {
  // Editor lives permanently inside the fixed overlay; parking is a no-op.
}

function setEditorOverlay(open) {
  const ov = $("#editor-overlay");
  if (!ov) return;
  ov.classList.toggle("hidden", !open);
  ov.classList.toggle("flex", open);
  $("#notes-editor-wrap")?.classList.toggle("hidden", !open);
}

function openEditor(id, kind = "note") {
  if (!requireWrite("edit notes")) return;
  state.editorKind = kind;
  state.editingId = id;
  const doc = id ? currentNote() : null;
  $("#note-title-input").value = doc ? doc.title : "";
  $("#note-title-input").placeholder = "Untitled note";
  $("#note-tags-input").value = doc ? doc.tags : "";
  $("#note-content-input").innerHTML = doc ? doc.content : "";
  updatePinBtn();
  $("#save-state").textContent = "";
  $("#notes-list-wrap").classList.add("hidden");
  $("#note-viewer-wrap")?.classList.add("hidden");
  setEditorOverlay(true);
  setTimeout(() => $("#note-title-input").focus(), 40);
  setRoute(id ? "#/notes/" + id : "#/notes");
}

async function exitToNotesList() {
  await flushPendingSave();
  hideImgToolbar();
  hideColHandle();
  const backToPage = state.returnTo === "page" && state.currentPageId;
  state.editingId = null;
  state.editorKind = "note";
  state.returnTo = null;
  setEditorOverlay(false);
  $("#notes-editor-wrap").classList.add("hidden");
  $("#note-viewer-wrap").classList.add("hidden");
  if (backToPage) {
    switchViewShell("pages");
    state.view = "pages";
    renderPageDetail();
    setRoute("#/pages/" + backToPage);
    return;
  }
  $("#notes-list-wrap").classList.remove("hidden");
  renderNotesGrid();
  renderTagsBar();
  setRoute("#/notes");
}

function updatePinBtn() {
  const note = currentNote();
  const pinned = note ? !!note.pinned : false;
  $("#pin-toggle-btn").style.color = pinned ? "hsl(45 93% 47%)" : "";
  $("#pin-toggle-btn").title = pinned ? "Unpin note" : "Pin note";
}

function showNotesList() {
  if (state.view !== "notes" || !$("#notes-editor-wrap").classList.contains("hidden")) {
    switchViewRaw();
  }
  loadNotes();
}

function switchViewRaw() {
  $$(".view").forEach((v) => v.classList.add("hidden"));
  $(`#view-notes`).classList.remove("hidden");
  $$(".nav-link").forEach((n) => n.classList.toggle("active", n.dataset.view === "notes"));
  $("#page-title").textContent = "Notes";
  setEditorOverlay(false);
  $("#notes-editor-wrap").classList.add("hidden");
  $("#note-viewer-wrap").classList.add("hidden");
  $("#notes-list-wrap").classList.remove("hidden");
}

async function loadNotes() {
  // Always pull fresh data from the server whenever Notes opens
  const grid = $("#notes-grid");
  if (grid && !state.noteQuery.trim() && !state.activeTag) {
    grid.innerHTML = `<div class="col-span-full py-12 text-center text-sm text-muted-foreground">Loading notes…</div>`;
  }
  try {
    state.notes = await api("/api/notes");
    invalidateSearchIndex();
  } catch (e) {
    toast(e.message, "error");
  }
  renderTagsBar();
  renderNotesGrid();
}

async function showPagesList() {
  try {
    state.pages = await api("/api/pages");
  } catch (e) {
    toast(e.message, "error");
  }
  invalidateSearchIndex();
  state.currentPageId = null;
  $("#page-detail-wrap").classList.add("hidden");
  $("#pages-list-wrap").classList.remove("hidden");
  renderPagesGrid();
  setRoute("#/pages");
}

function pageName(id) {
  if (!id) return "";
  const p = state.pages.find((x) => x.id === id);
  if (!p) return "";
  const icon = isVectorIcon(p.icon) ? "▣" : (p.icon || "📄");
  return `${icon} ${p.title}`.trim();
}

function renderPagesGrid() {
  const grid = $("#pages-grid");
  $("#pages-count-badge").textContent = state.pages.length;
  if (!state.pages.length) {
    grid.innerHTML = `
      <div class="col-span-full flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-16 text-center">
        <p class="text-sm font-medium">No pages yet</p>
        <p class="mt-1 text-xs text-muted-foreground">Create a page for a project and keep its notes and tasks together</p>
      </div>`;
    return;
  }
  grid.innerHTML = state.pages
    .map((p) => {
      const nNotes = state.notes.filter((x) => x.page_id === p.id).length;
      const nTasks = state.tasks.filter((x) => x.page_id === p.id).length;
      return `
      <div class="card group cursor-pointer p-4 transition-shadow hover:shadow-md" data-page="${p.id}">
        <div class="flex items-start gap-3">
          <div class="flex shrink-0 items-center justify-center text-2xl leading-none">${pageIconHTML(p.icon, isVectorIcon(p.icon) ? "h-6 w-6" : "")}</div>
          <div class="min-w-0 flex-1 pt-0.5">
            <h4 class="truncate text-sm font-semibold">${escapeHtml(p.title)}</h4>
            <p class="mt-0.5 text-[11px] text-muted-foreground">${nNotes} note${nNotes === 1 ? "" : "s"} · ${nTasks} task${nTasks === 1 ? "" : "s"}</p>
          </div>
        </div>
        <div class="mt-3 flex items-center">
          <span class="text-[10px] text-muted-foreground">${relTime(p.updated_at)}</span>
          <div class="ml-auto hidden items-center gap-1 group-hover:flex">
            <button class="tool-btn h-7 min-w-7 hover:text-destructive" data-pact="del" title="Delete"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg></button>
          </div>
        </div>
      </div>`;
    })
    .join("");
}

// ---------- Emoji icon picker ----------

const EMOJI_GROUPS = [
  { name: "Popular", icons: ["🚀","🎯","💡","🔥","⚡","📊","📈","🗂️","🧠","🌱","🎨","🧩","📌","🏆","💼","📚","🗓️","✅","🔍","💬","🤝","⚙️","🛠️","🔒","☕","🌈","🧭","🪴","💎","🔔"] },
  { name: "Smileys", icons: ["😀","😃","😄","😁","😆","😅","🤣","😊","🙂","😉","😍","🥰","😘","🤔","🤗","🤩","😎","🥳","😴","🤯","🫡","😇"] },
  { name: "Work", icons: ["💼","📈","📊","🗂️","📁","📂","🗓️","📅","⏰","⏳","📌","📎","🖇️","✂️","🖊️","📝","📋","🖥️","💻","⌨️","🖱️","🗄️"] },
  { name: "Study", icons: ["📚","📖","📗","📘","📙","📕","📓","📔","📒","✏️","🎓","🏫","🔤","🔢","🧮","🔬","🔭","🧪","🧫","🧬","🌐","🗺️"] },
  { name: "Objects", icons: ["🔑","🗝️","🔒","🔓","🔨","🛠️","⚙️","🧲","💎","🔮","🕯️","💡","🔦","🏮","📦","🎁","🎈","🏷️","🧧","💰","💳","🧾"] },
  { name: "Tech", icons: ["📱","☎️","📞","📟","📠","🔋","🔌","💾","💿","📀","🛰️","📷","📹","🎥","📺","📻","🎙️","🎧","🎮","🕹️","🤖","🛸"] },
  { name: "Food", icons: ["🍎","🍏","🍐","🍊","🍋","🍌","🍉","🍇","🍓","🫐","🍒","🍑","🥭","🍍","🥥","🥝","🍅","🥑","🌽","🍕","🍔","☕"] },
  { name: "Travel", icons: ["✈️","🚀","🛫","🚁","🚂","🚗","🚕","🚌","🏍️","🚲","⛵","🚢","🏔️","🌋","🏝️","🏖️","🏕️","🗼","🗽","🕌","🎡","🎢"] },
  { name: "Nature", icons: ["🌱","🌿","☘️","🍀","🌵","🌴","🌲","🌳","🌸","🌺","🌻","🌼","🌷","🍁","🍂","🌊","🔥","🌙","☀️","⛅","❄️","🌈"] },
  { name: "Symbols", icons: ["✅","☑️","✔️","❌","❎","⚠️","🚫","⛔","❓","❗","💯","🔴","🟠","🟡","🟢","🔵","🟣","⚫","⚪","♻️","🔱","⚜️"] },
  { name: "Hearts", icons: ["❤️","🧡","💛","💚","💙","💜","🖤","🤍","🤎","💕","💞","💓","💗","💖","💘","💝","💟","♥️","💔","❣️","🫶","💐"] },
  { name: "Activities", icons: ["⚽","🏀","🏈","⚾","🎾","🏐","🏓","🏸","🥊","🎯","🎲","♟️","🎨","🎭","🎬","🎤","🎵","🎸","🏆","🥇","🏅","🎖️"] },
];

const DEFAULT_PAGE_ICONS = ["📄", "🚀", "🎯", "💡", "🔥", "⭐", "🧠", "📈", "🗂️", "💼", "🏠", "🌱", "🎨", "⚡", "🧩", "📘"];

const ICON_RECENT_KEY = "recentIcons";

const LUCIDE_PREFIX = "lucide:";
const COREUI_PREFIX = "coreui:";

function isLucideIcon(v) {
  return typeof v === "string" && v.startsWith(LUCIDE_PREFIX) && window.LUCIDE_ICONS && !!window.LUCIDE_ICONS[v.slice(LUCIDE_PREFIX.length)];
}

function isCoreIcon(v) {
  return typeof v === "string" && v.startsWith(COREUI_PREFIX) && window.COREUI_ICONS && !!window.COREUI_ICONS[v.slice(COREUI_PREFIX.length)];
}

function isVectorIcon(v) {
  return isLucideIcon(v) || isCoreIcon(v);
}

const VECTOR_SVG_ATTRS = {
  lucide: 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"',
  coreui: 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" fill="currentColor"',
};

function vectorSVG(kind, inner, cls) {
  return `<svg ${VECTOR_SVG_ATTRS[kind]}${cls ? ` class="${cls}"` : ""}>${inner}</svg>`;
}

function pageIconHTML(icon, cls) {
  if (isLucideIcon(icon)) {
    return vectorSVG("lucide", window.LUCIDE_ICONS[icon.slice(LUCIDE_PREFIX.length)], cls);
  }
  if (isCoreIcon(icon)) {
    const n = icon.slice(COREUI_PREFIX.length);
    const vb = (window.COREUI_VB && window.COREUI_VB[n]) || "0 0 512 512";
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" fill="currentColor"${cls ? ` class="${cls}"` : ""}>${window.COREUI_ICONS[n]}</svg>`;
  }
  return escapeHtml(icon || "📄");
}

function getRecentIcons() {
  try {
    const v = JSON.parse(localStorage.getItem(ICON_RECENT_KEY));
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch (e) {
    return [];
  }
}

function pushRecentIcon(em) {
  if (!em) return;
  try {
    const r = getRecentIcons().filter((x) => x !== em);
    r.unshift(em);
    localStorage.setItem(ICON_RECENT_KEY, JSON.stringify(r.slice(0, 12)));
  } catch (e) {}
}

function lucideIconNames() {
  return window.LUCIDE_ICONS ? Object.keys(window.LUCIDE_ICONS) : [];
}

function coreuiKeys(rx) {
  return window.COREUI_ICONS
    ? Object.keys(window.COREUI_ICONS)
        .filter((n) => rx.test(n))
        .map((n) => COREUI_PREFIX + n)
    : [];
}

const COREUI_SETS = [
  { cat: "CoreUI", rx: /^cil-/ },
  { cat: "Brand", rx: /^cib-/ },
  { cat: "Flags", rx: /^cif-/ },
];

function iconPickerGridHTML(cat, query) {
  let icons = [];
  const coreSet = COREUI_SETS.find((s) => s.cat === cat);
  if (query.trim()) {
    const q = query.toLowerCase();
    EMOJI_GROUPS.forEach((g) => {
      if (g.name.toLowerCase().includes(q)) icons = icons.concat(g.icons);
    });
    icons = icons.concat(lucideIconNames().filter((n) => n.includes(q)).map((n) => LUCIDE_PREFIX + n));
    if (window.COREUI_ICONS) {
      icons = icons.concat(Object.keys(window.COREUI_ICONS).filter((n) => n.includes(q)).map((n) => COREUI_PREFIX + n));
    }
  } else if (cat === "Recent") {
    icons = getRecentIcons();
  } else if (cat === "All") {
    icons = EMOJI_GROUPS.flatMap((x) => x.icons).concat(lucideIconNames().map((n) => LUCIDE_PREFIX + n));
  } else if (cat === "Lucide") {
    icons = lucideIconNames().map((n) => LUCIDE_PREFIX + n);
  } else if (coreSet) {
    icons = coreuiKeys(coreSet.rx);
  } else {
    const g = EMOJI_GROUPS.find((x) => x.name === cat);
    icons = g ? g.icons : [];
  }
  if (!icons.length) return `<p class="col-span-full py-6 text-center text-xs text-muted-foreground">No icons found</p>`;
  return icons
    .map((em) => `<button type="button" class="emoji-pick flex h-10 w-10 items-center justify-center rounded-lg text-xl hover:bg-accent" data-icon="${em}" title="${escapeHtml(isVectorIcon(em) ? em.slice(em.indexOf(":") + 1) : em)}">${pageIconHTML(em, isVectorIcon(em) ? "h-5 w-5" : "")}</button>`)
    .join("");
}

function buildIconPickerHTML() {
  return `
    <input id="icon-search" type="text" placeholder="Search icons and categories..." class="input" autocomplete="off" />
    <div id="icon-cats" class="mt-3 flex flex-wrap gap-1.5"></div>
    <div id="icon-grid" class="mt-3 grid max-h-[300px] grid-cols-[repeat(auto-fill,minmax(42px,1fr))] gap-1 overflow-y-auto pr-1"></div>
    <button type="button" id="icon-remove-btn" class="mt-3 w-full rounded-md border border-border px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-destructive">Remove icon</button>
  `;
}

function bindIconPicker(root, onSelect) {
  let cat = "All";
  let query = "";
  const recents = getRecentIcons();
  const cats = ["All", ...(recents.length ? ["Recent"] : []), ...EMOJI_GROUPS.map((g) => g.name), "Lucide", ...COREUI_SETS.map((s) => s.cat)];
  const catsBox = root.querySelector("#icon-cats");
  const grid = root.querySelector("#icon-grid");

  const renderCats = () => {
    catsBox.innerHTML = cats
      .map((c) => `<button type="button" class="day-chip ${c === cat ? "active" : ""}" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</button>`)
      .join("");
    catsBox.querySelectorAll("[data-cat]").forEach((b) =>
      b.addEventListener("click", () => {
        cat = b.dataset.cat;
        query = "";
        root.querySelector("#icon-search").value = "";
        renderCats();
        renderGrid();
      })
    );
  };
  const renderGrid = () => {
    grid.innerHTML = iconPickerGridHTML(cat, query);
    grid.querySelectorAll("[data-icon]").forEach((b) =>
      b.addEventListener("click", () => {
        pushRecentIcon(b.dataset.icon);
        onSelect(b.dataset.icon);
      })
    );
  };
  root.querySelector("#icon-search").addEventListener("input", (e) => {
    query = e.target.value;
    renderGrid();
  });
  root.querySelector("#icon-remove-btn").addEventListener("click", () => onSelect(""));
  renderCats();
  renderGrid();
}

function openIconPickerDialog(onSelect) {
  openDialog(`
    <div class="flex items-center justify-between">
      <h2 class="text-lg font-semibold">Choose an icon</h2>
      <button type="button" class="btn btn-ghost btn-icon" data-close-x>✕</button>
    </div>
    <div id="icon-picker-root" class="mt-4">${buildIconPickerHTML()}</div>
  `);
  $("#dialog-root [data-close-x]").addEventListener("click", closeDialog);
  bindIconPicker($("#icon-picker-root"), (em) => {
    closeDialog();
    onSelect(em);
  });
}

// ---------- Create page dialog ----------

function pageCreateDialog() {
  if (!requireWrite("create pages")) return;
  let icon = DEFAULT_PAGE_ICONS[Math.floor(Math.random() * DEFAULT_PAGE_ICONS.length)];
  openDialog(`
    <h2 class="text-lg font-semibold">Create a new page</h2>
    <p class="mt-1 text-sm text-muted-foreground">Pick an icon and give it a title - then add notes and tasks inside.</p>
    <form id="page-create-form" class="mt-5 space-y-4">
      <div class="flex items-center gap-4">
        <button type="button" id="create-icon-btn" class="flex h-16 w-16 shrink-0 items-center justify-center text-3xl" title="Choose icon">${pageIconHTML(icon)}</button>
        <div class="min-w-0 flex-1 space-y-1.5">
          <label class="text-sm font-medium">Page title</label>
          <input id="create-page-title" type="text" class="input" placeholder="e.g. University Project" autocomplete="off" />
        </div>
      </div>
      <div id="create-icon-picker" class="hidden rounded-lg border border-border p-3">${buildIconPickerHTML()}</div>
      <div class="flex justify-end gap-2">
        <button type="button" class="btn btn-outline" data-cancel-dialog>Cancel</button>
        <button type="submit" class="btn btn-primary">Create page</button>
      </div>
    </form>
  `);
  $("#page-create-form [data-cancel-dialog]").addEventListener("click", closeDialog);
  const iconBtn = $("#create-icon-btn");
  const pickerWrap = $("#create-icon-picker");
  iconBtn.addEventListener("click", () => {
    if (pickerWrap.classList.contains("hidden")) {
      pickerWrap.classList.remove("hidden");
      if (!pickerWrap.dataset.bound) {
        pickerWrap.dataset.bound = "1";
        bindIconPicker(pickerWrap, (em) => {
          icon = em || "📄";
          iconBtn.innerHTML = pageIconHTML(icon);
          pickerWrap.classList.add("hidden");
        });
      }
    } else {
      pickerWrap.classList.add("hidden");
    }
  });
  $("#page-create-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = $("#create-page-title").value.trim() || "Untitled";
    try {
      const created = await api("/api/pages", { method: "POST", body: JSON.stringify({ title, icon }) });
      state.pages.unshift(created);
      closeDialog();
      toast("Page created");
      showPageDetail(created.id);
    } catch (err) {
      toast(err.message, "error");
    }
  });
  setTimeout(() => $("#create-page-title").focus(), 40);
}

// ---------- Auth: login/register screen, user menu, profile dialogs ----------

function initialsOf(name) {
  return (name || "U")
    .trim()
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function updateUserChip(u) {
  if (!u) return;
  $("#user-avatar").textContent = initialsOf(u.display_name);
  $("#user-name").textContent = u.display_name;
  $("#user-role").textContent = u.role;
  $("#menu-display-name").textContent = u.display_name;
  $("#menu-username").textContent = "@" + u.username;
  const rb = $("#menu-role-badge");
  rb.textContent = u.role;
  rb.className = `role-badge mt-1 inline-block ${u.role}`;
  if (u.role === "admin") $("#menu-manage-users").classList.remove("hidden");
  $("#user-menu-btn").classList.remove("hidden");
}

function showAuthScreen() {
  $("#auth-overlay").classList.remove("hidden");
  const err = (formSel, msg) => {
    const el = $(`${formSel} .auth-error`);
    el.textContent = msg;
    el.classList.remove("hidden");
  };
  const switchTab = (which) => {
    $("#auth-tab-login").classList.toggle("active", which === "login");
    $("#auth-tab-register").classList.toggle("active", which === "register");
    $("#auth-form-login").classList.toggle("hidden", which !== "login");
    $("#auth-form-register").classList.toggle("hidden", which !== "register");
  };
  $("#auth-tab-login").addEventListener("click", () => switchTab("login"));
  $("#auth-tab-register").addEventListener("click", () => switchTab("register"));

  $("#auth-form-login").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      state.user = await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          username: $("#login-username").value,
          password: $("#login-password").value,
        }),
      });
      afterAuthSuccess();
    } catch (err) {
      err("#auth-form-login", err.message);
    }
  });

  $("#auth-form-register").addEventListener("submit", async (e) => {
    e.preventDefault();
    if ($("#reg-password").value !== $("#reg-confirm").value) {
      return err("#auth-form-register", "Passwords do not match");
    }
    try {
      state.user = await api("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({
          display_name: $("#reg-display-name").value,
          username: $("#reg-username").value,
          password: $("#reg-password").value,
        }),
      });
      afterAuthSuccess();
    } catch (err) {
      err("#auth-form-register", err.message);
    }
  });
}

let appStarted = false;
function afterAuthSuccess() {
  $("#auth-overlay").classList.add("hidden");
  if (!appStarted) initApp();
}

// ---------- Role helpers ----------
// user = view only · manager = add/edit · admin = full access incl. delete
function canWrite() {
  return !!state.user && (state.user.role === "admin" || state.user.role === "manager");
}
function isAdminUser() {
  return !!state.user && state.user.role === "admin";
}
function requireWrite(what = "make changes") {
  if (canWrite()) return true;
  toast(`Your account (${state.user?.role}) cannot ${what} — view only`, "error");
  return false;
}

function applyRoleUI() {
  const w = canWrite();
  ["#tasks-add-btn", "#sched-add-btn", "#notes-add-btn", "#pages-add-btn", "#viewer-edit-btn"].forEach((sel) => {
    const el = $(sel);
    if (el) el.classList.toggle("hidden", !w);
  });
  // Destructive / replace-all operations are admin-only
  ["#reset-btn", "#import-btn", "#import-sqlite-btn", "#import-excel-btn"].forEach((sel) => {
    const el = $(sel);
    if (el) el.classList.toggle("hidden", !isAdminUser());
  });
  // View-only users see only Dashboard, Notes & Pages
  const restricted = new Set(["tasks", "schedule", "calendar", "settings"]);
  const isViewer = state.user?.role === "user";
  $$(".nav-link").forEach((n) => {
    if (restricted.has(n.dataset.view)) n.classList.toggle("hidden", isViewer);
  });
  if (isViewer && restricted.has(state.view)) {
    switchView("dashboard");
  }
}

async function boot() {
  try {
    const res = await fetch("/api/auth/me");
    if (!res.ok) throw new Error("unauthenticated");
    state.user = await res.json();
  } catch (e) {
    showAuthScreen();
    return;
  }
  initApp();
}

function wireUserMenu() {
  updateUserChip(state.user);
  const btn = $("#user-menu-btn");
  const menu = $("#user-menu");
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.classList.toggle("hidden");
  });
  document.addEventListener("click", (e) => {
    if (!menu.classList.contains("hidden") && !btn.contains(e.target) && !menu.contains(e.target)) {
      menu.classList.add("hidden");
    }
  });
  menu.querySelectorAll("[data-uact]").forEach((b) =>
    b.addEventListener("click", async () => {
      menu.classList.add("hidden");
      const act = b.dataset.uact;
      if (act === "profile") profileDialog();
      else if (act === "password") passwordDialog();
      else if (act === "users") usersDialog();
      else if (act === "logout") {
        try {
          await api("/api/auth/logout", { method: "POST" });
        } catch (e) {}
        location.reload();
      }
    })
  );
}

function profileDialog() {
  const u = state.user;
  openDialog(`
    <h2 class="text-lg font-semibold">My Profile</h2>
    <div class="mt-4 flex items-center gap-3 rounded-xl border border-border p-3">
      <span class="user-avatar" style="width:44px;height:44px;font-size:16px;">${initialsOf(u.display_name)}</span>
      <div class="min-w-0">
        <p class="truncate text-sm font-semibold">${escapeHtml(u.display_name)}</p>
        <p class="text-xs text-muted-foreground">@${escapeHtml(u.username)} · Member since ${fmtStampFull(u.created_at)}</p>
        <span class="role-badge ${u.role} mt-1 inline-block">${u.role}</span>
      </div>
    </div>
    <div class="mt-4 space-y-3">
      <label class="block text-xs font-semibold">Display name
        <input id="pf-display" class="input mt-1 w-full" maxlength="60" value="${escapeHtml(u.display_name)}" />
      </label>
      <label class="block text-xs font-semibold">Username
        <input id="pf-username" class="input mt-1 w-full" value="${escapeHtml(u.username)}" />
      </label>
      <p class="text-[11px] text-muted-foreground">Role changes are managed by an admin.</p>
    </div>
    <div class="mt-5 flex justify-end gap-2">
      <button type="button" class="btn btn-secondary" data-cancel-dialog>Cancel</button>
      <button type="button" class="btn btn-primary" id="pf-save">Save Changes</button>
    </div>
  `);
  $("[data-cancel-dialog]").addEventListener("click", closeDialog);
  $("#pf-save").addEventListener("click", async () => {
    try {
      state.user = await api("/api/auth/profile", {
        method: "PUT",
        body: JSON.stringify({ display_name: $("#pf-display").value, username: $("#pf-username").value }),
      });
      updateUserChip(state.user);
      closeDialog();
      toast("Profile updated");
    } catch (e) {
      toast(e.message, "error");
    }
  });
}

function passwordDialog() {
  openDialog(`
    <h2 class="text-lg font-semibold">Change Password</h2>
    <div class="mt-4 space-y-3">
      <label class="block text-xs font-semibold">Current password
        <input id="pw-current" type="password" class="input mt-1 w-full" autocomplete="current-password" />
      </label>
      <label class="block text-xs font-semibold">New password
        <input id="pw-new" type="password" class="input mt-1 w-full" autocomplete="new-password" placeholder="At least 6 characters" />
      </label>
      <label class="block text-xs font-semibold">Confirm new password
        <input id="pw-confirm" type="password" class="input mt-1 w-full" autocomplete="new-password" />
      </label>
    </div>
    <div class="mt-5 flex justify-end gap-2">
      <button type="button" class="btn btn-secondary" data-cancel-dialog>Cancel</button>
      <button type="button" class="btn btn-primary" id="pw-save">Update Password</button>
    </div>
  `);
  $("[data-cancel-dialog]").addEventListener("click", closeDialog);
  $("#pw-save").addEventListener("click", async () => {
    if ($("#pw-new").value !== $("#pw-confirm").value) return toast("New passwords do not match", "error");
    try {
      await api("/api/auth/password", {
        method: "PUT",
        body: JSON.stringify({ current_password: $("#pw-current").value, new_password: $("#pw-new").value }),
      });
      closeDialog();
      toast("Password updated");
    } catch (e) {
      toast(e.message, "error");
    }
  });
}

async function usersDialog() {
  let users = [];
  try {
    users = await api("/api/auth/users");
  } catch (e) {
    return toast(e.message, "error");
  }
  const rows = users
    .map(
      (u) => `
      <tr data-uid="${u.id}">
        <td class="py-2 pr-2">
          <p class="text-sm font-medium">${escapeHtml(u.display_name)} ${u.id === state.user.id ? '<span class="text-[10px] text-muted-foreground">(you)</span>' : ""}</p>
          <p class="text-[11px] text-muted-foreground">@${escapeHtml(u.username)}</p>
        </td>
        <td class="py-2 pr-2 text-xs">${fmtStampShort(u.created_at)}</td>
        <td class="py-2 pr-2">
          <select class="input h-8 w-28 text-xs" data-role-select ${u.id === state.user.id ? "disabled title='You cannot change your own role'" : ""}>
            <option value="user" ${u.role === "user" ? "selected" : ""}>User (view only)</option>
            <option value="manager" ${u.role === "manager" ? "selected" : ""}>Manager</option>
            <option value="admin" ${u.role === "admin" ? "selected" : ""}>Admin</option>
          </select>
        </td>
        <td class="py-2 text-right">
          <button class="tool-btn h-7 min-w-7 hover:text-destructive" data-del-user title="Delete user" ${u.id === state.user.id ? "disabled style='opacity:.35;cursor:not-allowed'" : ""}>
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4v4"/></svg>
          </button>
        </td>
      </tr>`
    )
    .join("");
  openDialog(`
    <h2 class="text-lg font-semibold">Manage Users</h2>
    <p class="mt-0.5 text-xs text-muted-foreground">Admins can change roles and remove accounts. Data is shared across all users.</p>
    <div class="mt-4 max-h-[50vh] overflow-y-auto">
      <table class="w-full">
        <thead><tr class="border-b border-border text-left text-[10px] uppercase tracking-wide text-muted-foreground"><th class="pb-2 pr-2">Account</th><th class="pb-2 pr-2">Joined</th><th class="pb-2 pr-2">Role</th><th></th></tr></thead>
        <tbody class="divide-y divide-border">${rows}</tbody>
      </table>
    </div>
    <div class="mt-5 flex justify-end">
      <button type="button" class="btn btn-secondary" data-cancel-dialog>Close</button>
    </div>
  `);
  $("[data-cancel-dialog]").addEventListener("click", closeDialog);
  $$("#dialog-root [data-role-select]").forEach((sel) =>
    sel.addEventListener("change", async () => {
      const uid = Number(sel.closest("tr").dataset.uid);
      try {
        await api(`/api/auth/users/${uid}`, { method: "PATCH", body: JSON.stringify({ role: sel.value }) });
        toast("Role updated");
        if (uid === state.user.id) {
          state.user.role = sel.value;
          updateUserChip(state.user);
          applyRoleUI();
        }
      } catch (e) {
        toast(e.message, "error");
        usersDialog();
      }
    })
  );
  $$("#dialog-root [data-del-user]").forEach((b) =>
    b.addEventListener("click", () => {
      const tr = b.closest("tr");
      const uid = Number(tr.dataset.uid);
      confirmDialog(`Delete user "@${tr.querySelector("p").textContent.replace(" (you)", "")}"?`, async () => {
        try {
          await api(`/api/auth/users/${uid}`, { method: "DELETE" });
          toast("User deleted");
          usersDialog();
        } catch (e) {
          toast(e.message, "error");
        }
      }, "Delete");
    })
  );
}

// ---------- Quick search palette (Ctrl+P) ----------

let palItems = [];
let palSel = 0;

function palCandidates() {
  const out = [];
  const strip = (html) => stripHtml(html, 0);
  state.pages.forEach((p) =>
    out.push({
      kind: "page",
      id: p.id,
      icon: p.icon || "📄",
      title: p.title || "Untitled",
      sub: `Page · ${state.notes.filter((x) => x.page_id === p.id).length} notes · updated ${relTime(p.updated_at)}`,
      hay: `${p.title || ""} ${(p.content && strip(p.content)) || ""}`.toLowerCase(),
      raw: `${p.title || ""} ${(p.content && strip(p.content)) || ""}`,
      ts: p.updated_at || "",
    })
  );
  state.notes.forEach((n) => {
    const text = strip(n.content);
    out.push({
      kind: "note",
      id: n.id,
      icon: "📝",
      title: n.title || "Untitled",
      sub: text ? text.slice(0, 90) : n.tags ? `Tags: ${n.tags}` : "Note",
      hay: `${n.title || ""} ${n.tags || ""} ${text}`.toLowerCase(),
      raw: `${n.title || ""} ${text}`,
      pinned: !!n.pinned,
      ts: n.updated_at || "",
    });
  });
  state.tasks.forEach((t) =>
    out.push({
      kind: "task",
      id: t.id,
      icon: t.due_date ? "🔔" : "✅",
      title: t.title,
      sub: t.done ? "Task · completed" : t.due_date ? `Task · due ${fmtDate(t.due_date)}` : "Task",
      hay: t.title.toLowerCase(),
      raw: t.title,
      ts: t.created_at || "",
    })
  );
  state.routines.forEach((r) =>
    out.push({
      kind: "routine",
      id: r.id,
      icon: "🔁",
      title: r.title,
      sub: r.time ? `Routine · ${r.time}` : "Routine",
      hay: `${r.title} ${r.time || ""}`.toLowerCase(),
      raw: r.title,
      ts: "",
    })
  );
  return out;
}

const PAL_COMMANDS = [
  { label: "New note", hint: "Create a new note", run: () => { switchView("notes"); openEditor(null, "note"); } },
  { label: "New page", hint: "Create a page workspace", run: () => pageCreateDialog() },
  { label: "New task / reminder", hint: "Add a task", run: () => { switchView("tasks"); setTimeout(() => taskDialog(), 120); } },
  { label: "Toggle dark mode", hint: "Switch theme", run: () => $("#header-theme-toggle").click() },
  { label: "Go to Dashboard", run: () => switchView("dashboard") },
  { label: "Go to Notes", run: () => switchView("notes") },
  { label: "Go to Tasks", run: () => switchView("tasks") },
  { label: "Go to Pages", run: () => switchView("pages") },
  { label: "Go to Schedule", run: () => switchView("schedule") },
  { label: "Go to Calendar", run: () => switchView("calendar") },
];

// fuzzy match q inside lowercased text -> {score, idx, len} or null
function fuzzyMatch(text, q) {
  if (!q) return null;
  let idx = text.indexOf(q);
  if (idx === 0) return { score: 0, idx: 0, len: q.length };
  const wb = (" " + text).indexOf(" " + q);
  if (wb !== -1) return { score: 1, idx: Math.max(0, wb), len: q.length };
  if (idx !== -1) return { score: 2, idx, len: q.length };
  let ti = 0;
  let start = -1;
  for (const ch of q) {
    if (ch === " ") continue;
    const f = text.indexOf(ch, ti);
    if (f === -1) return null;
    if (start === -1) start = f;
    ti = f + 1;
  }
  return { score: 3, idx: start, len: ti - start };
}

// whole-word hit inside text -> {score, idx, len} or null (first matching term wins)
function wbFind(text, q) {
  const terms = q.split(/\s+/).filter(Boolean);
  for (const w of terms) {
    const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    try {
      const m = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").exec(text);
      if (m) return { score: 1, idx: m.index + m[1].length, len: w.length };
    } catch (_) {}
  }
  return null;
}

function palSuggest(cands) {
  const by = (k) => {
    const l = cands.filter((c) => c.kind === k);
    l.sort(
      (a, b) =>
        (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) ||
        String(b.ts || "").localeCompare(String(a.ts || ""))
    );
    return l;
  };
  const lists = [by("page"), by("note"), by("task"), by("routine")].filter((l) => l.length);
  const items = [];
  for (let i = 0; items.length < 8; i++) {
    let added = false;
    for (const l of lists) {
      if (l[i]) {
        items.push(l[i]);
        added = true;
        if (items.length >= 8) break;
      }
    }
    if (!added) break;
  }
  return items;
}

const PAL_LABELS = { action: "Actions", page: "Pages", note: "Notes", task: "Tasks", routine: "Routines" };

function palHL(text, q, m) {
  if (!m || !q) return escapeHtml(text);
  const s = Math.max(0, Math.min(m.idx, text.length));
  const e = Math.min(text.length, s + m.len);
  return `${escapeHtml(text.slice(0, s))}<mark class="rounded bg-primary/20 px-0.5 text-inherit">${escapeHtml(text.slice(s, e))}</mark>${escapeHtml(text.slice(e))}`;
}

function palSnippet(c, q) {
  const base = c.raw || c.sub || "";
  if (!q) return c.sub || "";
  const low = base.toLowerCase();
  const pos = low.indexOf(q);
  if (pos === -1) return c.sub || "";
  const start = Math.max(0, pos - 32);
  let frag = base.slice(start, Math.min(base.length, pos + q.length + 40));
  if (start > 0) frag = "\u2026" + frag;
  return palHL(frag, q, { idx: pos - start, len: q.length });
}

function palRender() {
  const box = $("#palette-results");
  if (!box) return;
  const qRaw = ($("#palette-input").value || "").trim();
  const q = qRaw.toLowerCase();
  const statsEl = document.getElementById("palette-stats");
  if (statsEl) {
    statsEl.textContent = `${state.pages.length} pages · ${state.notes.length} notes · ${state.tasks.length} tasks`;
  }
  const cands = palCandidates();

  let items;
  let actions = [];
  if (q) {
    actions = PAL_COMMANDS.map((c) => ({
      kind: "action",
      icon: "⚡",
      title: c.label,
      sub: c.hint || "Action",
      run: c.run,
      hay: c.label.toLowerCase(),
      ts: "",
    }))
      .map((c) => ({ ...c, m: fuzzyMatch(c.title.toLowerCase(), q) }))
      .filter((c) => c.m)
      .sort((a, b) => a.m.score - b.m.score)
      .slice(0, 4);
    items = cands
      .map((c) => ({ ...c, m: fuzzyMatch(c.title.toLowerCase(), q) || (c.hay.includes(q) ? { score: 4, idx: -1, len: q.length } : null) }))
      .filter((c) => c.m)
      .sort((a, b) => a.m.score - b.m.score)
      .slice(0, 14);
    if (!state.deepSearch) {
      // Normal (whole-word) mode — mirrors the Notes grid search
      const wbItems = cands
        .map((c) => {
          if (!matchesQuery(c.hay, q, false)) return null;
          const hit = wbFind(c.title.toLowerCase(), q);
          return { ...c, m: hit || { score: 5, idx: -1, len: 0 } };
        })
        .filter(Boolean)
        .sort((a, b) => a.m.score - b.m.score)
        .slice(0, 14);
      items = actions.concat(wbItems);
      if (!wbItems.length) {
        box.innerHTML = `<p class="px-3 py-10 text-center text-sm text-muted-foreground">No exact word match for "${escapeHtml(qRaw)}" — enable Deep Search below</p>`;
        return;
      }
    } else {
      items = actions.concat(items);
    }
  } else {
    items = palSuggest(cands);
  }
  palItems = items;
  palSel = 0;
  if (!palItems.length) {
    box.innerHTML = `<p class="px-3 py-10 text-center text-sm text-muted-foreground">No results for "${escapeHtml(qRaw)}"</p>`;
    return;
  }
  let html = "";
  let lastKind = null;
  palItems.forEach((it, i) => {
    if (it.kind !== lastKind) {
      lastKind = it.kind;
      html += `<p class="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">${PAL_LABELS[it.kind]}</p>`;
    }
    html += `
      <button type="button" data-pi="${i}" class="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors ${i === palSel ? "bg-accent" : "hover:bg-accent/60"}">
        <span class="flex shrink-0 items-center justify-center text-base leading-none">${pageIconHTML(it.icon, isVectorIcon(it.icon) ? "h-4 w-4" : "")}</span>
        <span class="min-w-0 flex-1">
          <span class="block truncate text-sm font-medium">${palHL(it.title, q, (!it.m || it.m.idx === -1) ? null : it.m)}</span>
          <span class="block truncate text-[11px] text-muted-foreground">${it.kind === "note" && q ? palSnippet(it, q.toLowerCase()) : escapeHtml(it.sub)}</span>
        </span>
        <span class="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">${it.kind}</span>
      </button>`;
  });
  box.innerHTML = html;
}

function palPaintSel() {
  document.querySelectorAll("#palette-results [data-pi]").forEach((b) => {
    const on = Number(b.dataset.pi) === palSel;
    b.classList.toggle("bg-accent", on);
    if (on) b.scrollIntoView({ block: "nearest" });
  });
}

function palKeydown(e) {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (palItems.length) {
      palSel = Math.min(palSel + 1, palItems.length - 1);
      palPaintSel();
    }
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (palItems.length) {
      palSel = Math.max(palSel - 1, 0);
      palPaintSel();
    }
  } else if (e.key === "Enter") {
    e.preventDefault();
    const it = palItems[palSel];
    if (!it) return;
    if (e.ctrlKey && it.kind === "note") {
      closePalette();
      switchView("notes");
      openEditor(it.id, "note");
    } else {
      palActivate(it);
    }
  } else if (e.key === "Escape") {
    e.preventDefault();
    closePalette();
  }
}

function palActivate(it) {
  if (!it) return;
  closePalette();
  if (it.kind === "action") it.run();
  else if (it.kind === "page") showPageDetail(it.id);
  else if (it.kind === "note") {
    switchView("notes");
    openViewer(it.id);
  } else if (it.kind === "task") switchView("tasks");
  else if (it.kind === "routine") switchView("schedule");
}

function openPalette() {
  if (document.getElementById("palette-overlay")) return;
  const ov = document.createElement("div");
  ov.id = "palette-overlay";
  ov.className = "fixed inset-0 z-[100] flex items-start justify-center bg-black/50 pt-[9vh] backdrop-blur-sm";
  ov.innerHTML = `
    <div id="palette-panel" class="mx-4 w-full max-w-xl overflow-hidden rounded-2xl border border-border bg-popover shadow-2xl">
      <div class="flex items-center gap-3 border-b border-border px-4 py-3.5">
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-muted-foreground"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
        <input id="palette-input" type="text" autocomplete="off" spellcheck="false" placeholder="Search pages, notes, tasks, routines..." class="w-full border-0 bg-transparent p-0 text-base outline-none placeholder:text-muted-foreground/60" />
        <label class="flex shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground" title="Deep: loose matching anywhere inside words — helps with spelling mistakes. Off: whole words only (UTI will not match COMPUTING).">
          <input type="checkbox" id="palette-deep" class="h-3 w-3 cursor-pointer" ${state.deepSearch ? "checked" : ""} />
          Deep
        </label>
        <kbd class="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">ESC</kbd>
      </div>
      <div id="palette-results" class="max-h-[46vh] overflow-y-auto p-2"></div>
      <div class="flex items-center justify-between border-t border-border px-4 py-2 text-[10px] text-muted-foreground">
        <span>↑↓ navigate · Enter open · Ctrl+Enter edit · Esc close</span>
        <span id="palette-stats"></span>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const input = $("#palette-input");
  input.addEventListener("input", palRender);
  input.addEventListener("keydown", palKeydown);
  $("#palette-deep").addEventListener("change", (e) => {
    state.deepSearch = e.target.checked;
    localStorage.setItem("nb_deep_search", e.target.checked ? "1" : "0");
    const gridToggle = $("#deep-search-toggle");
    if (gridToggle) gridToggle.checked = e.target.checked;
    palRender();
    input.focus();
  });
  $("#palette-results").addEventListener("mousedown", (e) => {
    const b = e.target.closest("[data-pi]");
    if (b) {
      e.preventDefault();
      palActivate(palItems[Number(b.dataset.pi)]);
    }
  });
  $("#palette-results").addEventListener("mousemove", (e) => {
    const b = e.target.closest("[data-pi]");
    if (b && Number(b.dataset.pi) !== palSel) {
      palSel = Number(b.dataset.pi);
      palPaintSel();
    }
  });
  ov.addEventListener("mousedown", (e) => {
    if (e.target === ov) closePalette();
  });
  setTimeout(() => input.focus(), 30);
  palRender();
}

function closePalette() {
  document.getElementById("palette-overlay")?.remove();
}

// ---------- Page detail ----------

async function showPageDetail(id) {
  if (!state.pages.some((x) => x.id === id)) {
    try {
      [state.pages, state.notes, state.tasks] = await Promise.all([
        api("/api/pages"),
        api("/api/notes"),
        api("/api/tasks"),
      ]);
    } catch (e) {
      toast(e.message, "error");
      return;
    }
  }
  if (!state.pages.some((p) => p.id === id)) {
    toast("Page not found", "error");
    setRoute("#/pages");
    showPagesList();
    return;
  }
  state.currentPageId = id;
  switchViewShell("pages");
  $("#pages-list-wrap").classList.add("hidden");
  $("#page-detail-wrap").classList.remove("hidden");
  renderPageDetail();
  setRoute("#/pages/" + id);
}

function renderPageDetail() {
  const pid = state.currentPageId;
  const p = state.pages.find((x) => x.id === pid);
  if (!p) return;
  $("#page-icon-btn").innerHTML = pageIconHTML(p.icon);
  $("#page-title-input").value = p.title;
  const notes = state.notes.filter((n) => n.page_id === pid);
  const tasks = state.tasks.filter((t) => t.page_id === pid);
  $("#page-notes-count").textContent = notes.length;
  $("#page-tasks-count").textContent = tasks.length;
  $("#page-meta").textContent = `Created ${fmtDate((p.created_at || "").slice(0, 10))} · Updated ${relTime(p.updated_at)}`;
  $("#page-export-xlsx").href = `/api/pages/${pid}/export.xlsx`;
  renderPageNotes(notes);
  renderPageTasks(tasks);
}

async function setNotePage(nid, pageId) {
  try {
    const updated = await api(`/api/notes/${nid}`, { method: "PUT", body: JSON.stringify({ page_id: pageId }) });
    const n = state.notes.find((x) => x.id === nid);
    if (n) Object.assign(n, updated);
    if ($("#page-detail-wrap").classList.contains("hidden")) {
      renderPagesGrid();
    } else {
      renderPageDetail();
    }
    toast(pageId ? "Note added to page" : "Note removed from page");
  } catch (e) {
    toast(e.message, "error");
  }
}

async function setTaskPage(tid, pageId) {
  try {
    const updated = await api(`/api/tasks/${tid}`, { method: "PATCH", body: JSON.stringify({ page_id: pageId }) });
    const t = state.tasks.find((x) => x.id === tid);
    if (t) Object.assign(t, updated);
    if ($("#page-detail-wrap").classList.contains("hidden")) {
      renderTasks();
    } else {
      renderPageDetail();
    }
    toast(pageId ? "Task added to page" : "Task removed from page");
  } catch (e) {
    toast(e.message, "error");
  }
}

function renderPageNotes(notes) {
  const box = $("#page-notes-list");
  box.innerHTML = notes.length
    ? notes
        .map(
          (n) => `
          <div class="group flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/50" data-pnote="${n.id}">
            <span class="shrink-0 text-base">📄</span>
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-medium">${escapeHtml(n.title)}</p>
              <p class="truncate text-xs text-muted-foreground">${escapeHtml(stripHtml(n.content, 90)) || "Empty note"}</p>
            </div>
            <span class="shrink-0 text-[10px] text-muted-foreground">${relTime(n.updated_at)}</span>
            <div class="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
              <button class="tool-btn h-7 min-w-7" data-pnact="unlink" title="Remove from page"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18.84 12.25l1.72-1.71a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M5.17 11.75l-1.72 1.71a5 5 0 0 0 7.07 7.07l1.72-1.71"/></svg></button>
              <button class="tool-btn h-7 min-w-7 hover:text-destructive" data-pnact="del" title="Delete"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg></button>
            </div>
          </div>`
        )
        .join("")
    : `<p class="px-4 py-8 text-center text-sm text-muted-foreground">No notes on this page yet</p>`;
}

function renderPageTasks(tasks) {
  const box = $("#page-tasks-list");
  box.innerHTML = tasks.length
    ? tasks
        .map(
          (t) => `
          <div class="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/50" data-ptask="${t.id}">
            <button class="flex h-[19px] w-[19px] shrink-0 items-center justify-center rounded border ${t.done ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40 hover:border-primary"}" data-ptoggle="${t.id}">
              ${t.done ? `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>` : ""}
            </button>
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-medium ${t.done ? "line-through text-muted-foreground" : ""}">${escapeHtml(t.title)}</p>
              ${t.description ? `<p class="truncate text-xs text-muted-foreground">${escapeHtml(t.description)}</p>` : ""}
            </div>
            ${priorityBadge(t.priority)}
            ${dueChip(t)}
            <div class="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
              <button class="tool-btn h-7 min-w-7" data-ptact="unlink" title="Remove from page"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18.84 12.25l1.72-1.71a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M5.17 11.75l-1.72 1.71a5 5 0 0 0 7.07 7.07l1.72-1.71"/></svg></button>
              <button class="tool-btn h-7 min-w-7 hover:text-destructive" data-ptact="del" title="Delete"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg></button>
            </div>
          </div>`
        )
        .join("")
    : `<p class="px-4 py-8 text-center text-sm text-muted-foreground">No tasks here yet - add one above</p>`;
}

// ---------- Link existing items to page ----------

function linkExistingDialog(kind) {
  const pid = state.currentPageId;
  if (pid == null) return;
  const isNote = kind === "note";
  let query = "";
  openDialog(`
    <div class="flex items-center justify-between">
      <h2 class="text-lg font-semibold">${isNote ? "Link existing notes" : "Link existing tasks"}</h2>
      <button type="button" class="btn btn-ghost btn-icon" data-close-x>✕</button>
    </div>
    <p class="mt-1 text-xs text-muted-foreground">Click an item to add it to this page. It stays available in its original list too.</p>
    <input id="link-search" type="text" placeholder="Search..." class="input mt-3" autocomplete="off" />
    <div id="link-candidates" class="mt-3 max-h-[320px] space-y-1 overflow-y-auto pr-1"></div>
  `);
  $("#dialog-root [data-close-x]").addEventListener("click", closeDialog);

  const renderCandidates = () => {
    const q = query.toLowerCase();
    const items = (isNote ? state.notes : state.tasks).filter((x) => x.page_id !== pid);
    const filtered = items.filter((x) =>
      !q
        ? true
        : isNote
          ? `${x.title} ${stripHtml(x.content, 500)}`.toLowerCase().includes(q)
          : `${x.title} ${x.description || ""}`.toLowerCase().includes(q)
    );
    const box = $("#link-candidates");
    if (!filtered.length) {
      box.innerHTML = `<p class="py-8 text-center text-sm text-muted-foreground">${items.length ? "Nothing matches your search" : "Everything is already on this page"}</p>`;
      return;
    }
    box.innerHTML = filtered
      .map((x) => {
        const onOther = x.page_id != null && x.page_id !== undefined;
        return `
        <button type="button" class="flex w-full items-center gap-3 rounded-lg border border-border p-2.5 text-left hover:bg-accent" data-link="${x.id}">
          <span class="shrink-0 text-base">${isNote ? "📄" : "☑️"}</span>
          <span class="min-w-0 flex-1 truncate text-sm font-medium">${escapeHtml(x.title)}</span>
          ${onOther ? `<span class="badge badge-secondary max-w-[140px] shrink-0 truncate">${escapeHtml(pageName(x.page_id))}</span>` : ""}
          <span class="shrink-0 text-xs font-semibold text-primary">Add +</span>
        </button>`;
      })
      .join("");
    box.querySelectorAll("[data-link]").forEach((b) =>
      b.addEventListener("click", async () => {
        const iid = Number(b.dataset.link);
        if (isNote) await setNotePage(iid, pid);
        else await setTaskPage(iid, pid);
        renderCandidates();
      })
    );
  };
  $("#link-search").addEventListener("input", (e) => {
    query = e.target.value;
    renderCandidates();
  });
  renderCandidates();
}

function renderTagsBar() {
  const bar = $("#tags-bar");
  const tags = new Map();
  state.notes.forEach((n) =>
    (n.tags || "").split(",").forEach((t) => {
      t = t.trim();
      if (t) tags.set(t.toLowerCase(), t);
    })
  );
  if (!tags.size) {
    bar.classList.add("hidden");
    bar.innerHTML = "";
    return;
  }
  bar.classList.remove("hidden");
  bar.classList.add("flex");
  const chips = [`<button class="day-chip ${!state.activeTag ? "active" : ""}" data-tag="">All</button>`];
  [...tags.entries()].sort((a, b) => a[0].localeCompare(b[0])).forEach(([k, v]) => {
    chips.push(`<button class="day-chip ${state.activeTag === k ? "active" : ""}" data-tag="${escapeHtml(k)}">#${escapeHtml(v)}</button>`);
  });
  bar.innerHTML = chips.join("");
  bar.querySelectorAll("[data-tag]").forEach((b) =>
    b.addEventListener("click", () => {
      state.activeTag = b.dataset.tag;
      renderTagsBar();
      renderNotesGrid();
    })
  );
}

// ---------- Lightweight search index (rebuilt only when data changes) ----------
let SEARCH_INDEX = null;

function buildSearchIndex() {
  const noteMap = new Map();
  state.notes.forEach((n) => {
    noteMap.set(n.id, `${n.title || ""} ${n.tags || ""} ${stripHtml(n.content, 0)}`.toLowerCase());
  });
  const pageMap = new Map();
  state.pages.forEach((p) => {
    pageMap.set(p.id, `${p.title || ""} ${stripHtml(p.content, 0)}`.toLowerCase());
  });
  return { noteMap, pageMap, stamp: `${state.notes.length}:${state.pages.length}` };
}

function getSearchIndex() {
  if (!SEARCH_INDEX) SEARCH_INDEX = buildSearchIndex();
  return SEARCH_INDEX;
}

function invalidateSearchIndex() {
  SEARCH_INDEX = null;
}

// every word of the query must match (AND).
// Normal mode: whole-word match only — "uti" will NOT match "computing".
// Deep mode: substring match anywhere — looser, helps with spelling mistakes.
function matchesQuery(hay, q, deep = false) {
  if (!q) return true;
  return q.split(/\s+/).every((w) => {
    if (!w) return true;
    if (deep) return hay.includes(w);
    const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    try {
      return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(hay);
    } catch (e) {
      return hay.includes(w);
    }
  });
}

function renderNotesGrid() {
  const q = state.noteQuery.trim().toLowerCase();
  const tag = state.activeTag;
  const idx = getSearchIndex();
  let items = state.notes.filter((n) => {
    if (q && !matchesQuery(idx.noteMap.get(n.id) || "", q, state.deepSearch)) return false;
    if (tag && !`#${(n.tags || "").toLowerCase()}#`.includes(`#${tag}#`) && !(n.tags || "").toLowerCase().split(",").map((t) => t.trim()).includes(tag)) return false;
    return true;
  });
  const grid = $("#notes-grid");
  if (!items.length) {
    grid.innerHTML = `
      <div class="col-span-full flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-16 text-center">
        <p class="text-sm font-medium">No notes found</p>
        <p class="mt-1 text-xs text-muted-foreground">${q ? (state.deepSearch ? "Try a different search" : "No exact match — enable Deep Search for looser matching") : tag ? "Try a different tag" : "Click New Note to create your first one"}</p>
      </div>`;
    return;
  }
  grid.innerHTML = items
    .map(
      (n) => `
      <div class="card group cursor-pointer p-4 transition-shadow hover:shadow-md" data-note="${n.id}">
        <div class="flex items-start justify-between gap-2">
          <h4 class="min-w-0 flex-1 truncate text-sm font-semibold">${escapeHtml(n.title)}</h4>
          ${n.pinned ? `<svg class="shrink-0 text-yellow-500" xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>` : ""}
        </div>
        <p class="mt-1 line-clamp-3 min-h-[42px] text-xs leading-relaxed text-muted-foreground">${escapeHtml(stripHtml(n.content)) || "Empty note"}</p>
        <div class="mt-3 flex items-center gap-1.5">
          ${(n.tags || "")
            .split(",")
            .filter((t) => t.trim())
            .slice(0, 3)
            .map((t) => `<span class="rounded-md bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-secondary-foreground">${escapeHtml(t.trim())}</span>`)
            .join("")}
          ${n.page_id ? `<span class="max-w-[110px] truncate rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary" title="In page: ${escapeHtml(pageName(n.page_id))}">${escapeHtml(pageName(n.page_id))}</span>` : ""}
          <span class="ml-auto shrink-0 text-right text-[10px] leading-tight text-muted-foreground" title="Created ${fmtStampFull(n.created_at)}">
            ${relTime(n.updated_at)}<br><span class="opacity-70">Created ${fmtStampShort(n.created_at)}</span>
          </span>
        </div>
        <div class="mt-3 hidden items-center gap-1 border-t border-border pt-2 group-hover:flex">
          <button class="tool-btn h-7 min-w-7" data-act="view" title="View"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg></button>
          ${canWrite() ? `<button class="tool-btn h-7 min-w-7" data-act="edit" title="Edit"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/></svg></button>` : ""}
          ${isAdminUser() ? `<button class="tool-btn h-7 min-w-7 hover:text-destructive" data-act="del" title="Delete"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg></button>` : ""}
        </div>
      </div>`
    )
    .join("");
}

function openViewer(id, from = null) {
  let note = state.notes.find((n) => n.id === id);
  if (!note) {
    // Stale client list — refresh once from the server before giving up
    toast("Loading note...");
    api("/api/notes")
      .then((fresh) => {
        state.notes = fresh;
        if (state.notes.some((n) => n.id === id)) openViewer(id, from);
        else toast("Note not found — it may have been deleted", "error");
      })
      .catch((e) => toast(e.message, "error"));
    return;
  }
  state.editingId = null;
  state.returnTo = from === "page" ? "page" : null;
  $("#viewer-title").textContent = note.title;
  const tagsHtml = (note.tags || "")
    .split(",")
    .filter((t) => t.trim())
    .map((t) => `<span class="badge badge-secondary">#${escapeHtml(t.trim())}</span>`)
    .join(" ");
  $("#viewer-meta").innerHTML = `Created ${fmtStampFull(note.created_at)} · Updated ${relTime(note.updated_at)}${tagsHtml ? ` · ${tagsHtml}` : ""}`;
  $("#viewer-content").innerHTML = note.content || "<p class='text-muted-foreground'>Empty note</p>";
  $("#viewer-edit-btn").onclick = () => openEditor(note.id);
  $("#viewer-excel-link").href = `/api/notes/${note.id}/export.xlsx`;
  $("#viewer-print-btn").onclick = () => printNote(note);
  setEditorOverlay(false);
  if (state.view !== "notes") {
    // Opened from another context (e.g. page detail rows) — switch the visible section
    switchViewShell("notes");
    state.view = "notes";
    document.body.classList.remove("sidebar-open");
  }
  $("#notes-list-wrap").classList.add("hidden");
  $("#notes-editor-wrap").classList.add("hidden");
  $("#note-viewer-wrap").classList.remove("hidden");
  setRoute("#/notes/" + note.id);
}

function printNote(note) {
  const w = window.open("", "_blank", "width=840,height=920");
  if (!w) {
    toast("Popup blocked — allow popups to print", "error");
    return;
  }
  const tags = (note.tags || "").split(",").filter((t) => t.trim()).map((t) => `#${escapeHtml(t.trim())}`).join(" ");
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(note.title)}</title>
<style>
body{font-family:Georgia,'Segoe UI',serif;max-width:720px;margin:40px auto;padding:0 16px;color:#111;line-height:1.6}
h1{font-size:26px;border-bottom:2px solid #ddd;padding-bottom:8px;margin-bottom:6px}
.meta{color:#666;font-size:12px;margin-bottom:28px}
img{max-width:100%}table{border-collapse:collapse;width:100%;table-layout:fixed}td,th{border:1px solid #ccc;padding:6px 10px;word-break:break-word}
blockquote{border-left:3px solid #ccc;margin:0;padding-left:14px;color:#555}
@media print{body{margin:10mm auto}}
</style></head><body><h1>${escapeHtml(note.title)}</h1>
<div class="meta">Created ${escapeHtml(fmtStampFull(note.created_at))} · Updated ${escapeHtml(relTime(note.updated_at))}${tags ? ` · ${tags}` : ""}</div>
${note.content || "<p>Empty note</p>"}
<script>window.onload=function(){setTimeout(function(){window.print()},150)}<\/script>
</body></html>`);
  w.document.close();
}

const SWATCH_COLORS = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#14b8a6", "#3b82f6", "#8b5cf6", "#ec4899", "#78716c", "#18181b", "#ffffff"];

function buildSwatches(containerId, cmd) {
  const c = document.getElementById(containerId);
  c.innerHTML = SWATCH_COLORS.map((col) => `<button type="button" class="swatch" style="background:${col}" data-color="${col}"></button>`).join("");
  c.querySelectorAll(".swatch").forEach((s) => {
    s.addEventListener("mousedown", (e) => e.preventDefault());
    s.addEventListener("click", () => {
      exec(cmd, s.dataset.color);
      if (cmd === "foreColor") $("#text-color-bar").style.background = s.dataset.color;
      closePopovers();
    });
  });
}

function closePopovers() {
  $("#text-color-popover")?.classList.add("hidden");
  $("#hl-color-popover")?.classList.add("hidden");
}

function initEditorToolbar() {
  const toolbar = $("#notes-editor-wrap");

  document.addEventListener("selectionchange", () => {
    const sel = window.getSelection();
    if (sel.rangeCount > 0 && $("#note-content-input")?.contains(sel.getRangeAt(0).commonAncestorContainer)) {
      savedRange = sel.getRangeAt(0).cloneRange();
    }
  });

  toolbar.addEventListener("mousedown", (e) => {
    const btn = e.target.closest("button.tool-btn, #pin-toggle-btn, #history-btn, #editor-back-btn");
    const isSelect = e.target.closest("select");
    if (isSelect) saveSelection();
    if (btn) e.preventDefault();
  });

  toolbar.addEventListener("click", (e) => {
    const cmdBtn = e.target.closest("[data-cmd]");
    if (cmdBtn) {
      exec(cmdBtn.dataset.cmd);
      return;
    }
    const blockBtn = e.target.closest("[data-block]");
    if (blockBtn) {
      exec("formatBlock", `<${blockBtn.dataset.block}>`);
      return;
    }
    const clearBtn = e.target.closest("[data-clear-color]");
    if (clearBtn) {
      exec(clearBtn.dataset.clearColor, "transparent");
      if (clearBtn.dataset.clearColor === "foreColor") $("#text-color-bar").style.background = "";
      closePopovers();
      return;
    }
  });

  $("#text-color-btn").addEventListener("click", () => {
    const pop = $("#text-color-popover");
    const opening = pop.classList.contains("hidden");
    closePopovers();
    if (opening) {
      buildSwatchesOnce("text-swatches", "foreColor");
      pop.classList.remove("hidden");
    }
  });

  $("#hl-color-btn").addEventListener("click", () => {
    const pop = $("#hl-color-popover");
    const opening = pop.classList.contains("hidden");
    closePopovers();
    if (opening) {
      buildSwatchesOnce("hl-swatches", "hiliteColor");
      pop.classList.remove("hidden");
    }
  });

  $("#font-family").addEventListener("change", (e) => {
    if (e.target.value) exec("fontName", e.target.value);
    e.target.value = "";
  });

  $("#font-size").addEventListener("change", (e) => {
    exec("fontSize", e.target.value);
  });

  $("#checklist-btn").addEventListener("click", () => {
    restoreSelection();
    document.execCommand("insertHTML", false, `<ul data-task="1"><li>&nbsp;</li></ul><p><br></p>`);
    markDirty();
  });

  $("#link-btn").addEventListener("click", () => {
    saveSelection();
    openDialog(`
      <h2 class="text-lg font-semibold">Insert link</h2>
      <form id="link-dialog-form" class="mt-4 space-y-4">
        <div class="space-y-1.5">
          <label class="text-sm font-medium">URL</label>
          <input id="link-url" type="url" placeholder="https://example.com" class="input" required />
        </div>
        <div class="space-y-1.5">
          <label class="text-sm font-medium">Text (optional)</label>
          <input id="link-text" type="text" placeholder="Link text" class="input" />
        </div>
        <div class="flex justify-end gap-2">
          <button type="button" class="btn btn-outline" data-cancel-dialog>Cancel</button>
          <button type="submit" class="btn btn-primary">Insert</button>
        </div>
      </form>
    `);
    $("#link-dialog-form [data-cancel-dialog]").addEventListener("click", closeDialog);
    $("#link-dialog-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const url = $("#link-url").value.trim();
      const text = $("#link-text").value.trim() || url;
      if (!url) return;
      restoreSelection();
      document.execCommand("insertHTML", false, `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(text)}</a>&nbsp;`);
      markDirty();
      closeDialog();
    });
    setTimeout(() => $("#link-url").focus(), 40);
  });

  $("#table-btn").addEventListener("click", () => {
    saveSelection();
    openDialog(`
      <h2 class="text-lg font-semibold">Insert table</h2>
      <form id="table-dialog-form" class="mt-4 space-y-4">
        <div class="grid grid-cols-2 gap-4">
          <div class="space-y-1.5">
            <label class="text-sm font-medium">Rows</label>
            <input id="table-rows" type="number" min="1" max="20" value="3" class="input" />
          </div>
          <div class="space-y-1.5">
            <label class="text-sm font-medium">Columns</label>
            <input id="table-cols" type="number" min="1" max="8" value="3" class="input" />
          </div>
        </div>
        <div class="flex justify-end gap-2">
          <button type="button" class="btn btn-outline" data-cancel-dialog>Cancel</button>
          <button type="submit" class="btn btn-primary">Insert</button>
        </div>
      </form>
    `);
    $("#table-dialog-form [data-cancel-dialog]").addEventListener("click", closeDialog);
    $("#table-dialog-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const rows = Math.min(Math.max(Number($("#table-rows").value) || 3, 1), 20);
      const cols = Math.min(Math.max(Number($("#table-cols").value) || 3, 1), 8);
      const width = Math.floor(100 / cols);
      const colsHtml = Array(cols).fill(`<col style="width:${width}%"></col>`).join("");
      const headHtml = `<tr>${Array(cols).fill("<th>&nbsp;</th>").join("")}</tr>`;
      const bodyHtml = Array(rows).fill(`<tr>${Array(cols).fill("<td>&nbsp;</td>").join("")}</tr>`).join("");
      restoreSelection();
      document.execCommand("insertHTML", false, `<table><colgroup>${colsHtml}</colgroup><thead>${headHtml}</thead><tbody>${bodyHtml}</tbody></table><p><br></p>`);
      markDirty();
      closeDialog();
    });
  });

  $("#emoji-select").addEventListener("change", (e) => {
    if (!e.target.value) return;
    restoreSelection();
    document.execCommand("insertText", false, e.target.value);
    markDirty();
    e.target.value = "";
  });

  $("#image-btn").addEventListener("click", () => $("#image-file-input").click());
  $("#image-file-input").addEventListener("change", (e) => {
    if (e.target.files.length) uploadAndInsert(Array.from(e.target.files));
    e.target.value = "";
  });

  $("#search-btn").addEventListener("click", openSearchDialog);

  $("#history-btn").addEventListener("click", openVersionsDialog);

  $("#pin-toggle-btn").addEventListener("click", async () => {
    let note = currentNote();
    if (!note) {
      await flushPendingSave();
      note = currentNote();
    }
    if (!note) return;
    const updated = await api(`/api/notes/${note.id}`, { method: "PUT", body: JSON.stringify({ pinned: !note.pinned }) });
    Object.assign(note, updated);
    updatePinBtn();
    toast(note.pinned ? "Note pinned" : "Note unpinned");
  });

  $("#editor-back-btn").addEventListener("click", exitToNotesList);
  $("#viewer-back-btn").addEventListener("click", exitToNotesList);
  $("#note-title-input").addEventListener("input", () => markDirty());
  $("#note-tags-input").addEventListener("input", () => markDirty());

  const editor = $("#note-content-input");

  editor.addEventListener("input", () => markDirty());
  editor.addEventListener("keyup", syncToolbarState);
  editor.addEventListener("mouseup", syncToolbarState);
  editor.addEventListener("keydown", editorKeydown);
  editor.addEventListener("paste", (e) => {
    const files = Array.from(e.clipboardData?.files || []).filter((f) => f.type.startsWith("image/"));
    if (files.length) {
      e.preventDefault();
      uploadAndInsert(files);
    }
  });
  editor.addEventListener("dragover", (e) => e.preventDefault());
  editor.addEventListener("drop", (e) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer?.files || []).filter((f) => f.type.startsWith("image/"));
    if (files.length) uploadAndInsert(files);
  });
  editor.addEventListener("click", editorClick);
  editor.addEventListener("dblclick", (e) => {
    const img = e.target.closest("img");
    if (!img || !editor.contains(img)) return;
    img.style.width = "";
    img.style.height = "";
    img.style.maxWidth = "";
    markDirty();
    selectedEditorImg = img;
    positionImgToolbar(img);
    $("#img-resize-layer").classList.remove("hidden");
  });

  document.addEventListener("mousedown", (e) => {
    const t = e.target;
    const onImg = selectedEditorImg && (t === selectedEditorImg || (t.closest && t.closest("#img-resize-layer")));
    const onHandle = t.id === "col-resize-handle";
    if (!onImg && !onHandle) hideImgToolbar();
    const onCell = t.closest && t.closest("td, th") && editor.contains(t);
    if (!onCell && t.id !== "col-resize-handle") hideColHandle();
    if (!t.closest(".relative")) closePopovers();
  }, true);

  document.addEventListener("click", (e) => {
    if (!e.target.closest("#dialog-root") && !e.target.closest(".dropdown-menu") && !e.target.closest("#text-color-btn") && !e.target.closest("#hl-color-btn")) closePopovers();
  });
}

const builtSwatches = new Set();

function buildSwatchesOnce(containerId, cmd) {
  if (builtSwatches.has(containerId)) {
    const c = document.getElementById(containerId);
    c.querySelectorAll(".swatch").forEach((s) => {
      s.onclick = () => {
        exec(cmd, s.dataset.color);
        if (cmd === "foreColor") $("#text-color-bar").style.background = s.dataset.color;
        closePopovers();
      };
    });
    return;
  }
  builtSwatches.add(containerId);
  buildSwatches(containerId, cmd);
}

function syncToolbarState() {
  ["bold", "italic", "underline", "strikeThrough"].forEach((cmd) => {
    $$('#view-notes [data-cmd="' + cmd + '"]').forEach((b) => b.classList.toggle("bg-accent", document.queryCommandState(cmd)));
  });
}

function editorKeydown(e) {
  if ((e.key === "Delete" || e.key === "Backspace") && selectedEditorImg) {
    e.preventDefault();
    selectedEditorImg.remove();
    hideImgToolbar();
    markDirty();
    toast("Image removed");
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
    e.preventDefault();
    openSearchDialog();
  }
  const li = getActiveChecklistLi();
  if (li && (e.key === "Enter" || e.key === "Tab")) {
    const ul = li.closest('ul[data-task]');
    if (li.textContent.trim() === "" && e.key === "Enter") {
      e.preventDefault();
      document.execCommand("insertHTML", false, "</ul><p><br></p>");
      markDirty();
    } else if (e.key === "Tab") {
      e.preventDefault();
      document.execCommand("insertText", false, "\u00a0\u00a0\u00a0\u00a0");
    }
  }
}

function getActiveChecklistLi() {
  const sel = window.getSelection();
  if (!sel.rangeCount) return null;
  let node = sel.getRangeAt(0).startContainer;
  while (node && node !== document.body) {
    if (node.tagName === "LI" && node.parentElement?.hasAttribute("data-task")) return node;
    node = node.parentElement || node.parentNode;
  }
  return null;
}

function editorClick(e) {
  const li = e.target.closest("li");
  if (li) {
    const ul = li.closest("ul[data-task]");
    if (ul) {
      const rect = li.getBoundingClientRect();
      if (e.clientX - rect.left < 30) {
        ul.setAttribute("data-task", ul.getAttribute("data-task") === "1" ? "2" : "1");
        markDirty();
        return;
      }
    }
  }
  const cell = e.target.closest("td, th");
  if (cell && $("#note-content-input").contains(cell)) {
    hideImgToolbar();
    showColHandle(cell);
    return;
  }
  const img = e.target.closest("img");
  if (img && $("#note-content-input").contains(img)) {
    hideColHandle();
    selectedEditorImg = img;
    positionImgToolbar(img);
    $("#img-resize-layer").classList.remove("hidden");
    return;
  }
}

async function uploadAndInsert(files) {
  for (const file of files.slice(0, 6)) {
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await api("/api/upload", { method: "POST", body: fd });
      restoreSelection();
      document.execCommand("insertHTML", false, `<img src="/${res.url}" alt="${escapeHtml(file.name)}">&nbsp;`);
      markDirty();
    } catch (err) {
      toast(err.message, "error");
    }
  }
}

function positionImgToolbar(img) {
  const layer = $("#img-resize-layer");
  const r = img.getBoundingClientRect();
  layer.style.left = `${r.left}px`;
  layer.style.top = `${r.top}px`;
  layer.style.width = `${r.width}px`;
  layer.style.height = `${r.height}px`;
}

function hideImgToolbar() {
  if (selectedEditorImg) selectedEditorImg = null;
  $("#img-resize-layer")?.classList.add("hidden");
}

function initResizeHandles() {
  $$(".resize-handle").forEach((handle) => {
    handle.addEventListener("mousedown", (e) => startImgResize(e, handle.dataset.dir));
  });
  $("#col-resize-handle").addEventListener("mousedown", (e) => startColResize(e));
}

function startImgResize(e, dir) {
  e.preventDefault();
  e.stopPropagation();
  const img = selectedEditorImg;
  if (!img) return;
  const startX = e.clientX;
  const startY = e.clientY;
  const r = img.getBoundingClientRect();
  const startW = r.width;
  const ratio = r.height / r.width;
  const move = (ev) => {
    let dx = ev.clientX - startX;
    if (dir.includes("w")) dx = -dx;
    const newW = Math.max(40, Math.min(startW + dx, 1600));
    img.style.width = `${newW}px`;
    img.style.height = "auto";
    img.style.maxWidth = "100%";
    positionImgToolbar(img);
  };
  const up = () => {
    document.removeEventListener("mousemove", move);
    document.removeEventListener("mouseup", up);
    markDirty();
  };
  document.addEventListener("mousemove", move);
  document.addEventListener("mouseup", up);
}

function showColHandle(cell) {
  colResizeCtx = { cell };
  positionColHandle();
  $("#col-resize-handle").classList.remove("hidden");
}

function positionColHandle() {
  if (!colResizeCtx) return;
  const r = colResizeCtx.cell.getBoundingClientRect();
  const handle = $("#col-resize-handle");
  handle.style.left = `${r.right - 2}px`;
  handle.style.top = `${r.top}px`;
}

function hideColHandle() {
  colResizeCtx = null;
  $("#col-resize-handle")?.classList.add("hidden");
}

function ensureColgroup(table, cols) {
  let cg = table.querySelector("colgroup");
  if (!cg) {
    cg = document.createElement("colgroup");
    table.prepend(cg);
  }
  while (cg.children.length < cols) cg.appendChild(document.createElement("col"));
  return cg;
}

function startColResize(e) {
  e.preventDefault();
  if (!colResizeCtx) return;
  const cell = colResizeCtx.cell;
  const table = cell.closest("table");
  const idx = cell.cellIndex;
  const colgroup = ensureColgroup(table, table.rows[0]?.cells.length || idx + 1);
  const col = colgroup.children[idx];
  const startX = e.clientX;
  const startW = cell.getBoundingClientRect().width;
  const move = (ev) => {
    const w = Math.max(36, startW + ev.clientX - startX);
    col.style.width = `${w}px`;
    cell.style.width = `${w}px`;
    positionColHandle();
  };
  const up = () => {
    document.removeEventListener("mousemove", move);
    document.removeEventListener("mouseup", up);
    markDirty();
  };
  document.addEventListener("mousemove", move);
  document.addEventListener("mouseup", up);
}

function collectTextMatches(root, term) {
  const matches = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const lower = term.toLowerCase();
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const text = node.nodeValue.toLowerCase();
    let idx = text.indexOf(lower);
    while (idx !== -1) {
      matches.push({ node, start: idx, end: idx + term.length });
      idx = text.indexOf(lower, idx + term.length);
    }
  }
  return matches;
}

function selectMatch(m) {
  const range = document.createRange();
  range.setStart(m.node, m.start);
  range.setEnd(m.node, m.end);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  const rect = range.getBoundingClientRect();
  if (rect.top < 100 || rect.bottom > window.innerHeight - 100) {
    m.node.parentElement?.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

function replaceMatch(m, replacement) {
  m.node.nodeValue = m.node.nodeValue.slice(0, m.start) + replacement + m.node.nodeValue.slice(m.end);
}

function openSearchDialog() {
  saveSelection();
  openDialog(`
    <h2 class="text-lg font-semibold">Search &amp; Replace</h2>
    <form id="search-form" class="mt-4 space-y-3">
      <input id="find-input" type="text" placeholder="Find in note..." class="input" autocomplete="off" />
      <input id="replace-input" type="text" placeholder="Replace with (optional)" class="input" autocomplete="off" />
      <div class="flex flex-wrap items-center gap-1.5">
        <button type="button" class="btn btn-outline btn-sm" id="find-prev-btn">Prev</button>
        <button type="button" class="btn btn-outline btn-sm" id="find-next-btn">Next</button>
        <button type="button" class="btn btn-outline btn-sm" id="replace-one-btn">Replace</button>
        <button type="button" class="btn btn-outline btn-sm" id="replace-all-btn">Replace All</button>
      </div>
      <p id="search-status" class="text-xs text-muted-foreground"></p>
    </form>
  `);
  let cursor = -1;
  let matches = [];
  const status = $("#search-status");
  const findInput = $("#find-input");
  const refresh = () => {
    const term = findInput.value;
    if (!term) {
      matches = [];
      status.textContent = "";
      return 0;
    }
    matches = collectTextMatches($("#note-content-input"), term);
    status.textContent = `${matches.length} match${matches.length === 1 ? "" : "es"}`;
    return matches.length;
  };
  findInput.addEventListener("input", () => {
    cursor = -1;
    refresh();
  });
  const jump = (dir) => {
    if (!refresh()) return;
    cursor = (cursor + dir + matches.length) % matches.length;
    selectMatch(matches[cursor]);
    status.textContent = `${cursor + 1} of ${matches.length}`;
  };
  $("#find-next-btn").addEventListener("click", () => jump(1));
  $("#find-prev-btn").addEventListener("click", () => jump(-1));
  $("#replace-one-btn").addEventListener("click", () => {
    const rep = $("#replace-input").value;
    if (!refresh()) return;
    if (cursor < 0) cursor = 0;
    const m = matches[cursor];
    replaceMatch(m, rep);
    markDirty();
    cursor--;
    refresh();
    if (matches.length) jump(1);
  });
  $("#replace-all-btn").addEventListener("click", () => {
    const rep = $("#replace-input").value;
    if (!refresh()) return;
    [...matches].reverse().forEach((m) => replaceMatch(m, rep));
    const n = matches.length;
    markDirty();
    refresh();
    toast(`${n} replacement${n === 1 ? "" : "s"} done`);
  });
  setTimeout(() => findInput.focus(), 40);
}

async function openVersionsDialog() {
  if (!currentNote()) {
    toast("Save the note first", "info");
    return;
  }
  await flushPendingSave();
  const id = state.editingId;
  const versions = await api(`/api/notes/${id}/versions`);
  const rows = versions.length
    ? versions
        .map(
          (v, i) => `
          <div class="flex items-center gap-3 rounded-lg border border-border p-3">
            <div class="min-w-0 flex-1">
              <p class="text-sm font-medium">Version ${versions.length - i}</p>
              <p class="text-[11px] text-muted-foreground">${v.created_at.replace("T", " ").slice(0, 19)} · ${stripHtml(v.title || "", 40) || "Untitled"}</p>
            </div>
            ${canWrite() ? `<button class="btn btn-outline btn-sm" data-restore="${v.id}">Restore</button>` : ""}
          </div>`
        )
        .join("")
    : `<p class="py-8 text-center text-sm text-muted-foreground">No versions yet. Versions are created automatically as you edit.</p>`;
  openDialog(`
    <div class="flex items-center justify-between">
      <h2 class="text-lg font-semibold">Version history</h2>
      <button type="button" class="btn btn-ghost btn-icon" data-close-x>✕</button>
    </div>
    <div class="mt-4 max-h-[50vh] space-y-2 overflow-y-auto pr-1">${rows}</div>
    ${
      versions.length && isAdminUser()
        ? `<button class="mt-4 w-full rounded-lg border border-border py-2 text-xs text-muted-foreground hover:bg-accent hover:text-destructive" id="clear-versions-btn">Delete all versions</button>`
        : ""
    }
  `);
  $("#dialog-root [data-close-x]").addEventListener("click", closeDialog);
  $$("#dialog-root [data-restore]").forEach((b) =>
    b.addEventListener("click", async () => {
      await api(`/api/notes/${id}/restore`, { method: "POST", body: JSON.stringify({ version_id: Number(b.dataset.restore) }) });
      const fresh = state.notes.find((n) => n.id === id);
      if (fresh) {
        const updated = await api("/api/notes");
        state.notes = updated;
      }
      closeDialog();
      openEditor(id);
      toast("Version restored");
    })
  );
  const clearBtn = $("#clear-versions-btn");
  if (clearBtn)
    clearBtn.addEventListener("click", () => {
      confirmDialog("Delete all versions?", async () => {
        await api(`/api/notes/${id}/versions`, { method: "DELETE" });
        closeDialog();
        toast("Version history cleared");
      }, "Clear");
    });
}

async function loadDashboard() {
  const today = isoDate(new Date());
  const wd = (new Date().getDay() + 6) % 7;
  const total = state.tasks.length;
  const pending = state.tasks.filter((t) => !t.done).length;
  $("#stat-tasks").textContent = total;
  $("#stat-pending").textContent = pending;
  $("#stat-notes").textContent = state.notes.length;
  const todayRoutines = state.routines.filter((r) => r.active && r.weekday === wd);
  const doneToday = todayRoutines.filter((r) => (r.completions || []).includes(today)).length;
  $("#stat-routines").textContent = `${doneToday}/${todayRoutines.length}`;

  renderChart();
  renderRecentNotes();
  renderTodayTasks();
  renderTodayRoutines(todayRoutines, today);
}

const RING_COLORS = [
  ["#60a5fa", "#2563eb"],
  ["#c084fc", "#9333ea"],
  ["#f472b6", "#db2777"],
  ["#f87171", "#dc2626"],
  ["#fb923c", "#ea580c"],
  ["#facc15", "#ca8a04"],
  ["#4ade80", "#16a34a"],
];

function weekData() {
  const days = [];
  const todayIso = isoDate(new Date());
  for (let back = 6; back >= 0; back--) {
    const d = new Date();
    d.setDate(d.getDate() - back);
    const iso = isoDate(d);
    const wd = (d.getDay() + 6) % 7;

    // Routines: own percentage for this weekday
    const scheduled = state.routines.filter((r) => r.active && r.weekday === wd);
    const rDone = scheduled.filter((r) => (r.completions || []).includes(iso)).length;
    const rTotal = scheduled.length;

    // Tasks: dated ones only (no due_date = ignored).
    // Unfinished overdue tasks roll into TODAY's total until completed.
    const tPool =
      iso === todayIso
        ? state.tasks.filter((t) => t.due_date && (t.due_date === todayIso || (!t.done && t.due_date < todayIso)))
        : state.tasks.filter((t) => t.due_date === iso);
    const tDone = tPool.filter((t) => t.done).length;
    const tTotal = tPool.length;

    // Day percentage = average of the available parts (tasks & routines weighted equally)
    const parts = [];
    if (rTotal) parts.push(rDone / rTotal);
    if (tTotal) parts.push(tDone / tTotal);
    const pct = parts.length ? Math.round((parts.reduce((a, b) => a + b, 0) / parts.length) * 100) : 0;

    days.push({
      date: d,
      iso,
      label: DAY_NAMES[wd],
      total: rTotal + tTotal,
      done: rDone + tDone,
      rTotal,
      rDone,
      tTotal,
      tDone,
      pct,
    });
  }
  return days;
}

function arcPoint(cx, cy, r, deg) {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

function describeArc(cx, cy, r, startDeg, endDeg) {
  const [sx, sy] = arcPoint(cx, cy, r, endDeg);
  const [ex, ey] = arcPoint(cx, cy, r, startDeg);
  const largeArc = endDeg - startDeg <= 180 ? 0 : 1;
  return `M ${sx} ${sy} A ${r} ${r} 0 ${largeArc} 0 ${ex} ${ey}`;
}

function renderChart() {
  const days = weekData();
  const cx = 175;
  const cy = 165;
  const radii = [150, 136, 122, 108, 94, 80, 66];
  const stroke = 11;
  let defs = "";
  let groups = "";
  radii.forEach((r, i) => {
    const [light, base] = RING_COLORS[i];
    defs += `<linearGradient id="rg-${i}" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="${light}"/><stop offset="100%" stop-color="${base}"/></linearGradient>`;
    const track = `<circle class="ring-track" cx="${cx}" cy="${cy}" r="${r}" stroke-width="${stroke}"/>`;
    const day = days[i];
    const frac = day.pct / 100;
    const arcLen = 2 * Math.PI * r * frac;
    const value =
      day.pct > 0
        ? `<circle class="ring-value" cx="${cx}" cy="${cy}" r="${r}" stroke="url(#rg-${i})" stroke-width="${stroke}"
             stroke-dasharray="${arcLen} ${2 * Math.PI * r}" transform="rotate(-90 ${cx} ${cy})"/>`
        : "";
    groups += `<g class="ring-group"><title>${day.label}, ${fmtDate(day.iso)} — Tasks ${day.tDone}/${day.tTotal}, Routines ${day.rDone}/${day.rTotal} (${day.pct}%)</title>${track}${value}</g>`;
  });
  const avg = Math.round(days.reduce((s, d) => s + d.pct, 0) / 7);
  const chart = `
    <svg width="330" height="330" viewBox="0 0 350 330">
      <defs>${defs}</defs>
      ${groups}
      <text x="${cx}" y="${cy - 4}" text-anchor="middle" style="fill:hsl(var(--foreground));font-size:38px;font-weight:700;">${avg}%</text>
      <text x="${cx}" y="${cy + 22}" text-anchor="middle" style="fill:hsl(var(--muted-foreground));font-size:12px;font-weight:500;">7-day average</text>
    </svg>`;
  $("#rings-chart").innerHTML = chart;
  $("#rings-breakdown").innerHTML = days
    .map((d, i) => {
      const [light, base] = RING_COLORS[i];
      const bits = [];
      if (d.rTotal) bits.push(`R ${d.rDone}/${d.rTotal}`);
      if (d.tTotal) bits.push(`T ${d.tDone}/${d.tTotal}`);
      const counts = bits.length ? bits.join(" · ") : "—";
      return `
        <div class="breakdown-row">
          <span class="breakdown-dot" style="background:${base}"></span>
          <span class="w-8 shrink-0 font-semibold ${i === 6 ? "text-foreground" : "text-muted-foreground"}">${d.label}</span>
          <div class="breakdown-bar"><div class="breakdown-fill" style="width:${d.pct}%;background:linear-gradient(90deg,${light},${base});"></div></div>
          <span class="w-24 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground" title="R = Routines · T = Tasks">${counts}</span>
        </div>`;
    })
    .join("");
  const today = days[6];
  const pill = $("#rings-center-pill");
  pill.textContent = `Today ${today.pct}% · ${today.done}/${today.total}`;
  pill.classList.remove("hidden");
}

function renderRecentNotes() {
  const box = $("#recent-notes");
  const items = [...state.notes].sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || "")).slice(0, 5);
  if (!items.length) {
    box.innerHTML = `<p class="p-4 text-sm text-muted-foreground">No notes yet</p>`;
    return;
  }
  box.innerHTML = items
    .map(
      (n) => `
      <button class="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-accent" data-open="${n.id}">
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-medium">${n.pinned ? "📌 " : ""}${escapeHtml(n.title)}</p>
          <p class="truncate text-xs text-muted-foreground">${escapeHtml(stripHtml(n.content, 70)) || "Empty note"}</p>
        </div>
        <span class="shrink-0 text-[10px] text-muted-foreground">${relTime(n.updated_at)}</span>
      </button>`
    )
    .join("");
  box.querySelectorAll("[data-open]").forEach((b) => {
    const id = Number(b.dataset.open);
    b.addEventListener("click", () => {
      state.activeTag = "";
      state.noteQuery = "";
      $("#notes-search").value = "";
      switchView("notes");
      openViewer(id);
    });
  });
}

function renderTodayTasks() {
  const today = isoDate(new Date());
  const box = $("#today-tasks");
  const items = state.tasks.filter((t) => t.due_date === today);
  if (!items.length) {
    box.innerHTML = `<p class="p-4 text-sm text-muted-foreground">Nothing due today 🎉</p>`;
    return;
  }
  box.innerHTML = items
    .map(
      (t) => `
      <div class="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-accent" data-task-row="${t.id}">
        <button class="flex h-4.5 w-4.5 h-[18px] w-[18px] shrink-0 items-center justify-center rounded border ${t.done ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40"}" data-toggle="${t.id}">
          ${t.done ? `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>` : ""}
        </button>
        <span class="min-w-0 flex-1 truncate text-sm ${t.done ? "line-through text-muted-foreground" : ""}">${escapeHtml(t.title)}</span>
        <span class="badge badge-${t.priority}">${t.priority}</span>
      </div>`
    )
    .join("");
  bindTaskToggles(box);
}

function renderTodayRoutines(list, today) {
  const box = $("#today-routines");
  if (!list.length) {
    box.innerHTML = `<p class="p-4 text-sm text-muted-foreground">No routines scheduled today</p>`;
    return;
  }
  box.innerHTML = list
    .map((r) => {
      const done = (r.completions || []).includes(today);
      return `
        <div class="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-accent">
          <button class="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded border ${done ? "border-emerald-500 bg-emerald-500 text-white" : "border-muted-foreground/40"}" data-routine-toggle="${r.id}" data-date="${today}">
            ${done ? `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>` : ""}
          </button>
          <span class="min-w-0 flex-1 truncate text-sm">${escapeHtml(r.title)}</span>
          ${r.time ? `<span class="badge badge-secondary">${r.time}</span>` : ""}
        </div>`;
    })
    .join("");
  bindRoutineToggles(box);
}

function bindTaskToggles(scope) {
  scope.querySelectorAll("[data-toggle]").forEach((b) =>
    b.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!requireWrite("mark tasks done")) return;
      const id = Number(b.dataset.toggle);
      const task = state.tasks.find((t) => t.id === id);
      const updated = await api(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify({ done: !task.done }) });
      Object.assign(task, updated);
      if (state.view === "dashboard") {
        renderTodayTasks();
        $("#stat-pending").textContent = state.tasks.filter((t) => !t.done).length;
      } else renderTasks();
      toast(updated.done ? "Task completed ✓" : "Marked pending");
    })
  );
}

function bindRoutineToggles(scope) {
  scope.querySelectorAll("[data-routine-toggle]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!requireWrite("mark routines done")) return;
      const id = Number(b.dataset.routineToggle);
      const d = b.dataset.date;
      const res = await api(`/api/routines/${id}/toggle`, { method: "POST", body: JSON.stringify({ date: d }) });
      const r = state.routines.find((x) => x.id === id);
      if (r) {
        r.completions = r.completions || [];
        r.completions = res.done ? [...new Set([...r.completions, d])] : r.completions.filter((x) => x !== d);
      }
      if (state.view === "dashboard") loadDashboard();
      else renderSchedList();
      toast(res.done ? "Routine done ✓" : "Undone");
    })
  );
}

function priorityBadge(p) {
  return `<span class="badge badge-${p}">${p}</span>`;
}

function dueChip(t) {
  if (!t.due_date) return "";
  const today = isoDate(new Date());
  const overdue = !t.done && t.due_date < today;
  return `<span class="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] font-medium ${overdue ? "bg-red-500/15 text-red-500" : "bg-secondary text-secondary-foreground"}">
    <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/></svg>
    ${fmtDate(t.due_date)}${t.due_date === today ? " · Today" : ""}
  </span>`;
}

async function loadTasks() {
  try {
    state.tasks = await api("/api/tasks");
  } catch (e) {
    toast(e.message, "error");
  }
  renderTasks();
}

function renderTasks() {
  const f = state.taskFilter;
  const items = state.tasks.filter((t) => (f === "all" ? true : f === "done" ? t.done : !t.done));
  $("#tasks-list").innerHTML = items.length
    ? items
        .map(
          (t) => `
          <div class="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/50">
            <button class="flex h-[19px] w-[19px] shrink-0 items-center justify-center rounded border ${t.done ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40 hover:border-primary"}" data-toggle="${t.id}">
              ${t.done ? `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>` : ""}
            </button>
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-medium ${t.done ? "line-through text-muted-foreground" : ""}">${escapeHtml(t.title)}</p>
              ${t.description ? `<p class="mt-0.5 truncate text-xs text-muted-foreground">${escapeHtml(t.description)}</p>` : ""}
            </div>
            ${priorityBadge(t.priority)}
            ${dueChip(t)}
            ${t.page_id ? `<span class="max-w-[110px] truncate rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary" title="In page: ${escapeHtml(pageName(t.page_id))}">${escapeHtml(pageName(t.page_id))}</span>` : ""}
            <div class="flex items-center gap-0.5">
              <a class="tool-btn" href="/api/tasks/${t.id}/export.xlsx" download title="Export to Excel"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg></a>
              <button class="tool-btn" data-edit="${t.id}" title="Edit"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/></svg></button>
              <button class="tool-btn hover:text-destructive" data-del="${t.id}" title="Delete"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg></button>
            </div>
          </div>`
        )
        .join("")
    : `<p class="p-10 text-center text-sm text-muted-foreground">No tasks here</p>`;
}

function taskDialog(task = null, presetDate = null) {
  if (!requireWrite(task ? "edit tasks" : "add tasks")) return;
  const isEdit = !!task;
  openDialog(`
    <h2 class="text-lg font-semibold">${isEdit ? "Edit task" : "New task"}</h2>
    <form id="task-form" class="mt-4 space-y-4">
      <div class="space-y-1.5">
        <label class="text-sm font-medium">Title</label>
        <input id="task-title" type="text" class="input" placeholder="What needs to be done?" value="${escapeHtml(task?.title || "")}" required />
      </div>
      <div class="space-y-1.5">
        <label class="text-sm font-medium">Description</label>
        <textarea id="task-desc" rows="2" class="input resize-none py-2" placeholder="Optional details...">${escapeHtml(task?.description || "")}</textarea>
      </div>
      <div class="grid grid-cols-2 gap-4">
        <div class="space-y-1.5">
          <label class="text-sm font-medium">Priority</label>
          <select id="task-priority" class="input">
            ${["low", "medium", "high"].map((p) => `<option value="${p}" ${task?.priority === p ? "selected" : ""}>${p[0].toUpperCase() + p.slice(1)}</option>`).join("")}
          </select>
        </div>
        <div class="space-y-1.5">
          <label class="text-sm font-medium">Due date</label>
          <input id="task-due" type="date" class="input" value="${task?.due_date || presetDate || ""}" />
        </div>
      </div>
      <div class="flex justify-end gap-2">
        <button type="button" class="btn btn-outline" data-cancel-dialog>Cancel</button>
        <button type="submit" class="btn btn-primary">${isEdit ? "Save changes" : "Add task"}</button>
      </div>
    </form>
  `);
  $("#task-form [data-cancel-dialog]").addEventListener("click", closeDialog);
  $("#task-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = {
      title: $("#task-title").value.trim(),
      description: $("#task-desc").value.trim(),
      priority: $("#task-priority").value,
      due_date: $("#task-due").value || null,
    };
    if (!payload.title) return;
    try {
      if (isEdit) {
        const updated = await api(`/api/tasks/${task.id}`, { method: "PATCH", body: JSON.stringify(payload) });
        Object.assign(task, updated);
        toast("Task updated");
      } else {
        const created = await api("/api/tasks", { method: "POST", body: JSON.stringify(payload) });
        state.tasks.unshift(created);
        toast("Task added");
      }
      closeDialog();
      renderTasks();
      if (state.view === "calendar") renderCalendar();
    } catch (err) {
      toast(err.message, "error");
    }
  });
  setTimeout(() => $("#task-title").focus(), 40);
}

async function loadSchedule() {
  try {
    state.routines = await api("/api/routines");
  } catch (e) {
    toast(e.message, "error");
  } finally {
    state.schedWd = (new Date().getDay() + 6) % 7;
    renderSchedChips();
    renderSchedList();
  }
}

function schedDateFor(wd) {
  const now = new Date();
  const mondayOffset = (now.getDay() + 6) % 7;
  const d = new Date(now);
  d.setDate(now.getDate() - mondayOffset + wd);
  return d;
}

function renderSchedChips() {
  const box = $("#sched-day-chips");
  box.innerHTML = DAY_NAMES.map(
    (n, i) => `<button class="day-chip ${i === state.schedWd ? "active" : ""}" data-wd="${i}">${n}</button>`
  ).join("");
  box.querySelectorAll("[data-wd]").forEach((b) =>
    b.addEventListener("click", () => {
      state.schedWd = Number(b.dataset.wd);
      renderSchedChips();
      renderSchedList();
    })
  );
}

function renderSchedList() {
  const d = schedDateFor(state.schedWd);
  const iso = isoDate(d);
  $("#sched-date-label").textContent = d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  const items = state.routines.filter((r) => r.weekday === state.schedWd && r.active);
  const doneCount = items.filter((r) => (r.completions || []).includes(iso)).length;
  $("#sched-progress").textContent = items.length ? `${doneCount}/${items.length} done` : "None";
  $("#sched-progress").className = `badge ${items.length && doneCount === items.length ? "badge-low" : "badge-secondary"}`;
  $("#sched-list").innerHTML = items.length
    ? items
        .map((r) => {
          const done = (r.completions || []).includes(iso);
          return `
            <div class="flex items-center gap-3 px-4 py-3 hover:bg-accent/50">
              <button class="flex h-[19px] w-[19px] shrink-0 items-center justify-center rounded border ${done ? "border-emerald-500 bg-emerald-500 text-white" : "border-muted-foreground/40 hover:border-emerald-500"}" data-routine-toggle="${r.id}" data-date="${iso}">
                ${done ? `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>` : ""}
              </button>
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm font-medium ${done ? "text-muted-foreground line-through" : ""}">${escapeHtml(r.title)}</p>
              </div>
              ${r.time ? `<span class="badge badge-secondary">${r.time}</span>` : ""}
              ${canWrite() ? `<button class="tool-btn" data-redit="${r.id}" title="Edit"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/></svg></button>` : ""}
              ${isAdminUser() ? `<button class="tool-btn hover:text-destructive" data-rdel="${r.id}" title="Delete"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg></button>` : ""}
            </div>`;
        })
        .join("")
    : `<p class="p-10 text-center text-sm text-muted-foreground">No routines for this day</p>`;
  bindRoutineToggles($("#sched-list"));
  $("#sched-list").querySelectorAll("[data-redit]").forEach((b) =>
    b.addEventListener("click", () => routineDialog(state.routines.find((r) => r.id === Number(b.dataset.redit))))
  );
  $("#sched-list").querySelectorAll("[data-rdel]").forEach((b) =>
    b.addEventListener("click", () => {
      const id = Number(b.dataset.rdel);
      confirmDialog("Delete this routine?", async () => {
        await api(`/api/routines/${id}`, { method: "DELETE" });
        state.routines = state.routines.filter((r) => r.id !== id);
        renderSchedList();
        toast("Routine deleted");
      });
    })
  );
}

function routineDialog(routine = null) {
  if (!requireWrite(routine ? "edit routines" : "add routines")) return;
  const isEdit = !!routine;
  openDialog(`
    <h2 class="text-lg font-semibold">${isEdit ? "Edit routine" : "New routine"}</h2>
    <form id="routine-form" class="mt-4 space-y-4">
      <div class="space-y-1.5">
        <label class="text-sm font-medium">Title</label>
        <input id="routine-title" type="text" class="input" placeholder="e.g. Morning walk" value="${escapeHtml(routine?.title || "")}" required />
      </div>
      <div class="grid grid-cols-2 gap-4">
        <div class="space-y-1.5">
          <label class="text-sm font-medium">Day of week</label>
          <select id="routine-weekday" class="input">
            ${DAY_NAMES.map((n, i) => `<option value="${i}" ${routine?.weekday === i ? "selected" : ""}>${["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][i]}</option>`).join("")}
          </select>
        </div>
        <div class="space-y-1.5">
          <label class="text-sm font-medium">Time (optional)</label>
          <input id="routine-time" type="time" class="input" value="${routine?.time || ""}" />
        </div>
      </div>
      <div class="flex justify-end gap-2">
        <button type="button" class="btn btn-outline" data-cancel-dialog>Cancel</button>
        <button type="submit" class="btn btn-primary">${isEdit ? "Save changes" : "Add routine"}</button>
      </div>
    </form>
  `);
  $("#routine-form [data-cancel-dialog]").addEventListener("click", closeDialog);
  $("#routine-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = {
      title: $("#routine-title").value.trim(),
      weekday: Number($("#routine-weekday").value),
      time: $("#routine-time").value || null,
    };
    if (!payload.title) return;
    try {
      if (isEdit) {
        const updated = await api(`/api/routines/${routine.id}`, { method: "PATCH", body: JSON.stringify(payload) });
        const idx = state.routines.findIndex((r) => r.id === routine.id);
        state.routines[idx] = { ...updated, completions: routine.completions };
        toast("Routine updated");
      } else {
        const created = await api("/api/routines", { method: "POST", body: JSON.stringify(payload) });
        state.routines.push(created);
        toast("Routine added");
      }
      closeDialog();
      renderSchedList();
    } catch (err) {
      toast(err.message, "error");
    }
  });
  setTimeout(() => $("#routine-title").focus(), 40);
}

function renderCalendar() {
  const y = state.calY;
  const m = state.calM;
  $("#cal-label").textContent = `${MONTHS[m]} ${y}`;
  const first = new Date(y, m, 1);
  const startOffset = (first.getDay() + 6) % 7;
  const cells = [];
  const todayIso = isoDate(new Date());
  const tasksByDate = {};
  state.tasks.forEach((t) => {
    if (t.due_date) (tasksByDate[t.due_date] = tasksByDate[t.due_date] || []).push(t);
  });
  const notesByDate = {};
  (state.notes || []).forEach((n) => {
    const nd = String(n.created_at || "").slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(nd)) (notesByDate[nd] = notesByDate[nd] || []).push(n);
  });
  for (let i = 0; i < 42; i++) {
    const d = new Date(y, m, 1 - startOffset + i);
    cells.push(d);
  }
  let html = DAY_NAMES.map((n) => `<div class="calendar-head">${n}</div>`).join("");
  cells.forEach((d) => {
    const iso = isoDate(d);
    const wd = (d.getDay() + 6) % 7;
    const other = d.getMonth() !== m;
    const isToday = iso === todayIso;
    const dayTasks = (tasksByDate[iso] || []).filter((t) => !t.done).slice(0, 2);
    const extraTasks = (tasksByDate[iso] || []).filter((t) => !t.done).length - dayTasks.length;
    const allDayTasks = tasksByDate[iso] || [];
    const doneTasks = allDayTasks.filter((t) => t.done).length;
    const dayNotes = notesByDate[iso] || [];
    const dayRoutines = state.routines.filter((r) => r.active && r.weekday === wd);
    const routineChips = dayRoutines.slice(0, 2);
    const extraRoutines = dayRoutines.length - routineChips.length;
    const hols = HOLIDAYS[iso];
    const holBadges = hols
      ? hols
          .map(
            (h) =>
              `<span class="cal-hol ${h.country}" title="${escapeHtml(h.name)}${h.country === "pk" ? " (Pakistan)" : " (USA)"}">${h.name}</span>`
          )
          .join("")
      : "";
    const totalItems = allDayTasks.length + dayNotes.length + dayRoutines.length;
    const dotRow = [
      allDayTasks.length ? `<span class="cal-dot cal-dot-task" title="${allDayTasks.length} task${allDayTasks.length > 1 ? "s" : ""}${doneTasks ? ` · ${doneTasks} done` : ""}"></span>` : "",
      dayNotes.length ? `<span class="cal-dot cal-dot-note" title="${dayNotes.length} note${dayNotes.length > 1 ? "s" : ""}"></span>` : "",
      dayRoutines.length ? `<span class="cal-dot cal-dot-routine" title="${dayRoutines.length} routine${dayRoutines.length > 1 ? "s" : ""}"></span>` : "",
    ]
      .filter(Boolean)
      .join("");
    html += `
      <div class="cal-cell ${other ? "cal-other bg-muted/30" : ""} ${isToday ? "cal-today" : ""} ${holBadges ? "cal-holiday" : ""}" data-date="${iso}">
        <div class="mb-1 flex items-center justify-between">
          <span class="cal-day-num">${d.getDate()}</span>
          ${totalItems ? `<div class="cal-dots">${dotRow}</div>` : ""}
        </div>
        ${holBadges}
        ${dayRoutines
          .slice(0, 2)
          .map((r) => {
            const done = (r.completions || []).includes(iso);
            return `<span class="cal-chip routine ${done ? "cal-chip-done" : ""}" title="${escapeHtml(r.title)}${r.time ? " · " + escapeHtml(r.time) : ""}">${r.time ? `<b>${escapeHtml(r.time)}</b> ` : ""}${escapeHtml(r.title)}</span>`;
          })
          .join("")}
        ${extraRoutines > 0 ? `<span class="text-[9.5px] text-emerald-600 dark:text-emerald-400">+${extraRoutines} more</span>` : ""}
        ${dayTasks.map((t) => `<span class="cal-chip task" title="${escapeHtml(t.title)}">${escapeHtml(t.title)}</span>`).join("")}
        ${extraTasks > 0 ? `<span class="text-[9.5px] text-muted-foreground">+${extraTasks} more</span>` : ""}
        ${
          dayNotes.length
            ? `<span class="cal-chip note" title="${dayNotes.map((n) => escapeHtml(n.title)).join("\n")}">📝 ${dayNotes.length} note${dayNotes.length > 1 ? "s" : ""}</span>`
            : ""
        }
        ${
          doneTasks > 0
            ? `<span class="cal-done-row" title="${doneTasks} completed task${doneTasks > 1 ? "s" : ""}"><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg> ${doneTasks} done</span>`
            : ""
        }
      </div>`;
  });
  const grid = $("#calendar-grid");
  grid.innerHTML = html;
  grid.querySelectorAll(".cal-cell").forEach((c) =>
    c.addEventListener("click", () => dayDialog(c.dataset.date))
  );
}

function dayDialog(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  const wd = (d.getDay() + 6) % 7;
  const tasks = (state.tasks || []).filter((t) => t.due_date === dateStr);
  const doneTasks = tasks.filter((t) => t.done);
  const openTasks = tasks.filter((t) => !t.done);
  const notes = (state.notes || []).filter(
    (n) => String(n.created_at || "").slice(0, 10) === dateStr
  );
  const routines = state.routines.filter((r) => r.active && r.weekday === wd);
  const hols = HOLIDAYS[dateStr] || [];
  const totalAll = tasks.length + notes.length + routines.length;
  openDialog(`
    <div class="flex items-center justify-between">
      <h2 class="text-lg font-semibold">${d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</h2>
      <button type="button" class="btn btn-ghost btn-icon" data-close-x>✕</button>
    </div>
    <p class="mt-0.5 text-xs text-muted-foreground">
      ${
        totalAll
          ? `${tasks.length} task${tasks.length === 1 ? "" : "s"} (${doneTasks.length} done) · ${notes.length} note${notes.length === 1 ? "" : "s"} · ${routines.length} routine${routines.length === 1 ? "" : "s"}`
          : "Nothing planned yet"
      }
    </p>
    ${
      hols.length
        ? `<div class="mt-3 flex flex-wrap gap-1.5">${hols
            .map(
              (h) =>
                `<span class="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ${h.country === "pk" ? "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400" : "bg-sky-500/12 text-sky-600 dark:text-sky-400"}">● ${escapeHtml(h.name)}${h.country === "pk" ? " 🇵🇰" : " 🇺🇸"}</span>`
            )
            .join("")}</div>`
        : ""
    }
    <div class="mt-4 space-y-4">
      <div>
        <p class="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Tasks (${openTasks.length} open · ${doneTasks.length} done)</p>
        ${
          tasks.length
            ? `<div class="space-y-1.5">${tasks
                .map(
                  (t) => `
                  <div class="flex items-center gap-2.5 rounded-lg border border-border p-2.5 transition-colors hover:bg-accent/40">
                    <button class="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded border ${t.done ? "border-emerald-500 bg-emerald-500 text-white" : "border-muted-foreground/40 hover:border-primary"}" data-day-task-toggle="${t.id}">
                      ${t.done ? `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>` : ""}
                    </button>
                    <span class="min-w-0 flex-1 truncate text-sm ${t.done ? "text-muted-foreground line-through" : ""}" data-day-open-task="${t.id}">${escapeHtml(t.title)}</span>
                    ${priorityBadge(t.priority)}
                    <button class="tool-btn hover:text-destructive" data-day-task-del="${t.id}" title="Delete"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg></button>
                  </div>`
                )
                .join("")}</div>`
            : `<p class="text-sm text-muted-foreground">Nothing scheduled</p>`
        }
        <button type="button" class="btn btn-outline btn-sm mt-2 w-full" data-day-add-task>+ Add task on this date</button>
      </div>
      <div>
        <p class="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Notes (${notes.length})</p>
        ${
          notes.length
            ? `<div class="space-y-1.5">${notes
                .map(
                  (n) => `
                  <div class="flex cursor-pointer items-center gap-2.5 rounded-lg border border-border p-2.5 transition-colors hover:bg-accent/40" data-day-note="${n.id}">
                    <span class="text-base leading-none">📝</span>
                    <span class="min-w-0 flex-1 truncate text-sm">${escapeHtml(n.title) || "Untitled"}</span>
                    ${n.pinned ? `<span title="Pinned">📌</span>` : ""}
                  </div>`
                )
                .join("")}</div>`
            : `<p class="text-sm text-muted-foreground">No notes created on this date</p>`
        }
      </div>
      <div>
        <p class="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Routines (${routines.length})</p>
        ${
          routines.length
            ? `<div class="space-y-1.5">${routines
                .map((r) => {
                  const done = (r.completions || []).includes(dateStr);
                  return `
                    <div class="flex items-center gap-2.5 rounded-lg border border-border p-2.5">
                      <button class="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded border ${done ? "border-emerald-500 bg-emerald-500 text-white" : "border-muted-foreground/40"}" data-day-toggle="${r.id}">
                        ${done ? `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>` : ""}
                      </button>
                      <span class="min-w-0 flex-1 truncate text-sm">${escapeHtml(r.title)}</span>
                      ${r.time ? `<span class="badge badge-secondary">${r.time}</span>` : ""}
                    </div>`;
                })
                .join("")}</div>`
            : `<p class="text-sm text-muted-foreground">None for this day</p>`
        }
      </div>
    </div>
  `);
  $("#dialog-root [data-close-x]").addEventListener("click", closeDialog);
  $$("#dialog-root [data-day-task-toggle]").forEach((b) =>
    b.addEventListener("click", async () => {
      const id = Number(b.dataset.dayTaskToggle);
      const t = state.tasks.find((x) => x.id === id);
      if (!t) return;
      try {
        const updated = await api(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify({ done: !t.done }) });
        Object.assign(t, updated);
        toast(updated.done ? "Task completed" : "Task reopened");
        dayDialog(dateStr);
        renderCalendar();
      } catch (err) {
        toast(err.message, "error");
      }
    })
  );
  $$("#dialog-root [data-day-task-del]").forEach((b) =>
    b.addEventListener("click", async () => {
      const id = Number(b.dataset.dayTaskDel);
      confirmDialog("Delete this task?", async () => {
        try {
          await api(`/api/tasks/${id}`, { method: "DELETE" });
          state.tasks = state.tasks.filter((x) => x.id !== id);
          toast("Task deleted");
          dayDialog(dateStr);
          renderCalendar();
        } catch (err) {
          toast(err.message, "error");
        }
      });
    })
  );
  $("#dialog-root [data-day-add-task]").addEventListener("click", () =>
    taskDialog(null, dateStr)
  );
  $$("#dialog-root [data-day-note]").forEach((el) =>
    el.addEventListener("click", () => {
      closeDialog();
      openViewer(Number(el.dataset.dayNote), "calendar");
    })
  );
  $$("#dialog-root [data-day-toggle]").forEach((b) =>
    b.addEventListener("click", async () => {
      const id = Number(b.dataset.dayToggle);
      const res = await api(`/api/routines/${id}/toggle`, { method: "POST", body: JSON.stringify({ date: dateStr }) });
      const r = state.routines.find((x) => x.id === id);
      if (r) {
        r.completions = r.completions || [];
        r.completions = res.done ? [...new Set([...r.completions, dateStr])] : r.completions.filter((x) => x !== dateStr);
      }
      dayDialog(dateStr);
      if (state.calY === new Date().getFullYear() && state.calM === new Date().getMonth()) renderCalendar();
    })
  );
}

function initApp() {
  appStarted = true;
  const now = new Date();
  $("#today-date").textContent = now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  wireUserMenu();
  applyRoleUI();

  // World clocks: Pakistan + Burr Ridge, IL
  const fmtPK = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "Asia/Karachi" });
  const fmtUS = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "America/Chicago" });
  const tickClocks = () => {
    const t = new Date();
    const pk = $("#clock-pk");
    const us = $("#clock-us");
    if (!pk || !us) return;
    pk.textContent = fmtPK.format(t);
    us.textContent = fmtUS.format(t);
  };
  tickClocks();
  setInterval(tickClocks, 30000);

  $$(".nav-link").forEach((n) => n.addEventListener("click", (e) => {
    e.preventDefault();
    switchView(n.dataset.view);
  }));
  $$("[data-goto]").forEach((b) => b.addEventListener("click", () => switchView(b.dataset.goto)));

  $("#sidebar-toggle").addEventListener("click", () => document.body.classList.toggle("sidebar-open"));
  $("#sidebar-overlay").addEventListener("click", () => document.body.classList.remove("sidebar-open"));

  $("#sidebar-theme-toggle").addEventListener("click", () => applyTheme(document.documentElement.classList.contains("dark") ? "light" : "dark"));
  $("#header-theme-toggle").addEventListener("click", () => applyTheme(document.documentElement.classList.contains("dark") ? "light" : "dark"));
  $("#theme-dark-btn").addEventListener("click", () => applyTheme("dark"));
  $("#theme-light-btn").addEventListener("click", () => applyTheme("light"));
  syncThemeUI();

  $$(".task-tab").forEach((tab) =>
    tab.addEventListener("click", () => {
      state.taskFilter = tab.dataset.filter;
      $$(".task-tab").forEach((t) => t.classList.toggle("active", t === tab));
      renderTasks();
    })
  );
  $("#tasks-add-btn").addEventListener("click", () => taskDialog());
  $("#sched-add-btn").addEventListener("click", () => routineDialog());
  $("#sched-add-btn").addEventListener("click", () => {});
  $("#notes-add-btn").addEventListener("click", () => openEditor(null));
  $("#pages-add-btn").addEventListener("click", () => pageCreateDialog());

  // Page detail bindings
  $("#page-back-btn").addEventListener("click", () => showPagesList());
  $("#page-icon-btn").addEventListener("click", () => {
    openIconPickerDialog(async (em) => {
      const p = state.pages.find((x) => x.id === state.currentPageId);
      if (!p) return;
      try {
        const updated = await api(`/api/pages/${p.id}`, { method: "PUT", body: JSON.stringify({ icon: em }) });
        Object.assign(p, updated);
        renderPageDetail();
        toast(em ? "Icon updated" : "Icon removed");
      } catch (e) {
        toast(e.message, "error");
      }
    });
  });
  const savePageTitle = async () => {
    const p = state.pages.find((x) => x.id === state.currentPageId);
    if (!p) return;
    const val = $("#page-title-input").value.trim();
    if (!val) {
      $("#page-title-input").value = p.title;
      return;
    }
    if (val === p.title) return;
    try {
      const updated = await api(`/api/pages/${p.id}`, { method: "PUT", body: JSON.stringify({ title: val }) });
      Object.assign(p, updated);
      renderPageDetail();
    } catch (e) {
      toast(e.message, "error");
    }
  };
  $("#page-title-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.target.blur();
    }
  });
  $("#page-title-input").addEventListener("blur", savePageTitle);

  $("#page-note-new-btn").addEventListener("click", async () => {
    const pid = state.currentPageId;
    if (pid == null) return;
    try {
      const created = await api("/api/notes", { method: "POST", body: JSON.stringify({ title: "Untitled note", content: "", page_id: pid }) });
      state.notes.unshift(created);
      state.returnTo = "page";
      openEditor(created.id, "note");
    } catch (e) {
      toast(e.message, "error");
    }
  });

  $("#page-note-link-btn").addEventListener("click", () => linkExistingDialog("note"));
  $("#page-task-link-btn").addEventListener("click", () => linkExistingDialog("task"));

  $("#page-task-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pid = state.currentPageId;
    if (pid == null) return;
    const input = $("#page-task-input");
    const title = input.value.trim();
    if (!title) return;
    const due = $("#page-task-date").value || null;
    try {
      const created = await api("/api/tasks", { method: "POST", body: JSON.stringify({ title, due_date: due, page_id: pid }) });
      state.tasks.unshift(created);
      input.value = "";
      $("#page-task-date").value = "";
      renderPageDetail();
      toast(due ? "Reminder added" : "Task added");
    } catch (err) {
      toast(err.message, "error");
    }
  });
  $("#notes-search").addEventListener("input", (e) => {
    state.noteQuery = e.target.value;
    clearTimeout(renderNotesGrid._t);
    renderNotesGrid._t = setTimeout(renderNotesGrid, 120);
  });

  const deepToggle = $("#deep-search-toggle");
  if (deepToggle) {
    deepToggle.checked = localStorage.getItem("nb_deep_search") === "1";
    state.deepSearch = deepToggle.checked;
    deepToggle.addEventListener("change", () => {
      state.deepSearch = deepToggle.checked;
      localStorage.setItem("nb_deep_search", deepToggle.checked ? "1" : "0");
      renderNotesGrid();
    });
  }

  $("#cal-prev").addEventListener("click", () => {
    state.calM--;
    if (state.calM < 0) {
      state.calM = 11;
      state.calY--;
    }
    HOLIDAYS = buildHolidaysForYear(state.calY);
    renderCalendar();
  });
  $("#cal-next").addEventListener("click", () => {
    state.calM++;
    if (state.calM > 11) {
      state.calM = 0;
      state.calY++;
    }
    HOLIDAYS = buildHolidaysForYear(state.calY);
    renderCalendar();
  });
  $("#cal-today-btn").addEventListener("click", () => {
    state.calY = new Date().getFullYear();
    state.calM = new Date().getMonth();
    HOLIDAYS = buildHolidaysForYear(state.calY);
    renderCalendar();
  });

  $("#editor-overlay").addEventListener("mousedown", (e) => {
    if (e.target.id === "editor-overlay") exitToNotesList();
  });

  $("#import-sqlite-btn").addEventListener("click", () => {
    const file = $("#import-sqlite-file").files[0];
    const status = $("#import-sqlite-status");
    if (!file) {
      toast("Choose a .sqlite backup first", "error");
      return;
    }
    const doRestore = async () => {
      status.textContent = "Restoring...";
      try {
        const fd = new FormData();
        fd.append("file", file);
        await api("/api/import/sqlite", { method: "POST", body: fd });
        status.textContent = "Restored";
        toast("Database restored — reloading");
        setTimeout(() => location.reload(), 900);
      } catch (e) {
        status.textContent = "";
        toast(e.message, "error");
      }
    };
    confirmDialog("Replace ALL current data with this SQLite snapshot?", doRestore, "Restore");
  });

  $("#import-excel-btn").addEventListener("click", async () => {
    const file = $("#import-excel-file").files[0];
    const status = $("#import-excel-status");
    if (!file) {
      toast("Choose an .xlsx workbook first", "error");
      return;
    }
    const mode = document.querySelector('input[name="excel-import-mode"]:checked').value;
    const doImport = async () => {
      status.textContent = "Importing...";
      try {
        const fd = new FormData();
        fd.append("file", file);
        fd.append("mode", mode);
        const res = await api("/api/import/excel", { method: "POST", body: fd });
        status.textContent = `Done — imported ${res.imported}, skipped ${res.skipped}`;
        toast(`Excel imported (${mode})`);
        await loadAll();
      } catch (e) {
        status.textContent = "";
        toast(e.message, "error");
      }
    };
    if (mode === "replace") {
      confirmDialog("Replace ALL current data with this Excel workbook?", doImport, "Replace");
    } else doImport();
  });

  // Custom "Choose file" buttons (native file input is hidden)
  [
    ["#pick-json-btn", "#import-file", "#json-file-name"],
    ["#pick-sqlite-btn", "#import-sqlite-file", "#sqlite-file-name"],
    ["#pick-excel-btn", "#import-excel-file", "#excel-file-name"],
  ].forEach(([pickSel, inputSel, nameSel]) => {
    const pick = $(pickSel);
    const inp = $(inputSel);
    const name = $(nameSel);
    pick.addEventListener("click", () => inp.click());
    inp.addEventListener("change", () => {
      name.textContent = inp.files[0]?.name || "No file chosen";
    });
  });

  $("#import-btn").addEventListener("click", async () => {
    const file = $("#import-file").files[0];
    const status = $("#import-status");
    if (!file) {
      toast("Choose a backup file first", "error");
      return;
    }
    const mode = document.querySelector('input[name="import-mode"]:checked').value;
    const doImport = async () => {
      status.textContent = "Importing...";
      try {
        const fd = new FormData();
        fd.append("file", file);
        fd.append("mode", mode);
        const res = await api("/api/import", { method: "POST", body: fd });
        status.textContent = `Done — imported ${res.imported}, skipped ${res.skipped}`;
        toast(`Backup restored (${mode})`);
        await loadAll();
      } catch (e) {
        status.textContent = "";
        toast(e.message, "error");
      }
    };
    if (mode === "replace") {
      confirmDialog("Replace ALL current data with backup?", doImport, "Replace");
    } else doImport();
  });

  $("#reset-btn").addEventListener("click", () => {
    confirmDialog("Delete ALL data permanently? This cannot be undone.", async () => {
      await api("/api/reset", { method: "POST" });
      toast("All data erased");
      await loadAll();
      loadDashboard();
    }, "Reset");
  });

  initEditorToolbar();
  initResizeHandles();

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && ["p", "k"].includes(e.key.toLowerCase())) {
      e.preventDefault();
      openPalette();
    } else if (e.key === "Escape") {
      closeDialog();
      closePalette();
      closePopovers();
    }
  });

  $("#quick-search-btn").addEventListener("click", openPalette);

  // ---------- Delegated clicks (survive re-renders; no more dead cards) ----------
  document.addEventListener("click", (e) => {
    const noteCard = e.target.closest("[data-note]");
    if (noteCard) {
      const id = Number(noteCard.dataset.note);
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (!act) {
        openViewer(id);
        return;
      }
      if (act === "view") openViewer(id);
      else if (act === "edit") openEditor(id);
      else if (act === "del") {
        confirmDialog("Delete this note?", async () => {
          await api(`/api/notes/${id}`, { method: "DELETE" });
          state.notes = state.notes.filter((n) => n.id !== id);
          renderNotesGrid();
          toast("Note deleted");
        });
      }
      return;
    }

    const pageCard = e.target.closest("[data-page]");
    if (pageCard) {
      const id = Number(pageCard.dataset.page);
      if (e.target.closest('[data-pact="del"]')) {
        confirmDialog("Delete this page? Its notes and tasks will be kept.", async () => {
          await api(`/api/pages/${id}`, { method: "DELETE" });
          state.notes.forEach((n) => { if (n.page_id === id) n.page_id = null; });
          state.tasks.forEach((t) => { if (t.page_id === id) t.page_id = null; });
          state.pages = state.pages.filter((p) => p.id !== id);
          renderPagesGrid();
          toast("Page deleted");
        });
        return;
      }
      showPageDetail(id);
      return;
    }

    const pnoteRow = e.target.closest("[data-pnote]");
    if (pnoteRow) {
      const nid = Number(pnoteRow.dataset.pnote);
      const pact = e.target.closest("[data-pnact]")?.dataset.pnact;
      if (!pact) {
        openViewer(nid, "page");
        return;
      }
      if (pact === "unlink") setNotePage(nid, null);
      else if (pact === "del") {
        confirmDialog("Delete this note permanently?", async () => {
          await api(`/api/notes/${nid}`, { method: "DELETE" });
          state.notes = state.notes.filter((n) => n.id !== nid);
          renderPageDetail();
          toast("Note deleted");
        });
      }
      return;
    }

    const ptoggle = e.target.closest("[data-ptoggle]");
    if (ptoggle) {
      e.stopPropagation();
      const tid = Number(ptoggle.dataset.ptoggle);
      const task = state.tasks.find((t) => t.id === tid);
      api(`/api/tasks/${tid}`, { method: "PATCH", body: JSON.stringify({ done: !task.done }) })
        .then((updated) => {
          Object.assign(task, updated);
          renderPageDetail();
          toast(updated.done ? "Task completed ✓" : "Marked pending");
        })
        .catch((err) => toast(err.message, "error"));
      return;
    }

    const ptact = e.target.closest("[data-ptact]");
    if (ptact) {
      e.stopPropagation();
      const row = ptact.closest("[data-ptask]");
      const tid = Number(row.dataset.ptask);
      if (ptact.dataset.ptact === "unlink") setTaskPage(tid, null);
      else {
        confirmDialog("Delete this task permanently?", async () => {
          await api(`/api/tasks/${tid}`, { method: "DELETE" });
          state.tasks = state.tasks.filter((t) => t.id !== tid);
          renderPageDetail();
          toast("Task deleted");
        });
      }
      return;
    }

    if (e.target.closest("#tasks-list")) {
      const tg = e.target.closest("[data-toggle]");
      if (tg) {
        e.stopPropagation();
        const id = Number(tg.dataset.toggle);
        const task = state.tasks.find((t) => t.id === id);
        api(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify({ done: !task.done }) })
          .then((updated) => {
            Object.assign(task, updated);
            renderTasks();
            toast(updated.done ? "Task completed ✓" : "Marked pending");
          })
          .catch((err) => toast(err.message, "error"));
        return;
      }
      const ed = e.target.closest("[data-edit]");
      if (ed) {
        taskDialog(state.tasks.find((t) => t.id === Number(ed.dataset.edit)));
        return;
      }
      const del = e.target.closest("[data-del]");
      if (del) {
        const id = Number(del.dataset.del);
        confirmDialog("Delete this task?", async () => {
          await api(`/api/tasks/${id}`, { method: "DELETE" });
          state.tasks = state.tasks.filter((t) => t.id !== id);
          renderTasks();
          toast("Task deleted");
        });
      }
    }
  });

  // Brand icon acts like a hamburger: collapse/expand the sidebar (desktop), close drawer (mobile)
  $("#brand-toggle").addEventListener("click", () => {
    if (window.innerWidth < 768) {
      document.body.classList.remove("sidebar-open");
      return;
    }
    const mini = document.body.classList.toggle("sidebar-mini");
    if (mini) localStorage.setItem("nb_sidebar_mini", "1");
    else localStorage.removeItem("nb_sidebar_mini");
  });
  $$(".nav-link").forEach((n) => {
    n.title = n.querySelector("span")?.textContent || "";
  });

  // ---------- Table editing: floating toolbar with row/column controls ----------
  (() => {
    const ed = $("#note-content-input");
    const tb = $("#table-toolbar");
    const trh = $("#table-resize-handle");
    if (!ed || !tb) return;
    let ctx = null; // { table, cell }

    function hideTableToolbar() {
      tb.classList.add("hidden");
      trh?.classList.add("hidden");
      ctx = null;
    }

    function positionTableToolbar() {
      if (!ctx) return;
      tb.classList.remove("hidden");
      const card = ed.closest(".card");
      const hr = (card || document.body).getBoundingClientRect();
      const r = ctx.table.getBoundingClientRect();
      let top = r.top - hr.top - 36;
      if (top < 4) top = r.bottom - hr.top + 6;
      const left = Math.max(4, Math.min(r.right - hr.left - tb.offsetWidth, hr.width - tb.offsetWidth - 8));
      tb.style.top = top + "px";
      tb.style.left = left + "px";
      if (trh) {
        trh.style.left = r.right - 5 + "px";
        trh.style.top = r.bottom - 5 + "px";
        trh.classList.remove("hidden");
      }
    }

    function setCellContext(cell) {
      const table = cell.closest("table");
      if (!table || !ed.contains(table)) {
        hideTableToolbar();
        return;
      }
      ctx = { table, cell };
      positionTableToolbar();
    }

    function makeRow(refRow) {
      const tr = document.createElement("tr");
      [...refRow.cells].forEach((c) => {
        const nc = document.createElement(c.tagName.toLowerCase());
        nc.style.cssText = c.style.cssText;
        nc.innerHTML = "<br>";
        tr.appendChild(nc);
      });
      return tr;
    }

    function ensureColgroup(table, cols) {
      let cg = table.querySelector("colgroup");
      if (!cg) {
        cg = document.createElement("colgroup");
        table.prepend(cg);
      }
      while (cg.children.length < cols) cg.appendChild(document.createElement("col"));
      return cg;
    }

    function runAction(act) {
      if (!ctx || !document.body.contains(ctx.table)) return;
      const { table, cell } = ctx;
      const ri = cell.parentElement.rowIndex;
      const ci = cell.cellIndex;

      if (act === "add-row") {
        const ref = cell.parentElement;
        ref.parentElement.insertBefore(makeRow(ref), ref.nextSibling);
      } else if (act === "del-row") {
        const rows = [...table.querySelectorAll("tr")];
        if (rows.length > 1) cell.parentElement.remove();
        else return toast("Table needs at least one row", "error");
      } else if (act === "add-col") {
        const cols = Math.max(...[...table.rows].map((r) => r.cells.length));
        [...table.rows].forEach((r) => {
          const ref = r.cells[Math.min(ci, r.cells.length - 1)];
          const nc = document.createElement(ref.tagName.toLowerCase());
          nc.style.cssText = ref.style.cssText;
          nc.innerHTML = "<br>";
          r.insertBefore(nc, ref.nextSibling);
        });
        ensureColgroup(table, cols + 1);
      } else if (act === "del-col") {
        const cols = Math.max(...[...table.rows].map((r) => r.cells.length));
        if (cols <= 1) return toast("Table needs at least one column", "error");
        [...table.rows].forEach((r) => r.cells[ci]?.remove());
        const cg = table.querySelector("colgroup");
        if (cg && cg.children[ci]) cg.children[ci].remove();
      } else if (act === "del-table") {
        confirmDialog("Delete this entire table?", () => {
          table.remove();
          markDirty();
          hideTableToolbar();
          toast("Table deleted");
        }, "Delete");
        return;
      }
      markDirty();
      // Re-acquire a valid cell reference after structural changes, then repaint
      const rows = [...table.querySelectorAll("tr")];
      const nr = rows[Math.min(Math.max(ri, 0), rows.length - 1)];
      ctx.cell = nr?.cells[Math.min(ci, nr.cells.length - 1)] || null;
      if (!ctx.cell) return hideTableToolbar();
      positionTableToolbar();
    }

    ed.addEventListener("click", (e) => {
      const cell = e.target.closest("td, th");
      if (cell && ed.contains(cell)) setCellContext(cell);
      else hideTableToolbar();
    });
    ed.addEventListener("input", hideTableToolbar);
    ed.addEventListener("scroll", () => {
      if (ctx) positionTableToolbar();
      else hideTableToolbar();
    });

    tb.querySelectorAll("button[data-tact]").forEach((b) =>
      b.addEventListener("mousedown", (e) => e.preventDefault())
    );
    tb.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-tact]");
      if (!btn) return;
      e.stopPropagation();
      runAction(btn.dataset.tact);
    });

    document.addEventListener("mousedown", (e) => {
      if (!tb.classList.contains("hidden") && !tb.contains(e.target) && e.target !== trh && !e.target.closest("td, th")) {
        hideTableToolbar();
      }
    });
    window.addEventListener("resize", () => {
      if (ctx) positionTableToolbar();
      else hideTableToolbar();
    });

    // Word-style whole-table resize: drag the bottom-right corner handle
    if (trh) {
      trh.addEventListener("mousedown", (e) => {
        if (!ctx) return;
        e.preventDefault();
        e.stopPropagation();
        const table = ctx.table;
        const x0 = e.clientX;
        const startW = table.getBoundingClientRect().width;
        const maxW = ed.clientWidth - 48;
        const colCount = Math.max(...[...table.rows].map((r) => r.cells.length), 1);
        const colWidths = [];
        for (let i = 0; i < colCount; i++) {
          const c = table.rows[0]?.cells[i];
          colWidths.push(c ? c.getBoundingClientRect().width : startW / colCount);
        }
        const applyScale = (newW) => {
          const scale = newW / startW;
          table.style.width = newW + "px";
          [...table.rows].forEach((row) =>
            [...row.cells].forEach((c, i) => {
              c.style.width = Math.max(28, Math.round((colWidths[i] || 0) * scale)) + "px";
            })
          );
          const cg = table.querySelector("colgroup");
          if (cg)
            [...cg.children].forEach((col, i) => {
              if (colWidths[i]) col.style.width = Math.max(28, Math.round(colWidths[i] * scale)) + "px";
            });
        };
        const move = (ev) => {
          const newW = Math.max(colCount * 36, Math.min(Math.round(startW + ev.clientX - x0), maxW));
          applyScale(newW);
          if (ctx) {
            const rr = ctx.table.getBoundingClientRect();
            trh.style.left = rr.right - 5 + "px";
            trh.style.top = rr.bottom - 5 + "px";
          }
        };
        const up = () => {
          document.removeEventListener("mousemove", move);
          document.removeEventListener("mouseup", up);
          markDirty();
        };
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", up);
      });
      trh.addEventListener("dblclick", () => {
        if (!ctx) return;
        ctx.table.style.width = "";
        markDirty();
      });
    }
  })();

  // ---------- Table column/row resize (drag cell borders) ----------
  (() => {
    const ed = $("#note-content-input");
    const EDGE = 6;
    let mode = null;

    ed.addEventListener("mousemove", (e) => {
      const cell = e.target.closest("td, th");
      if (!cell || !ed.contains(cell)) {
        if (ed.style.cursor) ed.style.cursor = "";
        mode = null;
        return;
      }
      const r = cell.getBoundingClientRect();
      if (r.right - e.clientX <= EDGE && e.clientX >= r.left) {
        ed.style.cursor = "col-resize";
        mode = { type: "col", cell };
      } else if (r.bottom - e.clientY <= EDGE && e.clientY >= r.top) {
        ed.style.cursor = "row-resize";
        mode = { type: "row", cell };
      } else if (ed.style.cursor) {
        ed.style.cursor = "";
        mode = null;
      }
    });
    ed.addEventListener("mouseleave", () => {
      ed.style.cursor = "";
      mode = null;
    });

    ed.addEventListener("mousedown", (e) => {
      if (!mode) return;
      e.preventDefault();
      e.stopPropagation();
      const { type, cell } = mode;
      const table = cell.closest("table");
      const ci = cell.cellIndex;
      const ri = cell.parentElement.rowIndex;

      let start, apply;
      if (type === "col") {
        start = table.rows[0].cells[ci].getBoundingClientRect().width;
        const colEl = table.querySelector("colgroup")?.children[ci];
        const cells = [...table.rows].map((row) => row.cells[ci]).filter(Boolean);
        apply = (delta) => {
          const w = Math.max(28, Math.round(start + delta));
          if (colEl) colEl.style.width = w + "px";
          cells.forEach((c) => (c.style.width = w + "px"));
        };
      } else {
        start = cell.getBoundingClientRect().height;
        const cells = [...table.rows[ri].cells];
        apply = (delta) => {
          const h = Math.max(24, Math.round(start + delta));
          cells.forEach((c) => (c.style.height = h + "px"));
        };
      }

      ed.style.cursor = "";
      mode = null;
      const x0 = e.clientX;
      const y0 = e.clientY;
      const move = (ev) => apply(type === "col" ? ev.clientX - x0 : ev.clientY - y0);
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        markDirty();
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
  })();

  // ---------- Date pickers open on field click ----------
  document.addEventListener("click", (e) => {
    const inp = e.target.closest('input[type="date"]');
    if (!inp || !inp.showPicker) return;
    try {
      inp.showPicker();
    } catch (_) {}
  });

  const initialHash = location.hash;
  const bootSegs = initialHash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const BOOT_VIEWS = ["tasks", "notes", "pages", "schedule", "calendar", "settings"];
  const viewerLocked = state.user?.role === "user" && ["tasks", "schedule", "calendar", "settings"].includes(bootSegs[0]);
  if (bootSegs.length && BOOT_VIEWS.includes(bootSegs[0]) && !viewerLocked) {
    // Deep-link boot: show the target shell instantly so dashboard never flashes
    switchViewShell(bootSegs[0]);
    state.view = bootSegs[0];
  } else {
    switchView("dashboard");
  }
  loadAll()
    .then(() => {
      const segs = initialHash.replace(/^#\/?/, "").split("/").filter(Boolean);
      const v = segs[0];
      const VIEWS = ["tasks", "notes", "pages", "schedule", "calendar", "settings"];
      if (v === "pages") {
        const pid = Number(segs[1]);
        if (segs[1] && state.pages.some((p) => p.id === pid)) showPageDetail(pid);
        else switchView("pages");
      } else if (v === "notes" && segs[1] && state.notes.some((n) => n.id === Number(segs[1]))) {
        switchView("notes");
        openViewer(Number(segs[1]));
      } else if (VIEWS.includes(v)) {
        switchView(v);
      } else {
        loadDashboard();
      }
    })
    .catch((e) => toast(e.message, "error"));
}

document.addEventListener("DOMContentLoaded", boot);
