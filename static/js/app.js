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
const VIEW_TITLES = { dashboard: "Dashboard", tasks: "Tasks", notes: "Notes", pages: "Pages", webportals: "Web portals", schedule: "Schedule", calendar: "Calendar", settings: "Settings", chat: "Chat", knowledge: "Knowledge Base", "chat-settings": "AI Models", agents: "Agents" };

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
  if (state.user?.role === "user" && ["tasks", "schedule", "calendar", "settings", "chat", "knowledge", "chat-settings", "agents"].includes(name)) {
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
  else if (name === "webportals") loadPortals();
  else if (name === "schedule") loadSchedule();
  else if (name === "chat") loadChat();
  else if (name === "knowledge") loadKnowledge();
  else if (name === "chat-settings") loadChatSettings();
  else if (name === "agents") loadAgents();
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
  clearTimeout(markDirty._t);
  markDirty._t = null;
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
        <div class="mt-3 flex items-center gap-1.5">
          <span class="text-[10px] text-muted-foreground">${relTime(p.updated_at)}</span>
          ${creatorChip(p)}
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
  ["#tasks-add-btn", "#sched-add-btn", "#notes-add-btn", "#pages-add-btn", "#viewer-edit-btn", "#knowledge-add-btn"].forEach((sel) => {
    const el = $(sel);
    if (el) el.classList.toggle("hidden", !w);
  });
  // Destructive / replace-all operations are admin-only
  ["#reset-btn", "#import-btn", "#import-sqlite-btn", "#import-excel-btn"].forEach((sel) => {
    const el = $(sel);
    if (el) el.classList.toggle("hidden", !isAdminUser());
  });
  // View-only users see only Dashboard, Notes & Pages
  const restricted = new Set(["tasks", "schedule", "calendar", "settings", "chat", "knowledge", "chat-settings", "agents"]);
  const isViewer = state.user?.role === "user";
  // Page detail: hide write controls for viewers (backend still enforces 403)
  const pageIconBtn = $("#page-icon-btn");
  if (pageIconBtn && isViewer) {
    pageIconBtn.classList.add("pointer-events-none", "opacity-70");
    pageIconBtn.title = "View only account";
  }
  ["#page-note-new-btn", "#page-note-link-btn", "#page-task-form", "#page-task-link-btn"].forEach((sel) => {
    const el = $(sel);
    if (el) el.classList.toggle("hidden", isViewer);
  });
  const pageTitleInput = $("#page-title-input");
  if (pageTitleInput) {
    pageTitleInput.readOnly = isViewer;
    pageTitleInput.classList.toggle("cursor-default", isViewer);
  }
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
    <div class="mt-4 max-h-[50vh] overflow-x-auto overflow-y-auto">
      <table class="w-full min-w-[32rem]">
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
  state.pages.forEach((p) =>
    out.push({
      kind: "page",
      id: p.id,
      icon: p.icon || "📄",
      title: p.title || "Untitled",
      sub: `Page · ${state.notes.filter((x) => x.page_id === p.id).length} notes · updated ${relTime(p.updated_at)}`,
      hay: `${p.title || ""} ${getStripped(p) || ""}`.toLowerCase(),
      raw: `${p.title || ""} ${getStripped(p) || ""}`,
      ts: p.updated_at || "",
    })
  );
  state.notes.forEach((n) => {
    const text = getStripped(n);
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
  getPortals().forEach((pt) =>
    out.push({
      kind: "portal",
      id: null,
      icon: pt.type === "sheet" ? "📊" : "🌐",
      title: pt.name,
      sub: `Portal · ${pt.type === "sheet" ? "Google Sheet" : "Website"}${pt.notes ? ` · ${pt.notes}` : ""}`,
      hay: `${pt.name} ${pt.notes || ""} ${hostOf(pt.url)}`.toLowerCase(),
      raw: `${pt.name} ${pt.notes || ""}`,
      ts: "",
      url: pt.url,
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
  const lists = [by("page"), by("note"), by("task"), by("routine"), by("portal")].filter((l) => l.length);
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

const PAL_LABELS = { action: "Actions", page: "Pages", note: "Notes", task: "Tasks", routine: "Routines", portal: "Web portals" };

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
    statsEl.textContent = `${state.pages.length} pages · ${state.notes.length} notes · ${state.tasks.length} tasks · ${getPortals().length} portals`;
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
  else if (it.kind === "portal") {
    const url = normalUrl(it.url);
    if (url) window.open(url, "_blank", "noopener");
  }
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
        <input id="palette-input" type="text" autocomplete="off" spellcheck="false" placeholder="Search pages, notes, tasks, routines, portals..." class="w-full border-0 bg-transparent p-0 text-base outline-none placeholder:text-muted-foreground/60" />
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
  if (!$("#notes-editor-wrap").classList.contains("hidden")) {
    // Landing on a page from the palette/nav while a note editor is open:
    // flush pending changes, drop the overlay, and cancel the back-navigation flag.
    await flushPendingSave();
    hideImgToolbar();
    hideColHandle();
    setEditorOverlay(false);
    $("#notes-editor-wrap").classList.add("hidden");
    state.returnTo = null;
  }
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
            ${canWrite() ? `<div class="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
              <button class="tool-btn h-7 min-w-7" data-pnact="unlink" title="Remove from page"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18.84 12.25l1.72-1.71a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M5.17 11.75l-1.72 1.71a5 5 0 0 0 7.07 7.07l1.72-1.71"/></svg></button>
              <button class="tool-btn h-7 min-w-7 hover:text-destructive" data-pnact="del" title="Delete"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg></button>
            </div>` : ""}
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
          <div class="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/50" data-ptask="${t.id}">
            <button class="flex h-[19px] w-[19px] shrink-0 items-center justify-center rounded border ${t.done ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40 hover:border-primary"}" data-ptoggle="${t.id}">
              ${t.done ? `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>` : ""}
            </button>
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-medium ${t.done ? "line-through text-muted-foreground" : ""}">${escapeHtml(t.title)}</p>
              ${t.description ? `<p class="truncate text-xs text-muted-foreground">${escapeHtml(t.description)}</p>` : ""}
            </div>
            ${priorityBadge(t.priority)}
            ${dueChip(t)}
            ${canWrite() ? `<div class="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
              <button class="tool-btn h-7 min-w-7" data-ptact="unlink" title="Remove from page"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18.84 12.25l1.72-1.71a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M5.17 11.75l-1.72 1.71a5 5 0 0 0 7.07 7.07l1.72-1.71"/></svg></button>
              <button class="tool-btn h-7 min-w-7 hover:text-destructive" data-ptact="del" title="Delete"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg></button>
            </div>` : ""}
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
const STRIP_CACHE = new Map(); // id-keyed stripped text cache (notes & pages)

function stripCacheKey(item) {
  return `${item.kind}:${item.id}`;
}

function getStripped(item) {
  const key = stripCacheKey(item);
  if (!STRIP_CACHE.has(key)) STRIP_CACHE.set(key, stripHtml(item.content, 0));
  return STRIP_CACHE.get(key);
}

function buildSearchIndex() {
  const noteMap = new Map();
  state.notes.forEach((n) => {
    noteMap.set(n.id, `${n.title || ""} ${n.tags || ""} ${getStripped({ kind: "note", id: n.id, content: n.content })}`.toLowerCase());
  });
  const pageMap = new Map();
  state.pages.forEach((p) => {
    pageMap.set(p.id, `${p.title || ""} ${getStripped({ kind: "page", id: p.id, content: p.content })}`.toLowerCase());
  });
  return { noteMap, pageMap, stamp: `${state.notes.length}:${state.pages.length}` };
}

function getSearchIndex() {
  if (!SEARCH_INDEX) SEARCH_INDEX = buildSearchIndex();
  return SEARCH_INDEX;
}

function invalidateSearchIndex() {
  SEARCH_INDEX = null;
  STRIP_CACHE.clear();
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
          ${creatorChip(n)}
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

// ---------- Note reader: related notes + details side panels ----------
let viewerMode = localStorage.getItem("pa_viewer_mode") || "related";
viewerMode = ["related", "focus", "detail"].includes(viewerMode) ? viewerMode : "related";
let viewerCurrentId = null;

const STOP_WORDS = new Set([
  "the","a","an","and","or","but","for","with","from","this","that","these","those",
  "you","your","our","have","has","had","are","was","were","not","its","then","than",
  "about","into","them","they","their","will","can","may","might","just","very","been",
  "being","would","should","could","there","here","all","any","some","what","when",
  "where","which","who","how","why","too","do","does","did","is","of","in","on","at","it",
]);

function tokensOf(str) {
  return (str || "").toLowerCase().match(/[a-z0-9]+/g) || [];
}

function relatedNotes(note) {
  const myTags = new Set((note.tags || "").toLowerCase().split(",").map((t) => t.trim()).filter(Boolean));
  const myWords = tokensOf(note.title + " " + getStripped({ kind: "note", id: note.id, content: note.content }));
  const ranked = [];
  for (const n of state.notes) {
    if (n.id === note.id) continue;
    let score = 0;
    const tags = (n.tags || "").toLowerCase().split(",").map((t) => t.trim()).filter(Boolean);
    score += tags.filter((t) => myTags.has(t)).length * 40;
    const words = new Set(tokensOf(n.title + " " + getStripped({ kind: "note", id: n.id, content: n.content })));
    let hits = 0;
    for (const w of myWords) if (w.length > 3 && !STOP_WORDS.has(w) && words.has(w)) hits++;
    score += Math.min(hits, 15) * 6;
    if (score > 0) ranked.push({ note: n, score });
  }
  ranked.sort((a, b) => b.score - a.score || String(b.note.updated_at || "").localeCompare(String(a.note.updated_at || "")));
  return ranked.slice(0, 9);
}

function renderRelatedPanel(note) {
  const panel = $("#related-panel");
  const list = relatedNotes(note);
  panel.innerHTML = `
    <div class="nr-panel-head">
      <span class="nr-panel-title">Related notes</span>
      <span class="badge badge-secondary">${list.length}</span>
    </div>
    <div class="p-2">
      ${list.length
        ? list
            .map(
              ({ note: n }) => `
              <button class="nr-rel-item" data-switch-note="${n.id}">
                <span class="nr-rel-title">${escapeHtml(n.title)}</span>
                <span class="nr-rel-snippet">${escapeHtml(stripHtml(getStripped({ kind: "note", id: n.id, content: n.content }), 80)) || "No text"}</span>
                ${
                  (n.tags || "").trim()
                    ? `<span class="nr-rel-tags">${(n.tags || "")
                        .split(",")
                        .filter((t) => t.trim())
                        .slice(0, 3)
                        .map((t) => `<span class="badge badge-secondary">#${escapeHtml(t.trim())}</span>`)
                        .join("")}</span>`
                    : ""
                }
              </button>`
            )
            .join("")
        : `<p class="px-1 py-2 text-xs text-muted-foreground">No related notes — add shared tags to link notes together.</p>`}
    </div>`;
  panel.querySelectorAll("[data-switch-note]").forEach((b) =>
    b.addEventListener("click", () => openViewer(Number(b.dataset.switchNote), state.returnTo === "page" ? "page" : null))
  );
}

async function renderDetailPanel(note) {
  const panel = $("#detail-panel");
  const versions = await api(`/api/notes/${note.id}/versions`).catch(() => []);
  if (viewerCurrentId !== note.id) return; // user already switched to another note
  const page = note.page_id ? state.pages.find((p) => p.id === note.page_id) : null;
  const tags = (note.tags || "").split(",").map((t) => t.trim()).filter(Boolean);
  const tagChips = tags
    .map((t) => `<button class="badge badge-secondary cursor-pointer hover:bg-accent" data-note-tag="${escapeHtml(t)}">#${escapeHtml(t)}</button>`, )
    .join(" ");
  panel.innerHTML = `
    <div class="nr-panel-head"><span class="nr-panel-title">Details</span></div>
    <div class="space-y-2.5 p-3 text-xs">
      <div>
        <p class="text-[10px] uppercase tracking-wide text-muted-foreground">Tags</p>
        <p class="mt-1 flex flex-wrap gap-1">${tagChips || `<span class="text-muted-foreground">No tags</span>`}</p>
      </div>
      <div>
        <p class="text-[10px] uppercase tracking-wide text-muted-foreground">Created</p>
        <p class="mt-0.5">${escapeHtml(fmtStampFull(note.created_at))}</p>
      </div>
      <div>
        <p class="text-[10px] uppercase tracking-wide text-muted-foreground">Updated</p>
        <p class="mt-0.5">${escapeHtml(fmtStampFull(note.updated_at))}</p>
      </div>
      ${page ? `<div><p class="text-[10px] uppercase tracking-wide text-muted-foreground">Page</p><p class="mt-0.5">${escapeHtml(page.title)}</p></div>` : ""}
      ${note.pinned ? `<div><p class="text-[10px] uppercase tracking-wide text-muted-foreground">Status</p><p class="mt-0.5">📌 Pinned</p></div>` : ""}
      <div class="grid gap-1.5 pt-1">
        <button class="btn btn-outline btn-sm w-full" id="detail-share-btn">🔗 Share link</button>
        ${isAdminUser() ? `<button class="btn btn-outline btn-sm w-full hover:text-destructive" id="detail-del-btn">Delete note</button>` : ""}
      </div>
    </div>
    <div class="border-t border-border p-3">
      <p class="mb-2 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Versions (${versions.length})</p>
      ${
        versions.length
          ? `<div class="max-h-44 space-y-1 overflow-y-auto pr-1">${versions
              .map(
                (v) => `
              <div class="flex items-center justify-between gap-2 rounded-lg border border-border/70 px-2 py-1.5">
                <span class="truncate text-[11px]" title="${escapeHtml(v.created_at)}">${escapeHtml(v.title)}</span>
                <button class="btn btn-ghost btn-icon shrink-0" data-restore="${v.id}" title="Restore this version">
                  <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
                </button>
              </div>`
              )
              .join("")}</div>`
          : `<p class="text-xs text-muted-foreground">No previous versions.</p>`
      }
    </div>`;
  panel.querySelectorAll("[data-note-tag]").forEach((b) =>
    b.addEventListener("click", () => {
      state.activeTag = b.dataset.noteTag;
      exitToNotesList();
    })
  );
  const shareBtn = $("#detail-share-btn");
  if (shareBtn) shareBtn.addEventListener("click", () => shareNoteDialog(note));
  const delBtn = $("#detail-del-btn");
  if (delBtn) {
    delBtn.addEventListener("click", () =>
      confirmDialog(`Delete "${note.title}"?`, async () => {
        try {
          await api(`/api/notes/${note.id}`, { method: "DELETE" });
          state.notes = state.notes.filter((x) => x.id !== note.id);
          invalidateSearchIndex();
          toast("Note deleted");
          exitToNotesList();
        } catch (err) {
          toast(err.message, "error");
        }
      })
    );
  }
  panel.querySelectorAll("[data-restore]").forEach((b) =>
    b.addEventListener("click", () =>
      confirmDialog(
        "Restore this version? Your current content will be saved as a version first.",
        async () => {
          try {
            const updated = await api(`/api/notes/${note.id}/restore`, {
              method: "POST",
              body: JSON.stringify({ version_id: Number(b.dataset.restore) }),
            });
            Object.assign(note, updated);
            invalidateSearchIndex();
            openViewer(note.id, state.returnTo === "page" ? "page" : null);
            toast("Version restored");
          } catch (err) {
            toast(err.message, "error");
          }
        },
        "Restore"
      )
    )
  );
}

function applyViewerMode() {
  const wrap = $("#note-reader");
  wrap.classList.remove("nr-focus", "nr-related", "nr-detail");
  wrap.classList.add("nr-" + viewerMode);
  $$("#viewer-mode [data-mode]").forEach((b) => b.classList.toggle("active", b.dataset.mode === viewerMode));
}

function openViewer(id, from = null) {
  let note = state.notes.find((n) => n.id === id);
  if (!note) {
    // Stale client list — refresh once from the server before giving up
    toast("Loading note...");
    api("/api/notes")
      .then((fresh) => {
        state.notes = fresh;
        invalidateSearchIndex();
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
  $("#viewer-share-btn").onclick = () => shareNoteDialog(note);
  $("#viewer-print-btn").onclick = () => printNote(note);
  applyViewerMode();
  viewerCurrentId = note.id;
  $$("#viewer-mode [data-mode]").forEach((b) => {
    b.onclick = () => {
      viewerMode = b.dataset.mode;
      localStorage.setItem("pa_viewer_mode", viewerMode);
      applyViewerMode();
    };
  });
  renderRelatedPanel(note);
  renderDetailPanel(note);
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

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (e2) {}
    ta.remove();
    return ok;
  }
}

function shareNoteDialog(note) {
  const $l = (id) => document.getElementById(id);
  const render = (url) => {
    openDialog(`
      <div>
        <div class="flex items-start gap-3">
          <div class="mt-0.5 rounded-full bg-primary/10 p-2 text-primary">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
          </div>
          <div>
            <h3 class="text-base font-semibold">Share note</h3>
            <p class="mt-0.5 text-sm text-muted-foreground">Anyone with this link can view “${escapeHtml(note.title)}” — no login required.</p>
          </div>
        </div>
        <p id="share-status" class="mt-4 text-sm"></p>
        ${
          url
            ? `<div class="mt-2 flex items-center gap-2">
                <input id="share-url" type="text" readonly value="${escapeHtml(url)}" class="input min-w-0 flex-1 text-xs">
                <button id="share-copy" type="button" class="btn btn-outline">Copy</button>
                <button id="share-revoke" type="button" class="btn btn-destructive">Disable</button>
              </div>`
            : `<div class="mt-2 flex justify-end">
                <button id="share-create" type="button" class="btn btn-primary">Create link</button>
              </div>`
        }
        <div class="mt-4 flex justify-end">
          <button id="share-close" type="button" class="btn btn-ghost">Close</button>
        </div>
      </div>
    `);
    $l("share-status").textContent = url === null
      ? "Not shared yet — only you (and signed-in users) can see this note."
      : "Sharing is ON — the link above is live and public.";
    $l("share-close").addEventListener("click", closeDialog);
    if (url === null) {
      $l("share-create").addEventListener("click", async () => {
        try {
          const res = await api(`/api/notes/${note.id}/share`, { method: "POST" });
          render(res.url);
          toast("Share link created");
        } catch (err) {
          toast(err.message, "error");
        }
      });
    } else {
      $l("share-copy").addEventListener("click", async () => {
        const ok = await copyText(url);
        toast(ok ? "Link copied to clipboard" : "Copy failed — select the link manually", ok ? "success" : "error");
      });
      $l("share-revoke").addEventListener("click", async () => {
        try {
          await api(`/api/notes/${note.id}/share`, { method: "DELETE" });
          render(null);
          toast("Sharing disabled");
        } catch (err) {
          toast(err.message, "error");
        }
      });
    }
  };
  api(`/api/notes/${note.id}/share`)
    .then((r) => render(r.url))
    .catch((err) => {
      toast(err.message, "error");
      closeDialog();
    });
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

  // Show every font name in its own typeface so the list is easy to browse
  $$("#font-family option").forEach((o) => {
    if (o.value) o.style.fontFamily = `'${o.value}'`;
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
      return;
    }
    const plain = e.clipboardData?.getData ? e.clipboardData.getData("text/plain") : "";
    const html = e.clipboardData?.getData ? e.clipboardData.getData("text/html") : "";
    if (!plain && !html) return;
    e.preventDefault();
    const hasRich = html && html !== "<meta charset='utf-8'>" && html !== '<meta charset="utf-8">';
    saveSelection();
    pendingPaste = { plain, html: hasRich ? html : "" };
    let rect = null;
    try {
      const sel = window.getSelection();
      if (sel.rangeCount) rect = sel.getRangeAt(0).getBoundingClientRect();
    } catch (err) {}
    showPasteMenu(rect, hasRich);
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
    const btns = $$("#editor-toolbar [data-cmd='" + cmd + "']");
    const active = btns.length === 1 && document.queryCommandState(cmd);
    btns.forEach((b) => b.classList.toggle("bg-accent", active));
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
        <button class="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded border ${t.done ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40"}" data-toggle="${t.id}">
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

function creatorChip(item) {
  const c = item && item.created_by;
  if (!c) return "";
  if (c === "AI")
    return `<span class="inline-flex shrink-0 items-center gap-1 rounded-md bg-cyan-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-cyan-600 dark:text-cyan-400" title="Created by AI"><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>Create by AI</span>`;
  return `<span class="inline-flex shrink-0 items-center rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground" title="Created by ${escapeHtml(c)}">Create by ${escapeHtml(c)}</span>`;
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
            ${creatorChip(t)}
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
              ${creatorChip(r)}
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
                    <span class="min-w-0 flex-1 cursor-pointer truncate text-sm hover:text-primary ${t.done ? "text-muted-foreground line-through hover:line-through" : ""}" data-day-open-task="${t.id}" title="Open task">${escapeHtml(t.title)}</span>
                    ${priorityBadge(t.priority)}
                    <button class="tool-btn hover:text-primary" data-day-task-edit="${t.id}" title="Edit"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg></button>
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
  $$("#dialog-root [data-day-task-edit]").forEach((b) =>
    b.addEventListener("click", () => {
      const task = state.tasks.find((x) => x.id === Number(b.dataset.dayTaskEdit));
      if (!task) return;
      closeDialog();
      taskDialog(task);
    })
  );
  $$("#dialog-root [data-day-open-task]").forEach((el) =>
    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-day-task-toggle], [data-day-task-edit], [data-day-task-del]")) return;
      const task = state.tasks.find((x) => x.id === Number(el.dataset.dayOpenTask));
      if (!task) return;
      closeDialog();
      taskDialog(task);
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

// ---------- Smart paste menu (Only text / With formatting) ----------
let pendingPaste = null;

function insertPlain(plain) {
  restoreSelection();
  let ok = false;
  try { ok = document.execCommand("insertText", false, plain); } catch (err) { ok = false; }
  if (!ok) {
    const esc = plain.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r?\n/g, "<br>");
    document.execCommand("insertHTML", false, esc);
  }
  markDirty();
  syncToolbarState();
}

function pastePlain() {
  const t = pendingPaste ? pendingPaste.plain : "";
  pendingPaste = null;
  if (t) insertPlain(t);
}

function pasteFormatted() {
  const p = pendingPaste || { html: "", plain: "" };
  pendingPaste = null;
  restoreSelection();
  if (p.html) {
    try {
      document.execCommand("insertHTML", false, p.html);
      markDirty();
      syncToolbarState();
      return;
    } catch (err) {}
  }
  if (p.plain) insertPlain(p.plain);
}

function onPasteMenuDocDown(e) {
  if (e.target && e.target.closest && e.target.closest("#paste-menu")) return;
  hidePasteMenu();
}

function onPasteMenuKey(e) {
  if (e.key === "Escape") { e.preventDefault(); hidePasteMenu(); }
}

function hidePasteMenu() {
  const menu = $("#paste-menu");
  if (!menu) return;
  menu.remove();
  document.removeEventListener("mousedown", onPasteMenuDocDown, true);
  document.removeEventListener("keydown", onPasteMenuKey);
  window.removeEventListener("resize", onPasteMenuDocDown);
  window.removeEventListener("scroll", hidePasteMenu, true);
}

function showPasteMenu(rectAtPaste, richAvailable) {
  hidePasteMenu();
  const menu = document.createElement("div");
  menu.id = "paste-menu";
  menu.className = "fixed z-[95] w-56 overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-xl";
  const mk = (label, hint, onPick, disabled) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs" + (disabled ? " cursor-not-allowed opacity-50" : " hover:bg-accent");
    const s = document.createElement("span");
    s.className = "font-medium";
    s.textContent = label;
    b.appendChild(s);
    if (hint) {
      const h = document.createElement("span");
      h.className = "text-[10px] text-muted-foreground";
      h.textContent = hint;
      b.appendChild(h);
    }
    b.addEventListener("click", (ev) => {
      if (disabled) return;
      ev.stopPropagation();
      hidePasteMenu();
      onPick();
    });
    return b;
  };
  const header = document.createElement("div");
  header.className = "border-b border-border px-3 py-2 text-[10px] font-bold uppercase tracking-wide text-muted-foreground";
  header.textContent = "Paste as";
  menu.appendChild(header);
  menu.appendChild(mk("Only text", "Note style", pastePlain));
  menu.appendChild(mk("With formatting", "Keep colors", pasteFormatted, !richAvailable));
  const sep = document.createElement("div");
  sep.className = "mx-2 border-t border-border/70";
  menu.appendChild(sep);
  menu.appendChild(mk("Cancel", "", () => { pendingPaste = null; }));
  document.body.appendChild(menu);

  let left = 12, top = 12;
  if (rectAtPaste) {
    left = rectAtPaste.left;
    top = rectAtPaste.bottom + 6;
  }
  left = Math.max(8, Math.min(left, window.innerWidth - menu.offsetWidth - 8));
  top = Math.max(8, Math.min(top, window.innerHeight - menu.offsetHeight - 8));
  menu.style.left = left + "px";
  menu.style.top = top + "px";

  document.addEventListener("mousedown", onPasteMenuDocDown, true);
  document.addEventListener("keydown", onPasteMenuKey);
  window.addEventListener("resize", onPasteMenuDocDown);
  window.addEventListener("scroll", hidePasteMenu, true);
}

// ---------- Web portals (local favourites for daily-use sites) ----------
const PORTALS_KEY = "pa_web_portals";

function getPortals() {
  try {
    const raw = localStorage.getItem(PORTALS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (err) {
    return [];
  }
}

function savePortals(list) {
  localStorage.setItem(PORTALS_KEY, JSON.stringify(list));
}

function normalUrl(url) {
  let u = (url || "").trim();
  if (!u) return "";
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(u)) u = "https://" + u;
  return u;
}

function hostOf(url) {
  try {
    return new URL(normalUrl(url)).hostname.replace(/^www\./, "");
  } catch (err) {
    return "";
  }
}

function portalAvatarStyle(name) {
  const colors = ["#f43f5e", "#f97316", "#f59e0b", "#84cc16", "#10b981", "#06b6d4", "#3b82f6", "#8b5cf6", "#d946ef", "#ec4899"];
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return colors[h % colors.length];
}

function renderPortals() {
  const grid = $("#portals-grid");
  const list = getPortals();
  $("#portals-count-badge").textContent = list.length;
  if (!list.length) {
    grid.innerHTML = `
      <div class="col-span-full flex flex-col items-center justify-center gap-3 py-14 text-center text-sm text-muted-foreground">
        <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>
        <p>No portals yet — add your first one.</p>
      </div>`;
    return;
  }
  grid.innerHTML = list
    .map(
      (p, i) => `
      <div class="group relative cursor-pointer rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/50 hover:shadow-md" data-open-portal="${i}">
        <div class="flex items-center gap-3">
          <span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-sm font-bold text-white" style="background:${portalAvatarStyle(p.name || "?")}">${escapeHtml((p.name || "?")[0].toUpperCase())}</span>
          <div class="min-w-0">
            <p class="truncate text-sm font-semibold">${escapeHtml(p.name)}</p>
            <p class="truncate text-xs text-muted-foreground">${escapeHtml(hostOf(p.url))}</p>
          </div>
        </div>
        <p class="mt-2 inline-flex">
          ${
            p.type === "sheet"
              ? `<span class="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
                  <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/></svg>
                  Google Sheet
                </span>`
              : `<span class="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                  <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>
                  Website
                </span>`
          }
        </p>
        ${
          (p.notes || "").trim()
            ? `<p class="mt-2 flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/><path d="M8 7h8"/><path d="M8 11h6"/></svg>
                <span>${escapeHtml(p.notes)}</span>
              </p>`
            : ""
        }
        <div class="absolute right-2 top-2 hidden gap-1 group-hover:flex">
          <button type="button" class="btn btn-ghost btn-icon" data-edit-portal="${i}" title="Edit">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
          </button>
          <button type="button" class="btn btn-ghost btn-icon hover:text-destructive" data-del-portal="${i}" title="Remove">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
          </button>
        </div>
      </div>`
    )
    .join("");
  grid.querySelectorAll("[data-open-portal]").forEach((el) =>
    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-edit-portal], [data-del-portal]")) return;
      const p = getPortals()[Number(el.dataset.openPortal)];
      const url = p && normalUrl(p.url);
      if (url) window.open(url, "_blank", "noopener");
    })
  );
  grid.querySelectorAll("[data-edit-portal]").forEach((b) => b.addEventListener("click", () => portalDialog(Number(b.dataset.editPortal))));
  grid.querySelectorAll("[data-del-portal]").forEach((b) =>
    b.addEventListener("click", () => {
      const list = getPortals();
      const p = list[Number(b.dataset.delPortal)];
      if (!p) return;
      confirmDialog(`Remove "${p.name}"?`, () => {
        savePortals(getPortals().filter((_, j) => j !== Number(b.dataset.delPortal)));
        renderPortals();
      });
    })
  );
}

function portalDialog(idx) {
  const list = getPortals();
  const editing = idx != null && list[idx];
  const src = editing || { name: "", url: "", notes: "", type: "web" };
  const typeOpt = (val, label) => `<option value="${val}"${src.type === val ? " selected" : ""}>${label}</option>`;
  openDialog(`
    <div class="flex items-start gap-3">
      <div class="mt-0.5 rounded-full bg-primary/10 p-2 text-primary">
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>
      </div>
      <div>
        <h3 class="text-base font-semibold">${editing ? "Edit portal" : "Add portal"}</h3>
        <p class="mt-0.5 text-sm text-muted-foreground">Give it a name and paste the website or Google Sheet address.</p>
      </div>
    </div>
    <form id="portal-form" class="mt-4 space-y-3">
      <input id="portal-name" required type="text" maxlength="40" placeholder="Portal name (e.g. Gmail)" class="input w-full" value="${escapeHtml(src.name)}">
      <select id="portal-type" class="input w-full" title="Portal type">
        ${typeOpt("web", "Website")}
        ${typeOpt("sheet", "Google Sheet")}
      </select>
      <input id="portal-url" required type="text" placeholder="https://example.com" class="input w-full" value="${escapeHtml(src.url)}">
      <textarea id="portal-notes" maxlength="200" rows="2" placeholder="Additional notes (optional)" class="input w-full resize-none">${escapeHtml(src.notes || "")}</textarea>
      <div class="flex justify-end gap-2">
        <button type="button" class="btn btn-outline" data-cancel-dialog>Cancel</button>
        <button type="submit" class="btn btn-primary">Save</button>
      </div>
    </form>
  `);
  $("#portal-form [data-cancel-dialog]").addEventListener("click", closeDialog);
  $("#portal-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("#portal-name").value.trim();
    const url = normalUrl($("#portal-url").value);
    const notes = $("#portal-notes").value.trim();
    const type = $("#portal-type").value;
    if (!name || !url) return;
    if (editing) list[idx] = { name, url, notes, type };
    else list.push({ name, url, notes, type });
    savePortals(list);
    renderPortals();
    closeDialog();
  });
  setTimeout(() => $("#portal-name").focus(), 0);
}

function initPortals() {
  $("#portals-add-btn").addEventListener("click", () => portalDialog(null));
}

function loadPortals() {
  renderPortals();
}

// ---------- Hybrid chat: local knowledge + cloud LLM ----------

let chatSessions = [];
let chatActiveSession = null;
let chatMessages = [];
let chatBusy = false;
let chatAttachments = [];
let chatAttaching = false;
let chatModels = { active: "gemini", active_label: "Gemini (Google)", active_model: "", providers: [] };
let chatAgentEnabled = false;
let chatLive = false;
let chatSettings = { active: "gemini", active_label: "", providers: [], meta: {} };
let chatSettingsProvider = "";
const CHAT_PROVIDER_BRANDS = {
  gemini: { cls: "bg-gradient-to-br from-fuchsia-500 via-purple-500 to-indigo-500", glyph: "✦" },
  openai: { cls: "bg-gradient-to-br from-emerald-600 to-teal-600", glyph: "◆" },
  groq: { cls: "bg-gradient-to-br from-orange-500 to-red-500", glyph: "G" },
  xai: { cls: "bg-[#141414]", glyph: "✕" },
  omni: { cls: "bg-gradient-to-br from-sky-500 to-indigo-500", glyph: "◉" },
};

function providerLogo(provider, size = "h-9 w-9 text-base") {
  const b = CHAT_PROVIDER_BRANDS[provider] || { cls: "bg-muted", glyph: (provider || "?").slice(0, 1).toUpperCase() };
  return `<span class="inline-flex ${size} shrink-0 items-center justify-center rounded-lg ${b.cls} font-bold text-white shadow-sm">${b.glyph}</span>`;
}

function chatProviderBadge(isActive, hasKey, large = false) {
  const pad = large ? "px-2.5 py-1 text-[11px]" : "px-2 py-0.5 text-[10px]";
  if (isActive)
    return `<span class="inline-flex shrink-0 rounded-full bg-emerald-500/10 ${pad} font-semibold text-emerald-600 dark:text-emerald-400">Active</span>`;
  if (hasKey)
    return `<span class="inline-flex shrink-0 rounded-full bg-primary/10 ${pad} font-semibold text-primary">Key saved</span>`;
  return `<span class="inline-flex shrink-0 rounded-full bg-muted ${pad} text-muted-foreground">No key</span>`;
}
let knowledge = [];

// Tiny safe markdown → HTML (input is escaped first; only fixed tags are emitted)
function mdInline(s) {
  let t = escapeHtml(s);
  t = t.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*\s])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  return t;
}

function mdToHtml(raw) {
  const lines = String(raw || "").replace(/\r\n?/g, "\n").split("\n");
  let html = "";
  let buf = [];
  let inList = null;
  let inPre = false;
  let preBuf = [];
  let tableBuf = null;
  const flush = () => {
    if (buf.length) {
      html += "<p>" + buf.join("<br>") + "</p>";
      buf = [];
    }
  };
  const flushList = () => {
    if (inList) {
      html += "</" + inList + ">";
      inList = null;
    }
  };
  const flushTable = () => {
    if (tableBuf && tableBuf.length) {
      html += renderMarkdownTable(tableBuf, tableBuf.isHeader);
      tableBuf = null;
    }
  };
  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      if (!inPre) {
        flushTable();
        flush();
        flushList();
        inPre = true;
        preBuf = [];
      } else {
        html += "<pre>" + escapeHtml(preBuf.join("\n")) + "</pre>";
        inPre = false;
      }
      continue;
    }
    if (inPre) {
      preBuf.push(line);
      continue;
    }
    const mHead = line.match(/^(#{1,4})\s+(.*)/);
    const mUl = line.match(/^\s*(?:[-*+])\s+(.*)/);
    const mOl = line.match(/^\s*\d+[.)]\s+(.*)/);
    const mQ = line.match(/^\s*>\s?(.*)/);
    const mTable = line.match(/^\|(.+)\|$/);
    const mTableSep = line.match(/^\|(?:\s*[-:]+\s*\|)+$/);
    if (mTable || mTableSep) {
      flushList();
      flush();
      if (!tableBuf) tableBuf = [];
      if (mTableSep) {
        tableBuf.isHeader = true;
      } else {
        tableBuf.push(line);
      }
      continue;
    }
    flushTable();
    const mBy = line.match(/^__agentby__(.+?)__(.+?)__(.*)$/);
    const mFile = line.match(/^__filebadge__(.+?)__(.+?)__$/);
    if (mFile) {
      flushList();
      flush();
      html += fileBadgeHTML(decodeURIComponent(mFile[1]), mFile[2]);
    } else if (mBy) {
      flushList();
      flush();
      html += agentByFooterHTML(mBy[1], mBy[2], mBy[3]);
    } else if (mHead) {
      flushList();
      flush();
      const lv = mHead[1].length + 2;
      html += `<h${lv}>${mdInline(mHead[2])}</h${lv}>`;
    } else if (mUl || mOl) {
      const tag = mUl ? "ul" : "ol";
      if (inList !== tag) {
        flushList();
        html += "<" + tag + ">";
        inList = tag;
      }
      html += "<li>" + mdInline((mUl || mOl)[1]) + "</li>";
    } else if (mQ) {
      flushList();
      flush();
      html += "<blockquote>" + mdInline(mQ[1]) + "</blockquote>";
    } else if (line.trim() === "") {
      flushList();
      flush();
    } else {
      flushList();
      buf.push(mdInline(line));
    }
  }
  flushTable();
  flushList();
  flush();
  if (inPre) html += "<pre>" + escapeHtml(preBuf.join("\n")) + "</pre>";
  return html || "";
}

