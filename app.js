const API_URL = "https://script.google.com/macros/s/AKfycbz7YSy4UaSvT3naIuIU9MuWgYvh2YjYPeYLLDGuTcIL33JAhHbjDuzRMh0bAcpOUVO0/exec"; // Paste your Web App URL here

// Router State
window.addEventListener("popstate", router);
document.addEventListener("DOMContentLoaded", () => {
  updateAuthUI();
  
  // Intercept client links
  document.body.addEventListener("click", e => {
    if (e.target.matches("[data-link]")) {
      e.preventDefault();
      navigateTo(e.target.href);
    }
  });

  router();
});

function navigateTo(url) {
  history.pushState(null, null, url);
  router();
}

async function apiCall(data) {
  // Apps Script requires text/plain body to avoid CORS preflight failures
  const response = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(data)
  });
  return await response.json();
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
    loginBtn.classList.add("hidden");
    logoutBtn.classList.remove("hidden");
    addLink.classList.remove("hidden");
    userDisplay.classList.remove("hidden");
    userDisplay.innerText = `@${user.username}`;
  } else {
    loginBtn.classList.remove("hidden");
    logoutBtn.classList.add("hidden");
    addLink.classList.add("hidden");
    userDisplay.classList.add("hidden");
  }
}

function logout() {
  localStorage.removeItem("lyrix_user");
  updateAuthUI();
  navigateTo("/");
}

// Client Router
async function router() {
  const path = window.location.pathname;
  const app = document.getElementById("app");

  if (path === "/") {
    renderHome(app);
  } else if (path === "/login") {
    renderLogin(app);
  } else if (path === "/add") {
    renderAddSong(app);
  } else if (path.startsWith("/song/")) {
    const id = path.split("/song/")[1];
    renderSongDetail(app, id);
  } else {
    app.innerHTML = "<h2>404 - Page Not Found</h2>";
  }
}

// Views
async function renderHome(container) {
  container.innerHTML = "<h2>Recent Additions</h2><div class='grid' id='song-grid'>Loading...</div>";
  
  const res = await apiCall({ action: "getSongs" });
  const grid = document.getElementById("song-grid");

  if (res.success && res.songs.length > 0) {
    grid.innerHTML = res.songs.map(song => `
      <a href="/song/${song.id}" data-link class="card">
        <img src="${song.coverUrl}" alt="${song.title}">
        <div class="card-info">
          <div class="card-title">${song.title}</div>
          <div class="card-artist">${song.artist}</div>
        </div>
      </a>
    `).join("");
  } else {
    grid.innerHTML = "<p>No songs found yet. Be the first to add one!</p>";
  }
}

function renderLogin(container) {
  container.innerHTML = `
    <div class="form-container">
      <h2>Account</h2>
      <div class="form-group">
        <label>Username</label>
        <input type="text" id="auth-username" required>
      </div>
      <div class="form-group">
        <label>Password</label>
        <input type="password" id="auth-password" required>
      </div>
      <button class="btn-submit" onclick="handleAuth('login')">Login</button>
      <button class="btn-submit" style="background:#444; margin-top:0.5rem;" onclick="handleAuth('register')">Register New Account</button>
    </div>
  `;
}

async function handleAuth(type) {
  const username = document.getElementById("auth-username").value;
  const password = document.getElementById("auth-password").value;

  if (!username || !password) return alert("Please fill all fields");

  const res = await apiCall({ action: type, username, password });
  if (res.success) {
    localStorage.setItem("lyrix_user", JSON.stringify(res.user));
    updateAuthUI();
    navigateTo("/");
  } else {
    alert(res.message);
  }
}

function renderAddSong(container) {
  const user = getUser();
  if (!user) return navigateTo("/login");

  container.innerHTML = `
    <div class="form-container">
      <h2>Add New Song Lyrics</h2>
      <div class="form-group">
        <label>Song Title</label>
        <input type="text" id="song-title" required>
      </div>
      <div class="form-group">
        <label>Artist</label>
        <input type="text" id="song-artist" required>
      </div>
      <div class="form-group">
        <label>Album</label>
        <input type="text" id="song-album">
      </div>
      <div class="form-group">
        <label>Cover Art (Image File)</label>
        <input type="file" id="song-cover" accept="image/*">
      </div>
      <div class="form-group">
        <label>Lyrics</label>
        <textarea id="song-lyrics" rows="10" required></textarea>
      </div>
      <button class="btn-submit" onclick="submitSong()">Publish Lyrics</button>
    </div>
  `;
}

async function submitSong() {
  const user = getUser();
  const title = document.getElementById("song-title").value;
  const artist = document.getElementById("song-artist").value;
  const album = document.getElementById("song-album").value;
  const lyrics = document.getElementById("song-lyrics").value;
  const fileInput = document.getElementById("song-cover");

  if (!title || !artist || !lyrics) return alert("Title, Artist, and Lyrics are required.");

  let coverBase64 = null;
  if (fileInput.files.length > 0) {
    coverBase64 = await new Promise((res) => {
      const reader = new FileReader();
      reader.onload = () => res(reader.result);
      reader.readAsDataURL(fileInput.files[0]);
    });
  }

  const res = await apiCall({
    action: "addSong",
    username: user.username,
    title, artist, album, lyrics, coverBase64
  });

  if (res.success) {
    navigateTo(`/song/${res.songId}`);
  } else {
    alert("Error publishing song: " + res.message);
  }
}

async function renderSongDetail(container, id) {
  container.innerHTML = "Loading song...";
  const res = await apiCall({ action: "getSong", id });

  if (res.success) {
    const s = res.song;
    container.innerHTML = `
      <div class="song-detail">
        <div>
          <img src="${s.coverUrl}" class="song-cover" alt="${s.title}">
          <h1 style="margin-bottom:0.2rem;">${s.title}</h1>
          <h3 style="color:var(--text-dim); margin-top:0;">${s.artist} ${s.album ? '• ' + s.album : ''}</h3>
          <p style="font-size:0.85rem; color:#666;">Added by @${s.createdBy}</p>
        </div>
        <div class="lyrics-box">${s.lyrics}</div>
      </div>
    `;
  } else {
    container.innerHTML = "<h2>Song not found</h2>";
  }
}
