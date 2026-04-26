// ─── SwiftDL Popup v2 ─────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const statusDot = $("statusDot");
const statusText = $("statusText");
const enableToggle = $("enableToggle");
const toggleSub = $("toggleSub");
const chunksInput = $("chunksInput");
const portInput = $("portInput");
const downloadsList = $("downloadsList");
const videosList = $("videosList");
const videoBadge = $("videoBadge");
const filterInput = $("filterInput");
const typeFilter = $("typeFilter");
const footerPort = $("footerPort");

let allVideos = [];
let currentTabId = -1;

// ── Get current tab ───────────────────────────────────────────────────────────
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  if (tabs[0]) currentTabId = tabs[0].id;
});

// ── Load settings ─────────────────────────────────────────────────────────────
chrome.storage.local.get({ enabled: true, chunks: 8, port: 6543 }, (data) => {
  enableToggle.checked = data.enabled;
  chunksInput.value = data.chunks;
  portInput.value = data.port;
  footerPort.textContent = data.port;
  updateToggleSub(data.enabled);
});

enableToggle.addEventListener("change", () => {
  chrome.storage.local.set({ enabled: enableToggle.checked });
  updateToggleSub(enableToggle.checked);
});

chunksInput.addEventListener("change", () => {
  const v = Math.max(1, Math.min(32, parseInt(chunksInput.value) || 8));
  chunksInput.value = v;
  chrome.storage.local.set({ chunks: v });
});

portInput.addEventListener("change", () => {
  const v = Math.max(1024, Math.min(65535, parseInt(portInput.value) || 6543));
  portInput.value = v;
  footerPort.textContent = v;
  chrome.storage.local.set({ port: v });
});

function updateToggleSub(enabled) {
  toggleSub.textContent = enabled
    ? "All downloads → SwiftDL manager"
    : "Browser handles downloads normally";
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document
      .querySelectorAll(".tab-btn")
      .forEach((b) => b.classList.remove("active"));
    document
      .querySelectorAll(".tab-content")
      .forEach((c) => c.classList.remove("active"));
    btn.classList.add("active");
    $(`tab-${btn.dataset.tab}`).classList.add("active");
  });
});

// ── Manager status ────────────────────────────────────────────────────────────
function checkStatus() {
  statusDot.className = "dot checking";
  statusText.textContent = "checking";
  chrome.runtime.sendMessage({ action: "pingManager" }, (alive) => {
    statusDot.className = alive ? "dot online" : "dot";
    statusText.textContent = alive ? "online" : "offline";
  });
}

// ── Downloads tab ─────────────────────────────────────────────────────────────
function loadDownloads() {
  animateBtn($("refreshDlBtn"));
  chrome.runtime.sendMessage({ action: "getStatus" }, (jobs) => {
    renderDownloads(jobs || []);
  });
}

function renderDownloads(jobs) {
  if (!jobs.length) {
    downloadsList.innerHTML = `<div class="empty"><div class="empty-icon">📭</div>No active downloads</div>`;
    return;
  }
  downloadsList.innerHTML = [...jobs]
    .reverse()
    .map((job) => {
      const pct =
        job.total_bytes > 0
          ? Math.round((job.downloaded_bytes / job.total_bytes) * 100)
          : 0;
      const size =
        job.total_bytes > 0
          ? `${humanSize(job.downloaded_bytes)} / ${humanSize(job.total_bytes)}`
          : "–";
      return `
      <div class="dl-item">
        <div class="dl-name" title="${esc(job.filename)}">${esc(job.filename)}</div>
        <div class="dl-meta">
          <span class="dl-status ${job.status}">${job.status}</span>
          <span class="dl-progress">${size}</span>
        </div>
        ${
          job.status === "running" || job.status === "merging"
            ? `
          <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>`
            : ""
        }
      </div>`;
    })
    .join("");
}

$("refreshDlBtn").addEventListener("click", loadDownloads);