function renderMarkdownTable(rows, hasHeader) {
  if (!rows || !rows.length) return "";
  const parseRow = (r) => r.split("|").slice(1, -1).map(c => c.trim());
  const header = parseRow(rows[0]);
  const bodyRows = rows.slice(hasHeader ? 1 : 0).map(parseRow);
  let out = '<div class="md-table-wrap"><table class="md-table">';
  if (hasHeader || header.some(h => h)) {
    out += "<thead><tr>";
    for (const h of header) out += `<th>${escapeHtml(h)}</th>`;
    out += "</tr></thead>";
  }
  if (bodyRows.length) {
    out += "<tbody>";
    for (const r of bodyRows) {
      out += "<tr>";
      for (const c of r) out += `<td>${escapeHtml(c)}</td>`;
      out += "</tr>";
    }
    out += "</tbody>";
  }
  out += "</table></div>";
  return out;
}

function agentByFooterHTML(name, icon, role) {
  const ic = icon ? pageIconHTML(icon, "h-3.5 w-3.5") : "";
  const roleHtml = role ? `<span class="cab-role">${escapeHtml(role)}</span>` : "";
  return (
    `<div class="chat-agent-by" style="--chip-h:${agentHue(name)}">${ic ? `<span class="cab-ic">${ic}</span>` : ""}` +
    `<span class="cab-name">${escapeHtml(name)}</span>` +
    roleHtml +
    `<span class="cab-tag">Replied</span></div>`
  );
}

