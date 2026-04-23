// ─────────────────────────────────────────────────────────────────────────────
// SwiftDL — Popup UI Logic
// ─────────────────────────────────────────────────────────────────────────────

const statusDot   = document.getElementById("statusDot");
const statusText  = document.getElementById("statusText");
const enableToggle = document.getElementById("enableToggle");
const toggleSub   = document.getElementById("toggleSub");
const chunksInput  = document.getElementById("chunksInput");
const portInput    = document.getElementById("portInput");
const downloadsList = document.getElementById("downloadsList");
const refreshBtn  = document.getElementById("refreshBtn");
const footerPort  = document.getElementById("footerPort");

// ── Load saved settings ───────────────────────────────────────────────────────
chrome.storage.local.get(
  { enabled: true, chunks: 8, port: 6543 },
  (data) => {
    enableToggle.checked = data.enabled;
    chunksInput.value    = data.chunks;
    portInput.value      = data.port;
    footerPort.textContent = data.port;
    updateToggleSub(data.enabled);
  }
);

// ── Save settings on change ───────────────────────────────────────────────────
enableToggle.addEventListener("change", () => {
  const enabled = enableToggle.checked;
  chrome.storage.local.set({ enabled });
  updateToggleSub(enabled);
});

chunksInput.addEventListener("change", () => {
  const val = Math.max(1, Math.min(32, parseInt(chunksInput.value) || 8));
  chunksInput.value = val;
  chrome.storage.local.set({ chunks: val });
});

portInput.addEventListener("change", () => {
  const val = Math.max(1024, Math.min(65535, parseInt(portInput.value) || 6543));
  portInput.value = val;
  footerPort.textContent = val;
  chrome.storage.local.set({ port: val });
});

function updateToggleSub(enabled) {
  toggleSub.textContent = enabled
    ? "All downloads → SwiftDL manager"
    : "Browser handles downloads normally";
}

// ── Check if manager is running ───────────────────────────────────────────────
async function checkManagerStatus() {
  statusDot.className = "dot checking";
  statusText.textContent = "checking";

  chrome.runtime.sendMessage({ type: "PING_MANAGER" }, (alive) => {
    if (alive) {
      statusDot.className = "dot online";
      statusText.textContent = "online";
    } else {
      statusDot.className = "dot";
      statusText.textContent = "offline";
    }
  });
}

// ── Load active downloads from manager ───────────────────────────────────────
async function loadDownloads() {
  refreshBtn.style.transform = "rotate(360deg)";
  refreshBtn.style.transition = "transform 0.4s";
  setTimeout(() => {
    refreshBtn.style.transform = "";
    refreshBtn.style.transition = "";
  }, 400);

  chrome.runtime.sendMessage({ type: "GET_STATUS" }, (jobs) => {
    renderDownloads(jobs || []);
  });
}

function renderDownloads(jobs) {
  if (!jobs || jobs.length === 0) {
    downloadsList.innerHTML = `
      <div class="empty">
        <div class="empty-icon">📭</div>
        No active downloads
      </div>`;
    return;
  }

  // Show most recent first
  const sorted = [...jobs].reverse();

  downloadsList.innerHTML = sorted.map((job) => {
    const pct = job.total_bytes > 0
      ? Math.round((job.downloaded_bytes / job.total_bytes) * 100)
      : 0;

    const sizeText = job.total_bytes > 0
      ? `${humanSize(job.downloaded_bytes)} / ${humanSize(job.total_bytes)}`
      : "–";

    return `
      <div class="dl-item">
        <div class="dl-name" title="${escHtml(job.filename)}">${escHtml(job.filename)}</div>
        <div class="dl-meta">
          <span class="dl-status ${job.status}">${job.status}</span>
          <span class="dl-progress">${sizeText}</span>
        </div>
        ${job.status === "running" || job.status === "merging" ? `
          <div class="progress-bar-wrap">
            <div class="progress-bar-fill" style="width:${pct}%"></div>
          </div>` : ""}
      </div>`;
  }).join("");
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function humanSize(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Init ──────────────────────────────────────────────────────────────────────
checkManagerStatus();
loadDownloads();

refreshBtn.addEventListener("click", () => {
  checkManagerStatus();
  loadDownloads();
});

// Auto-refresh every 3 seconds while popup is open
setInterval(loadDownloads, 3000);