const API_URL = "https://script.google.com/macros/s/AKfycbx-whzgpWaFJ6D1i1Tte8uzXVomzvbk9rmhZSQpv7x7dKs6879dQElWRqQIP97uC9sK/exec"; 
const DATA_URL = "https://raw.githubusercontent.com/VoidiumV/lyricswebsite/main/lyrix-data.json";

let dataCache = null;
let dataCacheAt = 0;
const DATA_CACHE_MS = 15000;

// How many songs to render per row-group for the home page. This is just a
// generous buffer so the CSS row-clamp (.grid-limit-4) always has enough
// cards to fill 4 rows at any viewport width; the CSS is what actually
// enforces "only 4 rows visible", not this number.
const HOME_RECENT_BUFFER = 48;
const SEARCH_RESULT_LIMIT = 24;

window.addEventListener("popstate", router);

document.addEventListener("DOMContentLoaded", () => {
  updateAuthUI();
  document.body.addEventListener("click", e => {
    const link = e.target.closest("[data-link]");
    if (link) {
      e.preventDefault();
      navigateTo(link.href);
    }
  });
  router();
});

function navigateTo(url) {
  history.pushState(null, null, url);
  router();
}

async function apiCall(data, timeoutMs = 25000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(data),
      signal: controller.signal
    });
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch (parseErr) {
      return { success: false, message: "The server didn't return valid data. Double-check the Apps Script deployment." };
    }
  } catch (err) {
    if (err.name === "AbortError") {
      return { success: false, message: "Request timed out after " + Math.round(timeoutMs / 1000) + "s. The backend may be slow or unreachable — try again in a moment." };
    }
    return { success: false, message: "Network error reaching the backend: " + err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function getData(forceFresh = false) {
  if (!DATA_URL) return null;
  if (!forceFresh && dataCache && (Date.now() - dataCacheAt < DATA_CACHE_MS)) return dataCache;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const sep = DATA_URL.includes("?") ? "&" : "?";
    const res = await fetch(DATA_URL + sep + "t=" + Date.now(), { cache: "no-store", signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const json = await res.json();
    if (!json || !Array.isArray(json.songs)) return null;
    dataCache = json;
    dataCacheAt = Date.now();
    return json;
  } catch (e) {
    return null;
  }
}

function normalizeText(s) {
  return (s || "").toString().trim().toLowerCase();
}

function slugify(text) {
  return text ? text.toString().toLowerCase().trim().replace(/[\s\W-]+/g, '-').replace(/^-+|-+$/g, '') : '';
}

function splitAkas(akasStr) {
  return (akasStr || "").toString().split(/[,;]+/).map(s => s.trim()).filter(Boolean);
}

// Strips ALL invisible/control/format/space-like unicode characters (not
// just a hand-picked few), which is what was causing stray characters to
// render as "?" (tofu) in the browser - e.g. "Callie?Mae" instead of
// "Callie Mae". Mirrors the same fix on the backend.
function cleanText(str) {
  if (!str) return "";
  return str.toString()
    .replace(/[\p{Cc}\p{Cf}\p{Zs}\uFFFD]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanArtist(str) {
  if (!str) return "";
  return cleanText(str).replace(/\?/g, " ").replace(/\s+/g, " ").trim();
}

// Splits combined artists into an array safely
function splitArtists(artistStr) {
  if (!artistStr) return [];
  return cleanArtist(artistStr).split(/(?:\s*&\s*|\s+feat\.?\s+|\s+ft\.?\s+|\s*,\s*)/i).filter(Boolean);
}

// Splits a song's album field into individual album/EP names, since one
// song can appear on multiple different album releases (e.g. an original
// album plus a later deluxe edition or compilation). Stored as a single
// comma/semicolon-separated string, same pattern as artists.
function splitAlbums(albumStr) {
  if (!albumStr) return [];
  return cleanText(albumStr).split(/[,;]+/).map(s => s.trim()).filter(Boolean);
}

// Given a list of {name, slug, ...} artist objects (e.g. from the public
// snapshot), expands any entry whose name is actually a combined byline
// ("A & B") into separate entries and de-dupes by slug. This protects
// against legacy/stale snapshot data that hasn't been republished yet.
function expandArtists(list) {
  const seen = new Map();
  (list || []).forEach(a => {
    const parts = splitArtists(a.name);
    const names = parts.length > 0 ? parts : [a.name];
    names.forEach(nm => {
      const slug = slugify(nm);
      if (!slug || seen.has(slug)) return;
      seen.set(slug, Object.assign({}, a, { name: nm, slug: slug }));
    });
  });
  return Array.from(seen.values());
}

// ---------- song relations (Remix, Sped Up, Cover, Sample, etc.) ----------

const RELATION_TYPES = [
  { value: "Remix", label: "Remix", phrase: "Remix of" },
  { value: "Sped Up", label: "Sped Up", phrase: "Sped Up version of" },
  { value: "Slowed Down", label: "Slowed Down / Nightcore", phrase: "Slowed Down version of" },
  { value: "Cover", label: "Cover of", phrase: "Cover of" },
  { value: "Sample", label: "Samples", phrase: "Samples" },
  { value: "Acoustic", label: "Acoustic Version", phrase: "Acoustic version of" },
  { value: "Live", label: "Live Version", phrase: "Live version of" },
  { value: "Remaster", label: "Remaster of", phrase: "Remaster of" },
  { value: "Other", label: "Other", phrase: "Related to" }
];

function relationTypeLabel(type) {
  const entry = RELATION_TYPES.find(r => r.value === type);
  return entry ? entry.phrase : (type || "Related to");
}

function relationOptionsHtml(selectedValue) {
  return `<option value="" ${!selectedValue ? "selected" : ""}>None</option>` +
    RELATION_TYPES.map(r => `<option value="${esc(r.value)}" ${selectedValue === r.value ? "selected" : ""}>${esc(r.label)}</option>`).join("");
}

// Maps "title — artist" (lowercase) -> slug, so the relation-target text
// input (backed by a <datalist>) can resolve a typed/selected song to an
// actual slug without a dedicated search endpoint. Populated fresh each
// time a form that needs it is rendered.
let songLookupMap = {};

async function populateRelationDatalist() {
  const dl = document.getElementById("relation-song-options");
  if (!dl) return;
  const snapshot = await getData();
  let list = snapshot ? snapshot.songs : null;
  if (!list) {
    const res = await apiCall({ action: "getSongs", limit: 1000 });
    list = res.success ? res.songs : [];
  }
  songLookupMap = {};
  dl.innerHTML = list.map(s => {
    const label = `${s.title} — ${cleanArtist(s.artist)}`;
    songLookupMap[label.toLowerCase()] = s.slug;
    return `<option value="${esc(label)}"></option>`;
  }).join("");
}

function resolveRelationSlug(text) {
  if (!text) return "";
  return songLookupMap[text.trim().toLowerCase()] || "";
}

function esc(str) {
  return (str === undefined || str === null ? "" : str.toString())
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// Formats a "YYYY-MM-DD" (or full ISO) release date string for display
// without letting JS's Date parsing shift it a day due to timezone
// conversion on a date-only value.
function formatReleaseDate(str) {
  if (!str) return "";
  const s = str.toString().trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return s;
  const year = m[1], month = parseInt(m[2], 10), day = parseInt(m[3], 10);
  if (month < 1 || month > 12) return s;
  return `${MONTH_NAMES[month - 1]} ${day}, ${year}`;
}

function initials(name) {
  return (name || "?").trim().split(/\s+/).map(w => w[0]).slice(0, 2).join("").toUpperCase();
}

// Normalizes a raw string into a safe, absolute http(s) URL with a real
// host, or "" if it can't be made into one. Returning "" (instead of a
// broken/empty URL) means callers can skip rendering a link entirely rather
// than emitting an `href=""` anchor — which, with target="_blank", would
// otherwise just reopen the current page in a new tab.
function ensureUrl(url) {
  if (!url) return "";
  let s = url.toString().trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  if (!/^https?:\/\/[^\s/]+\.[^\s/]+/i.test(s)) return "";
  return s;
}

function coverHtml(url, label, cls) {
  cls = cls || "";
  if (url) return `<img src="${esc(url)}" alt="${esc(label)}" loading="lazy" class="${cls}">`;
  return `<div class="cover-fallback ${cls}">${esc(initials(label))}</div>`;
}

function avatarHtml(url, label) {
  if (url) return `<img src="${esc(url)}" alt="${esc(label)}" loading="lazy">`;
  return `<div class="avatar-fallback">${esc(initials(label))}</div>`;
}

function linkFallback(platform, url) {
  const safeUrl = ensureUrl(url);
  if (!safeUrl) return "";
  return `<a href="${esc(safeUrl)}" target="_blank" rel="noopener noreferrer" class="badge">${esc(platform)}</a>`;
}

function embedHtml(platform, url) {
  if (!url) return "";
  url = ensureUrl(url);
  if (!url) return "";
  try {
    if (platform === "youtube") {
      const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([a-zA-Z0-9_-]{6,})/);
      if (!m) return linkFallback(platform, url);
      return `<div class="embed-wrap embed-video"><iframe src="https://www.youtube.com/embed/${m[1]}" title="YouTube player" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen loading="lazy"></iframe></div>`;
    }
    if (platform === "spotify") {
      const m = url.match(/open\.spotify\.com\/(track|album|playlist|episode|show)\/([a-zA-Z0-9]+)/);
      if (!m) return linkFallback(platform, url);
      return `<div class="embed-wrap embed-compact" style="height:152px;"><iframe src="https://open.spotify.com/embed/${m[1]}/${m[2]}" title="Spotify player" allow="encrypted-media" loading="lazy"></iframe></div>`;
    }
    if (platform === "apple") {
      const m = url.match(/music\.apple\.com\/(.+)/);
      if (!m) return linkFallback(platform, url);
      return `<div class="embed-wrap embed-compact" style="height:175px;"><iframe src="https://embed.music.apple.com/${encodeURI(m[1])}" title="Apple Music player" allow="autoplay *; encrypted-media *;" loading="lazy"></iframe></div>`;
    }
    if (platform === "soundcloud") {
      return `<div class="embed-wrap embed-compact" style="height:166px;"><iframe src="https://w.soundcloud.com/player/?url=${encodeURIComponent(url)}&color=%23ff5500&auto_play=false&show_teaser=false" title="SoundCloud player" loading="lazy"></iframe></div>`;
    }
    return linkFallback(platform, url);
  } catch (e) {
    return linkFallback(platform, url);
  }
}

// ---------- lyrics credit-tag colorization ----------
//
// Lets song submitters tag who's singing/rapping a given part inline in the
// lyrics text using *name*, **name**, ***name*** (max 3 asterisks), or
// <i>name</i> / <b>name</b>. At render time (song detail page only - NOT in
// the raw edit textarea) each tagged name is rendered in its own color, with
// no italics/bold applied and the markers themselves stripped from the
// visible output. The same name always maps to the same color throughout a
// given song.

const LYRIC_COLORS = ["#B3261E", "#1F6FEB", "#1E8C4A", "#8C3FBF", "#BF6A1E", "#1E8C8C", "#BF1E7A", "#6B5B1E", "#3F4F8C", "#8C1E3F"];

function colorizeLyrics(rawText) {
  const text = (rawText || "").toString();
  const colorMap = new Map();
  let colorIdx = 0;

  function colorFor(label) {
    const key = label.trim().toLowerCase();
    if (!colorMap.has(key)) {
      colorMap.set(key, LYRIC_COLORS[colorIdx % LYRIC_COLORS.length]);
      colorIdx++;
    }
    return colorMap.get(key);
  }

  // Order matters: triple-asterisk before double before single, so a run of
  // "***" isn't partially swallowed by the double-asterisk alternative first.
  const pattern = /<b>([\s\S]*?)<\/b>|<i>([\s\S]*?)<\/i>|\*\*\*([\s\S]*?)\*\*\*|\*\*([\s\S]*?)\*\*|\*([\s\S]*?)\*/g;

  let result = "";
  let lastIndex = 0;
  let m;
  while ((m = pattern.exec(text)) !== null) {
    result += esc(text.slice(lastIndex, m.index));
    const label = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? "";
    const color = colorFor(label);
    result += `<span style="color:${color};">${esc(label)}</span>`;
    lastIndex = pattern.lastIndex;
  }
  result += esc(text.slice(lastIndex));
  return result;
}

function fileToCompressedBase64(file, maxDim = 900, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = () => reject(new Error("Could not load image"));
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxDim) { height = Math.round(height * (maxDim / width)); width = maxDim; }
        else if (height >= width && height > maxDim) { width = Math.round(width * (maxDim / height)); height = maxDim; }
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// ---------- cover-art / profile-picture input (upload file OR paste URL) ----------
//
// Renders a small toggle that lets people either upload an image file (the
// original behavior) or paste a direct image URL instead. Both inputs are
// always present in the DOM; only the active one is visible, and
// getImageInputValue() below reads whichever mode is selected at submit
// time. `currentUrl`, if given, pre-fills the URL field as a convenience
// (e.g. when editing something that already has a cover image) — it does
// NOT change which mode is selected by default (always starts on "Upload
// file").

function imageInputHtml(prefix, label, currentUrl) {
  return `
    <div class="form-group">
      <label>${esc(label)}</label>
      <div class="image-input-toggle">
        <label><input type="radio" name="${prefix}-mode" value="file" checked onchange="toggleImageInputMode('${prefix}')"> Upload file</label>
        <label><input type="radio" name="${prefix}-mode" value="url" onchange="toggleImageInputMode('${prefix}')"> Image URL</label>
      </div>
      <input type="file" id="${prefix}-file" accept="image/*">
      <input type="text" id="${prefix}-url" class="hidden" placeholder="https://..." value="${esc(currentUrl || "")}">
    </div>
  `;
}

function toggleImageInputMode(prefix) {
  const checked = document.querySelector(`input[name="${prefix}-mode"]:checked`);
  const mode = checked ? checked.value : "file";
  const fileInput = document.getElementById(`${prefix}-file`);
  const urlInput = document.getElementById(`${prefix}-url`);
  if (fileInput) fileInput.classList.toggle("hidden", mode !== "file");
  if (urlInput) urlInput.classList.toggle("hidden", mode !== "url");
}

// Reads whichever cover-art/profile-picture input mode is currently active
// for the given field prefix. Returns { base64, url, error }. At most one
// of base64/url is ever set; both null means "nothing provided" (leave
// unchanged on an edit, or no image on a new item).
async function getImageInputValue(prefix, maxDim = 900, quality = 0.85) {
  const checked = document.querySelector(`input[name="${prefix}-mode"]:checked`);
  const mode = checked ? checked.value : "file";

  if (mode === "url") {
    const urlInput = document.getElementById(`${prefix}-url`);
    const url = urlInput ? urlInput.value.trim() : "";
    return { base64: null, url: url || null, error: null };
  }

  const fileInput = document.getElementById(`${prefix}-file`);
  if (fileInput && fileInput.files.length > 0) {
    try {
      const base64 = await fileToCompressedBase64(fileInput.files[0], maxDim, quality);
      return { base64, url: null, error: null };
    } catch (e) {
      return { base64: null, url: null, error: "Could not process that image." };
    }
  }

  return { base64: null, url: null, error: null };
}

function getUser() {
  return JSON.parse(localStorage.getItem("lyrix_user"));
}

// Re-fetches this user's roles/points from the backend and refreshes local
// storage + the header. Call this after any action that could award points
// (adding a song, adding cover art, creating an artist, setting a pfp) so
// the header stays accurate without requiring a re-login.
async function refreshUserInfo() {
  const user = getUser();
  if (!user) return;
  const res = await apiCall({ action: "getUserInfo", username: user.username });
  if (res.success) {
    localStorage.setItem("lyrix_user", JSON.stringify(res.user));
    updateAuthUI();
  }
}

function updateAuthUI() {
  const user = getUser();
  const loginBtn = document.getElementById("login-btn");
  const logoutBtn = document.getElementById("logout-btn");
  const addLink = document.getElementById("add-link");
  const ownerLink = document.getElementById("owner-link");
  const userDisplay = document.getElementById("user-display");

  if (user) {
    if (loginBtn) loginBtn.classList.add("hidden");
    if (logoutBtn) logoutBtn.classList.remove("hidden");
    if (addLink) addLink.classList.remove("hidden");
    if (ownerLink) ownerLink.classList.toggle("hidden", !user.isOwner);
    if (userDisplay) {
      userDisplay.classList.remove("hidden");
      let roleTag = "";
      if (user.isOwner) roleTag = " (Owner)";
      else if (user.isEditor) roleTag = " (Editor)";
      else if (user.isTranscriber) roleTag = " (Transcriber)";
      userDisplay.innerText = `@${user.username}${roleTag} · ${user.points || 0} pts`;
    }
  } else {
    if (loginBtn) loginBtn.classList.remove("hidden");
    if (logoutBtn) logoutBtn.classList.add("hidden");
    if (addLink) addLink.classList.add("hidden");
    if (ownerLink) ownerLink.classList.add("hidden");
    if (userDisplay) userDisplay.classList.add("hidden");
  }
}

function logout() {
  localStorage.removeItem("lyrix_user");
  updateAuthUI();
  navigateTo("/");
}

function showStatus(elementId, message, isSuccess = false) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.innerText = message;
  el.className = `status-banner ${isSuccess ? 'success' : 'error'}`;
  el.classList.remove("hidden");
}

function doSearch() {
  const q = document.getElementById("search-input").value;
  navigateTo(`/?q=${encodeURIComponent(q)}`);
}

async function router() {
  const path = window.location.pathname;
  const searchParams = new URLSearchParams(window.location.search);
  const app = document.getElementById("app");

  if (path === "/" || path === "") {
    renderHome(app, searchParams.get("q"));
  } else if (path === "/login") {
    renderLogin(app);
  } else if (path === "/add") {
    renderAddSong(app);
  } else if (path === "/owner") {
    renderOwnerPage(app);
  } else if (path.startsWith("/song/")) {
    renderSongDetail(app, path.replace("/song/", ""));
  } else if (path.startsWith("/artist/")) {
    renderArtistDetail(app, path.replace("/artist/", ""));
  } else if (path.startsWith("/album/")) {
    renderAlbumDetail(app, path.replace("/album/", ""));
  } else {
    app.innerHTML = "<h2>404 - Page Not Found</h2>";
  }
}

// ---------- home ----------

async function renderHome(container, query = "") {
  container.innerHTML = `
    <div class="hero">
      <h1>Lyrics, <span class="highlight">annotated by the community</span></h1>
      <p>Search for a song or artist, or add the ones missing.</p>
      <div class="search-box">
        <input type="text" id="hero-search" placeholder="Search songs or artists..." value="${esc(query || "")}" onkeydown="if(event.key==='Enter') navigateTo('/?q='+encodeURIComponent(this.value))">
        <button onclick="navigateTo('/?q='+encodeURIComponent(document.getElementById('hero-search').value))">Search</button>
      </div>
    </div>
    <h2 class="section-title">Artists</h2>
    <div class="artist-row" id="artist-row">Loading...</div>
    <h2 class="section-title">${query ? `Results for "${esc(query)}"` : "Recently Added"}</h2>
    <div class="grid" id="song-grid">Loading...</div>
    <h2 class="section-title">Leaderboard</h2>
    <div id="home-leaderboard">Loading...</div>
  `;

  const grid = document.getElementById("song-grid");
  const artistRow = document.getElementById("artist-row");
  const isSearching = !!(query && query.trim());
  const songLimit = isSearching ? SEARCH_RESULT_LIMIT : HOME_RECENT_BUFFER;

  // Kick the leaderboard fetch off in parallel; it doesn't block the rest
  // of the page from rendering.
  loadHomeLeaderboard(document.getElementById("home-leaderboard"));

  let songs = null, artists = null, errorMessage = null;

  const snapshot = await getData();
  if (snapshot) {
    const terms = normalizeText(query).split(/\s+/).filter(Boolean);
    // Expand any legacy combined artist rows before filtering/displaying,
    // in case the published snapshot hasn't been rebuilt yet.
    const expandedArtists = expandArtists(snapshot.artists);
    const akaTextBySlug = {};
    expandedArtists.forEach(a => { akaTextBySlug[a.slug] = normalizeText(cleanArtist(a.name) + " " + (a.akas || "")); });

    songs = snapshot.songs
      .filter(s => terms.length === 0 || terms.every(t => normalizeText(s.title + " " + (s.album || "") + " " + (akaTextBySlug[s.artistSlug] || cleanArtist(s.artist))).includes(t)))
      .slice(0, songLimit);

    artists = expandedArtists
      .filter(a => terms.length === 0 || terms.every(t => normalizeText(cleanArtist(a.name) + " " + (a.akas || "")).includes(t)))
      .slice(0, 12);
  } else {
    const res = await apiCall({ action: "getHome", q: query || "", limit: songLimit });
    if (res.success) {
      songs = res.songs;
      artists = res.artists;
    } else {
      errorMessage = res.message;
    }
  }

  // Only clamp to 4 visible rows for the default "Recently Added" listing;
  // search results show in full.
  grid.classList.toggle("grid-limit-4", !isSearching);

  if (songs && songs.length > 0) {
    grid.innerHTML = songs.map(song => `
      <a href="/song/${song.slug}" data-link class="card">
        ${coverHtml(song.coverUrl, song.title)}
        <div class="card-info">
          <div class="card-title">${esc(song.title)}</div>
          <div class="card-artist">${esc(cleanArtist(song.artist))}</div>
        </div>
      </a>
    `).join("");
  } else if (errorMessage) {
    grid.innerHTML = `<p class="empty-state">Couldn't load songs: ${esc(errorMessage)}</p>`;
  } else {
    grid.innerHTML = `<p class="empty-state">No matching songs found.</p>`;
  }

  if (artists && artists.length > 0) {
    artistRow.innerHTML = artists.map(a => `
      <a href="/artist/${a.slug}" data-link class="artist-chip">
        ${avatarHtml(a.pfpUrl, cleanArtist(a.name))}
        <div class="artist-chip-name">${esc(cleanArtist(a.name))}</div>
      </a>
    `).join("");
  } else if (errorMessage) {
    artistRow.innerHTML = `<p class="empty-state">Couldn't load artists.</p>`;
  } else {
    artistRow.innerHTML = `<p class="empty-state">No matching artists found.</p>`;
  }
}

// ---------- auth ----------

function renderLogin(container) {
  container.innerHTML = `
    <div class="form-container">
      <h2>Account</h2>
      <div id="auth-status" class="status-banner hidden"></div>
      <div class="form-group"><label>Username</label><input type="text" id="auth-username" required></div>
      <div class="form-group"><label>Password</label><input type="password" id="auth-password" required></div>
      <button class="btn-submit" onclick="handleAuth('login')">Login</button>
      <button class="btn-submit" style="background:#fff; margin-top:0.6rem;" onclick="handleAuth('register')">Register New Account</button>
    </div>
  `;
}

async function handleAuth(type) {
  const username = document.getElementById("auth-username").value;
  const password = document.getElementById("auth-password").value;
  if (!username || !password) return showStatus("auth-status", "Please fill in all fields.");

  const res = await apiCall({ action: type, username, password });
  if (res.success) {
    if (type === "register") showStatus("auth-status", res.message + " (If you were promoted to Transcriber/Editor/Owner before registering, log in again after any role change to pick it up.)", true);
    else {
      localStorage.setItem("lyrix_user", JSON.stringify(res.user));
      updateAuthUI();
      navigateTo("/");
    }
  } else showStatus("auth-status", res.message);
}

// ---------- add song ----------

async function renderAddSong(container) {
  const user = getUser();
  if (!user) return navigateTo("/login");

  container.innerHTML = `
    <div class="form-container">
      <h2>Add New Song Lyrics</h2>
      <div id="song-status" class="status-banner hidden"></div>
      <div class="form-group"><label>Song Title</label><input type="text" id="song-title"></div>
      <div class="form-group"><label>Artist</label><input type="text" id="song-artist" placeholder="Separate multiple with '&' or ','"></div>
      <div class="form-group" style="display:flex; align-items:center; gap:0.5rem;">
        <input type="checkbox" id="is-single" onchange="document.getElementById('album-group').classList.toggle('hidden', this.checked)" style="width:auto;">
        <label for="is-single" style="margin:0;">This song is a Single</label>
      </div>
      <div class="form-group" id="album-group">
        <label>Album(s) / EP(s)</label>
        <input type="text" id="song-album" placeholder="Separate multiple with comma, e.g. Album A, Album B">
      </div>
      <div class="form-group">
        <label>Track Number(s) <span style="font-weight:400; color:var(--ink-dim);">(matches album order above, comma-separated)</span></label>
        <input type="text" id="song-track-numbers" placeholder="e.g. 3   or   3, 1">
      </div>
      <div class="form-group"><label>Release Date</label><input type="date" id="song-release-date"></div>
      ${imageInputHtml("song-cover", "Cover Art")}
      <div class="form-group">
        <label>Lyrics (paste text, or a single Google Doc link)</label>
        <textarea id="song-lyrics" rows="8"></textarea>
        <p style="font-size:0.78rem; color:var(--ink-dim); margin-top:0.4rem;">
          Tag credits like [Verse: *Name*, **Name**, ***Name***, &lt;i&gt;Name&lt;/i&gt;, &lt;b&gt;Name&lt;/b&gt;] — each tagged name gets its own color on the song page (no italics/bold), and the markers themselves won't be shown.
        </p>
      </div>

      <h3>Song Relation (optional)</h3>
      <p style="font-size:0.78rem; color:var(--ink-dim); margin-top:-0.6rem;">Link this song to an original/related version — a remix, cover, sped up edit, sample, etc.</p>
      <div class="form-group">
        <label>Relation Type</label>
        <select id="relation-type">${relationOptionsHtml("")}</select>
      </div>
      <div class="form-group">
        <label>Original / Related Song</label>
        <input type="text" id="relation-target" list="relation-song-options" placeholder="Start typing a song title...">
        <datalist id="relation-song-options"></datalist>
      </div>

      <h3>Audio Links</h3>
      <div class="form-group"><label>YouTube</label><input type="text" id="audio-youtube" placeholder="https://..."></div>
      <div class="form-group"><label>Spotify</label><input type="text" id="audio-spotify" placeholder="https://..."></div>
      <div class="form-group"><label>Apple Music</label><input type="text" id="audio-apple" placeholder="https://..."></div>
      <div class="form-group"><label>SoundCloud</label><input type="text" id="audio-soundcloud" placeholder="https://..."></div>
      <div class="form-group"><label>Bandcamp</label><input type="text" id="audio-bandcamp" placeholder="https://..."></div>

      <button class="btn-submit" id="submit-song-btn" onclick="submitSong()">Publish Lyrics</button>
    </div>
  `;

  populateRelationDatalist();
}

async function submitSong() {
  const user = getUser();
  const btn = document.getElementById("submit-song-btn");
  const title = document.getElementById("song-title").value;
  const artist = document.getElementById("song-artist").value;

  if (!title || !artist) return showStatus("song-status", "Title and Artist are required.");

  btn.disabled = true;
  btn.innerText = "Publishing...";

  const coverResult = await getImageInputValue("song-cover");
  if (coverResult.error) {
    btn.disabled = false;
    btn.innerText = "Publish Lyrics";
    return showStatus("song-status", coverResult.error);
  }

  const audioLinks = {
    youtube: document.getElementById("audio-youtube").value,
    spotify: document.getElementById("audio-spotify").value,
    apple: document.getElementById("audio-apple").value,
    soundcloud: document.getElementById("audio-soundcloud").value,
    bandcamp: document.getElementById("audio-bandcamp").value
  };

  const relationTargetText = document.getElementById("relation-target").value.trim();

  const res = await apiCall({
    action: "addSong",
    username: user.username,
    title, artist,
    isSingle: document.getElementById("is-single").checked,
    album: document.getElementById("song-album").value,
    trackNumbers: document.getElementById("song-track-numbers").value,
    releaseDate: document.getElementById("song-release-date").value,
    lyrics: document.getElementById("song-lyrics").value,
    coverBase64: coverResult.base64,
    coverImageUrl: coverResult.url,
    relationType: document.getElementById("relation-type").value,
    relationTarget: relationTargetText,
    relationTargetSlug: resolveRelationSlug(relationTargetText),
    audioLinks
  });

  if (res.success) {
    await refreshUserInfo();
    navigateTo(`/song/${res.slug}`);
  } else {
    btn.disabled = false;
    btn.innerText = "Publish Lyrics";
    showStatus("song-status", res.message);
  }
}

// ---------- song detail ----------

async function renderSongDetail(container, slug) {
  container.innerHTML = "<p>Loading...</p>";

  let s = null, errorMessage = null;
  const snapshot = await getData();
  if (snapshot) s = snapshot.songs.find(song => song.slug === slug) || null;

  if (!s) {
    const res = await apiCall({ action: "getSong", slug });
    if (res.success) s = res.song; else errorMessage = res.message;
  }

  if (s) {
    const user = getUser();
    const isEditor = user && user.isEditor;
    const isTranscriber = user && user.isTranscriber;
    const isCreator = user && user.username === s.createdBy;
    const canEdit = isEditor || isTranscriber || (isCreator && !s.isComplete);
    const audioEntries = Object.entries(s.audioLinks || {}).filter(([, v]) => v && v.toString().trim());

    const artistLinks = splitArtists(s.artist)
      .map(a => `<a href="/artist/${slugify(a)}" data-link style="color:var(--danger); text-decoration:none;">${esc(a)}</a>`)
      .join(" & ");

    // A song can be released on more than one album/EP - each entry links
    // through to that album's own page.
    const albumEntries = s.albumEntries || [];
    const albumLinksHtml = albumEntries.map(al => `<a href="/album/${al.slug}" data-link style="color:inherit;">${esc(al.name)}</a>`).join(" • ");

    // "This song is a Remix of X" - links to X if it resolves to a real
    // song, otherwise just shows the typed name.
    const relationHtml = (s.relationType && s.relationTarget) ? `
      <p style="margin-top:0.6rem; font-size:0.92rem; color:var(--ink-dim);">
        ${esc(relationTypeLabel(s.relationType))}
        ${s.relationTargetSlug ? `<a href="/song/${s.relationTargetSlug}" data-link style="color:var(--danger); font-weight:600;">${esc(s.relationTarget)}</a>` : `<strong>${esc(s.relationTarget)}</strong>`}
      </p>
    ` : '';

    // Reverse lookup: other songs (from the full snapshot, when available)
    // that point back at this one - "Related Versions".
    const relatedVersions = snapshot ? snapshot.songs.filter(other => other.relationTargetSlug && other.relationTargetSlug === s.slug && other.slug !== s.slug) : [];
    const relatedVersionsHtml = relatedVersions.length > 0 ? `
      <div style="margin-top:1.5rem;">
        <h4>Related Versions</h4>
        <div style="display:flex; flex-direction:column; gap:0.4rem;">
          ${relatedVersions.map(rv => `<a href="/song/${rv.slug}" data-link style="color:var(--danger); text-decoration:none;">${esc(relationTypeLabel(rv.relationType))} — ${esc(rv.title)} (${esc(cleanArtist(rv.artist))})</a>`).join('')}
        </div>
      </div>
    ` : '';

    container.innerHTML = `
      <div id="song-edit-status" class="status-banner hidden"></div>
      <div class="song-detail">
        <div>
          ${coverHtml(s.coverUrl, s.title, "song-cover")}
          <h1 style="margin-top:1rem;">${esc(s.title)} ${s.isComplete ? '✅' : ''}</h1>
          <h3 style="font-weight:600; font-family:var(--font-body);">${artistLinks}${albumLinksHtml ? ' • ' + albumLinksHtml : ''}</h3>
          ${s.releaseDate ? `<p style="font-size:0.85rem; color:var(--ink-dim);">Released ${esc(formatReleaseDate(s.releaseDate))}</p>` : ''}
          ${relationHtml}

          ${audioEntries.length > 0 ? `
            <div class="audio-links" style="margin-top:1rem;">
              <h4>Listen:</h4>
              ${audioEntries.map(([k, v]) => embedHtml(k, v)).join('')}
            </div>
          ` : ''}

          ${canEdit ? `<button class="btn-submit" onclick="document.getElementById('edit-song-box').classList.toggle('hidden')" style="background:#fff; margin-top:1rem;">Edit Song</button>` : ''}
          ${isEditor ? `<button class="btn-submit" onclick="deleteSong('${s.id}')" style="background:var(--danger); color:#fff; border-color:var(--danger); margin-top:0.5rem;">Delete Song Permanently</button>` : ''}

          ${relatedVersionsHtml}
        </div>
        <div class="lyrics-box">${colorizeLyrics(s.lyrics)}</div>
      </div>

      ${canEdit ? `
        <div id="edit-song-box" class="form-container floating-panel hidden">
          <button type="button" class="panel-close" onclick="document.getElementById('edit-song-box').classList.add('hidden')" aria-label="Close">×</button>
          <h3>Edit Song Information</h3>
          <div class="form-group"><label>Title</label><input type="text" id="edit-title" value="${esc(s.title)}"></div>
          <div class="form-group"><label>Artist</label><input type="text" id="edit-artist" value="${esc(cleanArtist(s.artist))}"></div>
          <div class="form-group"><label>Album(s) / EP(s)</label><input type="text" id="edit-album" value="${esc(s.album)}" placeholder="Separate multiple with comma"></div>
          <div class="form-group">
            <label>Track Number(s) <span style="font-weight:400; color:var(--ink-dim);">(matches album order above, comma-separated)</span></label>
            <input type="text" id="edit-track-numbers" value="${esc(albumEntries.map(al => (s.trackNumbers && s.trackNumbers[al.slug] != null) ? s.trackNumbers[al.slug] : '').join(', '))}">
          </div>
          <div class="form-group"><label>Release Date</label><input type="date" id="edit-release-date" value="${esc((s.releaseDate || "").toString().substring(0, 10))}"></div>
          ${imageInputHtml("edit-cover", "Cover Art (replace)", s.coverUrl)}
          <div class="form-group">
            <label>Lyrics (paste text, or a single Google Doc link)</label>
            <textarea id="edit-lyrics" rows="8">${esc(s.lyrics)}</textarea>
            <p style="font-size:0.78rem; color:var(--ink-dim); margin-top:0.4rem;">
              Tag credits like *Name*, **Name**, ***Name***, &lt;i&gt;Name&lt;/i&gt;, &lt;b&gt;Name&lt;/b&gt; for automatic color-coding.
            </p>
          </div>

          <h4>Song Relation (optional)</h4>
          <div class="form-group">
            <label>Relation Type</label>
            <select id="edit-relation-type">${relationOptionsHtml(s.relationType || "")}</select>
          </div>
          <div class="form-group">
            <label>Original / Related Song</label>
            <input type="text" id="edit-relation-target" list="relation-song-options" value="${esc(s.relationTarget || '')}">
            <datalist id="relation-song-options"></datalist>
          </div>

          <h4>Audio Links</h4>
          <div class="form-group"><label>YouTube</label><input type="text" id="edit-youtube" value="${esc(s.audioLinks.youtube || '')}"></div>
          <div class="form-group"><label>Spotify</label><input type="text" id="edit-spotify" value="${esc(s.audioLinks.spotify || '')}"></div>
          <div class="form-group"><label>Apple Music</label><input type="text" id="edit-apple" value="${esc(s.audioLinks.apple || '')}"></div>
          <div class="form-group"><label>SoundCloud</label><input type="text" id="edit-soundcloud" value="${esc(s.audioLinks.soundcloud || '')}"></div>
          <div class="form-group"><label>Bandcamp</label><input type="text" id="edit-bandcamp" value="${esc(s.audioLinks.bandcamp || '')}"></div>

          ${isEditor ? `
            <div class="form-group" style="display:flex; align-items:center; gap:0.5rem; margin-top:1rem;">
              <input type="checkbox" id="edit-is-complete" ${s.isComplete ? "checked" : ""} style="width:auto;">
              <label for="edit-is-complete" style="margin:0;">Mark Lyrics as Complete (Locks out non-editors)</label>
            </div>
          ` : ''}
          <button class="btn-submit" onclick="saveSongEdit('${s.id}')">Save Changes</button>
        </div>
      ` : ''}
    `;

    if (canEdit) populateRelationDatalist();
  } else {
    container.innerHTML = errorMessage ? `<h2>Couldn't load this song</h2><p class="empty-state">${esc(errorMessage)}</p>` : "<h2>Song not found</h2>";
  }
}

async function saveSongEdit(songId) {
  const user = getUser();
  const btn = event.target;
  btn.disabled = true;
  btn.innerText = "Saving...";

  const coverResult = await getImageInputValue("edit-cover");
  if (coverResult.error) {
    btn.disabled = false;
    btn.innerText = "Save Changes";
    return showStatus("song-edit-status", coverResult.error);
  }

  const audioLinks = {
    youtube: document.getElementById("edit-youtube").value,
    spotify: document.getElementById("edit-spotify").value,
    apple: document.getElementById("edit-apple").value,
    soundcloud: document.getElementById("edit-soundcloud").value,
    bandcamp: document.getElementById("edit-bandcamp").value
  };

  const editRelationTargetEl = document.getElementById("edit-relation-target");
  const editRelationTypeEl = document.getElementById("edit-relation-type");
  const editTrackNumbersEl = document.getElementById("edit-track-numbers");
  const editRelationTargetText = editRelationTargetEl ? editRelationTargetEl.value.trim() : undefined;

  const res = await apiCall({
    action: "updateSong",
    id: songId,
    username: user.username,
    title: document.getElementById("edit-title").value,
    artist: document.getElementById("edit-artist").value,
    album: document.getElementById("edit-album").value,
    trackNumbers: editTrackNumbersEl ? editTrackNumbersEl.value : undefined,
    releaseDate: document.getElementById("edit-release-date").value,
    lyrics: document.getElementById("edit-lyrics").value,
    audioLinks: audioLinks,
    coverBase64: coverResult.base64,
    coverImageUrl: coverResult.url,
    relationType: editRelationTypeEl ? editRelationTypeEl.value : undefined,
    relationTarget: editRelationTargetText,
    relationTargetSlug: editRelationTargetText !== undefined ? resolveRelationSlug(editRelationTargetText) : undefined,
    isComplete: document.getElementById("edit-is-complete") ? document.getElementById("edit-is-complete").checked : undefined
  });

  if (res.success) {
    await refreshUserInfo();
    navigateTo(`/song/${res.slug}`);
  } else {
    btn.disabled = false;
    btn.innerText = "Save Changes";
    showStatus("song-edit-status", res.message);
  }
}

async function deleteSong(songId) {
  if (!confirm("Are you sure you want to delete this song page permanently?")) return;
  const user = getUser();
  const res = await apiCall({ action: "deleteSong", id: songId, username: user.username });
  if (res.success) navigateTo("/");
  else showStatus("song-edit-status", res.message);
}

// ---------- artist detail ----------

async function renderArtistDetail(container, slug) {
  container.innerHTML = "<p>Loading artist...</p>";

  const snapshot = await getData();
  // Expand any legacy combined artist rows before matching/displaying, in
  // case the published snapshot hasn't been rebuilt yet.
  let allArtists = snapshot ? expandArtists(snapshot.artists) : null;
  if (!allArtists) {
    const res = await apiCall({ action: "getArtists", limit: 999999 });
    if (res.success) allArtists = res.artists;
  }

  if (allArtists) {
    const isDirectMatch = allArtists.some(a => a.slug === slug);
    if (!isDirectMatch) {
      const akaMatch = allArtists.find(a => splitAkas(a.akas).some(aka => slugify(aka) === slug));
      if (akaMatch) {
        history.replaceState(null, null, `/artist/${akaMatch.slug}`);
        return renderArtistDetail(container, akaMatch.slug);
      }
    }
  }

  let a = null, errorMessage = null;
  if (snapshot) {
    const artistMeta = (allArtists || []).find(ar => ar.slug === slug) || null;

    const songs = snapshot.songs.filter(s => {
      const slugs = splitArtists(s.artist).map(slugify);
      return slugs.includes(slug) || s.artistSlug === slug;
    }).map(s => ({ title: s.title, album: s.album, coverUrl: s.coverUrl, slug: s.slug, createdAt: s.createdAt, releaseDate: s.releaseDate || "" }));

    if (artistMeta) a = Object.assign({ streamLinks: {} }, artistMeta, { songs });
    else if (songs.length > 0) a = { slug, name: cleanArtist(snapshot.songs.find(s => splitArtists(s.artist).map(slugify).includes(slug) || s.artistSlug === slug).artist), pfpUrl: "", akas: "", streamLinks: {}, songs };
  }

  if (!a) {
    const res = await apiCall({ action: "getArtist", slug });
    if (res.success) a = res.artist; else errorMessage = res.message;
  }

  if (a) {
    a.streamLinks = a.streamLinks || {};
    const user = getUser();
    const canEdit = user && (user.isEditor || user.username === a.createdBy);
    const isEditor = user && user.isEditor;
    const streamEntries = Object.entries(a.streamLinks).filter(([, v]) => v && v.toString().trim());

    // Albums by this artist (auto-created whenever a song names one).
    let artistAlbums = [];
    if (snapshot && snapshot.albums) {
      artistAlbums = snapshot.albums.filter(al => al.artistSlug === a.slug);
    } else {
      const albumsRes = await apiCall({ action: "getAlbums", limit: 500 });
      if (albumsRes.success) artistAlbums = albumsRes.albums.filter(al => al.artistSlug === a.slug);
    }
    const albumsRowHtml = artistAlbums.length > 0 ? `
      <h2 class="section-title">Albums</h2>
      <div class="artist-row">
        ${artistAlbums.map(al => `
          <a href="/album/${al.slug}" data-link class="artist-chip">
            ${avatarHtml(al.coverUrl, al.name)}
            <div class="artist-chip-name">${esc(al.name)}</div>
          </a>
        `).join('')}
      </div>
    ` : '';

    container.innerHTML = `
      <div id="artist-status" class="status-banner hidden"></div>
      <div style="display:flex; gap:2rem; align-items:center; flex-wrap:wrap;">
        ${a.pfpUrl
          ? `<img src="${esc(a.pfpUrl)}" style="width:150px; height:150px; border-radius:50%; object-fit:cover; border:2px solid var(--ink);">`
          : `<div class="cover-fallback" style="width:150px; height:150px; border-radius:50%; font-size:2.4rem;">${esc(initials(cleanArtist(a.name)))}</div>`}
        <div>
          <h1>${esc(cleanArtist(a.name))}</h1>
          ${a.akas ? `<p style="color:var(--ink-dim);">AKA: ${esc(a.akas)}</p>` : ''}
          ${streamEntries.length > 0 ? `<div style="margin-top:0.4rem;">${streamEntries.map(([k, v]) => linkFallback(k, v)).join('')}</div>` : ''}
          <div style="display:flex; gap:0.5rem; flex-wrap:wrap; margin-top:0.6rem;">
            ${canEdit ? `<button class="btn-submit" onclick="document.getElementById('edit-artist-box').classList.toggle('hidden')" style="background:#fff; width:auto; padding:0.6rem 1rem;">Edit Artist Profile</button>` : ''}
            ${isEditor ? `<button class="btn-submit" onclick="deleteArtist('${a.slug}')" style="background:var(--danger); color:#fff; border-color:var(--danger); width:auto; padding:0.6rem 1rem;">Delete Artist Profile</button>` : ''}
          </div>
        </div>
      </div>

      ${albumsRowHtml}

      <div style="display:flex; justify-content:space-between; align-items:center; gap:1rem; flex-wrap:wrap; margin:2.5rem 0 1.1rem;">
        <h2 class="section-title" style="margin:0;">Songs by ${esc(cleanArtist(a.name))}</h2>
        <select id="artist-song-sort" onchange="sortArtistSongs()" style="width:auto; padding:0.5rem 0.7rem; font-size:0.85rem;">
          <option value="recent-added">Recently Added</option>
          <option value="oldest-added">Oldest Added</option>
          <option value="az">Title A–Z</option>
          <option value="za">Title Z–A</option>
          <option value="release-recent">Release Date (Newest)</option>
          <option value="release-oldest">Release Date (Oldest)</option>
        </select>
      </div>
      <div class="grid" id="artist-song-grid"></div>

      <h2 class="section-title">Top Contributors</h2>
      <div id="artist-leaderboard">Loading...</div>

      ${canEdit ? `
        <div id="edit-artist-box" class="form-container hidden" style="margin-top:2rem;">
          <h3>Edit Profile Information</h3>
          <div class="form-group"><label>AKAs (comma-separated)</label><input type="text" id="artist-akas" value="${esc(a.akas)}"></div>
          ${imageInputHtml("artist-pfp", "Profile Picture", a.pfpUrl)}

          <h4>Listen / Follow Links</h4>
          <div class="form-group"><label>YouTube</label><input type="text" id="artist-youtube" value="${esc(a.streamLinks.youtube || '')}" placeholder="https://..."></div>
          <div class="form-group"><label>Spotify</label><input type="text" id="artist-spotify" value="${esc(a.streamLinks.spotify || '')}" placeholder="https://..."></div>
          <div class="form-group"><label>Apple Music</label><input type="text" id="artist-apple" value="${esc(a.streamLinks.apple || '')}" placeholder="https://..."></div>
          <div class="form-group"><label>SoundCloud</label><input type="text" id="artist-soundcloud" value="${esc(a.streamLinks.soundcloud || '')}" placeholder="https://..."></div>
          <div class="form-group"><label>Bandcamp</label><input type="text" id="artist-bandcamp" value="${esc(a.streamLinks.bandcamp || '')}" placeholder="https://..."></div>

          <button class="btn-submit" onclick="saveArtistEdit('${a.slug}')">Save Profile</button>
        </div>
      ` : ''}
    `;

    currentArtistSongs = a.songs || [];
    sortArtistSongs();

    loadArtistLeaderboard(a.slug, document.getElementById("artist-leaderboard"));
  } else {
    container.innerHTML = errorMessage ? `<h2>Couldn't load this artist</h2><p class="empty-state">${esc(errorMessage)}</p>` : "<h2>Artist not found</h2>";
  }
}

// Holds the current artist's songs so the sort dropdown can re-render
// without needing to re-fetch anything.
let currentArtistSongs = [];

function renderArtistSongGrid(songs) {
  const grid = document.getElementById("artist-song-grid");
  if (!grid) return;
  grid.innerHTML = songs.length > 0 ? songs.map(s => `
    <a href="/song/${s.slug}" data-link class="card">
      ${coverHtml(s.coverUrl, s.title)}
      <div class="card-info">
        <div class="card-title">${esc(s.title)}</div>
      </div>
    </a>
  `).join('') : '<p class="empty-state">No songs found for this artist.</p>';
}

function sortArtistSongs() {
  const select = document.getElementById("artist-song-sort");
  const sortBy = select ? select.value : "recent-added";
  const songs = currentArtistSongs.slice();

  switch (sortBy) {
    case "az":
      songs.sort((a, b) => a.title.localeCompare(b.title));
      break;
    case "za":
      songs.sort((a, b) => b.title.localeCompare(a.title));
      break;
    case "oldest-added":
      songs.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
      break;
    case "release-recent":
      songs.sort((a, b) => new Date(b.releaseDate || 0) - new Date(a.releaseDate || 0));
      break;
    case "release-oldest":
      songs.sort((a, b) => new Date(a.releaseDate || 0) - new Date(b.releaseDate || 0));
      break;
    case "recent-added":
    default:
      songs.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
      break;
  }

  renderArtistSongGrid(songs);
}

async function saveArtistEdit(slug) {
  const user = getUser();

  const pfpResult = await getImageInputValue("artist-pfp", 500, 0.85);
  if (pfpResult.error) {
    return showStatus("artist-status", pfpResult.error);
  }

  const streamLinks = {
    youtube: document.getElementById("artist-youtube").value,
    spotify: document.getElementById("artist-spotify").value,
    apple: document.getElementById("artist-apple").value,
    soundcloud: document.getElementById("artist-soundcloud").value,
    bandcamp: document.getElementById("artist-bandcamp").value
  };

  const res = await apiCall({
    action: "updateArtist",
    slug,
    username: user.username,
    akas: document.getElementById("artist-akas").value,
    pfpBase64: pfpResult.base64,
    pfpImageUrl: pfpResult.url,
    streamLinks
  });

  if (res.success) {
    await refreshUserInfo();
    navigateTo(`/artist/${slug}`);
  } else showStatus("artist-status", res.message);
}

async function deleteArtist(slug) {
  if (!confirm("Delete this artist's profile permanently? Their songs will stay online, but the photo, AKAs, and links will be removed.")) return;
  const user = getUser();
  const res = await apiCall({ action: "deleteArtist", slug, username: user.username });
  if (res.success) navigateTo("/");
  else showStatus("artist-status", res.message);
}

// ---------- album detail ----------

async function renderAlbumDetail(container, slug) {
  container.innerHTML = "<p>Loading album...</p>";

  const res = await apiCall({ action: "getAlbum", slug });
  let alb = null, errorMessage = null;
  if (res.success) alb = res.album; else errorMessage = res.message;

  if (alb) {
    const user = getUser();
    const isEditor = user && user.isEditor;
    const canEdit = user && (user.isEditor || user.username === alb.createdBy);

    container.innerHTML = `
      <div id="album-status" class="status-banner hidden"></div>
      <div class="song-detail">
        <div>
          ${coverHtml(alb.coverUrl, alb.name, "song-cover")}
          <h1 style="margin-top:1rem;">${esc(alb.name)}</h1>
          <h3 style="font-weight:600; font-family:var(--font-body);"><a href="/artist/${alb.artistSlug}" data-link style="color:var(--danger); text-decoration:none;">${esc(alb.artist)}</a></h3>
          ${alb.releaseDate ? `<p style="font-size:0.85rem; color:var(--ink-dim);">Released ${esc(formatReleaseDate(alb.releaseDate))}</p>` : ''}

          ${canEdit ? `<button class="btn-submit" onclick="document.getElementById('edit-album-box').classList.toggle('hidden')" style="background:#fff; margin-top:1rem;">Edit Album</button>` : ''}
          ${isEditor ? `<button class="btn-submit" onclick="deleteAlbum('${alb.slug}')" style="background:var(--danger); color:#fff; border-color:var(--danger); margin-top:0.5rem;">Delete Album Page</button>` : ''}
        </div>
        <div style="flex:1; min-width:300px;">
          <h3 style="margin-top:0;">Tracklist</h3>
          <div class="form-container" style="max-width:600px;">
            ${alb.tracks.length > 0 ? alb.tracks.map((t, i) => `
              <a href="/song/${t.slug}" data-link style="display:flex; justify-content:space-between; align-items:center; gap:0.8rem; padding:0.6rem 0; border-bottom:1px solid var(--line); text-decoration:none; color:inherit;">
                <span><strong>${t.trackNumber != null ? t.trackNumber : (i + 1)}.</strong> &nbsp; ${esc(t.title)}</span>
              </a>
            `).join('') : `<p class="empty-state">No tracks found for this album yet.</p>`}
          </div>
        </div>
      </div>

      ${canEdit ? `
        <div id="edit-album-box" class="form-container floating-panel hidden">
          <button type="button" class="panel-close" onclick="document.getElementById('edit-album-box').classList.add('hidden')" aria-label="Close">×</button>
          <h3>Edit Album</h3>
          <div class="form-group"><label>Release Date</label><input type="date" id="edit-album-release-date" value="${esc((alb.releaseDate || "").toString().substring(0, 10))}"></div>
          ${imageInputHtml("edit-album-cover", "Cover Art (replace)", alb.coverUrl)}
          <button class="btn-submit" onclick="saveAlbumEdit('${alb.slug}')">Save Changes</button>
        </div>
      ` : ''}
    `;
  } else {
    container.innerHTML = errorMessage ? `<h2>Couldn't load this album</h2><p class="empty-state">${esc(errorMessage)}</p>` : "<h2>Album not found</h2>";
  }
}

async function saveAlbumEdit(slug) {
  const user = getUser();
  const coverResult = await getImageInputValue("edit-album-cover");
  if (coverResult.error) return showStatus("album-status", coverResult.error);

  const res = await apiCall({
    action: "updateAlbum",
    slug,
    username: user.username,
    releaseDate: document.getElementById("edit-album-release-date").value,
    coverBase64: coverResult.base64,
    coverImageUrl: coverResult.url
  });

  if (res.success) navigateTo(`/album/${slug}`);
  else showStatus("album-status", res.message);
}

async function deleteAlbum(slug) {
  if (!confirm("Delete this album page permanently? The songs themselves will stay online - only the album page is removed.")) return;
  const user = getUser();
  const res = await apiCall({ action: "deleteAlbum", slug, username: user.username });
  if (res.success) navigateTo("/");
  else showStatus("album-status", res.message);
}

// ---------- leaderboards ----------

// Global leaderboard, rendered inline at the bottom of the home page.
async function loadHomeLeaderboard(container) {
  if (!container) return;
  const res = await apiCall({ action: "getLeaderboard", limit: 50 });

  if (!res.success || !res.leaderboard || res.leaderboard.length === 0) {
    container.innerHTML = `<p class="empty-state">${esc(res.message || "No contributors yet.")}</p>`;
    return;
  }

  container.innerHTML = `
    <div class="form-container" style="max-width:600px;">
      ${res.leaderboard.map((u, i) => `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:0.6rem 0; border-bottom:1px solid var(--line);">
          <span><strong>#${i + 1}</strong> &nbsp; @${esc(u.username)} ${u.isOwner ? '<span class="badge">Owner</span>' : (u.isEditor ? '<span class="badge">Editor</span>' : (u.isTranscriber ? '<span class="badge">Transcriber</span>' : ''))}</span>
          <span style="font-weight:700;">${u.points} pts</span>
        </div>
      `).join("")}
    </div>
  `;
}

// Per-artist leaderboard, rendered on each artist's page. Shows the users
// who've earned the most points contributing specifically to that artist
// (adding their songs, cover art, the artist page itself, its pfp).
async function loadArtistLeaderboard(slug, container) {
  if (!container) return;
  const res = await apiCall({ action: "getArtistLeaderboard", slug, limit: 10 });

  if (!res.success || !res.leaderboard || res.leaderboard.length === 0) {
    container.innerHTML = `<p class="empty-state">No contributions yet.</p>`;
    return;
  }

  container.innerHTML = `
    <div class="form-container" style="max-width:600px;">
      ${res.leaderboard.map((u, i) => `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:0.6rem 0; border-bottom:1px solid var(--line);">
          <span><strong>#${i + 1}</strong> &nbsp; @${esc(u.username)}</span>
          <span style="font-weight:700;">${u.points} pts</span>
        </div>
      `).join("")}
    </div>
  `;
}

// ---------- owner page (editor-only point settings now live here, owner-only access) ----------

async function renderOwnerPage(container) {
  const user = getUser();
  if (!user || !user.isOwner) {
    container.innerHTML = `<h2>Owner</h2><p class="empty-state">Owner access required.</p>`;
    return;
  }

  container.innerHTML = `<div class="form-container"><h2>Owner Panel</h2><p style="color:var(--ink-dim); font-size:0.9rem;">Loading...</p></div>`;
  const res = await apiCall({ action: "getSettings" });
  if (!res.success) {
    container.innerHTML = `<h2>Owner Panel</h2><p class="empty-state">${esc(res.message || "Couldn't load settings.")}</p>`;
    return;
  }

  container.innerHTML = `
    <div class="form-container">
      <h2>Owner Panel</h2>
      <p style="color:var(--ink-dim); font-size:0.85rem; margin-top:-0.6rem;">Points awarded to users for contributing.</p>
      <div id="settings-status" class="status-banner hidden"></div>
      ${Object.keys(res.settings).map(k => `
        <div class="form-group">
          <label>${esc(res.labels[k] || k)}</label>
          <input type="number" step="1" class="setting-input" data-key="${esc(k)}" value="${esc(res.settings[k])}">
        </div>
      `).join("")}
      <button class="btn-submit" onclick="saveSettings()">Save Settings</button>
      <div class="form-container" style="margin-top:2rem;">
        <h3>Manually Adjust User Points</h3>
        <div id="points-status" class="status-banner hidden"></div>
        <div class="form-group"><label>Username</label><input type="text" id="points-username" placeholder="username"></div>
        <div class="form-group"><label>Points (negative to subtract)</label><input type="number" step="1" id="points-amount" placeholder="e.g. 25 or -10"></div>
        <button class="btn-submit" onclick="adjustPoints()">Apply</button>
      </div>
    </div>
  `;
}

async function saveSettings() {
  const user = getUser();
  const updates = {};
  document.querySelectorAll(".setting-input").forEach(el => { updates[el.dataset.key] = Number(el.value) || 0; });

  const res = await apiCall({ action: "updateSettings", username: user.username, settings: JSON.stringify(updates) });
  if (res.success) showStatus("settings-status", "Settings saved.", true);
  else showStatus("settings-status", res.message);
}

async function adjustPoints() {
  const user = getUser();
  const targetUsername = document.getElementById("points-username").value.trim();
  const amount = document.getElementById("points-amount").value;

  if (!targetUsername || !amount) return showStatus("points-status", "Enter a username and a point amount.");

  const res = await apiCall({ action: "adjustUserPoints", username: user.username, targetUsername, amount });
  if (res.success) {
    showStatus("points-status", res.message, true);
    document.getElementById("points-amount").value = "";
  } else {
    showStatus("points-status", res.message);
  }
}