function fileBadgeHTML(path, url) {
  return (
    `<div class="file-badge">` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>` +
    `<span class="file-badge-path" title="${escapeHtml(path)}">${escapeHtml(path)}</span>` +
    `<a class="file-badge-dl" href="${escapeHtml(url)}" download>Download</a>` +
    `</div>`
  );
}

function chatModelShort(label) {
  return (label || "").replace(/\s*\(.*\)\s*$/, "") || "Cloud AI";
}

function chatSourceChip(t) {
  if (t === "local_rag")
    return `<span class="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400"><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>Office rules</span>`;
  if (t === "cloud_llm")
    return `<span class="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary"><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/></svg>${escapeHtml(chatModelShort(chatModels.active_label))}</span>`;
  if (t === "agent_action")
    return `<span class="inline-flex items-center gap-1 rounded-full bg-cyan-500/10 px-2 py-0.5 text-[10px] font-semibold text-cyan-600 dark:text-cyan-400"><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>Agent action</span>`;
  if (t === "agent_ask")
    return `<span class="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400"><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>Agent ask</span>`;
  if (t === "error")
    return `<span class="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-semibold text-destructive"><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>Error</span>`;
  return "";
}

function chatStatus(text) {
  const el = $("#chat-status");
  if (el) el.textContent = text;
}

// ---- Live agent node tracker (SSE) ----

const CHAT_FLOW_NODES = [
  {
    id: "input",
    label: "User Input",
    icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  },
  {
    id: "rag",
    label: "SQLite RAG",
    icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/></svg>',
  },
  {
    id: "agents",
    label: "Agents",
    icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="4"/><circle cx="18" cy="9" r="3"/><path d="M2 21v-1a6 6 0 0 1 6-6"/><path d="M16 20v-1a4 4 0 0 0-3-3.87"/><path d="M18 4l1 2 2 1-2 1-1 2-1-2-2-1 2-1z"/></svg>',
  },
  {
    id: "llm",
    label: "Cloud LLM",
    icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/></svg>',
  },
  {
    id: "agent",
    label: "Actions Agent",
    icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#06b6d4" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
  },
  {
    id: "response",
    label: "Response",
    icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
  },
];

function chatFlowNodeHTML(id, label, icon) {
  return `<div class="chat-flow-node" data-flow-node="${id}" data-label="${escapeHtml(label)}" title="${escapeHtml(label)}">
    <span class="chat-flow-icon">${icon}</span>
    <span class="chat-flow-body">
      <span class="chat-flow-label">${escapeHtml(label)}</span>
      <span class="chat-flow-status">waiting</span>
    </span>
    <span class="chat-flow-dot"></span>
  </div>`;
}

function chatFlowConnectorHTML(toId) {
  return `<span class="chat-flow-connector" data-flow-to="${toId}">
    <span class="chat-flow-wire"><span class="chat-flow-packet"></span></span>
  </span>`;
}

function renderChatFlow() {
  const track = document.querySelector("#chat-flow .chat-flow-track");
  if (!track) return;
  const nodes = CHAT_FLOW_NODES.filter((n) => chatAgentEnabled || (n.id !== "agent" && n.id !== "agents"));
  track.innerHTML = nodes
    .map((n, i) => (i ? chatFlowConnectorHTML(n.id) : "") + chatFlowNodeHTML(n.id, n.label, n.icon))
    .join("");
}

function showChatFlow() {
  const el = $("#chat-flow");
  if (el) el.style.display = "flex";
}

function chatFlowPhase(text) {
  const el = $("#chat-flow-live");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("live-working", text === "working");
}

function chatFlowStatusText(status) {
  if (status === "running") return "running";
  if (status === "success") return "done";
  if (status === "error") return "failed";
  if (status === "skipped") return "skipped";
  return "waiting";
}

function chatFlowReset() {
  document.querySelectorAll(".chat-flow-node").forEach((n) => {
    n.classList.remove("flow-running", "flow-success", "flow-error", "flow-skipped", "flow-has-agents");
    const ag = n.querySelector(".chat-flow-agents");
    if (ag) ag.remove();
    n.title = n.dataset.label || "";
    const st = n.querySelector(".chat-flow-status");
    if (st) st.textContent = "waiting";
  });
  document.querySelectorAll(".chat-flow-connector").forEach((c) => c.classList.remove("active", "done"));
  chatFlowPhase("idle");
}

function chatFlowSet(nodeId, status, data) {
  const el = document.querySelector(`.chat-flow-node[data-flow-node="${nodeId}"]`);
  if (!el) return;
  const st = el.querySelector(".chat-flow-status");
  el.classList.remove("flow-running", "flow-success", "flow-error", "flow-skipped");
  el.classList.add("flow-" + status);
  if (st) st.textContent = chatFlowStatusText(status);
  const conn = document.querySelector(`.chat-flow-connector[data-flow-to="${nodeId}"]`);
  if (conn) {
    conn.classList.remove("active", "done");
    if (status === "running") conn.classList.add("active");
    else if (status === "success") conn.classList.add("done");
  }
  const agentsWrap = el.querySelector(".chat-flow-agents");
  if (agentsWrap) agentsWrap.remove();
  if (data && data.agents && data.agents.length) {
    const w = document.createElement("span");
    w.className = "chat-flow-agents";
    // More than 3 actual responders -> icon-only chips so names never
    // break the workflow row.
    w.innerHTML = data.agents.map((ag) => agentChipHTML(ag, data.agents.length > 3)).join("");
    const body = el.querySelector(".chat-flow-body");
    if (body) body.appendChild(w);
  }
  const note = (data && (data.error || data.note)) || "";
  el.title = note ? `${el.dataset.label || ""} \u2014 ${note}` : el.dataset.label || "";
}

function showChatMain(show) {
  const listCol = $("#chat-sessions-col");
  const main = $("#chat-main");
  if (!listCol || !main) return;
  if (window.innerWidth < 768) {
    listCol.style.display = show ? "none" : "flex";
    main.style.display = show ? "flex" : "none";
    if (show) listCol.classList.remove("sessions-collapsed");
    syncChatToggle();
    return;
  }
  listCol.style.display = "flex";
  main.style.display = "flex";
  syncChatToggle();
}

function toggleChatSessions() {
  const col = $("#chat-sessions-col");
  if (!col) return;
  // On phones the panels stack (list above chat); "show/hide" toggle then
  // behaves like the back button instead of shrinking the column to a rail.
  if (window.innerWidth < 768) {
    const showMain = col.style.display === "none";
    showChatMain(showMain);
    syncChatToggle();
    return;
  }
  col.classList.toggle("sessions-collapsed");
  syncChatToggle();
}

function syncChatToggle() {
  const btn = $("#chat-toggle-sessions");
  const col = $("#chat-sessions-col");
  if (!btn || !col) return;
  const visible = !col.classList.contains("sessions-collapsed") && col.style.display !== "none";
  btn.classList.toggle("active", visible);
  btn.setAttribute("aria-pressed", String(visible));
}

function renderChatSessions() {
  const box = $("#chat-sessions");
  if (!box) return;
  box.innerHTML = chatSessions.length
    ? chatSessions
        .map(
          (s) => `
      <div class="${s.id === chatActiveSession ? "rounded-lg bg-accent" : "rounded-lg hover:bg-accent/60"}">
        <button type="button" class="group flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left" data-open-session="${s.id}" title="${escapeHtml(s.title || "New chat")}">
          <svg class="shrink-0 text-muted-foreground" xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm font-medium">${escapeHtml(s.title || "New chat")}</span>
            <span class="block text-[10px] text-muted-foreground">${relTime(s.updated_at)}</span>
          </span>
          <span class="shrink-0 opacity-0 transition-opacity group-hover:opacity-100" data-del-session="${s.id}" title="Delete conversation">
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-muted-foreground hover:text-destructive"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
          </span>
        </button>
      </div>`
        )
        .join("")
    : `<p class="px-3 py-10 text-center text-xs text-muted-foreground">No conversations yet</p>`;
  box.querySelectorAll("[data-open-session]").forEach((b) => b.addEventListener("click", () => chatOpenSession(b.dataset.openSession)));
  box.querySelectorAll("[data-del-session]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const sid = b.dataset.delSession;
      const s = chatSessions.find((x) => x.id === sid);
      if (!s) return;
      confirmDialog(`Delete "${s.title || "This conversation"}"?`, async () => {
        try {
          await api(`/api/chat/sessions/${encodeURIComponent(sid)}`, { method: "DELETE" });
          chatSessions = chatSessions.filter((x) => x.id !== sid);
          if (chatActiveSession === sid) {
            chatActiveSession = null;
            chatMessages = [];
          }
          renderChatSessions();
          renderChatMessages();
        } catch (err) {
          toast(err.message, "error");
        }
      });
    })
  );
}

function renderChatMessages() {
  const box = $("#chat-messages");
  if (!box) return;
  const titleEl = $("#chat-title");
  const s = chatSessions.find((x) => x.id === chatActiveSession);
  if (titleEl) titleEl.textContent = s ? s.title || "New chat" : "New chat";
  showChatMain(!!chatActiveSession);
  if (!chatActiveSession) {
    box.innerHTML = `
      <div class="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-muted-foreground"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        <div>
          <p class="text-sm font-medium">Start a conversation</p>
          <p class="mt-1 max-w-sm text-xs text-muted-foreground">Ask about your office billing rules — answers come from the Knowledge Base or Gemini cloud AI (labelled on every reply).</p>
        </div>
        <button type="button" class="btn btn-primary btn-sm" data-chat-new>New chat</button>
      </div>`;
    box.querySelector("[data-chat-new]")?.addEventListener("click", chatNewSession);
    chatStatus("");
    return;
  }
  box.innerHTML = chatMessages.length
    ? chatMessages
        .map(
          (m) => `
      <div class="flex ${m.sender === "user" ? "justify-end" : "justify-start"}">
        <div class="max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${m.sender === "user" ? "rounded-br-sm bg-primary text-primary-foreground" : "rounded-bl-sm bg-accent text-accent-foreground"}">
          ${m.sender === "assistant" ? `<div class="mb-1 flex items-center gap-1.5">${chatSourceChip(m.source_type)}</div>` : ""}
          <div class="md-body whitespace-pre-wrap">${m.sender === "assistant" ? mdToHtml(m.message) : escapeHtml(m.message)}</div>
        </div>
      </div>`
        )
        .join("")
    : `<p class="px-4 py-8 text-center text-xs text-muted-foreground">Say hello to get started — or ask about a specific billing rule.</p>`;
  box.scrollTop = box.scrollHeight;
}

function chatSetBusy(busy) {
  chatBusy = busy;
  const send = $("#chat-send-btn");
  const input = $("#chat-input");
  if (send) send.disabled = busy;
  if (input) input.disabled = busy;
  chatStatus(busy ? `Asking ${chatModelShort(chatModels.active_label)}…` : "");
}

async function loadChat() {
  try {
    chatSessions = await api("/api/chat/sessions");
  } catch (e) {
    toast(e.message, "error");
    return;
  }
  chatActiveSession = null;
  chatMessages = [];
  chatFlowReset();
  renderChatSessions();
  renderChatMessages();
}

async function chatOpenSession(sid) {
  try {
    const msgs = await api(`/api/chat/sessions/${encodeURIComponent(sid)}/messages`);
    chatActiveSession = sid;
    chatMessages = msgs;
    chatFlowReset();
    renderChatSessions();
    renderChatMessages();
  } catch (e) {
    toast(e.message, "error");
  }
}

async function chatNewSession() {
  try {
    const s = await api("/api/chat/sessions", { method: "POST", body: JSON.stringify({}) });
    chatSessions.unshift(s);
    chatActiveSession = s.id;
    chatMessages = [];
    renderChatSessions();
    renderChatMessages();
    setTimeout(() => {
      const input = $("#chat-input");
      if (input) {
        input.value = "";
        input.focus();
      }
    }, 60);
  } catch (e) {
    toast(e.message, "error");
  }
}

const CHAT_ATTACH_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf"];
const CHAT_ATTACH_MAX = 6;

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function chatAttachThumb(a) {
  if (a.kind === "pdf") {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 15h6"/><path d="M9 11h2"/></svg>`;
  }
  if (a.thumb) return `<img src="${a.thumb}" alt="" class="h-10 w-10 rounded-md object-cover">`;
  return `<div class="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 text-primary text-[10px] font-bold">IMG</div>`;
}

