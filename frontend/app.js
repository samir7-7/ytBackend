/* ============================================================================
 * VidTube frontend — vanilla JS SPA synced to the ytBackend API.
 * Auth uses Authorization: Bearer <accessToken> (backend CORS is "*", which
 * blocks credentialed cookies), with automatic refresh-token retry on 401.
 * ==========================================================================*/

const API_BASE = "http://localhost:8001/api/v1";

/* ----------------------------- tiny helpers ------------------------------ */
const $ = (sel, root = document) => root.querySelector(sel);
const view = $("#view");

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

function toast(msg, type = "") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast " + type;
  setTimeout(() => t.classList.add("hidden"), 3200);
}

function fmtNum(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

function fmtDuration(sec) {
  sec = Math.floor(Number(sec) || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return (h ? h + ":" : "") + mm + ":" + String(s).padStart(2, "0");
}

function timeAgo(date) {
  if (!date) return "";
  const d = (Date.now() - new Date(date).getTime()) / 1000;
  const units = [
    [31536000, "year"],
    [2592000, "month"],
    [604800, "week"],
    [86400, "day"],
    [3600, "hour"],
    [60, "minute"],
  ];
  for (const [secs, label] of units) {
    const v = Math.floor(d / secs);
    if (v >= 1) return `${v} ${label}${v > 1 ? "s" : ""} ago`;
  }
  return "just now";
}

const FALLBACK_AV =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#ccc"/><circle cx="40" cy="32" r="16" fill="#999"/><rect x="16" y="52" width="48" height="28" rx="14" fill="#999"/></svg>'
  );
const FALLBACK_THUMB =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#222"/><text x="160" y="96" fill="#888" font-size="18" text-anchor="middle" font-family="Arial">no thumbnail</text></svg>'
  );

/* ------------------------------ auth state ------------------------------- */
const store = {
  get access() { return localStorage.getItem("vt_access"); },
  get refresh() { return localStorage.getItem("vt_refresh"); },
  get user() { try { return JSON.parse(localStorage.getItem("vt_user")); } catch { return null; } },
  set tokens({ access, refresh }) {
    if (access) localStorage.setItem("vt_access", access);
    if (refresh) localStorage.setItem("vt_refresh", refresh);
  },
  set user(u) { localStorage.setItem("vt_user", JSON.stringify(u)); },
  clear() {
    ["vt_access", "vt_refresh", "vt_user"].forEach((k) => localStorage.removeItem(k));
  },
};

const isAuthed = () => !!store.access && !!store.user;

/* ------------------------------- API core -------------------------------- */
/**
 * api(path, { method, body, auth, raw })
 * - body: plain object => JSON; FormData => sent as-is (multipart).
 * - returns parsed `data` field of the ApiResponse envelope.
 * - on 401, transparently tries the refresh token once, then retries.
 */
async function api(path, opts = {}) {
  return request(path, opts, true);
}

async function request(path, opts, allowRefresh) {
  const { method = "GET", body, auth = true } = opts;
  const headers = {};
  let payload;

  if (body instanceof FormData) {
    payload = body; // browser sets multipart boundary
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  if (auth && store.access) headers["Authorization"] = "Bearer " + store.access;

  let res;
  try {
    res = await fetch(API_BASE + path, { method, headers, body: payload });
  } catch (e) {
    throw new Error("Cannot reach server. Is the backend running on :8001?");
  }

  if (res.status === 401 && allowRefresh && store.refresh) {
    const ok = await tryRefresh();
    if (ok) return request(path, opts, false);
  }

  // The backend has no JSON error middleware: success => JSON envelope,
  // errors => an HTML page. Parse whichever we got.
  const ctype = res.headers.get("content-type") || "";
  let json = null, text = null;
  if (ctype.includes("application/json")) {
    try { json = await res.json(); } catch { /* empty */ }
  } else {
    try { text = await res.text(); } catch { /* empty */ }
  }

  if (!res.ok) {
    let msg = json && (json.message || json.error);
    if (!msg && text) {
      // extract "Error: <message>" from the express HTML error page
      const m = text.match(/<pre>(?:Error:\s*)?([^<]+)/i);
      if (m) msg = m[1].trim();
    }
    const err = new Error(msg || res.statusText || "Request failed");
    err.status = res.status;
    throw err;
  }
  return json ? json.data : null;
}

async function tryRefresh() {
  try {
    const res = await fetch(API_BASE + "/users/refresh-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: store.refresh }),
    });
    if (!res.ok) return false;
    const json = await res.json();
    store.tokens = { access: json.data.accessToken, refresh: json.data.refreshToken };
    return true;
  } catch {
    return false;
  }
}

/* --------------------------- watch history ------------------------------- */
// The backend never writes to user.watchHistory (no endpoint records it),
// so /users/history is always empty. We track history locally instead,
// keyed per logged-in user, storing a lightweight snapshot of each video.
const HISTORY_MAX = 100;
const historyKey = () => `vt_history_${store.user?._id || "anon"}`;

function recordHistory(v) {
  if (!v || !v._id) return;
  const o = v.owner || {};
  const entry = {
    _id: v._id,
    title: v.title,
    thumbnail: v.thumbnail,
    duration: v.duration,
    views: v.views,
    createdAt: v.createdAt,
    owner: o._id ? { _id: o._id, username: o.username, fullName: o.fullName, avatar: o.avatar } : null,
    watchedAt: new Date().toISOString(),
  };
  let list = [];
  try { list = JSON.parse(localStorage.getItem(historyKey())) || []; } catch { list = []; }
  list = list.filter((x) => x._id !== v._id); // move to top, no dupes
  list.unshift(entry);
  if (list.length > HISTORY_MAX) list = list.slice(0, HISTORY_MAX);
  localStorage.setItem(historyKey(), JSON.stringify(list));
}

function getHistory() {
  try { return JSON.parse(localStorage.getItem(historyKey())) || []; } catch { return []; }
}
function clearHistory() { localStorage.removeItem(historyKey()); }

/* --------------------------- owner name cache ---------------------------- */
// getAllVideos returns `owner` as a bare id; getVideoById populates it.
// We cache resolved owners so grids can show channel name/avatar.
const ownerCache = new Map();

function cacheOwner(o) {
  if (o && typeof o === "object" && o._id) ownerCache.set(o._id, o);
}

async function enrichVideos(videos) {
  const need = new Set();
  for (const v of videos) {
    if (v && typeof v.owner === "string" && !ownerCache.has(v.owner)) need.add(v._id);
  }
  // Resolve unknown owners by fetching video detail (owner gets populated).
  await Promise.all(
    [...need].map(async (id) => {
      try {
        const full = await api(`/videos/${id}`);
        cacheOwner(full.owner);
      } catch { /* ignore */ }
    })
  );
  return videos.map((v) => {
    if (v && typeof v.owner === "object") cacheOwner(v.owner);
    const owner = typeof v.owner === "object" ? v.owner : ownerCache.get(v.owner);
    return { ...v, owner: owner || null };
  });
}