// ── Videos tab ────────────────────────────────────────────────────────────────
function loadVideos() {
  animateBtn($("refreshVideosBtn"));
  chrome.runtime.sendMessage({ action: "getVideos" }, (resp) => {
    allVideos = (resp && resp.videos) || [];
    videoBadge.textContent = allVideos.length;
    applyFilters();
  });
}

function applyFilters() {
  const text = filterInput.value.toLowerCase();
  const type = typeFilter.value;

  let filtered = allVideos;
  if (text) {
    filtered = filtered.filter(
      (v) =>
        v.url.toLowerCase().includes(text) ||
        (v.filename && v.filename.toLowerCase().includes(text)),
    );
  }
  if (type !== "all") {
    filtered = filtered.filter(
      (v) => v.type && v.type.toLowerCase().includes(type),
    );
  }

  renderVideos(filtered);
}

filterInput.addEventListener("input", applyFilters);
typeFilter.addEventListener("change", applyFilters);

function renderVideos(videos) {
  if (!videos.length) {
    videosList.innerHTML = `<div class="empty"><div class="empty-icon">🎬</div>Play a video to detect it</div>`;
    return;
  }

  videosList.innerHTML = videos
    .map((v, i) => {
      const name = v.filename || extractFilename(v.url) || "video";
      const type = v.type ? v.type.split("/").pop().split("+")[0] : "?";
      const ago = timeAgo(v.timestamp);
      return `
      <div class="video-item">
        <div class="video-name" title="${esc(v.url)}">${esc(name)}</div>
        <div class="video-url">${esc(v.url)}</div>
        <div class="video-meta">
          <span class="video-type">${esc(type)}</span>
          <span class="video-time">${ago}</span>
          <button class="btn-dl" data-idx="${i}">↓ Download</button>
        </div>
      </div>`;
    })
    .join("");

  videosList.querySelectorAll(".btn-dl").forEach((btn) => {
    btn.addEventListener("click", () => {
      const video = videos[parseInt(btn.dataset.idx)];
      btn.textContent = "Sending…";
      btn.disabled = true;

      chrome.runtime.sendMessage(
        {
          action: "downloadVideo",
          url: video.url,
          filename: video.filename || extractFilename(video.url),
          tabId: video.tabId || currentTabId,
        },
        (result) => {
          btn.textContent = result && result.success ? "✓ Sent" : "✗ Error";
          setTimeout(() => {
            btn.textContent = "↓ Download";
            btn.disabled = false;
          }, 2500);
        },
      );
    });
  });
}

$("clearVideosBtn").addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "clearVideos" }, () => {
    allVideos = [];
    videoBadge.textContent = "0";
    renderVideos([]);
  });
});

$("refreshVideosBtn").addEventListener("click", loadVideos);

// ── Listen for live video detection while popup is open ───────────────────────
chrome.runtime.onMessage.addListener((request) => {
  if (request.action === "videoDetected") {
    loadVideos();
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function humanSize(b) {
  if (!b) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0,
    v = b;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${u[i]}`;
}

function esc(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function extractFilename(url) {
  try {
    const p = new URL(url).pathname.split("/").filter(Boolean).pop() || "";
    return p.includes(".") ? decodeURIComponent(p) : null;
  } catch {
    return null;
  }
}

function timeAgo(ts) {
  const d = Date.now() - ts;
  if (d < 60_000) return "Just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

function animateBtn(btn) {
  if (!btn) return;
  btn.style.transform = "rotate(360deg)";
  btn.style.transition = "transform 0.4s";
  setTimeout(() => {
    btn.style.transform = "";
    btn.style.transition = "";
  }, 400);
}

// ── Init ──────────────────────────────────────────────────────────────────────
checkStatus();
loadDownloads();
loadVideos();
setInterval(loadDownloads, 3000);
setInterval(loadVideos, 5000);
