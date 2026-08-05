const API_URL = "https://script.google.com/macros/s/AKfycbzX2yNyc4-1Oblx1qi8xNNdqi9gGwpCOu6Vz0qOpuXKdncfqpabvzY4meujiQ9t8-ZS/exec"; // Paste your Web App URL here

// Optional: once you've set GITHUB_TOKEN / GITHUB_REPO in the Apps Script's
// Script Properties, paste the raw file URL here (e.g.
// "https://raw.githubusercontent.com/USERNAME/REPO/main/lyrix-data.json").
// When set, all browsing (home, song pages, artist pages) reads from this
// static file instead of Apps Script, which is dramatically faster and
// doesn't depend on Apps Script being fast or even reachable. Leave blank
// to keep using Apps Script directly for reads — everything still works,
// just slower.
const DATA_URL = "";

let dataCache = null;
let dataCacheAt = 0;
const DATA_CACHE_MS = 15000;

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

// Always resolves — never throws and never hangs forever. A network error,
// a timeout, or a non-JSON response (e.g. Apps Script serving a Google
// sign-in page because the deployment isn't set to "Anyone can access")
// all come back as { success:false, message }, so callers' existing
// if(res.success)/else logic just works instead of leaving a button stuck
// on "Publishing..." with no feedback.
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
      return { success: false, message: "The server didn't return valid data. Double-check the Apps Script deployment is set to \"Execute as: Me\" / \"Who has access: Anyone\", and redeploy (New deployment) after any code change." };
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

// Fetches the CDN-hosted snapshot (if DATA_URL is configured). Cached in
// memory for DATA_CACHE_MS so navigating between pages doesn't refetch.
// Returns null (never throws) if unset or unreachable, so callers can
// fall back to apiCall.
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

// ---------- small utils ----------