function renderChatAttachStrip() {
  const strip = $("#chat-attach-strip");
  if (!strip) return;
  if (chatAttachments.length === 0) {
    strip.classList.add("hidden");
    strip.innerHTML = "";
    return;
  }
  strip.classList.remove("hidden");
  strip.innerHTML = "";
  chatAttachments.forEach((a, i) => {
    const pill = document.createElement("div");
    pill.className = "flex items-center gap-2 rounded-lg border border-border bg-background px-2 py-1";
    pill.innerHTML = `${chatAttachThumb(a)}<span class="max-w-[140px] truncate text-xs text-foreground" title="${a.filename.replace(/"/g, "&quot;")}">${a.filename}</span>
      <button type="button" class="badge flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground hover:text-destructive" title="Remove">
        <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
      </button>`;
    pill.querySelector("button").addEventListener("click", () => {
      chatAttachments.splice(i, 1);
      renderChatAttachStrip();
    });
    strip.appendChild(pill);
  });
}

async function chatAttachFiles(files) {
  const list = Array.from(files || []);
  if (!list.length) return;
  for (const file of list) {
    if (chatAttachments.length >= CHAT_ATTACH_MAX) {
      toast(`Max ${CHAT_ATTACH_MAX} attachments`, "error");
      return;
    }
    if (!CHAT_ATTACH_TYPES.includes(file.type)) {
      toast(`"${file.name}" is not supported. Use PNG, JPG, WebP or PDF.`, "error");
      continue;
    }
    chatAttaching = true;
    try {
      const fd = new FormData();
      fd.append("file", file, file.name);
      const res = await api("/api/chat/upload", { method: "POST", body: fd });
      const att = { token: res.token, filename: file.name, kind: res.kind, thumb: null };
      // Image preview: base64 data URL so it passes the img-src data: CSP rule
      // (blob: URLs would be blocked). PDF files get the fallback SVG icon.
      if (res.kind === "image") {
        try {
          att.thumb = await readFileAsDataURL(file);
        } catch (e) {
          att.thumb = null;
        }
      }
      chatAttachments.push(att);
    } catch (e) {
      toast(e.message, "error");
    } finally {
      chatAttaching = false;
    }
  }
  renderChatAttachStrip();
}

async function chatSend() {
  if (chatBusy || chatAttaching) return;
  const input = $("#chat-input");
  const text = (input ? input.value : "").trim();
  if (!text && chatAttachments.length === 0) return;
  if (!chatActiveSession) await chatNewSession();
  if (!chatActiveSession) return;
  input.value = "";
  input.style.height = "";
  chatSetBusy(true);
  showChatFlow();
  chatFlowReset();
  chatFlowPhase("working");
  const sid = chatActiveSession;
  chatMessages.push({ id: "pending-" + Date.now(), sender: "user", message: text || "\uD83D\uDCCE Attachment", source_type: "", created_at: new Date().toISOString() });
  renderChatMessages();
  const attTokens = chatAttachments.map((a) => a.token);
  const clearAtts = chatAttachments.slice();
  chatAttachments = [];
  renderChatAttachStrip();
  let done = false;
  let streamUrl = `/api/chat/sessions/${encodeURIComponent(sid)}/stream?q=${encodeURIComponent(text)}&p=${encodeURIComponent(JSON.stringify(getPortals()))}`;
  if (attTokens.length) streamUrl += `&a=${encodeURIComponent(JSON.stringify(attTokens))}`;
  const es = new EventSource(streamUrl);
  const finish = (userError) => {
    es.close();
    done = true;
    chatMessages = chatMessages.filter((m) => !(m.id && String(m.id).startsWith("pending-")));
    chatSetBusy(false);
    chatFlowReset();
    if (userError) toast(userError, "error");
    renderChatMessages();
    refreshAgentsSilently();
    setTimeout(() => {
      const i = $("#chat-input");
      if (i) i.focus();
    }, 30);
  };
  es.onmessage = (ev) => {
    let data;
    try {
      data = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (data.node && data.status) {
      chatFlowSet(data.node, data.status, data);
      return;
    }
    if (done || !data.event || data.event !== "final") return;
    if (data.user) chatMessages.push(data.user);
    if (data.assistant) chatMessages.push(data.assistant);
    if (data.session) {
      const existing = chatSessions.find((s) => s.id === sid);
      if (existing) Object.assign(existing, data.session);
      else chatSessions.unshift(data.session);
    }
    chatSessions.sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
    renderChatSessions();
    finish();
  };
  es.onerror = () => {
    if (!done) finish("Connection lost \u2014 the message may not have been saved. Check server logs.");
  };
}

function initChat() {
  renderChatFlow();
  syncChatToggle();
  const form = $("#chat-form");
  if (form) form.addEventListener("submit", (e) => { e.preventDefault(); chatSend(); });
  $("#chat-new-btn")?.addEventListener("click", chatNewSession);
  $("#chat-toggle-sessions")?.addEventListener("click", toggleChatSessions);
  $("#chat-back-btn")?.addEventListener("click", () => showChatMain(false));
  const agentBtn = $("#chat-agent-toggle");
  if (agentBtn) agentBtn.addEventListener("click", toggleChatAgent);
  const liveBtn = $("#chat-live-toggle");
  if (liveBtn) liveBtn.addEventListener("click", toggleChatLive);
  $("#chat-delete-btn")?.addEventListener("click", () => {
    if (!chatActiveSession) return;
    const s = chatSessions.find((x) => x.id === chatActiveSession);
    if (!s) return;
    confirmDialog(`Delete "${s.title || "This conversation"}"?`, async () => {
      try {
        await api(`/api/chat/sessions/${encodeURIComponent(chatActiveSession)}`, { method: "DELETE" });
        chatSessions = chatSessions.filter((x) => x.id !== chatActiveSession);
        chatActiveSession = null;
        chatMessages = [];
        renderChatSessions();
        renderChatMessages();
      } catch (err) {
        toast(err.message, "error");
      }
    });
  });
  $("#chat-clear-all-btn")?.addEventListener("click", () => {
    if (!chatSessions.length) return;
    confirmDialog(`Delete all ${chatSessions.length} conversations? This cannot be undone.`, async () => {
      try {
        const res = await api("/api/chat/sessions", { method: "DELETE" });
        chatSessions = [];
        chatActiveSession = null;
        chatMessages = [];
        renderChatSessions();
        renderChatMessages();
        toast(`Deleted ${res.deleted || 0} conversations`, "success");
      } catch (err) {
        toast(err.message, "error");
      }
    }, "Delete all");
  });
  const input = $("#chat-input");
  if (input) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        chatSend();
      }
    });
    input.addEventListener("input", () => {
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, 160) + "px";
    });
  }
  const attachBtn = $("#chat-attach-btn");
  const attachInput = $("#chat-attach-input");
  if (attachBtn && attachInput) {
    attachBtn.addEventListener("click", () => attachInput.click());
    attachInput.addEventListener("change", async () => {
      await chatAttachFiles(attachInput.files);
      attachInput.value = "";
    });
  }
  if (form) {
    form.addEventListener("dragenter", (e) => { e.preventDefault(); form.classList.add("drag-over"); });
    form.addEventListener("dragover", (e) => { e.preventDefault(); });
    form.addEventListener("dragleave", () => form.classList.remove("drag-over"));
    form.addEventListener("drop", async (e) => {
      e.preventDefault();
      form.classList.remove("drag-over");
      await chatAttachFiles(e.dataTransfer ? e.dataTransfer.files : []);
    });
  }
  loadChatModels();
  loadAgentSetting();
}

const AGENT_CHIP_HUES = [0, 20, 40, 60, 90, 120, 150, 180, 200, 220, 240, 260, 280, 300, 320, 345];

function agentHue(ag) {
  const name = ag && typeof ag === "object" ? ag.name : ag;
  const key = String(name || "");
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 131 + key.charCodeAt(i)) >>> 0;
  return AGENT_CHIP_HUES[h % AGENT_CHIP_HUES.length];
}

function agentDefaultIcon(ag) {
  /* Fallback icon when an agent has none saved — role detected from its
     name/description so every chip/tile still shows a meaningful icon. */
  const blob = " " + String((ag && (ag.name + " " + (ag.description || ""))) || "").toLowerCase() + " ";
  if (/(medical[ -]?billing|\binsurance\b|\bclaim[s]?\b|\brcm\b|\bdenial\b)/.test(blob)) return "lucide:stethoscope";
  if (/\bdata[ -]?entry\b|\bvdl\b/.test(blob)) return "lucide:database";
  if (/\bcalling\b|\bcalls\b|\bphone\b/.test(blob)) return "lucide:phone";
  if (/\bern\b|\bremittance\b/.test(blob)) return "lucide:receipt";
  if (/\bprocessing\b|\bprocessor\b/.test(blob)) return "lucide:settings";
  if (/\badmin\b|\bmanager\b|\bcoordinator\b|\bboss\b|\bowner\b/.test(blob)) return "lucide:shield-check";
  return "";
}

function agentChipHTML(ag, iconOnly) {
  const isObj = ag && typeof ag === "object";
  const rawName = isObj ? ag.name : ag;
  const name = escapeHtml(String(rawName || ""));
  const iconName = isObj ? (ag.icon || agentDefaultIcon(ag)) : "";
  const icon = iconName ? pageIconHTML(iconName, iconOnly ? "h-4 w-4" : "h-3 w-3") : "";
  if (iconOnly) {
    // Many responders at once -> keep the workflow row compact: avatar only,
    // full name on hover.
    const letter = escapeHtml(String(rawName || "").charAt(0).toUpperCase());
    return `<span class="cf-chip cf-chip-ico" title="${name}" style="--chip-h:${agentHue(ag)}">${icon || letter}</span>`;
  }
  return `<span class="cf-chip" style="--chip-h:${agentHue(ag)}">${icon}<span>${name}</span></span>`;
}

function chatSubtitleText(names, enabled) {
  if (chatLive) return `<span class="text-emerald-600 dark:text-emerald-400 font-medium">Live Chat with AI \u2014 general AI, no medical-billing restriction</span>`;
  const ready = (names && names.length) ? names : null;
  if (ready && enabled) return `Agents ready to respond: ${ready.map(agentChipHTML).join("")}`;
  if (ready) return `Agents ready: ${ready.map(agentChipHTML).join("")} \u2014 enable Agent to use them`;
  return "Answers from your notes, pages & guidelines";
}

function updateChatSubtitle(names) {
  const el = $("#chat-subtitle");
  if (el) el.innerHTML = chatSubtitleText(names, chatAgentEnabled);
}

async function loadAgentSetting() {
  try {
    const res = await api("/api/chat/agent");
    chatAgentEnabled = !!res.enabled;
    chatLive = !!res.live;
    updateChatSubtitle(res.active || []);
  } catch {
    chatAgentEnabled = false;
  }
  const btn = $("#chat-agent-toggle");
  if (btn) {
    btn.setAttribute("aria-pressed", chatAgentEnabled ? "true" : "false");
    btn.title = chatAgentEnabled
      ? "Actions Agent is ON \u2014 I can add/edit/delete your tasks, notes, pages, schedule, guidelines & conversations."
      : "Actions Agent is OFF \u2014 I only answer. Turn it on to let me change your app data.";
  }
  const liveBtn = $("#chat-live-toggle");
  if (liveBtn) {
    liveBtn.setAttribute("aria-pressed", chatLive ? "true" : "false");
    liveBtn.title = chatLive
      ? "Live Chat with AI is ON \u2014 I answer like ChatGPT/Gemini in a browser (no medical-billing restriction, translate & general chat work)."
      : "Live Chat with AI is OFF \u2014 I answer as the current agent. Turn it on for general AI mode.";
  }
  renderChatFlow();
}

async function toggleChatLive() {
  const btn = $("#chat-live-toggle");
  const next = !chatLive;
  try {
    const res = await api("/api/chat/live", {
      method: "PUT",
      body: JSON.stringify({ enabled: next }),
    });
    chatLive = !!res.enabled;
    if (btn) btn.setAttribute("aria-pressed", chatLive ? "true" : "false");
    updateChatSubtitle((await api("/api/chat/agent")).active || []);
    toast(
      chatLive
        ? "Live Chat with AI ON \u2014 general AI mode (no medical-billing restriction)."
        : "Live Chat with AI OFF \u2014 back to the normal agent behaviour.",
      "success"
    );
  } catch (err) {
    toast(err.message, "error");
  }
}

async function toggleChatAgent() {
  const btn = $("#chat-agent-toggle");
  const next = !chatAgentEnabled;
  try {
    const res = await api("/api/chat/agent", {
      method: "PUT",
      body: JSON.stringify({ enabled: next }),
    });
    chatAgentEnabled = !!res.enabled;
    if (btn) btn.setAttribute("aria-pressed", chatAgentEnabled ? "true" : "false");
    updateChatSubtitle(res.active || []);
    renderChatFlow();
    toast(
      chatAgentEnabled
        ? "Actions Agent ON \u2014 say things like \u201cadd a task\u201d, \u201cedit my note\u201d, \u201cdelete the conversation about\u2026\u201d."
        : "Actions Agent OFF \u2014 I now only answer questions.",
      "success"
    );
  } catch (err) {
    toast(err.message, "error");
  }
}

// ---------- Agents page ----------
let agentsState = { agents: [], enabled: false, active_id: null, active_ids: [], loading: false };
let agentsNewIcon = "";

function agentActiveBadge(isActive) {
  return `<span class="inline-flex shrink-0 rounded-full ${isActive ? "bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400" : "bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"}">${isActive ? "Active" : "Inactive"}</span>`;
}

async function loadAgents() {
  if (agentsState.loading) return;
  agentsState.loading = true;
  try {
    const [agents, agent] = await Promise.all([api("/api/agents"), api("/api/chat/agent")]);
    agentsState.agents = agents.agents || [];
    agentsState.active_id = agents.active_id ?? agent.active_id ?? null;
    agentsState.active_ids = Array.isArray(agents.active_ids) ? agents.active_ids : [];
    agentsState.enabled = !!agent.enabled;
  } catch (err) {
    toast(err.message, "error");
  }
  agentsState.loading = false;
  renderAgents();
}

function refreshAgentsSilently() {
  api("/api/agents")
    .then((res) => {
      if (!res || !Array.isArray(res.agents)) return;
      agentsState.agents = res.agents;
      agentsState.active_ids = res.active_ids || [];
      if (res.active_id != null) agentsState.active_id = res.active_id;
      renderAgents();
    })
    .catch(() => {});
}

const AGENT_MEMORY_KINDS = [
  { v: "fact", l: "Fact" },
  { v: "instruction", l: "Instruction" },
  { v: "role", l: "Role" },
  { v: "preference", l: "Preference" },
];

function agentMemoryKindBadge(kind) {
  const k = AGENT_MEMORY_KINDS.find((x) => x.v === kind);
  return `<span class="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">${escapeHtml((k ? k.l : kind) || "fact")}</span>`;
}

