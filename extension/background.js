// ─────────────────────────────────────────────────────────────────────────────
// SwiftDL — Background Service Worker
// Intercepts downloads, collects headers, sends job to local Rust downloader
// ─────────────────────────────────────────────────────────────────────────────

const MANAGER_URL = "http://localhost:6543";
const DEFAULT_CHUNKS = 8;

// Store request headers captured by webRequest listener
// key: url → value: { headers: [], tabId, pageUrl }
const requestHeadersCache = new Map();

// ─── 1. Capture outgoing request headers before they leave the browser ────────
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    // Store headers keyed by URL so we can retrieve them when the download fires
    requestHeadersCache.set(details.url, {
      headers: details.requestHeaders || [],
      tabId: details.tabId,
      initiator: details.initiator || "",
    });

    // Keep cache lean — remove entries older than 2 minutes
    pruneCache();
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders", "extraHeaders"]
);

// ─── 2. Intercept every new download ─────────────────────────────────────────
chrome.downloads.onCreated.addListener(async (downloadItem) => {
  // Check if the extension is enabled
  const { enabled } = await chrome.storage.local.get({ enabled: true });
  if (!enabled) return;

  const url = downloadItem.url;

  // Skip blob: and data: URLs — these can't be re-downloaded by the manager
  if (url.startsWith("blob:") || url.startsWith("data:")) return;

  // Skip already-cancelled items
  if (downloadItem.state === "interrupted") return;

  console.log("[SwiftDL] Intercepted download:", url);

  // Cancel the browser's own download immediately
  chrome.downloads.cancel(downloadItem.id, async () => {
    // Remove the cancelled item from the downloads shelf
    chrome.downloads.erase({ id: downloadItem.id });

    // Check if the manager is alive before sending
    const alive = await pingManager();
    if (!alive) {
      showNotification(
        "SwiftDL — Manager offline",
        "Start the SwiftDL manager app first, then try again."
      );
      return;
    }

    // Build the job
    const job = await buildJob(downloadItem);

    // Send to the Rust downloader
    const result = await sendToManager(job);

    if (result.success) {
      showNotification(
        "SwiftDL — Download started",
        `${job.filename || extractFilename(url)} is being downloaded.`
      );
    } else {
      showNotification(
        "SwiftDL — Error",
        `Failed to start download: ${result.message}`
      );
    }
  });
});

// ─── 3. Build a complete job from the download item ──────────────────────────
async function buildJob(downloadItem) {
  const url = downloadItem.url;

  // Get stored request headers for this URL
  const cached = requestHeadersCache.get(url) || {};
  let headers = cached.headers || [];

  // Get cookies for the URL's domain and add them to headers
  const cookieHeader = await getCookiesForUrl(url);
  if (cookieHeader) {
    // Replace or add Cookie header
    headers = headers.filter(
      (h) => h.name.toLowerCase() !== "cookie"
    );
    headers.push({ name: "Cookie", value: cookieHeader });
  }

  // Always include a Referer if we know the page that triggered the download
  const tabInfo = cached.tabId ? await getTabUrl(cached.tabId) : null;
  if (tabInfo) {
    headers = headers.filter(
      (h) => h.name.toLowerCase() !== "referer"
    );
    headers.push({ name: "Referer", value: tabInfo });
  }

  // Convert from [{name, value}] to [[name, value]] format for our Rust server
  const headerPairs = headers
    .filter((h) => h.name && h.value)
    .filter((h) => !isForbiddenHeader(h.name))
    .map((h) => [h.name, h.value]);

  // Get chunk count from settings
  const { chunks } = await chrome.storage.local.get({ chunks: DEFAULT_CHUNKS });

  return {
    url,
    filename: downloadItem.filename
      ? extractFilename(downloadItem.filename)
      : extractFilename(url),
    headers: headerPairs,
    chunks: parseInt(chunks),
  };
}

// ─── 4. Send job to the Rust manager ─────────────────────────────────────────
async function sendToManager(job) {
  try {
    const response = await fetch(`${MANAGER_URL}/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(job),
    });

    if (!response.ok) {
      return { success: false, message: `HTTP ${response.status}` };
    }

    return await response.json();
  } catch (err) {
    console.error("[SwiftDL] Failed to reach manager:", err);
    return { success: false, message: err.message };
  }
}

// ─── 5. Ping the manager to check if it's running ────────────────────────────
async function pingManager() {
  try {
    const res = await fetch(`${MANAGER_URL}/ping`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ─── 6. Get all cookies for a URL and format as Cookie header string ──────────
async function getCookiesForUrl(url) {
  try {
    const urlObj = new URL(url);
    const cookies = await chrome.cookies.getAll({ domain: urlObj.hostname });
    if (!cookies || cookies.length === 0) return null;
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch {
    return null;
  }
}

// ─── 7. Get the URL of the tab that triggered the download ───────────────────
async function getTabUrl(tabId) {
  if (!tabId || tabId < 0) return null;
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab?.url || null;
  } catch {
    return null;
  }
}

// ─── 8. Show a browser notification ──────────────────────────────────────────
function showNotification(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon48.png",
    title,
    message,
  });
}

// ─── 9. Extract filename from path or URL ────────────────────────────────────
function extractFilename(pathOrUrl) {
  try {
    // Try as a full URL first
    const url = new URL(pathOrUrl);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length > 0) return decodeURIComponent(parts[parts.length - 1]);
  } catch {
    // Fall back: treat as a file path
    const parts = pathOrUrl.replace(/\\/g, "/").split("/");
    return parts[parts.length - 1] || "download";
  }
  return "download";
}

// ─── 10. Headers that browsers block from being read/set ─────────────────────
function isForbiddenHeader(name) {
  const forbidden = [
    "accept-charset",
    "accept-encoding",
    "access-control-request-headers",
    "access-control-request-method",
    "connection",
    "content-length",
    "date",
    "dnt",
    "expect",
    "feature-policy",
    "host",
    "keep-alive",
    "origin",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "via",
  ];
  return forbidden.includes(name.toLowerCase());
}

// ─── 11. Prune old cache entries ──────────────────────────────────────────────
const cacheTimestamps = new Map();

function pruneCache() {
  const now = Date.now();
  for (const [url, ts] of cacheTimestamps.entries()) {
    if (now - ts > 120_000) {
      requestHeadersCache.delete(url);
      cacheTimestamps.delete(url);
    }
  }
}

// Listen for messages from the popup
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "PING_MANAGER") {
    pingManager().then(sendResponse);
    return true; // keep channel open for async response
  }

  if (message.type === "GET_STATUS") {
    fetch(`${MANAGER_URL}/status`)
      .then((r) => r.json())
      .then(sendResponse)
      .catch(() => sendResponse([]));
    return true;
  }
});