function esc(str) {
  return (str === undefined || str === null ? "" : str.toString())
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function initials(name) {
  return (name || "?").trim().split(/\s+/).map(w => w[0]).slice(0, 2).join("").toUpperCase();
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

// Resizes + compresses an image client-side before it's base64-encoded and
// POSTed to Apps Script. Full-resolution phone photos are the #1 cause of
// slow uploads (multi-MB payloads to parse, decode, and push to Drive).
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

function getUser() {
  return JSON.parse(localStorage.getItem("lyrix_user"));
}

function updateAuthUI() {
  const user = getUser();
  const loginBtn = document.getElementById("login-btn");
  const logoutBtn = document.getElementById("logout-btn");
  const addLink = document.getElementById("add-link");
  const userDisplay = document.getElementById("user-display");

  if (user) {
    if (loginBtn) loginBtn.classList.add("hidden");
    if (logoutBtn) logoutBtn.classList.remove("hidden");
    if (addLink) addLink.classList.remove("hidden");
    if (userDisplay) {
      userDisplay.classList.remove("hidden");
      let roleTag = "";
      if (user.isEditor) roleTag = " (Editor)";
      else if (user.isTranscriber) roleTag = " (Transcriber)";
      userDisplay.innerText = `@${user.username}${roleTag}`;
    }
  } else {
    if (loginBtn) loginBtn.classList.remove("hidden");
    if (logoutBtn) logoutBtn.classList.add("hidden");
    if (addLink) addLink.classList.add("hidden");
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
  } else if (path.startsWith("/song/")) {
    renderSongDetail(app, path.replace("/song/", ""));
  } else if (path.startsWith("/artist/")) {
    renderArtistDetail(app, path.replace("/artist/", ""));
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
  `;

  const grid = document.getElementById("song-grid");
  const artistRow = document.getElementById("artist-row");

  let songs = null, artists = null, errorMessage = null;

  const snapshot = await getData();
  if (snapshot) {
    const terms = normalizeText(query).split(/\s+/).filter(Boolean);
    songs = snapshot.songs
      .filter(s => terms.length === 0 || terms.every(t => normalizeText(s.title + " " + s.artist + " " + (s.album || "")).includes(t)))
      .slice(0, 24);
    artists = snapshot.artists.slice(0, 12);
  } else {
    const res = await apiCall({ action: "getHome", q: query || "", limit: 24 });
    if (res.success) {
      songs = res.songs;
      artists = res.artists;
    } else {
      errorMessage = res.message;
    }
  }

  if (songs && songs.length > 0) {
    grid.innerHTML = songs.map(song => `
      <a href="/song/${song.slug}" data-link class="card">
        ${coverHtml(song.coverUrl, song.title)}
        <div class="card-info">
          <div class="card-title">${esc(song.title)}</div>
          <div class="card-artist">${esc(song.artist)}</div>
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
        ${avatarHtml(a.pfpUrl, a.name)}
        <div class="artist-chip-name">${esc(a.name)}</div>
      </a>
    `).join("");
  } else if (errorMessage) {
    artistRow.innerHTML = `<p class="empty-state">Couldn't load artists.</p>`;
  } else {
    artistRow.innerHTML = `<p class="empty-state">No artist pages yet.</p>`;
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
    if (type === "register") showStatus("auth-status", res.message + " (If you were promoted to Transcriber/Editor before registering, log in again after any role change to pick it up.)", true);
    else {
      localStorage.setItem("lyrix_user", JSON.stringify(res.user));
      updateAuthUI();
      navigateTo("/");
    }
  } else showStatus("auth-status", res.message);
}

// ---------- add song ----------

function renderAddSong(container) {
  const user = getUser();
  if (!user) return navigateTo("/login");

  container.innerHTML = `
    <div class="form-container">
      <h2>Add New Song Lyrics</h2>
      <div id="song-status" class="status-banner hidden"></div>
      <div class="form-group"><label>Song Title</label><input type="text" id="song-title"></div>
      <div class="form-group"><label>Artist</label><input type="text" id="song-artist"></div>
      <div class="form-group" style="display:flex; align-items:center; gap:0.5rem;">
        <input type="checkbox" id="is-single" onchange="document.getElementById('album-group').classList.toggle('hidden', this.checked)" style="width:auto;">
        <label for="is-single" style="margin:0;">This song is a Single</label>
      </div>
      <div class="form-group" id="album-group"><label>Album / EP</label><input type="text" id="song-album"></div>
      <div class="form-group"><label>Cover Art</label><input type="file" id="song-cover" accept="image/*"></div>
      <div class="form-group"><label>Lyrics</label><textarea id="song-lyrics" rows="8"></textarea></div>

      <h3>Audio Links</h3>
      <div class="form-group"><label>YouTube</label><input type="text" id="audio-youtube"></div>
      <div class="form-group"><label>Spotify</label><input type="text" id="audio-spotify"></div>
      <div class="form-group"><label>Apple Music</label><input type="text" id="audio-apple"></div>
      <div class="form-group"><label>SoundCloud</label><input type="text" id="audio-soundcloud"></div>
      <div class="form-group"><label>Bandcamp</label><input type="text" id="audio-bandcamp"></div>

      <button class="btn-submit" id="submit-song-btn" onclick="submitSong()">Publish Lyrics</button>
    </div>
  `;
}

async function submitSong() {
  const user = getUser();
  const btn = document.getElementById("submit-song-btn");
  const title = document.getElementById("song-title").value;
  const artist = document.getElementById("song-artist").value;

  if (!title || !artist) return showStatus("song-status", "Title and Artist are required.");

  btn.disabled = true;
  btn.innerText = "Publishing...";

  let coverBase64 = null;
  const fileInput = document.getElementById("song-cover");
  if (fileInput.files.length > 0) {
    try {
      coverBase64 = await fileToCompressedBase64(fileInput.files[0]);
    } catch (e) {
      btn.disabled = false;
      btn.innerText = "Publish Lyrics";
      return showStatus("song-status", "Could not process that image.");
    }
  }

  const audioLinks = {
    youtube: document.getElementById("audio-youtube").value,
    spotify: document.getElementById("audio-spotify").value,
    apple: document.getElementById("audio-apple").value,
    soundcloud: document.getElementById("audio-soundcloud").value,
    bandcamp: document.getElementById("audio-bandcamp").value
  };

  const res = await apiCall({
    action: "addSong",
    username: user.username,
    title, artist,
    isSingle: document.getElementById("is-single").checked,
    album: document.getElementById("song-album").value,
    lyrics: document.getElementById("song-lyrics").value,
    coverBase64,
    audioLinks
  });

  if (res.success) navigateTo(`/song/${res.slug}`);
  else {
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

  // Falls back to a live lookup if not in the snapshot yet (e.g. it was
  // just added and the CDN copy hasn't caught up) or if no CDN is configured.
  if (!s) {
    const res = await apiCall({ action: "getSong", slug });
    if (res.success) s = res.song; else errorMessage = res.message;
  }

  if (s) {
    const user = getUser();
    const isEditor = user && user.isEditor;
    const isTranscriber = user && user.isTranscriber;
    const isCreator = user && user.username === s.createdBy;

    // Transcribers, Editors, and creators can edit (unless locked complete)
    const canEdit = isEditor || isTranscriber || (isCreator && !s.isComplete);

    container.innerHTML = `
      <div id="song-edit-status" class="status-banner hidden"></div>
      <div class="song-detail">
        <div>
          ${coverHtml(s.coverUrl, s.title, "song-cover")}
          <h1 style="margin-top:1rem;">${esc(s.title)} ${s.isComplete ? '✅' : ''}</h1>
          <h3 style="font-weight:600; font-family:var(--font-body);"><a href="/artist/${s.artistSlug}" data-link style="color:var(--danger); text-decoration:none;">${esc(s.artist)}</a> ${s.album ? '• ' + esc(s.album) : ''}</h3>
          <p style="font-size:0.85rem; color:var(--ink-dim);">Added by @${esc(s.createdBy)}</p>

          <div class="audio-links" style="margin-top:1rem;">
            <h4>Listen On:</h4>
            ${Object.entries(s.audioLinks).map(([k, v]) => v ? `<a href="${esc(v)}" target="_blank" rel="noopener" class="badge">${esc(k)}</a>` : '').join('')}
          </div>

          ${canEdit ? `<button class="btn-submit" onclick="document.getElementById('edit-song-box').classList.toggle('hidden')" style="background:#fff; margin-top:1rem;">Edit Song</button>` : ''}
          ${isEditor ? `<button class="btn-submit" onclick="deleteSong('${s.id}')" style="background:var(--danger); color:#fff; border-color:var(--danger); margin-top:0.5rem;">Delete Song Permanently</button>` : ''}
        </div>
        <div class="lyrics-box">${esc(s.lyrics)}</div>
      </div>

      ${canEdit ? `
        <div id="edit-song-box" class="form-container hidden" style="margin-top:2rem;">
          <h3>Edit Song Information</h3>
          <div class="form-group"><label>Title</label><input type="text" id="edit-title" value="${esc(s.title)}"></div>
          <div class="form-group"><label>Artist</label><input type="text" id="edit-artist" value="${esc(s.artist)}"></div>
          <div class="form-group"><label>Cover Art (replace)</label><input type="file" id="edit-cover" accept="image/*"></div>
          <div class="form-group"><label>Lyrics</label><textarea id="edit-lyrics" rows="8">${esc(s.lyrics)}</textarea></div>

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
  } else {
    container.innerHTML = errorMessage ? `<h2>Couldn't load this song</h2><p class="empty-state">${esc(errorMessage)}</p>` : "<h2>Song not found</h2>";
  }
}

async function saveSongEdit(songId) {
  const user = getUser();
  const btn = event.target;
  btn.disabled = true;
  btn.innerText = "Saving...";

  let coverBase64 = null;
  const fileInput = document.getElementById("edit-cover");
  if (fileInput && fileInput.files.length > 0) {
    try {
      coverBase64 = await fileToCompressedBase64(fileInput.files[0]);
    } catch (e) {
      btn.disabled = false;
      btn.innerText = "Save Changes";
      return showStatus("song-edit-status", "Could not process that image.");
    }
  }

  const audioLinks = {
    youtube: document.getElementById("edit-youtube").value,
    spotify: document.getElementById("edit-spotify").value,
    apple: document.getElementById("edit-apple").value,
    soundcloud: document.getElementById("edit-soundcloud").value,
    bandcamp: document.getElementById("edit-bandcamp").value
  };

  const res = await apiCall({
    action: "updateSong",
    id: songId,
    username: user.username,
    title: document.getElementById("edit-title").value,
    artist: document.getElementById("edit-artist").value,
    lyrics: document.getElementById("edit-lyrics").value,
    audioLinks: audioLinks,
    coverBase64,
    isComplete: document.getElementById("edit-is-complete") ? document.getElementById("edit-is-complete").checked : undefined
  });

  if (res.success) navigateTo(`/song/${res.slug}`);
  else {
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

  let a = null, errorMessage = null;
  const snapshot = await getData();
  if (snapshot) {
    const artistMeta = snapshot.artists.find(ar => ar.slug === slug) || null;
    const songs = snapshot.songs.filter(s => s.artistSlug === slug).map(s => ({ title: s.title, album: s.album, coverUrl: s.coverUrl, slug: s.slug }));
    if (artistMeta) a = Object.assign({}, artistMeta, { songs });
    else if (songs.length > 0) a = { slug, name: songs[0] ? snapshot.songs.find(s => s.artistSlug === slug).artist : slug, pfpUrl: "", akas: "", songs };
  }

  if (!a) {
    const res = await apiCall({ action: "getArtist", slug });
    if (res.success) a = res.artist; else errorMessage = res.message;
  }

  if (a) {
    const user = getUser();
    const canEdit = user && (user.isEditor || user.username === a.createdBy);

    container.innerHTML = `
      <div id="artist-status" class="status-banner hidden"></div>
      <div style="display:flex; gap:2rem; align-items:center; flex-wrap:wrap;">
        ${a.pfpUrl
          ? `<img src="${esc(a.pfpUrl)}" style="width:150px; height:150px; border-radius:50%; object-fit:cover; border:2px solid var(--ink);">`
          : `<div class="cover-fallback" style="width:150px; height:150px; border-radius:50%; font-size:2.4rem;">${esc(initials(a.name))}</div>`}
        <div>
          <h1>${esc(a.name)}</h1>
          ${a.akas ? `<p style="color:var(--ink-dim);">AKA: ${esc(a.akas)}</p>` : ''}
          ${canEdit ? `<button class="btn-submit" onclick="document.getElementById('edit-artist-box').classList.toggle('hidden')" style="background:#fff;">Edit Artist Profile</button>` : ''}
        </div>
      </div>

      <h2 class="section-title">Songs by ${esc(a.name)}</h2>
      <div class="grid">
        ${a.songs.length > 0 ? a.songs.map(s => `
          <a href="/song/${s.slug}" data-link class="card">
            ${coverHtml(s.coverUrl, s.title)}
            <div class="card-info">
              <div class="card-title">${esc(s.title)}</div>
            </div>
          </a>
        `).join('') : '<p class="empty-state">No songs found for this artist.</p>'}
      </div>

      ${canEdit ? `
        <div id="edit-artist-box" class="form-container hidden" style="margin-top:2rem;">
          <h3>Edit Profile Information</h3>
          <div class="form-group"><label>AKAs</label><input type="text" id="artist-akas" value="${esc(a.akas)}"></div>
          <div class="form-group"><label>Profile Picture</label><input type="file" id="artist-pfp" accept="image/*"></div>
          <button class="btn-submit" onclick="saveArtistEdit('${a.slug}')">Save Profile</button>
        </div>
      ` : ''}
    `;
  } else {
    container.innerHTML = errorMessage ? `<h2>Couldn't load this artist</h2><p class="empty-state">${esc(errorMessage)}</p>` : "<h2>Artist not found</h2>";
  }
}

async function saveArtistEdit(slug) {
  const user = getUser();
  let pfpBase64 = null;
  const fileInput = document.getElementById("artist-pfp");
  if (fileInput.files.length > 0) {
    try {
      pfpBase64 = await fileToCompressedBase64(fileInput.files[0], 500, 0.85);
    } catch (e) {
      return showStatus("artist-status", "Could not process that image.");
    }
  }

  const res = await apiCall({
    action: "updateArtist",
    slug,
    username: user.username,
    akas: document.getElementById("artist-akas").value,
    pfpBase64
  });

  if (res.success) navigateTo(`/artist/${slug}`);
  else showStatus("artist-status", res.message);
}