function openAgentMemoryDialog(a) {
  if (!a) return;
  const rows = a.memory || [];
  const listHtml = !rows.length
    ? `<p class="text-sm italic text-muted-foreground">Abhi koi memory save nahi. Neeche form se ya Chat se save karein.</p>`
    : `<div class="space-y-2">${rows.map((m) => `
        <div class="flex items-start justify-between gap-2 rounded-lg border border-border/70 bg-background/40 p-2.5" data-mem-row="${m.id}">
          <div class="min-w-0">
            <div class="flex items-center gap-1.5">${agentMemoryKindBadge(m.kind)}<span class="truncate text-xs font-semibold">${escapeHtml(m.key || m.kind || "note")}</span></div>
            <p class="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground/80">${escapeHtml(m.content || "")}</p>
            <p class="mt-1 text-[10px] text-muted-foreground">${escapeHtml(m.source || "manual")}${m.created_at ? " \u00b7 " + escapeHtml(String(m.created_at).slice(0, 10)) : ""}</p>
          </div>
          <div class="flex shrink-0 items-center gap-1">
            <button type="button" class="btn btn-ghost btn-sm" data-mem-edit="${m.id}">Edit</button>
            <button type="button" class="btn btn-ghost btn-sm hover:text-destructive" data-mem-del="${m.id}">Delete</button>
          </div>
        </div>`).join("")}</div>`;

  openDialog(`
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <h3 class="truncate text-base font-semibold">Memory \u2014 ${escapeHtml(a.name)}</h3>
        <p class="mt-0.5 text-xs text-muted-foreground">Jo agent yaad rakhta hai; Chat se bhi save hota hai</p>
      </div>
      <button type="button" class="btn btn-ghost btn-sm shrink-0" data-close-dialog-panel aria-label="Close">\u2715</button>
    </div>
    <div class="mt-4 max-h-64 space-y-2 overflow-y-auto">${listHtml}</div>
    <div class="mt-4 rounded-lg border border-border p-3">
      <p class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground" data-mem-form-title>Nayi memory</p>
      <div class="flex flex-wrap gap-2">
        <select data-mem-kind class="input h-9 min-w-[8.5rem] shrink-0">${AGENT_MEMORY_KINDS.map((k) => `<option value="${k.v}">${k.l}</option>`).join("")}</select>
        <input type="text" data-mem-key class="input h-9 min-w-0 flex-1" maxlength="120" placeholder="Key e.g. feeding_timings" />
      </div>
      <textarea data-mem-content rows="2" class="input mt-2 w-full resize-none" maxlength="2000" placeholder="Content \u2014 'Asmar ke calls 2pm ke baad'"></textarea>
      <div class="mt-3 flex items-center gap-2">
        <button type="button" class="btn btn-primary btn-sm" data-mem-save-new>Save memory</button>
        <button type="button" class="btn btn-outline btn-sm hidden" data-mem-update-cancel>Cancel edit</button>
        <span class="text-xs text-muted-foreground" data-mem-status></span>
      </div>
    </div>
  `);

  const statusEl = $("#dialog-root").querySelector("[data-mem-status]");
  const formTitle = $("#dialog-root").querySelector("[data-mem-form-title]");
  const kindSel = $("#dialog-root").querySelector("[data-mem-kind]");
  const keyIn = $("#dialog-root").querySelector("[data-mem-key]");
  const contentTa = $("#dialog-root").querySelector("[data-mem-content]");
  const saveBtn = $("#dialog-root").querySelector("[data-mem-save-new]");
  const cancelEditBtn = $("#dialog-root").querySelector("[data-mem-update-cancel]");

  const resetForm = () => {
    saveBtn.dataset.memUpdate = "";
    saveBtn.textContent = "Save memory";
    cancelEditBtn.classList.add("hidden");
    formTitle.textContent = "Nayi memory";
    kindSel.value = "fact";
    keyIn.value = "";
    contentTa.value = "";
  };

  $("#dialog-root").querySelector("[data-close-dialog-panel]").addEventListener("click", closeDialog);

  $("#dialog-root").querySelectorAll("[data-mem-del]").forEach((b) => {
    b.addEventListener("click", () => {
      const mid = Number(b.dataset.memDel);
      confirmDialog("Is memory ko delete karein?", async () => {
        await api(`/api/agents/${a.id}/memory/${mid}`, { method: "DELETE" });
        await loadAgents();
        const fresh = (agentsState.agents || []).find((x) => x.id === a.id);
        if (fresh) openAgentMemoryDialog(fresh);
        toast("Memory deleted", "success");
      });
    });
  });
  $("#dialog-root").querySelectorAll("[data-mem-edit]").forEach((b) => {
    b.addEventListener("click", () => {
      const mid = Number(b.dataset.memEdit);
      const m = rows.find((x) => x.id === mid);
      if (!m) return;
      saveBtn.dataset.memUpdate = String(mid);
      saveBtn.textContent = "Update memory";
      cancelEditBtn.classList.remove("hidden");
      formTitle.textContent = "Memory edit";
      kindSel.value = m.kind || "fact";
      keyIn.value = m.key || "";
      contentTa.value = m.content || "";
    });
  });
  cancelEditBtn.addEventListener("click", resetForm);
  saveBtn.addEventListener("click", async () => {
    const kind = kindSel.value;
    const key = keyIn.value.trim();
    const content = contentTa.value.trim();
    if (!content) {
      toast("Content is required", "error");
      return;
    }
    const mid = saveBtn.dataset.memUpdate;
    statusEl.textContent = "Saving\u2026";
    try {
      if (mid) {
        await api(`/api/agents/${a.id}/memory/${mid}`, { method: "PUT", body: JSON.stringify({ kind, key, content }) });
      } else {
        await api(`/api/agents/${a.id}/memory`, { method: "POST", body: JSON.stringify({ kind, key, content }) });
      }
      statusEl.textContent = "";
      closeDialog();
      await loadAgents();
      toast(mid ? "Memory updated" : "Memory saved", "success");
    } catch (err) {
      statusEl.textContent = "";
      toast(err.message, "error");
    }
  });
}

function renderAgents() {
  const grid = $("#agents-grid");
  const empty = $("#agents-empty");
  const btn = $("#agents-master-toggle");
  const status = $("#agents-master-status");
  const en = !!agentsState.enabled;
  const activeMap = {};
  (Array.isArray(agentsState.active_ids) ? agentsState.active_ids : []).forEach((i) => { activeMap[i] = true; });
  const activeAgents = (agentsState.agents || []).filter((a) => activeMap[a.id]);
  const activeNames = activeAgents.map((a) => a.name);
  if (btn) btn.setAttribute("aria-pressed", en ? "true" : "false");
  if (status) {
    if (en && activeNames.length) status.textContent = `Agents ready to respond: ${activeNames.join(", ")}`;
    else if (en) status.textContent = "Agent is ON \u2014 Chat can add / edit / delete your data";
    else status.textContent = "Agent is OFF \u2014 Chat only answers questions";
  }
  updateChatSubtitle(activeAgents);
  if (!grid || !empty) return;
  const agents = agentsState.agents || [];
  empty.classList.toggle("hidden", !!agents.length);
  grid.innerHTML = agents.map((a) => {
    const isActive = !!activeMap[a.id];
    const initials = escapeHtml((a.name || "?").slice(0, 1).toUpperCase());
    const tileIcon = (a.icon || agentDefaultIcon(a))
      ? `${pageIconHTML(a.icon || agentDefaultIcon(a), "h-9 w-9")}`
      : `<span class="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-sm font-bold text-primary">${initials}</span>`;
    return `
      <div class="flex flex-col rounded-xl border border-border bg-card/60 p-4 transition-all ${isActive ? "border-emerald-500/50 shadow-lg" : "hover:border-primary/40"}" data-agent-row="${a.id}">
        <div class="flex w-full items-start justify-between gap-2">
          <div class="flex min-w-0 items-center gap-2.5">
            ${tileIcon}
            <div class="min-w-0">
              <p class="truncate text-sm font-semibold">${escapeHtml(a.name)}</p>
              ${agentActiveBadge(isActive)}
            </div>
          </div>
          <button type="button" role="switch" aria-checked="${isActive ? "true" : "false"}" data-act="toggle" data-id="${a.id}" title="${isActive ? "Turn off" : "Use this agent"}"
            class="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] font-semibold transition-colors ${isActive ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "border-border bg-muted text-muted-foreground hover:border-primary/40 hover:text-foreground"}">
            <span class="h-2 w-2 rounded-full ${isActive ? "bg-emerald-500" : "bg-muted-foreground/40"}"></span>
            <span>${isActive ? "ON" : "OFF"}</span>
          </button>
        </div>
        <p class="mt-3 w-full text-xs leading-relaxed text-muted-foreground">${a.description ? escapeHtml(a.description) : '<i class="opacity-70">Koi kaam/description nahi likhi</i>'}</p>
        <div class="mt-2 flex w-full flex-1 flex-col rounded-lg border border-border/70 bg-background/40 p-2.5">
          <p class="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Qabliyat / Instructions</p>
          ${a.system_prompt
            ? `<p class="max-h-28 w-full overflow-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed text-foreground/80">${escapeHtml(a.system_prompt)}</p>`
            : `<p class="text-[11px] italic text-muted-foreground/70">Koi instructions nahi</p>`}
        </div>
        <div class="mt-3 flex w-full items-center gap-1.5 border-t border-border pt-2.5">
          <button type="button" class="btn btn-ghost btn-sm" data-act="memory" data-id="${a.id}">Memory (${(a.memory || []).length})</button>
          <button type="button" class="btn btn-ghost btn-sm" data-act="editstart" data-id="${a.id}">Edit</button>
          <button type="button" class="btn btn-ghost btn-sm hover:text-destructive" data-act="delete" data-id="${a.id}">Delete</button>
        </div>
        <div class="agent-edit mt-3 hidden space-y-2 rounded-lg border border-border p-3" data-edit-row="${a.id}">
          <div class="flex items-center gap-3">
            <button type="button" class="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-border bg-card/60 text-lg transition-colors hover:border-primary/50" data-act="pickicon" data-id="${a.id}" title="Icon choose karein">${a.icon ? pageIconHTML(a.icon, "h-5 w-5") : initials}</button>
            <div class="min-w-0 flex-1">
              <label class="mb-1 block text-[11px] font-medium text-muted-foreground">Name</label>
              <input type="text" class="input h-9 w-full" data-edit="name" maxlength="120" value="${escapeHtml(a.name)}" placeholder="Name" />
            </div>
          </div>
          <input type="hidden" data-edit="icon" value="${escapeHtml(a.icon || "")}" />
          <textarea rows="2" class="input w-full resize-none" data-edit="desc" maxlength="500" placeholder="Ye agent kya karta hai? (work / capacity)">${escapeHtml(a.description || "")}</textarea>
          <textarea rows="4" class="input w-full resize-y" data-edit="prompt" maxlength="4000" placeholder="Qabliyat / Instructions \u2014 kaise behave aur answer kare?">${escapeHtml(a.system_prompt || "")}</textarea>
          <div class="flex items-center gap-2">
            <button type="button" class="btn btn-primary btn-sm" data-act="save" data-id="${a.id}">Save</button>
            <button type="button" class="btn btn-outline btn-sm" data-act="cancel" data-id="${a.id}">Cancel</button>
            <span class="text-xs text-muted-foreground" data-edit-status></span>
          </div>
        </div>
      </div>`;
  }).join("");
}

async function handleAgentsRowClick(e) {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const act = btn.dataset.act;
  const agent = agentsState.agents.find((x) => x.id === id);
  if (act === "toggle") {
    const turningOn = !(Array.isArray(agentsState.active_ids) ? agentsState.active_ids : []).includes(id);
    try {
      if (turningOn) {
        await api(`/api/agents/${id}/active`, { method: "POST" });
        agentsState.active_ids = [...((agentsState.active_ids || []).filter((x) => x !== id)), id];
        if (agentsState.active_id == null) agentsState.active_id = id;
        if (!agentsState.enabled) {
          await api("/api/chat/agent", { method: "PUT", body: JSON.stringify({ enabled: true }) });
          agentsState.enabled = true;
        }
        renderAgents();
        toast(`Agent ON \u2014 \u201c${agent?.name || ""}\u201d ab Chat ke liye ready hai`);
      } else {
        await api("/api/agents/off", { method: "POST", body: JSON.stringify({ id }) });
        agentsState.active_ids = (agentsState.active_ids || []).filter((x) => x !== id);
        if (agentsState.active_id === id) {
          agentsState.active_id = agentsState.active_ids[0] ?? null;
        }
        renderAgents();
        toast(`Agent OFF \u2014 \u201c${agent?.name || ""}\u201d ab ready nahi hai`);
      }
    } catch (err) {
      toast(err.message, "error");
    }
    return;
  }
  const editRow = btn.closest("[data-agent-row]")?.querySelector("[data-edit-row]");
  const statusEl = editRow?.querySelector("[data-edit-status]");
  if (act === "editstart") {
    if (editRow) editRow.classList.remove("hidden");
  } else if (act === "cancel") {
    if (editRow) editRow.classList.add("hidden");
  } else if (act === "pickicon") {
    openIconPickerDialog((em) => {
      btn.innerHTML = em ? pageIconHTML(em, "h-5 w-5") : ((agent?.name || "?")[0] || "?").toUpperCase();
      const holder = btn.closest("[data-agent-row]")?.querySelector('[data-edit="icon"]');
      if (holder) holder.value = em || "";
    });
  } else if (act === "save") {
    const name = editRow?.querySelector('[data-edit="name"]')?.value.trim() || "";
    const desc = editRow?.querySelector('[data-edit="desc"]')?.value.trim() || "";
    const prompt = editRow?.querySelector('[data-edit="prompt"]')?.value.trim() || "";
    const icon = editRow?.querySelector('[data-edit="icon"]')?.value.trim() || "";
    if (!name) {
      toast("Name is required", "error");
      return;
    }
    if (statusEl) statusEl.textContent = "Saving\u2026";
    try {
      await api(`/api/agents/${id}`, { method: "PUT", body: JSON.stringify({ name, description: desc, system_prompt: prompt, icon }) });
      if (editRow) editRow.classList.add("hidden");
      await loadAgents();
      toast("Agent updated", "success");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      if (statusEl) statusEl.textContent = "";
    }
  } else if (act === "memory") {
    openAgentMemoryDialog(agentsState.agents.find((x) => x.id === id));
  } else if (act === "delete") {
    const a = agentsState.agents.find((x) => x.id === id);
    confirmDialog(`Delete agent "${a?.name || "this agent"}"?`, async () => {
      try {
        await api(`/api/agents/${id}`, { method: "DELETE" });
        if (agentsState.active_id === id) agentsState.active_id = null;
        await loadAgents();
        toast("Agent deleted", "success");
      } catch (err) {
        toast(err.message, "error");
      }
    });
  }
}

function initAgents() {
  $("#agents-master-toggle")?.addEventListener("click", async () => {
    const next = !agentsState.enabled;
    try {
      const res = await api("/api/chat/agent", { method: "PUT", body: JSON.stringify({ enabled: next }) });
      agentsState.enabled = !!res.enabled;
      if (res.active_id != null) agentsState.active_id = res.active_id;
      renderAgents();
      toast(agentsState.enabled ? "Actions Agent ON" : "Actions Agent OFF", "success");
    } catch (err) {
      toast(err.message, "error");
    }
  });
  $("#agent-new-icon-btn")?.addEventListener("click", () => {
    openIconPickerDialog((em) => {
      agentsNewIcon = em || "";
      const btn = $("#agent-new-icon-btn");
      if (btn) btn.innerHTML = em ? pageIconHTML(em, "h-5 w-5") : "📦";
    });
  });
  $("#agents-add-btn")?.addEventListener("click", async () => {
    const name = $("#agent-name-input").value.trim();
    const desc = $("#agent-desc-input").value.trim();
    const prompt = $("#agent-prompt-input").value.trim();
    const statusEl = $("#agents-add-status");
    if (!name) {
      toast("Agent name is required", "error");
      return;
    }
    if (statusEl) statusEl.textContent = "Creating\u2026";
    try {
      await api("/api/agents", { method: "POST", body: JSON.stringify({ name, description: desc, system_prompt: prompt, icon: agentsNewIcon }) });
      $("#agent-name-input").value = "";
      $("#agent-desc-input").value = "";
      $("#agent-prompt-input").value = "";
      agentsNewIcon = "";
      const iconBtn = $("#agent-new-icon-btn");
      if (iconBtn) iconBtn.innerHTML = "📦";
      if (statusEl) statusEl.textContent = "";
      await loadAgents();
      toast("Agent created", "success");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      if (statusEl) statusEl.textContent = "";
    }
  });
  $("#agents-grid")?.addEventListener("click", handleAgentsRowClick);
}

// ---------- Chat AI model switching ----------

async function loadChatModels() {
  try {
    chatModels = await api("/api/chat/models");
  } catch (e) {
    chatModels = { active: "gemini", active_label: "Gemini (Google)", active_model: "", providers: [] };
  }
}

// ---------- Chat AI settings page (admin) ----------

async function loadChatSettings() {
  chatSettingsProvider = "";
  try {
    chatSettings = await api("/api/chat/settings");
  } catch (e) {
    toast(e.message, "error");
  }
  renderChatSettings();
}

function openChatSettingsProvider(provider) {
  chatSettingsProvider = provider;
  window.scrollTo(0, 0);
  renderChatSettings();
}

function chatSettingsBack() {
  chatSettingsProvider = "";
  renderChatSettings();
}

function renderChatSettings() {
  const box = $("#chat-settings-container");
  if (!box) return;
  const rows = chatSettings.providers || [];
  const provider = rows.find((p) => p.provider === chatSettingsProvider);
  if (provider) {
    renderChatSettingsDetail(box, provider);
  } else {
    renderChatSettingsTiles(box, rows);
  }
}