/* ------------------------------- modal ----------------------------------- */
function openModal(title, html) {
  $("#modal-title").textContent = title;
  $("#modal-body").innerHTML = html;
  $("#modal-root").classList.remove("hidden");
}
function closeModal() {
  $("#modal-root").classList.add("hidden");
  $("#modal-body").innerHTML = "";
}
$("#modal-close").onclick = closeModal;
$("#modal-root").onclick = (e) => { if (e.target.id === "modal-root") closeModal(); };

/* =============================== ROUTER ================================== */
function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [pathPart, queryPart] = raw.split("?");
  const parts = pathPart.split("/").filter(Boolean);
  const query = {};
  if (queryPart) for (const kv of queryPart.split("&")) {
    const [k, v] = kv.split("=");
    query[decodeURIComponent(k)] = decodeURIComponent(v || "");
  }
  return { parts, query };
}

const routes = []; // {match(parts) -> params|null, handler}

function route(pattern, handler) {
  const segs = pattern.split("/").filter(Boolean);
  routes.push({
    handler,
    match(parts) {
      if (parts.length !== segs.length) return null;
      const params = {};
      for (let i = 0; i < segs.length; i++) {
        if (segs[i].startsWith(":")) params[segs[i].slice(1)] = parts[i];
        else if (segs[i] !== parts[i]) return null;
      }
      return params;
    },
  });
}

async function router() {
  const { parts, query } = parseHash();

  // gate: everything except auth/healthcheck requires login
  const open = parts[0] === "auth" || parts[0] === "healthcheck";
  if (!isAuthed() && !open) {
    location.hash = "#/auth";
    return;
  }
  if (isAuthed() && parts[0] === "auth") {
    location.hash = "#/";
    return;
  }

  renderChrome();
  for (const r of routes) {
    const params = r.match(parts);
    if (params) {
      view.innerHTML = `<div class="spinner">Loading…</div>`;
      try {
        await r.handler(params, query);
      } catch (e) {
        view.innerHTML = `<div class="empty">⚠️ ${esc(e.message)}</div>`;
      }
      view.scrollTo?.(0, 0);
      window.scrollTo(0, 0);
      return;
    }
  }
  view.innerHTML = `<div class="empty">Page not found.</div>`;
}

window.addEventListener("hashchange", router);

/* =========================== CHROME (nav/topbar) ======================== */
function renderChrome() {
  const u = store.user;
  // top-right
  const right = $("#topbar-right");
  if (isAuthed()) {
    right.innerHTML = `
      <button class="btn btn-sm" id="tb-upload">⬆ Upload</button>
      <button class="avatar-btn" id="tb-avatar" title="${esc(u.username)}">
        <img src="${esc(u.avatar || FALLBACK_AV)}" onerror="this.src='${FALLBACK_AV}'"/>
      </button>`;
    $("#tb-upload").onclick = openUploadModal;
    $("#tb-avatar").onclick = () => (location.hash = `#/channel/${u.username}`);
  } else {
    right.innerHTML = `<a class="btn btn-sm btn-primary" href="#/auth">Sign in</a>`;
  }

  // sidebar
  const nav = $("#side-nav");
  if (!isAuthed()) {
    nav.innerHTML = navLink("#/auth", "🔑", "Sign in") + navLink("#/healthcheck", "🩺", "Healthcheck");
  } else {
    nav.innerHTML =
      navLink("#/", "🏠", "Home") +
      navLink("#/subscriptions", "📺", "Subscriptions") +
      `<hr class="nav-sep"/>` +
      `<div class="nav-label">You</div>` +
      navLink(`#/channel/${u.username}`, "👤", "Your channel") +
      navLink("#/dashboard", "📊", "Dashboard") +
      navLink("#/history", "🕑", "History") +
      navLink("#/playlists", "📂", "Playlists") +
      navLink("#/liked", "👍", "Liked videos") +
      navLink("#/tweets", "💬", "Tweets") +
      `<hr class="nav-sep"/>` +
      navLink("#/settings", "⚙️", "Settings") +
      navLink("#/healthcheck", "🩺", "Healthcheck") +
      `<a href="#" id="nav-logout"><span class="nav-ico">🚪</span> Logout</a>`;
    $("#nav-logout").onclick = (e) => { e.preventDefault(); logout(); };
  }
  highlightNav();
}