function renderChatSettingsTiles(box, rows) {
  box.innerHTML = `
    <div class="space-y-4">
      <div class="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 class="card-title">AI Models</h3>
          <p class="mt-1 max-w-xl text-xs text-muted-foreground">Connect your AI providers \u2014 click a tile to open its settings. The provider marked <span class="font-medium text-emerald-600 dark:text-emerald-400">Active</span> is the one Chat uses.</p>
        </div>
        <span class="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-3 py-1 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
          <span class="h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
          Active: ${escapeHtml(chatSettings.active_label || "None")}
        </span>
      </div>
      ${
        rows.length
          ? `<div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        ${rows
          .map((p) => {
            const meta = (chatSettings.meta || {})[p.provider] || {};
            const isActive = chatSettings.active === p.provider;
            const hasKey = !!p.api_key || ((p.keys || []).length > 0);
            const modelName = p.model || meta.default_model || "";
            return `
        <button type="button" class="group flex flex-col rounded-xl border border-border bg-card/60 p-4 text-left transition-all hover:-translate-y-0.5 hover:border-primary/60 hover:shadow-lg" data-open="${p.provider}">
          <div class="flex w-full items-center gap-3">
            ${providerLogo(p.provider)}
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-semibold">${escapeHtml(meta.label || p.provider)}</p>
              <p class="text-[11px] text-muted-foreground">${meta.kind === "gemini" ? "Google AI" : "OpenAI-compatible"}</p>
            </div>
          </div>
          <div class="mt-3 w-full">${chatProviderBadge(isActive, hasKey)}</div>
          <p class="mt-3 w-full truncate text-[11px] text-muted-foreground">Model <span class="font-semibold text-foreground">${escapeHtml(modelName || "not set")}</span></p>
          <div class="mt-3 flex w-full items-center justify-between border-t border-border pt-2.5">
            <span class="text-[11px] font-semibold text-primary">Open settings</span>
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-muted-foreground transition-transform group-hover:translate-x-0.5"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
          </div>
        </button>`;
          })
          .join("")}
      </div>`
          : `<p class="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">No providers configured.</p>`
      }

      <div class="card overflow-visible">
        <div class="card-header flex-wrap gap-2">
          <div class="min-w-0">
            <h4 class="text-sm font-semibold">Activity Log <span class="rounded-full bg-muted px-2 py-0.5 text-[10px] font-normal text-muted-foreground">errors red &#183; warnings yellow</span></h4>
            <p class="text-xs text-muted-foreground">Live errors &amp; warnings from your AI calls \u2014 so you can see exactly where a problem is. Refreshes automatically.</p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <div class="inline-flex rounded-lg border border-border p-0.5">
              <button type="button" class="ai-log-level btn btn-ghost btn-sm rounded-md px-2.5 !bg-primary !text-primary-foreground" data-log-level="INFO">All</button>
              <button type="button" class="ai-log-level btn btn-ghost btn-sm rounded-md px-2.5" data-log-level="WARNING">Warnings</button>
              <button type="button" class="ai-log-level btn btn-ghost btn-sm rounded-md px-2.5" data-log-level="ERROR">Errors</button>
            </div>
            <input id="ai-log-search" type="text" placeholder="Search logs\u2026" class="input h-9 w-36 rounded-lg px-3 py-1 text-xs">
            <button type="button" class="btn btn-ghost btn-icon" id="ai-log-refresh" title="Refresh logs">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v5h-5"/></svg>
            </button>
          </div>
        </div>
        <div class="px-4 pb-4">
          <p id="ai-log-empty" class="hidden py-4 text-center text-[11px] text-muted-foreground">No log entries.</p>
          <ul id="ai-log-list" class="ai-log-list"></ul>
        </div>
      </div>

      <div class="card overflow-visible">
        <div class="card-header flex-wrap gap-2">
          <div class="min-w-0">
            <h4 class="text-sm font-semibold">Tools &amp; Routing</h4>
            <p class="text-xs text-muted-foreground">Task-aware routing: simple work goes to the Fast model, complex medical-billing reasoning to the Strong model. Plus the coded allowlist (read-only SQL + external APIs).</p>
          </div>
          <span id="routing-mode-pill" class="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-[11px] font-semibold text-muted-foreground">…</span>
        </div>
        <div class="space-y-4 px-4 pb-4">
          <div class="rounded-xl border border-border p-3">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div class="min-w-0">
                <p class="flex flex-wrap items-center gap-2 text-sm font-semibold">
                  Task-aware routing
                  <span id="route-auto-badge" class="rounded-full bg-muted px-2 py-0.5 text-[10px] font-normal text-muted-foreground">loading…</span>
                </p>
                <p class="max-w-2xl text-xs text-muted-foreground">Simple CRUD / lookups / translations → Fast model; denial / coding / drafting / analysis → Strong model. Missing keys fall back to the Active provider automatically.</p>
              </div>
              <button type="button" id="route-auto-toggle" class="btn btn-outline btn-sm w-20">…</button>
            </div>
            <div class="mt-3 grid gap-3 sm:grid-cols-2">
              <label class="block">
                <span class="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Fast model · simple tasks</span>
                <select id="route-fast" class="input h-9 w-full rounded-lg px-3 py-1 text-sm"></select>
              </label>
              <label class="block">
                <span class="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Strong model · complex reasoning</span>
                <select id="route-strong" class="input h-9 w-full rounded-lg px-3 py-1 text-sm"></select>
              </label>
            </div>
            <div class="mt-3 flex flex-wrap items-center gap-2">
              <button type="button" class="btn btn-primary btn-sm" id="routing-save">Save routing</button>
              <button type="button" class="btn btn-ghost btn-sm" id="routing-test-btn">
                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="mr-1.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/></svg>
                Test routing
              </button>
              <input id="routing-test-input" type="text" placeholder="e.g. denial N197 ka analysis do" class="input h-9 w-full min-w-0 flex-1 rounded-lg px-3 py-1 text-xs">
              <span id="routing-test-status" class="text-xs text-muted-foreground"></span>
            </div>
          </div>

          <div class="rounded-xl border border-border p-3">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div class="min-w-0">
                <p class="flex flex-wrap items-center gap-2 text-sm font-semibold">
                  Maker-Checker review
                  <span id="review-badge" class="rounded-full bg-muted px-2 py-0.5 text-[10px] font-normal text-muted-foreground">loading…</span>
                </p>
                <p class="max-w-2xl text-xs text-muted-foreground">Worker agents (Adnan, Asmar, Actions Agent…) ka output pehle DRAFT hota hai — Review Agent (<span class="font-medium">Medical Billing / Administrator</span>) isay hamesha <span class="font-medium">Strong model</span> par check karta hai (CPT/ICD, denial codes, original request). Rejected draft worker ko wapas jaata hai fix karne ke liye; retry limit khatam = <span class="font-medium">manual review</span> flag.</p>
              </div>
              <button type="button" id="review-toggle" class="btn btn-outline btn-sm w-20">…</button>
            </div>
            <div class="mt-3 flex flex-wrap items-center gap-2">
              <label class="flex items-center gap-2 text-xs">
                Max correction loops
                <select id="review-loops" class="input h-9 rounded-lg px-3 py-1 text-sm">
                  <option value="0">0</option>
                  <option value="1">1</option>
                  <option value="2">2</option>
                  <option value="3">3</option>
                </select>
              </label>
              <button type="button" class="btn btn-primary btn-sm" id="review-save">Save review settings</button>
            </div>
          </div>

          <div class="rounded-xl border border-border p-3">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div class="min-w-0">
                <p class="text-sm font-semibold">External API allowlist</p>
                <p class="text-xs text-muted-foreground">Sirf yahan registered <span class="font-medium">public HTTPS</span> endpoints ko call kar sakta hai (SSRF-guarded). Placeholders URL mein <code class="rounded bg-muted px-1 py-0.5">{name}</code> aur koi bhi params is convert ho jate hain.</p>
              </div>
              <span id="tools-count" class="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">…</span>
            </div>
            <ul id="tools-list" class="mt-3 space-y-2"></ul>
            <form id="tools-add-form" class="mt-3 grid gap-2 sm:grid-cols-12"></form>
          </div>
        </div>
      </div>
    </div>`;
  box.querySelectorAll("[data-open]").forEach((b) =>
    b.addEventListener("click", () => openChatSettingsProvider(b.dataset.open))
  );
  initAiLogs();
  initToolsRouting();
}

let aiLogFilter = "INFO";
let aiLogTimer = null;

async function loadAiLogs() {
  const list = $("#ai-log-list");
  if (!list) return;
  const search = ($("#ai-log-search")?.value || "").trim();
  try {
    const res = await api(
      `/api/logs?level=${encodeURIComponent(aiLogFilter)}&limit=300&search=${encodeURIComponent(search)}`
    );
    const logs = res.logs || [];
    const empty = $("#ai-log-empty");
    if (empty) empty.classList.toggle("hidden", logs.length > 0);
    list.innerHTML = logs.length
      ? logs
          .map((l) => {
            const lv = l.level || "INFO";
            const cls = lv === "ERROR" || lv === "CRITICAL" ? "log-error" : lv === "WARNING" ? "log-warning" : "log-info";
            return `<li class="ai-log-item ${cls}"><span class="ai-log-time">${escapeHtml(l.ts)}</span><span class="ai-log-lvl">${escapeHtml(lv)}</span><span class="ai-log-msg">${escapeHtml(l.message)}</span></li>`;
          })
          .join("")
      : "";
  } catch {
    // settings list may not be reachable — keep the previous content
  }
}

function initAiLogs() {
  if (aiLogTimer) {
    clearInterval(aiLogTimer);
    aiLogTimer = null;
  }
  loadAiLogs();
  document.querySelectorAll("[data-log-level]").forEach((b) =>
    b.addEventListener("click", () => {
      aiLogFilter = b.dataset.logLevel;
      document.querySelectorAll("[data-log-level]").forEach((x) => {
        const active = x.dataset.logLevel === aiLogFilter;
        x.classList.toggle("!bg-primary", active);
        x.classList.toggle("!text-primary-foreground", active);
      });
      loadAiLogs();
    })
  );
  const refresh = $("#ai-log-refresh");
  if (refresh) refresh.addEventListener("click", loadAiLogs);
  const s = $("#ai-log-search");
  if (s) {
    s._t = null;
    s.addEventListener("input", () => {
      clearTimeout(s._t);
      s._t = setTimeout(loadAiLogs, 350);
    });
  }
  aiLogTimer = setInterval(() => {
    const view = $("#view-settings");
    if (view && !view.classList.contains("hidden") && $("#ai-log-list")) loadAiLogs();
  }, 4000);
}

let routingState = { auto: true, fast: "gemini", strong: "omni", tools: [], providers: [], review: { enabled: true, max_loops: 2 } };

function toolProviderOptions(selected, placeholder) {
  const opts = ['<option value="">' + escapeHtml(placeholder) + "</option>"];
  for (const p of routingState.providers || []) {
    const sel = p.provider === selected ? " selected" : "";
    const noKey = p.has_key ? "" : " (no key)";
    opts.push(`<option value="${escapeHtml(p.provider)}"${sel}${p.has_key ? "" : " disabled"}>${escapeHtml(p.label)}${noKey}</option>`);
  }
  return opts.join("");
}

function routeProviderLabel(provider) {
  const p = (routingState.providers || []).find((x) => x.provider === provider);
  return p ? p.label : provider;
}

function renderToolsRouting() {
  const toggle = $("#route-auto-toggle");
  if (!toggle) return;
  const autoOn = routingState.auto;
  toggle.textContent = autoOn ? "On" : "Off";
  toggle.className = "btn btn-sm w-20 " + (autoOn ? "btn-primary" : "btn-outline");
  const badge = $("#route-auto-badge");
  if (badge) {
    badge.className =
      "rounded-full px-2 py-0.5 text-[10px] font-normal " +
      (autoOn ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-muted text-muted-foreground");
    badge.textContent = autoOn ? "ON — active" : "OFF — using Active provider";
  }
  const pill = $("#routing-mode-pill");
  if (pill) pill.textContent = `Fast: ${routeProviderLabel(routingState.fast)} · Strong: ${routeProviderLabel(routingState.strong)}`;
  const fast = $("#route-fast");
  const strong = $("#route-strong");
  if (fast) {
    fast.innerHTML = toolProviderOptions(routingState.fast, "gemini");
    fast.disabled = !autoOn;
  }
  if (strong) {
    strong.innerHTML = toolProviderOptions(routingState.strong, "omni");
    strong.disabled = !autoOn;
  }
  renderToolsList();
  renderToolsAddForm();
  const count = $("#tools-count");
  if (count) count.textContent = `${routingState.tools.length} tool${routingState.tools.length === 1 ? "" : "s"}`;
  renderReviewBlock();
}

function renderReviewBlock() {
  const toggle = $("#review-toggle");
  if (!toggle) return;
  const on = !!routingState.review.enabled;
  toggle.textContent = on ? "On" : "Off";
  toggle.className = "btn btn-sm w-20 " + (on ? "btn-primary" : "btn-outline");
  const badge = $("#review-badge");
  if (badge) {
    badge.className =
      "rounded-full px-2 py-0.5 text-[10px] font-normal " +
      (on ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-muted text-muted-foreground");
    badge.textContent = on ? `ON — ${routingState.review.max_loops} correction loop(s), Strong model` : "OFF — draft directly to user";
  }
  const loops = $("#review-loops");
  if (loops) loops.value = String(routingState.review.max_loops || 0);
}

async function loadToolsRouting() {
  try {
    const [r, t, rv] = await Promise.all([api("/api/chat/routing"), api("/api/tools"), api("/api/chat/review")]);
    routingState = {
      auto: (r.auto || "").toString() === "1" || r.auto === true,
      fast: r.fast || "gemini",
      strong: r.strong || "omni",
      providers: r.providers || [],
      tools: t.tools || [],
      review: { enabled: !!rv.enabled, max_loops: rv.max_loops ?? 2 },
    };
  } catch (e) {
    toast(e.message, "error");
  }
  renderToolsRouting();
}

function initToolsRouting() {
  const toggle = $("#route-auto-toggle");
  if (toggle) toggle.addEventListener("click", () => { routingState.auto = !routingState.auto; renderToolsRouting(); });
  const save = $("#routing-save");
  if (save)
    save.addEventListener("click", async () => {
      const fast = $("#route-fast")?.value || routingState.fast;
      const strong = $("#route-strong")?.value || routingState.strong;
      try {
        const r = await api("/api/chat/routing", { method: "PUT", body: JSON.stringify({ auto: routingState.auto, fast, strong }) });
        routingState.auto = (r.auto || "").toString() === "1" || r.auto === true;
        routingState.fast = r.fast || fast;
        routingState.strong = r.strong || strong;
        renderToolsRouting();
        toast("Routing settings saved.");
      } catch (e) {
        toast(e.message, "error");
      }
    });
  const testBtn = $("#routing-test-btn");
  if (testBtn)
    testBtn.addEventListener("click", async () => {
      const input = $("#routing-test-input");
      const msg = (input?.value || "").trim();
      const status = $("#routing-test-status");
      if (!msg) { if (status) status.textContent = "Pehle koi message likhein."; return; }
      if (status) status.textContent = "Checking…";
      try {
        const r = await api("/api/chat/routing/test", { method: "POST", body: JSON.stringify({ message: msg }) });
        if (status)
          status.innerHTML = `<span class="rounded-full bg-muted px-2 py-0.5 text-[11px] font-mono">${escapeHtml(r.kind)}</span> → <span class="font-semibold">${escapeHtml(r.label)}</span>${r.provider === r.fast ? " (fast tier)" : r.provider === r.strong ? " (strong tier)" : " (active fallback)"}`;
      } catch (e) {
        if (status) status.textContent = e.message;
      }
    });
  const input = $("#routing-test-input");
  if (input)
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") $("#routing-test-btn")?.click();
    });
  const rvToggle = $("#review-toggle");
  if (rvToggle)
    rvToggle.addEventListener("click", () => {
      routingState.review.enabled = !routingState.review.enabled;
      renderReviewBlock();
    });
  const rvLoops = $("#review-loops");
  if (rvLoops)
    rvLoops.addEventListener("change", () => {
      routingState.review.max_loops = Number(rvLoops.value) || 0;
      renderReviewBlock();
    });
  const rvSave = $("#review-save");
  if (rvSave)
    rvSave.addEventListener("click", async () => {
      try {
        const rv = await api("/api/chat/review", { method: "PUT", body: JSON.stringify({ enabled: routingState.review.enabled, max_loops: routingState.review.max_loops }) });
        routingState.review = { enabled: !!rv.enabled, max_loops: rv.max_loops ?? 2 };
        renderReviewBlock();
        toast("Review settings saved.");
      } catch (e) {
        toast(e.message, "error");
      }
    });
  loadToolsRouting();
}

function renderToolsList() {
  const list = $("#tools-list");
  if (!list) return;
  list.innerHTML = routingState.tools.length
    ? routingState.tools
        .map((t) => `
        <li class="rounded-lg border ${t.enabled ? "border-border" : "border-dashed border-border opacity-70"}" data-tool-id="${t.id}">
          <div class="flex flex-wrap items-center gap-2 px-3 py-2">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span class="truncate text-xs font-semibold">${escapeHtml(t.name)}</span>
                ${t.enabled ? `<span class="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-600 dark:text-emerald-400">Enabled</span>` : `<span class="rounded-full bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">Disabled</span>`}
              </div>
              <p class="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">${escapeHtml(t.url_template)}</p>
              ${t.description ? `<p class="mt-0.5 text-[10px] text-muted-foreground">${escapeHtml(t.description)}</p>` : ""}
            </div>
            <button type="button" class="btn btn-ghost btn-icon" data-edit-tool="${t.id}" title="Edit">
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
            </button>
            <button type="button" class="btn btn-ghost btn-icon" data-del-tool="${t.id}" title="Delete">
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
            </button>
          </div>
        </li>`)
        .join("")
    : '<li class="rounded-lg border border-dashed border-border px-3 py-4 text-center text-[11px] text-muted-foreground">No external APIs registered yet — add one below ("{placeholder}" params allowed).</li>';
  list.querySelectorAll("[data-edit-tool]").forEach((b) =>
    b.addEventListener("click", () => editToolRow(Number(b.dataset.editTool)))
  );
  list.querySelectorAll("[data-del-tool]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm("Is API tool ko hata dein?")) return;
      try {
        await api(`/api/tools/${b.dataset.delTool}`, { method: "DELETE" });
        routingState.tools = routingState.tools.filter((t) => t.id !== Number(b.dataset.delTool));
        renderToolsList();
        const count = $("#tools-count");
        if (count) count.textContent = `${routingState.tools.length} tool${routingState.tools.length === 1 ? "" : "s"}`;
        toast("Tool delete ho gaya.");
      } catch (e) {
        toast(e.message, "error");
      }
    })
  );
}

function renderToolsAddForm() {
  const form = $("#tools-add-form");
  if (!form) return;
  form.innerHTML = `
    <input type="text" id="tool-name" placeholder="Tool name (e.g. NPI Registry)" class="input h-9 rounded-lg px-3 py-1 text-xs sm:col-span-3">
    <input type="url" id="tool-url" placeholder="https://…/api/?key={param}" class="input h-9 rounded-lg px-3 py-1 text-xs sm:col-span-5">
    <input type="text" id="tool-desc" placeholder="Description (optional)" class="input h-9 rounded-lg px-3 py-1 text-xs sm:col-span-2">
    <button type="submit" class="btn btn-primary btn-sm h-9 sm:col-span-2">Add tool</button>
  `;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#tool-name")?.value.trim();
    const url = $("#tool-url")?.value.trim();
    const desc = $("#tool-desc")?.value.trim();
    if (!name || !url) { toast("Name aur URL dono required hain.", "error"); return; }
    try {
      const created = await api("/api/tools", { method: "POST", body: JSON.stringify({ name, url_template: url, description: desc, enabled: true }) });
      routingState.tools.push(created);
      renderToolsList();
      const count = $("#tools-count");
      if (count) count.textContent = `${routingState.tools.length} tool${routingState.tools.length === 1 ? "" : "s"}`;
      if ($("#tool-name")) $("#tool-name").value = "";
      if ($("#tool-url")) $("#tool-url").value = "";
      if ($("#tool-desc")) $("#tool-desc").value = "";
      toast("Tool added.");
    } catch (err) {
      toast(err.message, "error");
    }
  });
}

function editToolRow(id) {
  const list = $("#tools-list");
  if (!list) return;
  const li = list.querySelector(`[data-tool-id="${id}"]`);
  if (!li) return;
  const t = routingState.tools.find((x) => x.id === id);
  if (!t) return;
  li.innerHTML = `
    <div class="grid gap-2 p-3 sm:grid-cols-12">
      <input type="text" id="tool-name-${t.id}" value="${escapeHtml(t.name)}" class="input h-9 rounded-lg px-3 py-1 text-xs sm:col-span-3">
      <input type="url" id="tool-url-${t.id}" value="${escapeHtml(t.url_template)}" class="input h-9 rounded-lg px-3 py-1 text-xs sm:col-span-5">
      <input type="text" id="tool-desc-${t.id}" value="${escapeHtml(t.description || "")}" class="input h-9 rounded-lg px-3 py-1 text-xs sm:col-span-2">
      <div class="flex items-center gap-2 sm:col-span-2">
        <button type="button" class="btn btn-primary btn-sm" id="tool-save-${t.id}">Save</button>
        <button type="button" class="btn btn-ghost btn-sm" data-cancel-edit="${t.id}">Cancel</button>
      </div>
      <label class="flex items-center gap-2 text-xs sm:col-span-12">
        <input type="checkbox" id="tool-enabled-${t.id}" ${t.enabled ? "checked" : ""} class="accent-[hsl(var(--primary))]"> Enabled
      </label>
    </div>`;
  li.querySelector(`#tool-save-${t.id}`).addEventListener("click", async () => {
    const name = li.querySelector(`#tool-name-${t.id}`)?.value.trim();
    const url = li.querySelector(`#tool-url-${t.id}`)?.value.trim();
    const desc = li.querySelector(`#tool-desc-${t.id}`)?.value.trim();
    const enabled = li.querySelector(`#tool-enabled-${t.id}`)?.checked;
    if (!name || !url) { toast("Name aur URL dono required hain.", "error"); return; }
    try {
      const updated = await api(`/api/tools/${t.id}`, { method: "PUT", body: JSON.stringify({ name, url_template: url, description: desc, enabled }) });
      routingState.tools = routingState.tools.map((x) => (x.id === updated.id ? updated : x));
      renderToolsList();
      toast("Tool updated.");
    } catch (err) {
      toast(err.message, "error");
    }
  });
  li.querySelector(`[data-cancel-edit="${t.id}"]`).addEventListener("click", () => renderToolsList());
}

function renderChatSettingsDetail(box, p) {
  const meta = (chatSettings.meta || {})[p.provider] || {};
  const isActive = chatSettings.active === p.provider;
  const hasKey = !!p.api_key || ((p.keys || []).length > 0);
  const modelName = p.model || meta.default_model || "";
  const tuning = p.tuning || { temperature: 0.2, max_tokens: 1024 };
  const t = tuning.temperature;
  const mt = tuning.max_tokens;
  box.innerHTML = `
    <div class="mx-auto w-full max-w-5xl space-y-4">
      <button type="button" class="btn btn-ghost -ml-2 inline-flex items-center gap-1.5" data-back="1">
        <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>
        All models
      </button>

      <div class="card overflow-visible">
        <div class="flex flex-wrap items-center gap-4">
          ${providerLogo(p.provider, "h-14 w-14 text-2xl")}
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <h3 class="card-title">${escapeHtml(meta.label || p.provider)}</h3>
              ${chatProviderBadge(isActive, hasKey, true)}
            </div>
            <p class="mt-1.5 text-xs text-muted-foreground">${chatSettingHint(p.provider)}</p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <button type="button" class="btn btn-outline btn-sm" id="test-btn-${p.provider}" data-test="${p.provider}">
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/></svg>
              Test connection
            </button>
            ${isActive ? "" : `<button type="button" class="btn btn-primary btn-sm" data-activate="${p.provider}">Use this model</button>`}
          </div>
        </div>
        <p class="hidden mt-3 text-xs" id="test-result-${p.provider}"></p>
      </div>

      <div class="card overflow-visible">
        <div class="card-header flex-wrap gap-2">
          <div class="min-w-0">
            <h4 class="text-sm font-semibold">Server / Base URL</h4>
            <p class="text-xs text-muted-foreground">Where this provider's API lives. Local gateways like OmniRoute run on your machine — set your own address here.</p>
          </div>
          <button type="button" class="btn btn-ghost btn-sm" data-reset-base="${p.provider}" title="Restore the built-in default endpoint">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
            Reset to default
          </button>
        </div>
        <div class="px-4 pb-4">
          <input type="url" id="base-url-${p.provider}" value="${escapeHtml(p.base_url || meta.endpoint || "")}" placeholder="https://api.example.com/v1" class="input h-9 w-full rounded-lg px-3 py-1 text-sm">
          <p class="mt-1 text-[10px] text-muted-foreground">Default endpoint for this provider: <code class="rounded bg-muted px-1 py-0.5">${escapeHtml(meta.endpoint || "—")}</code></p>
        </div>
      </div>

      <div class="grid gap-4 lg:grid-cols-3">
        <div class="space-y-4 lg:col-span-2">
          <div class="card overflow-visible">
            <div class="card-header flex-wrap gap-2">
              <div class="min-w-0">
                <h4 class="text-sm font-semibold">Model</h4>
                <p class="text-xs text-muted-foreground">The exact model Chat uses for this provider.</p>
              </div>
              <button type="button" class="btn btn-ghost btn-sm" data-refresh="${p.provider}" title="Fetch available models">
                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v5h-5"/></svg>
                Refresh
              </button>
            </div>
            <div class="px-4 pb-4">
              <span class="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Model <span class="font-normal normal-case" id="model-count-${p.provider}"></span></span>
              <select id="model-${p.provider}" class="input h-9 w-full rounded-lg px-3 py-1 text-sm">
                <option value="${escapeHtml(modelName)}">${escapeHtml(modelName || "select a model…")}</option>
              </select>
              <p class="mt-1 text-[10px] text-muted-foreground" id="model-status-${p.provider}"></p>
            </div>
          </div>

          <div class="card overflow-visible">
            <div class="card-header flex-wrap gap-2">
              <div class="min-w-0">
                <h4 class="text-sm font-semibold">Response tuning</h4>
                <p class="text-xs text-muted-foreground">How creative and how long the answers are for this model.</p>
              </div>
              <button type="button" class="btn btn-ghost btn-sm" data-reset-tuning="${p.provider}" title="Reset to defaults (0.2 / 1024)">
                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
                Reset defaults
              </button>
            </div>
            <div class="space-y-5 px-4 pb-4">
              <div>
                <div class="flex items-center justify-between gap-2">
                  <label for="temp-${p.provider}" class="text-xs font-medium">Temperature</label>
                  <span id="temp-value-${p.provider}" class="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">${t.toFixed(1)}</span>
                </div>
                <input type="range" id="temp-${p.provider}" min="0" max="2" step="0.1" value="${t}" class="w-full cursor-pointer accent-[hsl(var(--primary))]">
                <div class="mt-0.5 flex justify-between text-[10px] text-muted-foreground"><span>0 · factual &amp; focused</span><span>1</span><span>2 · creative &amp; varied</span></div>
              </div>
              <div>
                <label for="maxtok-${p.provider}" class="mb-1 block text-xs font-medium">Max answer length <span class="font-normal text-muted-foreground">(tokens)</span></label>
                <input type="number" id="maxtok-${p.provider}" min="128" max="8192" step="16" value="${mt}" class="input h-9 w-40 rounded-lg px-3 py-1 text-sm">
              </div>
            </div>
          </div>
        </div>

        <div class="space-y-4">
          <div class="card keys-manager overflow-visible">
            <div class="card-header flex-wrap gap-2">
              <div class="min-w-0">
                <h4 class="text-sm font-semibold">API keys <span class="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">${(p.keys || []).length} keys</span></h4>
                <p class="text-xs text-muted-foreground">Add as many as you want \u2014 when one hits its limit, Chat auto-switches to the next.</p>
              </div>
            </div>
            <div class="px-4 pb-4">
              ${(p.keys || []).length ? `
              <ul class="space-y-2">
                ${(p.keys || [])
                  .map((k) => `
                <li class="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 ${k.is_active ? "border-primary/50 bg-primary/5" : "border-border"}">
                  <input type="radio" name="key-radio-${p.provider}" data-key-active="${k.id}" ${k.is_active ? "checked" : ""} title="Use this key now" class="accent-[hsl(var(--primary))]">
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2">
                      <span class="truncate text-xs font-semibold">${escapeHtml(k.label || "Key")}</span>
                      ${k.is_active ? `<span class="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-600 dark:text-emerald-400">In use</span>` : ""}
                      ${k.enabled ? "" : `<span class="rounded-full bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">Disabled</span>`}
                    </div>
                    <p class="font-mono text-[10px] text-muted-foreground">${escapeHtml(k.masked || "\u2026\u2026\u2026")}</p>
                  </div>
                  <label class="flex items-center gap-1 text-[10px] text-muted-foreground" title="Enabled keys participate in auto-failover">
                    <input type="checkbox" data-key-toggle="${k.id}" ${k.enabled ? "checked" : ""} class="accent-[hsl(var(--primary))]"> On
                  </label>
                  <button type="button" class="btn btn-ghost btn-icon" data-key-delete="${k.id}" title="Delete key">
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                  </button>
                </li>`)
                  .join("")}
              </ul>` : `<p class="rounded-lg border border-dashed border-border px-3 py-3 text-center text-xs text-muted-foreground">No keys yet \u2014 add your first one below.</p>`}
              <form data-key-add="${p.provider}" class="mt-3 space-y-2">
                <div class="grid gap-2 sm:grid-cols-[8rem_1fr]">
                  <input id="key-label-${p.provider}" placeholder="Label" class="input h-9 rounded-lg px-3 py-1 text-sm">
                  <input id="key-new-${p.provider}" type="password" autocomplete="off" placeholder="Paste new API key\u2026" class="input h-9 rounded-lg px-3 py-1 text-sm">
                </div>
                <button type="submit" class="btn btn-outline btn-sm h-9">Add key</button>
              </form>
              <p class="mt-2 text-[10px] text-muted-foreground">Auto-failover: on a rate-limit / auth error (401, 403, 429) Chat moves to the next enabled key automatically. Pick the active one here anytime.</p>
            </div>
          </div>

          <div class="card overflow-visible">
            <div class="card-header">
              <div class="min-w-0">
                <h4 class="text-sm font-semibold">Connection</h4>
                <p class="text-xs text-muted-foreground">Details and live checks for this provider.</p>
              </div>
            </div>
            <div class="space-y-2.5 px-4 pb-4 text-xs">
              <div class="flex items-center justify-between gap-2"><span class="text-muted-foreground">Online status</span><span id="conn-${p.provider}" class="font-medium text-muted-foreground">Not tested</span></div>
              <div class="flex items-center justify-between gap-2"><span class="text-muted-foreground">Active in Chat</span>${isActive ? `<span class="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">Yes</span>` : `<span class="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">No</span>`}</div>
              <div class="flex items-center justify-between gap-2"><span class="text-muted-foreground">Kind</span><span class="font-medium">${meta.kind === "gemini" ? "Google AI" : "OpenAI-compatible"}</span></div>
              <div class="flex items-center justify-between gap-2"><span class="shrink-0 text-muted-foreground">Endpoint</span><span class="truncate font-mono text-[10px]" title="${escapeHtml(meta.endpoint || "")}">${escapeHtml((meta.endpoint || "").replace(/^https?:\/\//, ""))}</span></div>
              <button type="button" class="btn btn-outline btn-sm mt-1 w-full" data-test="${p.provider}">Run connection test</button>
            </div>
          </div>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <button type="button" class="btn btn-primary btn-sm" data-save="${p.provider}">
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/></svg>
          Save changes
        </button>
        ${!!p.api_key ? `<button type="button" class="btn btn-ghost btn-icon" data-remove="${p.provider}" title="Remove legacy key">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
        </button>` : ""}
        <span class="ml-auto text-[10px] text-muted-foreground">Keys are stored server-side (.env)</span>
      </div>
    </div>`;
  box.querySelectorAll("[data-back]").forEach((b) =>
    b.addEventListener("click", chatSettingsBack)
  );
  box.querySelectorAll("[data-save]").forEach((b) =>
    b.addEventListener("click", () => saveChatSetting(b.dataset.save))
  );
  box.querySelectorAll("[data-activate]").forEach((b) =>
    b.addEventListener("click", () => activateChatProvider(b.dataset.activate))
  );
  box.querySelectorAll("[data-remove]").forEach((b) =>
    b.addEventListener("click", () => removeChatKey(b.dataset.remove))
  );
  box.querySelectorAll("[data-refresh]").forEach((b) =>
    b.addEventListener("click", () => loadProviderModels(b.dataset.refresh))
  );
  box.querySelectorAll("[data-test]").forEach((b) =>
    b.addEventListener("click", () => testChatProvider(b.dataset.test))
  );
  box.querySelectorAll("[data-reset-tuning]").forEach((b) =>
    b.addEventListener("click", () => resetChatTuning(b.dataset.resetTuning))
  );
  box.querySelectorAll("[data-reset-base]").forEach((b) => {
    const bu = $(`#base-url-${b.dataset.resetBase}`);
    if (bu && b.dataset.resetBase) {
      b.addEventListener("click", () => {
        bu.value = (p.default_base_url || meta.endpoint || "").replace(/\/+$/, "");
        saveChatSetting(p.provider);
      });
    }
  });
  box.querySelectorAll("[data-key-active]").forEach((r) =>
    r.addEventListener("change", () => activateChatKey(p.provider, parseInt(r.dataset.keyActive, 10)))
  );
  box.querySelectorAll("[data-key-toggle]").forEach((c) =>
    c.addEventListener("change", () => toggleChatKey(p.provider, parseInt(c.dataset.keyToggle, 10), c.checked))
  );
  box.querySelectorAll("[data-key-delete]").forEach((b) =>
    b.addEventListener("click", () => deleteChatKey(p.provider, parseInt(b.dataset.keyDelete, 10)))
  );
  box.querySelectorAll("[data-key-add]").forEach((f) =>
    f.addEventListener("submit", (e) => {
      e.preventDefault();
      addChatKey(p.provider);
    })
  );
  const tempEl = $(`#temp-${p.provider}`);
  if (tempEl) {
    tempEl.addEventListener("input", () => {
      const v = $(`#temp-value-${p.provider}`);
      if (v) v.textContent = parseFloat(tempEl.value).toFixed(1);
    });
  }
  box.querySelectorAll(".card input").forEach((inp) => {
    if (inp.closest && inp.closest(".keys-manager")) return;
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        saveChatSetting(p.provider);
      }
    });
  });
  loadProviderModels(p.provider);
}