function navLink(href, ico, label) {
  return `<a href="${href}"><span class="nav-ico">${ico}</span> ${label}</a>`;
}
function highlightNav() {
  const cur = "#" + (location.hash.replace(/^#/, "") || "/").split("?")[0];
  $("#side-nav").querySelectorAll("a").forEach((a) => {
    a.classList.toggle("active", a.getAttribute("href") === cur);
  });
}

$("#menu-toggle").onclick = () => {
  if (window.innerWidth <= 800) document.body.classList.toggle("nav-open");
  else document.body.classList.toggle("nav-collapsed");
};
$("#search-form").onsubmit = (e) => {
  e.preventDefault();
  const q = $("#search-input").value.trim();
  location.hash = q ? `#/search?q=${encodeURIComponent(q)}` : "#/";
};

/* ------------------------------- auth ops -------------------------------- */
async function logout() {
  try { await api("/users/logout", { method: "POST" }); } catch { /* ignore */ }
  store.clear();
  toast("Logged out", "ok");
  location.hash = "#/auth";
  router();
}

/* =============================== VIEWS ================================== */

/* ---- shared: video card + grid ---- */
function videoCardHTML(v) {
  const o = v.owner || {};
  return `
  <div class="video-card" data-id="${v._id}">
    <div class="thumb-wrap">
      <img src="${esc(v.thumbnail || FALLBACK_THUMB)}" onerror="this.src='${FALLBACK_THUMB}'"/>
      <span class="thumb-dur">${fmtDuration(v.duration)}</span>
      ${v.isPublished === false ? `<span class="badge-unpub">Unlisted/Draft</span>` : ""}
    </div>
    <div class="video-meta">
      <img class="av" src="${esc(o.avatar || FALLBACK_AV)}" onerror="this.src='${FALLBACK_AV}'"/>
      <div class="video-info">
        <p class="v-title">${esc(v.title)}</p>
        <div class="v-sub">${esc(o.fullName || o.username || "Unknown channel")}</div>
        <div class="v-sub">${fmtNum(v.views)} views • ${timeAgo(v.createdAt)}</div>
      </div>
    </div>
  </div>`;
}

function wireVideoCards(root) {
  root.querySelectorAll(".video-card").forEach((c) => {
    c.onclick = () => (location.hash = `#/watch/${c.dataset.id}`);
  });
}

function gridHTML(videos) {
  if (!videos.length) return `<div class="empty">No videos here yet.</div>`;
  return `<div class="video-grid">${videos.map(videoCardHTML).join("")}</div>`;
}

/* ---- HOME (with sort) ---- */
route("/", async (_p, q) => {
  const page = Number(q.page) || 1;
  const sort = q.sort || "new";
  const params = new URLSearchParams({ page: page, limit: 12 });
  if (sort === "views") { params.set("sortBy", "views"); params.set("sortType", "desc"); }
  else { params.set("sortBy", "createdAt"); params.set("sortType", "desc"); }

  const data = await api(`/videos?${params}`);
  const videos = await enrichVideos(data.docs || []);

  view.innerHTML = `
    <div class="row-between" style="margin-bottom:14px">
      <h1 class="page-title" style="margin:0">Home</h1>
      <div class="btn-row">
        <button class="btn btn-sm ${sort === "new" ? "btn-primary" : ""}" data-sort="new">Latest</button>
        <button class="btn btn-sm ${sort === "views" ? "btn-primary" : ""}" data-sort="views">Most viewed</button>
      </div>
    </div>
    ${gridHTML(videos)}
    ${pagerHTML(data, (p) => `#/?sort=${sort}&page=${p}`)}`;

  wireVideoCards(view);
  view.querySelectorAll("[data-sort]").forEach((b) => {
    b.onclick = () => (location.hash = `#/?sort=${b.dataset.sort}&page=1`);
  });
});

/* ---- SEARCH ---- */
route("/search", async (_p, q) => {
  const term = q.q || "";
  $("#search-input").value = term;
  const page = Number(q.page) || 1;
  const params = new URLSearchParams({ page, limit: 12, query: term });
  const data = await api(`/videos?${params}`);
  const videos = await enrichVideos(data.docs || []);
  view.innerHTML = `
    <h1 class="page-title">Results for “${esc(term)}”</h1>
    ${gridHTML(videos)}
    ${pagerHTML(data, (p) => `#/search?q=${encodeURIComponent(term)}&page=${p}`)}`;
  wireVideoCards(view);
});

function pagerHTML(data, hrefFor) {
  if (!data || data.totalPages <= 1) return "";
  const p = data.page;
  return `<div class="pager">
    ${data.hasPrevPage ? `<a class="btn btn-sm" href="${hrefFor(p - 1)}">← Prev</a>` : ""}
    <span class="muted">Page ${p} of ${data.totalPages}</span>
    ${data.hasNextPage ? `<a class="btn btn-sm" href="${hrefFor(p + 1)}">Next →</a>` : ""}
  </div>`;
}

/* ---- WATCH ---- */
route("/watch/:id", async ({ id }) => {
  const v = await api(`/videos/${id}`);
  cacheOwner(v.owner);
  recordHistory(v);
  const o = v.owner || {};
  const me = store.user;
  const isOwner = me && o._id === me._id;

  // like + subscribe state
  let liked = false;
  try {
    const likedList = await api("/likes/videos");
    liked = (likedList || []).some((l) => l.video && (l.video._id === v._id || l.video === v._id));
  } catch { /* ignore */ }

  let channel = null;
  if (o.username) {
    try { channel = await api(`/users/c/${o.username}`); } catch { /* ignore */ }
  }

  // related
  let related = [];
  try {
    const data = await api(`/videos?limit=8&sortBy=createdAt&sortType=desc`);
    related = await enrichVideos((data.docs || []).filter((x) => x._id !== v._id));
  } catch { /* ignore */ }

  view.innerHTML = `
  <div class="watch">
    <div class="primary">
      <div class="player">
        <video src="${esc(v.videoFile)}" controls autoplay playsinline poster="${esc(v.thumbnail || "")}"></video>
      </div>
      <h1 class="watch-title">${esc(v.title)}</h1>

      <div class="watch-actionbar">
        <div class="channel-row">
          <img class="av" src="${esc(o.avatar || FALLBACK_AV)}" onerror="this.src='${FALLBACK_AV}'"/>
          <div>
            <a class="c-name" href="#/channel/${esc(o.username || "")}">${esc(o.fullName || o.username || "Unknown")}</a>
            <div class="c-sub">${channel ? fmtNum(channel.subscribersCount) + " subscribers" : ""}</div>
          </div>
          ${
            isOwner || !o.username
              ? ""
              : `<button class="btn ${channel?.isSubscribed ? "" : "btn-accent"}" id="sub-btn" style="margin-left:14px">
                   ${channel?.isSubscribed ? "Subscribed ✓" : "Subscribe"}
                 </button>`
          }
        </div>

        <div class="pill-group">
          <button class="pill ${liked ? "active" : ""}" id="like-btn">👍 <span>${liked ? "Liked" : "Like"}</span></button>
          <button class="pill" id="save-btn">📂 Save</button>
          ${isOwner ? `<button class="pill" id="edit-btn">✏️ Edit</button>
                       <button class="pill" id="pub-btn">${v.isPublished ? "👁 Unpublish" : "🚀 Publish"}</button>
                       <button class="pill" id="del-btn">🗑 Delete</button>` : ""}
        </div>
      </div>

      <div class="desc-box">
        <div class="d-stats">${fmtNum(v.views)} views • ${timeAgo(v.createdAt)}</div>
        ${esc(v.description) || "<span class='muted'>No description</span>"}
      </div>

      <div class="comments" id="comments"></div>
    </div>

    <aside class="related">
      <h3 style="margin-top:0">Up next</h3>
      ${related.map(relatedItemHTML).join("") || "<div class='muted'>Nothing else yet.</div>"}
    </aside>
  </div>`;

  view.querySelectorAll(".related .r-item").forEach((el) => {
    el.onclick = () => (location.hash = `#/watch/${el.dataset.id}`);
  });

  // like
  $("#like-btn").onclick = async () => {
    try {
      const r = await api(`/likes/toggle/v/${v._id}`, { method: "POST" });
      const on = r.isLiked;
      $("#like-btn").classList.toggle("active", on);
      $("#like-btn").querySelector("span").textContent = on ? "Liked" : "Like";
    } catch (e) { toast(e.message, "err"); }
  };

  // save to playlist
  $("#save-btn").onclick = () => openSaveToPlaylist(v._id);

  // subscribe
  const subBtn = $("#sub-btn");
  if (subBtn && channel) {
    subBtn.onclick = async () => {
      try {
        const r = await api(`/subscriptions/c/${channel._id}`, { method: "POST" });
        channel.isSubscribed = r.isSubscribed;
        subBtn.textContent = r.isSubscribed ? "Subscribed ✓" : "Subscribe";
        subBtn.classList.toggle("btn-accent", !r.isSubscribed);
      } catch (e) { toast(e.message, "err"); }
    };
  }

  // owner controls
  if (isOwner) {
    $("#edit-btn").onclick = () => openEditVideo(v);
    $("#pub-btn").onclick = async () => {
      try {
        const r = await api(`/videos/toggle/publish/${v._id}`, { method: "PATCH" });
        toast(r.isPublished ? "Published" : "Unpublished", "ok");
        router();
      } catch (e) { toast(e.message, "err"); }
    };
    $("#del-btn").onclick = async () => {
      if (!confirm("Delete this video permanently?")) return;
      try {
        await api(`/videos/${v._id}`, { method: "DELETE" });
        toast("Video deleted", "ok");
        location.hash = "#/";
      } catch (e) { toast(e.message, "err"); }
    };
  }

  loadComments(v._id);
});

function relatedItemHTML(v) {
  const o = v.owner || {};
  return `<div class="r-item" data-id="${v._id}">
    <img class="r-thumb" src="${esc(v.thumbnail || FALLBACK_THUMB)}" onerror="this.src='${FALLBACK_THUMB}'"/>
    <div>
      <div class="r-title">${esc(v.title)}</div>
      <div class="r-sub">${esc(o.fullName || o.username || "")}</div>
      <div class="r-sub">${fmtNum(v.views)} views • ${timeAgo(v.createdAt)}</div>
    </div>
  </div>`;
}

/* ---- COMMENTS ---- */
async function loadComments(videoId) {
  const box = $("#comments");
  const me = store.user;
  let data;
  try { data = await api(`/comments/${videoId}?limit=50`); }
  catch (e) { box.innerHTML = `<div class="muted">Could not load comments: ${esc(e.message)}</div>`; return; }

  const comments = data.docs || [];
  box.innerHTML = `
    <h3>${comments.length} Comments</h3>
    <div class="comment-form">
      <img class="av" src="${esc(me.avatar || FALLBACK_AV)}" onerror="this.src='${FALLBACK_AV}'"/>
      <div class="grow">
        <div class="field" style="margin:0">
          <textarea id="cmt-input" placeholder="Add a comment…" style="min-height:48px"></textarea>
        </div>
        <div class="btn-row" style="margin-top:8px;justify-content:flex-end">
          <button class="btn btn-sm btn-primary" id="cmt-send">Comment</button>
        </div>
      </div>
    </div>
    <div id="cmt-list">${comments.map((c) => commentHTML(c, me)).join("")}</div>`;

  $("#cmt-send").onclick = async () => {
    const content = $("#cmt-input").value.trim();
    if (!content) return;
    try {
      await api(`/comments/${videoId}`, { method: "POST", body: { content } });
      loadComments(videoId);
    } catch (e) { toast(e.message, "err"); }
  };

  wireCommentActions(videoId);
}

function commentHTML(c, me) {
  const mine = me && (c.owner === me._id || c.owner?._id === me._id);
  const who = mine ? "You" : "User " + String(c.owner).slice(-6);
  const initial = (mine ? me.username : "U").charAt(0).toUpperCase();
  return `<div class="comment" data-id="${c._id}">
    <div class="av">${initial}</div>
    <div class="grow">
      <div class="c-head"><b>${esc(who)}</b> • ${timeAgo(c.createdAt)}</div>
      <div class="c-body">${esc(c.content)}</div>
      <div class="c-actions">
        <button class="btn-ghost cmt-like" data-id="${c._id}">👍 Like</button>
        ${mine ? `<button class="btn-ghost cmt-edit" data-id="${c._id}">Edit</button>
                  <button class="btn-ghost cmt-del" data-id="${c._id}">Delete</button>` : ""}
      </div>
    </div>
  </div>`;
}

function wireCommentActions(videoId) {
  view.querySelectorAll(".cmt-like").forEach((b) => {
    b.onclick = async () => {
      try {
        const r = await api(`/likes/toggle/c/${b.dataset.id}`, { method: "POST" });
        toast(r.isLiked ? "Liked comment" : "Like removed", "ok");
      } catch (e) { toast(e.message, "err"); }
    };
  });
  view.querySelectorAll(".cmt-del").forEach((b) => {
    b.onclick = async () => {
      if (!confirm("Delete this comment?")) return;
      try { await api(`/comments/c/${b.dataset.id}`, { method: "DELETE" }); loadComments(videoId); }
      catch (e) { toast(e.message, "err"); }
    };
  });
  view.querySelectorAll(".cmt-edit").forEach((b) => {
    b.onclick = () => {
      const row = b.closest(".comment");
      const body = row.querySelector(".c-body");
      const old = body.textContent;
      body.innerHTML = `<textarea class="cmt-edit-input" style="width:100%">${esc(old)}</textarea>
        <div class="btn-row" style="margin-top:6px">
          <button class="btn btn-sm btn-primary cmt-save">Save</button>
          <button class="btn btn-sm cmt-cancel">Cancel</button>
        </div>`;
      row.querySelector(".cmt-cancel").onclick = () => loadComments(videoId);
      row.querySelector(".cmt-save").onclick = async () => {
        const content = row.querySelector(".cmt-edit-input").value.trim();
        if (!content) return;
        try { await api(`/comments/c/${b.dataset.id}`, { method: "PATCH", body: { content } }); loadComments(videoId); }
        catch (e) { toast(e.message, "err"); }
      };
    };
  });
}

/* ---- CHANNEL ---- */
route("/channel/:username", async ({ username }, q) => {
  const tab = q.tab || "videos";
  const ch = await api(`/users/c/${username}`);
  cacheOwner({ _id: ch._id, username: ch.username, fullName: ch.fullName, avatar: ch.avatar });
  const me = store.user;
  const isMe = me && me._id === ch._id;

  view.innerHTML = `
    ${ch.coverImage ? `<img class="cover" src="${esc(ch.coverImage)}" onerror="this.style.display='none'"/>` : ""}
    <div class="channel-header">
      <img class="big-av" src="${esc(ch.avatar || FALLBACK_AV)}" onerror="this.src='${FALLBACK_AV}'"/>
      <div>
        <h1 style="margin:0 0 4px">${esc(ch.fullName)}</h1>
        <div class="muted">@${esc(ch.username)} • ${fmtNum(ch.subscribersCount)} subscribers • ${fmtNum(ch.channelsSubscribedToCount)} subscribed</div>
        <div style="margin-top:10px">
          ${
            isMe
              ? `<a class="btn btn-sm" href="#/settings">Customize</a> <a class="btn btn-sm" href="#/dashboard">Dashboard</a>`
              : `<button class="btn ${ch.isSubscribed ? "" : "btn-accent"}" id="ch-sub">${ch.isSubscribed ? "Subscribed ✓" : "Subscribe"}</button>`
          }
        </div>
      </div>
    </div>
    <div class="tabs">
      <button data-tab="videos" class="${tab === "videos" ? "active" : ""}">Videos</button>
      <button data-tab="playlists" class="${tab === "playlists" ? "active" : ""}">Playlists</button>
      <button data-tab="tweets" class="${tab === "tweets" ? "active" : ""}">Tweets</button>
    </div>
    <div id="ch-body"><div class="spinner">Loading…</div></div>`;

  view.querySelectorAll(".tabs button").forEach((b) => {
    b.onclick = () => (location.hash = `#/channel/${username}?tab=${b.dataset.tab}`);
  });

  const subBtn = $("#ch-sub");
  if (subBtn) subBtn.onclick = async () => {
    try {
      const r = await api(`/subscriptions/c/${ch._id}`, { method: "POST" });
      subBtn.textContent = r.isSubscribed ? "Subscribed ✓" : "Subscribe";
      subBtn.classList.toggle("btn-accent", !r.isSubscribed);
    } catch (e) { toast(e.message, "err"); }
  };

  const body = $("#ch-body");
  if (tab === "videos") {
    const data = await api(`/videos?userId=${ch._id}&limit=24&sortBy=createdAt&sortType=desc`);
    const videos = await enrichVideos(data.docs || []);
    body.innerHTML = gridHTML(videos);
    wireVideoCards(body);
  } else if (tab === "playlists") {
    const pls = await api(`/playlist/user/${ch._id}`);
    body.innerHTML = pls.length
      ? pls.map((p) => `<div class="card row-between"><div><b>${esc(p.name)}</b><div class="muted">${esc(p.description)} • ${(p.videos || []).length} videos</div></div>
          <a class="btn btn-sm" href="#/playlist/${p._id}">Open</a></div>`).join("")
      : `<div class="empty">No playlists.</div>`;
  } else {
    const tweets = await api(`/tweets/user/${ch._id}`);
    body.innerHTML = tweets.length
      ? tweets.map((t) => tweetHTML(t, isMe)).join("")
      : `<div class="empty">No tweets.</div>`;
    if (isMe) wireTweetActions(() => (location.hash = `#/channel/${username}?tab=tweets`));
  }
});

/* ---- DASHBOARD ---- */
route("/dashboard", async () => {
  const [stats, videos] = await Promise.all([
    api("/dashboard/stats"),
    api("/dashboard/videos"),
  ]);
  view.innerHTML = `
    <div class="row-between" style="margin-bottom:16px">
      <h1 class="page-title" style="margin:0">Creator Dashboard</h1>
      <button class="btn btn-primary" id="dash-upload">⬆ Upload video</button>
    </div>
    <div class="stat-grid">
      <div class="stat"><div class="num">${fmtNum(stats.totalVideos)}</div><div class="lbl">Videos</div></div>
      <div class="stat"><div class="num">${fmtNum(stats.totalViews)}</div><div class="lbl">Total views</div></div>
      <div class="stat"><div class="num">${fmtNum(stats.totalSubscribers)}</div><div class="lbl">Subscribers</div></div>
      <div class="stat"><div class="num">${fmtNum(stats.totalLikes)}</div><div class="lbl">Total likes</div></div>
    </div>
    <h2 style="font-size:16px">Your videos</h2>
    <div id="dash-list"></div>`;

  $("#dash-upload").onclick = openUploadModal;
  const list = $("#dash-list");
  list.innerHTML = videos.length
    ? videos.map((v) => `
        <div class="card row-between">
          <div style="display:flex;gap:12px;align-items:center;min-width:0">
            <img src="${esc(v.thumbnail || FALLBACK_THUMB)}" style="width:120px;aspect-ratio:16/9;object-fit:cover;border-radius:8px"/>
            <div style="min-width:0">
              <b>${esc(v.title)}</b>
              <div class="muted">${fmtNum(v.views)} views • ${v.isPublished ? "Published" : "Unpublished"} • ${timeAgo(v.createdAt)}</div>
            </div>
          </div>
          <div class="btn-row">
            <a class="btn btn-sm" href="#/watch/${v._id}">Open</a>
            <button class="btn btn-sm dash-edit" data-id="${v._id}">Edit</button>
            <button class="btn btn-sm dash-del" data-id="${v._id}">Delete</button>
          </div>
        </div>`).join("")
    : `<div class="empty">You haven't uploaded any videos. Click “Upload video”.</div>`;

  list.querySelectorAll(".dash-edit").forEach((b) => {
    b.onclick = async () => {
      const v = await api(`/videos/${b.dataset.id}`);
      openEditVideo(v);
    };
  });
  list.querySelectorAll(".dash-del").forEach((b) => {
    b.onclick = async () => {
      if (!confirm("Delete this video?")) return;
      try { await api(`/videos/${b.dataset.id}`, { method: "DELETE" }); toast("Deleted", "ok"); router(); }
      catch (e) { toast(e.message, "err"); }
    };
  });
});

/* ---- LIKED VIDEOS ---- */
route("/liked", async () => {
  const likes = await api("/likes/videos");
  const videos = (likes || []).map((l) => l.video).filter(Boolean);
  const enriched = await enrichVideos(videos);
  view.innerHTML = `<h1 class="page-title">👍 Liked videos</h1>${gridHTML(enriched)}`;
  wireVideoCards(view);
});

/* ---- HISTORY ---- */
route("/history", async () => {
  // The backend never writes watchHistory, so we rely on locally tracked
  // history. We still merge anything the backend returns, just in case.
  let backendVideos = [];
  try { backendVideos = (await api("/users/history")) || []; } catch { /* ignore */ }

  const local = getHistory();
  const seen = new Set();
  const merged = [];
  for (const v of [...local, ...backendVideos]) {
    if (v && v._id && !seen.has(v._id)) { seen.add(v._id); merged.push(v); }
  }

  view.innerHTML = `
    <div class="row-between" style="margin-bottom:14px">
      <h1 class="page-title" style="margin:0">🕑 Watch history</h1>
      ${merged.length ? `<button class="btn btn-sm" id="hist-clear">Clear history</button>` : ""}
    </div>
    <p class="muted" style="margin-top:-8px">Videos you open are saved here on this device.</p>
    ${gridHTML(merged)}`;

  wireVideoCards(view);
  const clr = $("#hist-clear");
  if (clr) clr.onclick = () => {
    if (!confirm("Clear your watch history on this device?")) return;
    clearHistory(); toast("History cleared", "ok"); router();
  };
});

/* ---- PLAYLISTS (mine) ---- */
route("/playlists", async () => {
  const me = store.user;
  const pls = await api(`/playlist/user/${me._id}`);
  view.innerHTML = `
    <div class="row-between" style="margin-bottom:14px">
      <h1 class="page-title" style="margin:0">📂 Your playlists</h1>
      <button class="btn btn-primary" id="new-pl">+ New playlist</button>
    </div>
    ${
      pls.length
        ? pls.map((p) => `<div class="card row-between">
            <div><b>${esc(p.name)}</b><div class="muted">${esc(p.description)} • ${(p.videos || []).length} videos</div></div>
            <a class="btn btn-sm" href="#/playlist/${p._id}">Open</a></div>`).join("")
        : `<div class="empty">No playlists yet.</div>`
    }`;
  $("#new-pl").onclick = openCreatePlaylist;
});

/* ---- PLAYLIST detail ---- */
route("/playlist/:id", async ({ id }) => {
  const pl = await api(`/playlist/${id}`);
  const me = store.user;
  const isOwner = me && (pl.owner === me._id || pl.owner?._id === me._id);
  const videos = await enrichVideos(pl.videos || []);
  view.innerHTML = `
    <div class="row-between" style="margin-bottom:14px">
      <div>
        <h1 class="page-title" style="margin:0">${esc(pl.name)}</h1>
        <div class="muted">${esc(pl.description)} • ${videos.length} videos</div>
      </div>
      ${isOwner ? `<div class="btn-row">
        <button class="btn btn-sm" id="pl-edit">Edit</button>
        <button class="btn btn-sm" id="pl-del">Delete</button></div>` : ""}
    </div>
    ${
      videos.length
        ? videos.map((v) => `<div class="card row-between">
            <div style="display:flex;gap:12px;align-items:center;cursor:pointer;min-width:0" class="pl-open" data-id="${v._id}">
              <img src="${esc(v.thumbnail || FALLBACK_THUMB)}" style="width:120px;aspect-ratio:16/9;object-fit:cover;border-radius:8px"/>
              <div style="min-width:0"><b>${esc(v.title)}</b><div class="muted">${fmtNum(v.views)} views</div></div>
            </div>
            ${isOwner ? `<button class="btn btn-sm pl-remove" data-id="${v._id}">Remove</button>` : ""}
          </div>`).join("")
        : `<div class="empty">This playlist is empty.</div>`
    }`;

  view.querySelectorAll(".pl-open").forEach((el) => el.onclick = () => (location.hash = `#/watch/${el.dataset.id}`));
  view.querySelectorAll(".pl-remove").forEach((b) => b.onclick = async () => {
    try { await api(`/playlist/remove/${b.dataset.id}/${id}`, { method: "PATCH" }); toast("Removed", "ok"); router(); }
    catch (e) { toast(e.message, "err"); }
  });
  if (isOwner) {
    $("#pl-edit").onclick = () => openEditPlaylist(pl);
    $("#pl-del").onclick = async () => {
      if (!confirm("Delete this playlist?")) return;
      try { await api(`/playlist/${id}`, { method: "DELETE" }); toast("Deleted", "ok"); location.hash = "#/playlists"; }
      catch (e) { toast(e.message, "err"); }
    };
  }
});

/* ---- SUBSCRIPTIONS ---- */
route("/subscriptions", async () => {
  // The backend's subscription *list* endpoints have a param-name mismatch
  // (getSubscribedChannels reads req.params.subscriberId on a :channelId route),
  // so they return 400. Subscribe/unsubscribe itself works from channel pages.
  const me = store.user;
  let channels = [];
  let note = "";
  try {
    channels = await api(`/subscriptions/c/${me._id}`);
  } catch (e) {
    note = `The backend list endpoint returned: “${esc(e.message)}”. Subscribe/unsubscribe still works on each channel page.`;
  }
  view.innerHTML = `
    <h1 class="page-title">📺 Subscriptions</h1>
    ${note ? `<div class="card"><div class="muted">${note}</div></div>` : ""}
    ${
      Array.isArray(channels) && channels.length
        ? channels.map((s) => {
            const c = s.channel || {};
            return `<div class="card row-between">
              <div style="display:flex;gap:12px;align-items:center">
                <img class="av" style="width:44px;height:44px;border-radius:50%" src="${esc(c.avatar || FALLBACK_AV)}" onerror="this.src='${FALLBACK_AV}'"/>
                <div><b>${esc(c.fullName || c.username || "Channel")}</b><div class="muted">@${esc(c.username || "")}</div></div>
              </div>
              <a class="btn btn-sm" href="#/channel/${esc(c.username || "")}">Visit</a>
            </div>`;
          }).join("")
        : (note ? "" : `<div class="empty">You're not subscribed to any channels yet.</div>`)
    }
    <div class="card">
      <b>Tip:</b> open any video, then use the <b>Subscribe</b> button under the channel name.
    </div>`;
});

/* ---- TWEETS (mine) ---- */
route("/tweets", async () => {
  const me = store.user;
  const tweets = await api(`/tweets/user/${me._id}`);
  view.innerHTML = `
    <h1 class="page-title">💬 Your tweets</h1>
    <div class="card">
      <div class="field" style="margin:0">
        <textarea id="tw-input" placeholder="What's happening?"></textarea>
      </div>
      <div class="btn-row" style="justify-content:flex-end;margin-top:10px">
        <button class="btn btn-primary" id="tw-send">Tweet</button>
      </div>
    </div>
    <div id="tw-list">${tweets.length ? tweets.map((t) => tweetHTML(t, true)).join("") : `<div class="empty">No tweets yet.</div>`}</div>`;

  $("#tw-send").onclick = async () => {
    const content = $("#tw-input").value.trim();
    if (!content) return;
    try { await api("/tweets", { method: "POST", body: { content } }); toast("Tweeted", "ok"); router(); }
    catch (e) { toast(e.message, "err"); }
  };
  wireTweetActions(() => router());
});

function tweetHTML(t, mine) {
  return `<div class="tweet" data-id="${t._id}">
    <div class="t-content">${esc(t.content)}</div>
    <div class="t-meta">
      <span>${timeAgo(t.createdAt)}</span>
      <button class="btn-ghost tw-like" data-id="${t._id}">👍 Like</button>
      ${mine ? `<button class="btn-ghost tw-edit" data-id="${t._id}">Edit</button>
                <button class="btn-ghost tw-del" data-id="${t._id}">Delete</button>` : ""}
    </div>
  </div>`;
}

function wireTweetActions(reload) {
  view.querySelectorAll(".tw-like").forEach((b) => b.onclick = async () => {
    try { const r = await api(`/likes/toggle/t/${b.dataset.id}`, { method: "POST" }); toast(r.isLiked ? "Liked" : "Unliked", "ok"); }
    catch (e) { toast(e.message, "err"); }
  });
  view.querySelectorAll(".tw-del").forEach((b) => b.onclick = async () => {
    if (!confirm("Delete tweet?")) return;
    try { await api(`/tweets/${b.dataset.id}`, { method: "DELETE" }); reload(); }
    catch (e) { toast(e.message, "err"); }
  });
  view.querySelectorAll(".tw-edit").forEach((b) => b.onclick = () => {
    const row = b.closest(".tweet");
    const body = row.querySelector(".t-content");
    const old = body.textContent;
    body.innerHTML = `<textarea class="tw-edit-input" style="width:100%">${esc(old)}</textarea>
      <div class="btn-row" style="margin-top:6px"><button class="btn btn-sm btn-primary tw-save">Save</button></div>`;
    row.querySelector(".tw-save").onclick = async () => {
      const content = row.querySelector(".tw-edit-input").value.trim();
      if (!content) return;
      try { await api(`/tweets/${b.dataset.id}`, { method: "PATCH", body: { content } }); reload(); }
      catch (e) { toast(e.message, "err"); }
    };
  });
}

/* ---- SETTINGS ---- */
route("/settings", async () => {
  const u = await api("/users/current-user");
  store.user = u;
  view.innerHTML = `
    <h1 class="page-title">⚙️ Settings</h1>

    <div class="card form wide">
      <h3 style="margin-top:0">Account details</h3>
      <div class="field"><label>Full name</label><input id="set-fullname" value="${esc(u.fullName)}"/></div>
      <div class="field"><label>Email</label><input id="set-email" value="${esc(u.email)}"/></div>
      <button class="btn btn-primary" id="set-save">Save details</button>
    </div>

    <div class="card form wide">
      <h3 style="margin-top:0">Change password</h3>
      <div class="field"><label>Old password</label><input type="password" id="set-old"/></div>
      <div class="field"><label>New password</label><input type="password" id="set-new"/></div>
      <button class="btn btn-primary" id="set-pass">Change password</button>
    </div>

    <div class="card form wide">
      <h3 style="margin-top:0">Avatar</h3>
      <div class="field"><input type="file" id="set-avatar" accept="image/*"/></div>
      <button class="btn" id="set-avatar-btn">Update avatar</button>
    </div>

    <div class="card form wide">
      <h3 style="margin-top:0">Cover image</h3>
      <div class="field"><input type="file" id="set-cover" accept="image/*"/></div>
      <button class="btn" id="set-cover-btn">Update cover</button>
    </div>`;

  $("#set-save").onclick = async () => {
    try {
      const u2 = await api("/users/update-account", {
        method: "PATCH",
        body: { fullName: $("#set-fullname").value, email: $("#set-email").value },
      });
      store.user = { ...store.user, fullName: u2.fullName, email: u2.email };
      toast("Details updated", "ok"); renderChrome();
    } catch (e) { toast(e.message, "err"); }
  };
  $("#set-pass").onclick = async () => {
    try {
      await api("/users/change-password", {
        method: "POST",
        body: { oldPassword: $("#set-old").value, newPassword: $("#set-new").value },
      });
      toast("Password changed", "ok"); $("#set-old").value = ""; $("#set-new").value = "";
    } catch (e) { toast(e.message, "err"); }
  };
  $("#set-avatar-btn").onclick = async () => {
    const f = $("#set-avatar").files[0];
    if (!f) return toast("Pick an image first", "err");
    const fd = new FormData(); fd.append("avatar", f);
    try {
      const u2 = await api("/users/avatar", { method: "PATCH", body: fd });
      store.user = { ...store.user, avatar: u2.avatar };
      toast("Avatar updated", "ok"); renderChrome();
    } catch (e) { toast(e.message, "err"); }
  };
  $("#set-cover-btn").onclick = async () => {
    const f = $("#set-cover").files[0];
    if (!f) return toast("Pick an image first", "err");
    const fd = new FormData(); fd.append("coverImage", f);
    try {
      await api("/users/cover-image", { method: "PATCH", body: fd });
      toast("Cover updated", "ok");
    } catch (e) { toast(e.message, "err"); }
  };
});

/* ---- HEALTHCHECK ---- */
route("/healthcheck", async () => {
  view.innerHTML = `<h1 class="page-title">🩺 Healthcheck</h1>
    <div class="card"><button class="btn btn-primary" id="hc-btn">Ping server</button>
    <pre id="hc-out" style="margin-top:12px"></pre></div>`;
  $("#hc-btn").onclick = async () => {
    try {
      const r = await fetch(API_BASE + "/healthcheck");
      const j = await r.json();
      $("#hc-out").textContent = JSON.stringify(j, null, 2);
    } catch (e) { $("#hc-out").textContent = "Error: " + e.message; }
  };
  $("#hc-btn").click();
});

/* ---- AUTH ---- */
route("/auth", async () => {
  view.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-tabs">
        <button id="tab-login" class="active">Login</button>
        <button id="tab-register">Register</button>
      </div>
      <div id="auth-body"></div>
    </div>`;
  const tabL = $("#tab-login"), tabR = $("#tab-register");
  tabL.onclick = () => { tabL.classList.add("active"); tabR.classList.remove("active"); renderLogin(); };
  tabR.onclick = () => { tabR.classList.add("active"); tabL.classList.remove("active"); renderRegister(); };
  renderLogin();
});

function renderLogin() {
  $("#auth-body").innerHTML = `
    <h2>Welcome back</h2>
    <div class="field"><label>Username or Email</label><input id="lg-id" placeholder="username or email"/></div>
    <div class="field"><label>Password</label><input id="lg-pw" type="password"/></div>
    <div id="lg-err" class="error-text hidden"></div>
    <button class="btn btn-primary btn-block" id="lg-btn">Login</button>`;
  $("#lg-btn").onclick = doLogin;
  $("#lg-pw").onkeydown = (e) => { if (e.key === "Enter") doLogin(); };
}

async function doLogin() {
  const id = $("#lg-id").value.trim();
  const password = $("#lg-pw").value;
  const errEl = $("#lg-err");
  errEl.classList.add("hidden");
  const body = { password };
  if (id.includes("@")) body.email = id; else body.username = id.toLowerCase();
  try {
    const data = await request("/users/login", { method: "POST", body, auth: false }, false);
    store.tokens = { access: data.accessToken, refresh: data.refreshToken };
    store.user = data.user;
    toast("Logged in", "ok");
    location.hash = "#/";
    renderChrome();
  } catch (e) {
    errEl.textContent = e.message; errEl.classList.remove("hidden");
  }
}

function renderRegister() {
  $("#auth-body").innerHTML = `
    <h2>Create account</h2>
    <div class="field"><label>Full name</label><input id="rg-full"/></div>
    <div class="field"><label>Username</label><input id="rg-user"/></div>
    <div class="field"><label>Email</label><input id="rg-email" type="email"/></div>
    <div class="field"><label>Password</label><input id="rg-pw" type="password"/></div>
    <div class="field"><label>Avatar (required)</label><input id="rg-avatar" type="file" accept="image/*"/></div>
    <div class="field"><label>Cover image (optional)</label><input id="rg-cover" type="file" accept="image/*"/></div>
    <div id="rg-err" class="error-text hidden"></div>
    <button class="btn btn-primary btn-block" id="rg-btn">Register</button>`;
  $("#rg-btn").onclick = doRegister;
}

async function doRegister() {
  const errEl = $("#rg-err"); errEl.classList.add("hidden");
  const avatar = $("#rg-avatar").files[0];
  if (!avatar) { errEl.textContent = "Avatar is required."; errEl.classList.remove("hidden"); return; }
  const fd = new FormData();
  fd.append("fullName", $("#rg-full").value);
  fd.append("username", $("#rg-user").value);
  fd.append("email", $("#rg-email").value);
  fd.append("password", $("#rg-pw").value);
  fd.append("avatar", avatar);
  if ($("#rg-cover").files[0]) fd.append("coverImage", $("#rg-cover").files[0]);
  try {
    await request("/users/register", { method: "POST", body: fd, auth: false }, false);
    toast("Account created — logging in…", "ok");
    // auto login
    $("#tab-login").click();
    $("#lg-id").value = $("#rg-user").value || $("#rg-email").value;
  } catch (e) {
    errEl.textContent = e.message; errEl.classList.remove("hidden");
  }
}

/* =========================== MODALS / DIALOGS =========================== */
function openUploadModal() {
  openModal("Upload video", `
    <div class="field"><label>Title</label><input id="up-title"/></div>
    <div class="field"><label>Description</label><textarea id="up-desc"></textarea></div>
    <div class="field"><label>Video file (required)</label><input id="up-video" type="file" accept="video/*"/></div>
    <div class="field"><label>Thumbnail (required)</label><input id="up-thumb" type="file" accept="image/*"/></div>
    <div id="up-err" class="error-text hidden"></div>
    <button class="btn btn-primary btn-block" id="up-btn">Publish</button>`);
  $("#up-btn").onclick = async () => {
    const err = $("#up-err"); err.classList.add("hidden");
    const video = $("#up-video").files[0], thumb = $("#up-thumb").files[0];
    if (!video || !thumb) { err.textContent = "Video and thumbnail are required."; err.classList.remove("hidden"); return; }
    const fd = new FormData();
    fd.append("title", $("#up-title").value);
    fd.append("description", $("#up-desc").value);
    fd.append("videoFile", video);
    fd.append("thumbnail", thumb);
    $("#up-btn").textContent = "Uploading…"; $("#up-btn").disabled = true;
    try {
      const v = await api("/videos", { method: "POST", body: fd });
      closeModal(); toast("Video published", "ok"); location.hash = `#/watch/${v._id}`; router();
    } catch (e) {
      err.textContent = e.message; err.classList.remove("hidden");
      $("#up-btn").textContent = "Publish"; $("#up-btn").disabled = false;
    }
  };
}

function openEditVideo(v) {
  openModal("Edit video", `
    <div class="field"><label>Title</label><input id="ev-title" value="${esc(v.title)}"/></div>
    <div class="field"><label>Description</label><textarea id="ev-desc">${esc(v.description)}</textarea></div>
    <div class="field"><label>New thumbnail (optional)</label><input id="ev-thumb" type="file" accept="image/*"/></div>
    <button class="btn btn-primary btn-block" id="ev-btn">Save changes</button>`);
  $("#ev-btn").onclick = async () => {
    const fd = new FormData();
    fd.append("title", $("#ev-title").value);
    fd.append("description", $("#ev-desc").value);
    if ($("#ev-thumb").files[0]) fd.append("thumbnail", $("#ev-thumb").files[0]);
    try { await api(`/videos/${v._id}`, { method: "PATCH", body: fd }); closeModal(); toast("Saved", "ok"); router(); }
    catch (e) { toast(e.message, "err"); }
  };
}

function openCreatePlaylist() {
  openModal("New playlist", `
    <div class="field"><label>Name</label><input id="pl-name"/></div>
    <div class="field"><label>Description</label><textarea id="pl-desc"></textarea></div>
    <button class="btn btn-primary btn-block" id="pl-btn">Create</button>`);
  $("#pl-btn").onclick = async () => {
    try {
      await api("/playlist", { method: "POST", body: { name: $("#pl-name").value, description: $("#pl-desc").value } });
      closeModal(); toast("Playlist created", "ok"); router();
    } catch (e) { toast(e.message, "err"); }
  };
}

function openEditPlaylist(pl) {
  openModal("Edit playlist", `
    <div class="field"><label>Name</label><input id=" pl-name" value="${esc(pl.name)}"/></div>
    <div class="field"><label>Description</label><textarea id="pl-desc">${esc(pl.description)}</textarea></div>
    <button class="btn btn-primary btn-block" id="pl-btn">Save</button>`);
  const nameEl = $("#modal-body").querySelector('input');
  $("#pl-btn").onclick = async () => {
    try {
      await api(`/playlist/${pl._id}`, { method: "PATCH", body: { name: nameEl.value, description: $("#pl-desc").value } });
      closeModal(); toast("Saved", "ok"); router();
    } catch (e) { toast(e.message, "err"); }
  };
}

async function openSaveToPlaylist(videoId) {
  openModal("Save to playlist", `<div class="spinner">Loading…</div>`);
  const me = store.user;
  let pls = [];
  try { pls = await api(`/playlist/user/${me._id}`); } catch { /* ignore */ }
  $("#modal-body").innerHTML = `
    ${
      pls.length
        ? pls.map((p) => `<label class="card row-between" style="cursor:pointer">
            <span>${esc(p.name)} <span class="muted">(${(p.videos || []).length})</span></span>
            <button class="btn btn-sm sp-add" data-id="${p._id}">Add</button></label>`).join("")
        : `<div class="muted" style="margin-bottom:12px">No playlists yet — create one below.</div>`
    }
    <hr class="list-divider"/>
    <div class="field"><label>New playlist name</label><input id="sp-name"/></div>
    <div class="field"><label>Description</label><input id="sp-desc"/></div>
    <button class="btn btn-primary" id="sp-create">Create & add</button>`;

  $("#modal-body").querySelectorAll(".sp-add").forEach((b) => b.onclick = async () => {
    try { await api(`/playlist/add/${videoId}/${b.dataset.id}`, { method: "PATCH" }); closeModal(); toast("Added to playlist", "ok"); }
    catch (e) { toast(e.message, "err"); }
  });
  $("#sp-create").onclick = async () => {
    const name = $("#sp-name").value.trim(), description = $("#sp-desc").value.trim();
    if (!name || !description) return toast("Name and description required", "err");
    try {
      const pl = await api("/playlist", { method: "POST", body: { name, description } });
      await api(`/playlist/add/${videoId}/${pl._id}`, { method: "PATCH" });
      closeModal(); toast("Added to new playlist", "ok");
    } catch (e) { toast(e.message, "err"); }
  };
}

/* =============================== BOOT =================================== */
(function init() {
  if (!location.hash) location.hash = isAuthed() ? "#/" : "#/auth";
  // validate session in the background
  if (isAuthed()) {
    api("/users/current-user").then((u) => { store.user = u; renderChrome(); }).catch(() => {});
  }
  router();
})();