async function loadProviderModels(provider) {
  const sel = $(`#model-${provider}`);
  const statusEl = $(`#model-status-${provider}`);
  const countEl = $(`#model-count-${provider}`);
  if (!sel) return;
  sel.disabled = true;
  if (statusEl) {
    statusEl.classList.remove("text-destructive");
    statusEl.textContent = "Loading models…";
  }
  let res;
  try {
    res = await api(`/api/chat/models/detail?provider=${encodeURIComponent(provider)}`);
  } catch (err) {
    if (statusEl) {
      statusEl.textContent = "Could not reach the provider.";
      statusEl.classList.add("text-destructive");
    }
    sel.disabled = false;
    return;
  }
  const current = (chatSettings.providers.find((p) => p.provider === provider) || {}).model || "";
  const available = (res.models || []).map((m) => m.id);
  if (res.error) {
    const msg =
      res.error === "no_key"
        ? "No API key set — models cannot be fetched."
        : `Could not fetch models (${res.error}).`;
    if (statusEl) {
      statusEl.textContent = msg;
      statusEl.classList.add("text-destructive");
    }
    if (countEl) countEl.textContent = "";
    sel.innerHTML = `<option value="${escapeHtml(current)}">${escapeHtml(current || "select a model…")}</option>`;
    if (!current) sel.classList.add("text-muted-foreground");
    sel.disabled = false;
    return;
  }
  const opts = [];
  const currentInList = current && available.includes(current);
  if (current && !currentInList) {
    opts.push(`<option value="${escapeHtml(current)}" selected>${escapeHtml(current)} — not available</option>`);
  }
  available.forEach((id) => {
    const isActive = id === current;
    opts.push(
      `<option value="${escapeHtml(id)}" ${isActive ? "selected" : ""}${isActive ? ' data-active="1"' : ""}>${escapeHtml(id)}${isActive ? " ★ Active" : ""}</option>`
    );
  });
  sel.innerHTML = opts.length ? opts.join("") : `<option value="${escapeHtml(current)}">${escapeHtml(current || "—")}</option>`;
  sel.classList.remove("text-muted-foreground");
  if (countEl) countEl.textContent = `(${available.length} available)`;
  if (statusEl) {
    statusEl.textContent = currentInList
      ? "The currently active model is below."
      : current
      ? "Your saved model is no longer available — pick one below."
      : "";
    if (!currentInList && current) statusEl.classList.add("text-destructive");
  }
  sel.disabled = false;
}

function chatSettingHint(provider) {
  if (provider === "gemini") return "Key from Google AI Studio. Popular models: gemini-3.6-flash, gemini-2.5-pro, gemini-2.5-flash.";
  if (provider === "openai") return "Key from OpenAI platform. Popular models: gpt-4o, gpt-4o-mini, gpt-4.1.";
  if (provider === "groq") return "Key from console.groq.com. Popular models: openai/gpt-oss-120b, openai/gpt-oss-20b, qwen/qwen3.8-27b.";
  if (provider === "xai") return "Key from console.x.ai. Popular models: grok-2-latest, grok-2, grok-3.";
  if (provider === "omni") return "OmniRoute is a local OpenAI-compatible AI gateway. Set your gateway URL (default http://localhost:20128/v1), its API key, and use model 'auto' for smart routing.";
  return "Enter the API key and model name from your provider.";
}

async function saveChatSetting(provider) {
  const modelEl = $(`#model-${provider}`);
  const tempEl = $(`#temp-${provider}`);
  const mtokEl = $(`#maxtok-${provider}`);
  const body = { provider, model: modelEl ? modelEl.value.trim() : "" };
  const baseEl = $(`#base-url-${provider}`);
  if (baseEl) body.base_url = baseEl.value.trim();
  if (tempEl && tempEl.value) body.temperature = parseFloat(tempEl.value);
  if (mtokEl && mtokEl.value) body.max_tokens = parseInt(mtokEl.value, 10);
  try {
    chatSettings = await api("/api/chat/settings", { method: "PUT", body: JSON.stringify(body) });
    renderChatSettings();
    loadChatModels();
    toast("Saved to .env + database", "success");
  } catch (e) {
    toast(e.message, "error");
  }
}

async function addChatKey(provider) {
  const labelEl = $(`#key-label-${provider}`);
  const keyEl = $(`#key-new-${provider}`);
  const api_key = keyEl ? keyEl.value.trim() : "";
  const label = (labelEl ? labelEl.value.trim() : "") || "Key";
  if (!api_key) {
    toast("Paste the API key first", "error");
    return;
  }
  try {
    chatSettings = await api("/api/chat/keys", { method: "POST", body: JSON.stringify({ provider, label, api_key }) });
    renderChatSettings();
    loadChatModels();
    toast("API key added \u2014 it's ready to use", "success");
  } catch (e) {
    toast(e.message, "error");
  }
}

async function activateChatKey(provider, keyId) {
  try {
    chatSettings = await api("/api/chat/keys/active", { method: "POST", body: JSON.stringify({ provider, key_id: keyId }) });
    renderChatSettings();
    toast("Active key changed", "success");
  } catch (e) {
    toast(e.message, "error");
  }
}

async function toggleChatKey(provider, keyId, enabled) {
  try {
    chatSettings = await api(`/api/chat/keys/${keyId}`, { method: "PUT", body: JSON.stringify({ provider, enabled }) });
    renderChatSettings();
    toast(enabled ? "Key enabled" : "Key disabled", "success");
  } catch (e) {
    toast(e.message, "error");
  }
}

function deleteChatKey(provider, keyId) {
  const masked = ((chatSettings.providers.find((p) => p.provider === provider) || {}).keys || []).find(
    (k) => k.id === keyId
  );
  const label = (masked && masked.label) || "key";
  confirmDialog(`Remove the ${label} key from ${((chatSettings.meta || {})[provider] || {}).label || provider}?`, async () => {
    try {
      chatSettings = await api(`/api/chat/keys/${keyId}`, { method: "DELETE" });
      renderChatSettings();
      toast("Key removed", "success");
    } catch (e) {
      toast(e.message, "error");
    }
  });
}

async function testChatProvider(provider) {
  const btnEls = document.querySelectorAll(`[data-test="${provider}"]`);
  const resultEl = $(`#test-result-${provider}`);
  const connEl = $(`#conn-${provider}`);
  const setConn = (html, cls) => {
    if (connEl) {
      connEl.textContent = html;
      connEl.className = "font-medium " + cls;
    }
  };
  btnEls.forEach((b) => {
    b.disabled = true;
    b.textContent = "Testing\u2026";
  });
  if (resultEl) {
    resultEl.classList.remove("hidden", "text-emerald-600", "dark:text-emerald-400", "text-destructive");
    resultEl.textContent = "Contacting the provider\u2026";
  }
  setConn("Testing\u2026", "text-muted-foreground");
  try {
    const res = await api("/api/chat/settings/test", { method: "POST", body: JSON.stringify({ provider }) });
    if (res && res.ok) {
      setConn(`Online \u00b7 ${res.latency_ms} ms`, "text-emerald-600 dark:text-emerald-400");
      if (resultEl) {
        resultEl.classList.add("text-emerald-600", "dark:text-emerald-400");
        resultEl.textContent = `Connected \u2014 ${res.model} replied in ${res.latency_ms} ms: \u201c${res.reply}\u201d`;
      }
    } else {
      const msg = (res && res.error) || "Failed";
      setConn("Offline", "text-destructive");
      if (resultEl) {
        resultEl.classList.add("text-destructive");
        resultEl.textContent = msg;
      }
    }
  } catch (e) {
    setConn("Offline", "text-destructive");
    if (resultEl) {
      resultEl.classList.add("text-destructive");
      resultEl.textContent = e.message;
    }
  } finally {
    btnEls.forEach((b) => {
      b.disabled = false;
      b.textContent = "Test connection";
    });
  }
}

function resetChatTuning(provider) {
  const tempEl = $(`#temp-${provider}`);
  const valEl = $(`#temp-value-${provider}`);
  const mtokEl = $(`#maxtok-${provider}`);
  if (tempEl) tempEl.value = "0.2";
  if (valEl) valEl.textContent = "0.2";
  if (mtokEl) mtokEl.value = "1024";
  saveChatSetting(provider);
}

async function activateChatProvider(provider) {
  try {
    chatSettings = await api("/api/chat/settings/active", {
      method: "POST",
      body: JSON.stringify({ provider }),
    });
    renderChatSettings();
    loadChatModels();
    toast(`Active model: ${chatSettings.active_label}`, "success");
  } catch (e) {
    toast(e.message, "error");
  }
}

function removeChatKey(provider) {
  const label = ((chatSettings.meta || {})[provider] || {}).label || provider;
  confirmDialog(`Remove the saved API key for ${label}?`, async () => {
    try {
      chatSettings = await api(`/api/chat/settings/${encodeURIComponent(provider)}`, { method: "DELETE" });
      renderChatSettings();
      loadChatModels();
      toast("API key removed", "success");
    } catch (e) {
      toast(e.message, "error");
    }
  });
}

// ---------- Knowledge base (admin/manager CRUD) ----------

async function loadKnowledge() {
  try {
    knowledge = await api("/api/knowledge");
  } catch (e) {
    toast(e.message, "error");
    return;
  }
  renderKnowledge();
}

function renderKnowledge() {
  const box = $("#knowledge-list");
  if (!box) return;
  box.innerHTML = knowledge.length
    ? knowledge
        .map(
          (k) => `
      <div class="group px-4 py-3">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <p class="truncate text-sm font-semibold">${escapeHtml(k.title)}</p>
              <span class="rounded-full bg-accent px-2 py-0.5 text-[10px] font-medium text-accent-foreground">${escapeHtml(k.category || "General")}</span>
              ${creatorChip(k)}
            </div>
            <p class="mt-1 line-clamp-3 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">${escapeHtml(k.content || "")}</p>
            <p class="mt-1 text-[10px] text-muted-foreground">Updated ${relTime(k.updated_at)}</p>
          </div>
          ${canWrite() ? `
          <div class="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
            <button type="button" class="tool-btn h-7 min-w-7" data-kedit="${k.id}" title="Edit"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg></button>
            <button type="button" class="tool-btn h-7 min-w-7 hover:text-destructive" data-kdel="${k.id}" title="Delete"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg></button>
          </div>` : ""}
        </div>
      </div>`
        )
        .join("")
    : `<div class="flex flex-col items-center justify-center gap-2 px-4 py-16 text-center">
         <p class="text-sm font-medium">No knowledge rules yet</p>
         <p class="max-w-sm text-xs text-muted-foreground">Add billing rules, CPT/ICD code notes and payer guidelines — the chatbot will answer from them first.</p>
       </div>`;
  box.querySelectorAll("[data-kedit]").forEach((b) =>
    b.addEventListener("click", () => knowledgeDialog(knowledge.find((x) => x.id === Number(b.dataset.kedit))))
  );
  box.querySelectorAll("[data-kdel]").forEach((b) =>
    b.addEventListener("click", () => {
      const k = knowledge.find((x) => x.id === Number(b.dataset.kdel));
      if (!k) return;
      confirmDialog(`Delete "${k.title}"?`, async () => {
        try {
          await api(`/api/knowledge/${k.id}`, { method: "DELETE" });
          knowledge = knowledge.filter((x) => x.id !== k.id);
          renderKnowledge();
          toast("Rule deleted");
        } catch (err) {
          toast(err.message, "error");
        }
      });
    })
  );
}

function knowledgeDialog(item) {
  const editing = !!item;
  const src = item || { title: "", category: "", content: "" };
  openDialog(`
    <div class="flex items-start gap-3">
      <div class="mt-0.5 rounded-full bg-primary/10 p-2 text-primary">
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/></svg>
      </div>
      <div>
        <h3 class="text-base font-semibold">${editing ? "Edit rule" : "New knowledge rule"}</h3>
        <p class="mt-0.5 text-sm text-muted-foreground">The chatbot searches these rules first and labels such answers "Office rules".</p>
      </div>
    </div>
    <form id="knowledge-form" class="mt-4 space-y-3">
      <input id="k-title" required type="text" maxlength="120" placeholder="Title (e.g. CalViva claim window)" class="input w-full" value="${escapeHtml(src.title)}">
      <input id="k-category" type="text" maxlength="80" placeholder="Category (e.g. CalViva · Sante IPA · CPT Rules)" class="input w-full" value="${escapeHtml(src.category || "")}">
      <textarea id="k-content" rows="8" placeholder="The rule / guideline text the assistant must follow..." class="input w-full resize-y">${escapeHtml(src.content || "")}</textarea>
      <div class="flex justify-end gap-2">
        <button type="button" class="btn btn-outline" data-cancel-dialog>Cancel</button>
        <button type="submit" class="btn btn-primary">Save</button>
      </div>
    </form>
  `);
  $("#knowledge-form [data-cancel-dialog]").addEventListener("click", closeDialog);
  $("#knowledge-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = $("#k-title").value.trim();
    if (!title) return;
    const body = { title, category: $("#k-category").value.trim(), content: $("#k-content").value };
    try {
      if (editing) {
        const updated = await api(`/api/knowledge/${item.id}`, { method: "PUT", body: JSON.stringify(body) });
        const idx = knowledge.findIndex((x) => x.id === item.id);
        if (idx >= 0) knowledge[idx] = updated;
      } else {
        const created = await api("/api/knowledge", { method: "POST", body: JSON.stringify(body) });
        knowledge.unshift(created);
      }
      closeDialog();
      renderKnowledge();
      toast(editing ? "Rule updated" : "Rule added");
    } catch (err) {
      toast(err.message, "error");
    }
  });
  setTimeout(() => $("#k-title").focus(), 0);
}

function initKnowledge() {
  $("#knowledge-add-btn")?.addEventListener("click", () => knowledgeDialog(null));
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
  initPortals();
  initChat();
  initKnowledge();
  initAgents();
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
        // Strip/restore the browser-local "web_portals" part into localStorage,
        // the rest of the file goes to the server.
        let payload;
        let hadPortals = false;
        try {
          payload = JSON.parse(await file.text());
        } catch (err) {
          throw new Error("Invalid JSON backup file");
        }
        const holder = payload && payload.data && typeof payload.data === "object" ? payload.data : payload;
        if (holder && typeof holder === "object") {
          if (Array.isArray(holder.web_portals)) {
            hadPortals = true;
            savePortals(holder.web_portals.filter((p) => p && (p.name || "").trim()));
            delete holder.web_portals;
          }
        } else {
          throw new Error("Unexpected backup structure");
        }
        const fd = new FormData();
        fd.append("file", new File([JSON.stringify(payload)], file.name, { type: "application/json" }));
        fd.append("mode", mode);
        const res = await api("/api/import", { method: "POST", body: fd });
        status.textContent = `Done — imported ${res.imported}, skipped ${res.skipped}`;
        toast(`Backup restored (${mode})${hadPortals ? ", portals included" : ""}`);
        if (state.view === "webportals") renderPortals();
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

  // Export JSON = server data + browser-local web portals in one file
  $("#export-json-btn").addEventListener("click", async (e) => {
    e.preventDefault();
    const btn = $("#export-json-btn");
    const orig = btn.innerHTML;
    btn.innerHTML = "Preparing…";
    btn.classList.add("opacity-60", "pointer-events-none");
    try {
      if (!navigator.onLine) throw new Error("Offline — cannot fetch server data");
      const res = await fetch("/api/export/json");
      if (!res.ok) throw new Error("Export failed");
      const payload = JSON.parse(await res.text());
      if (payload && payload.data && typeof payload.data === "object") payload.data.web_portals = getPortals();
      else if (payload && typeof payload === "object") payload.web_portals = getPortals();
      const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `assistant-backup-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      toast(err.message || "Export failed", "error");
    } finally {
      btn.innerHTML = orig;
      btn.classList.remove("opacity-60", "pointer-events-none");
    }
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
      document.body.classList.remove("sidebar-open");
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
  const BOOT_VIEWS = ["tasks", "notes", "pages", "webportals", "schedule", "calendar", "settings", "chat", "knowledge", "chat-settings", "agents"];
  const viewerLocked = state.user?.role === "user" && ["tasks", "schedule", "calendar", "settings", "chat", "knowledge", "chat-settings", "agents"].includes(bootSegs[0]);
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
      const VIEWS = ["tasks", "notes", "pages", "webportals", "schedule", "calendar", "settings", "chat", "knowledge", "chat-settings", "agents"];
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
