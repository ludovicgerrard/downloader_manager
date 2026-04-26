// ─────────────────────────────────────────────────────────────────────────────
// SwiftDL — Background Script (Manifest V2, persistent)
// Sniffs all video URLs at network level + intercepts browser downloads
// Routes everything to the local Rust manager on localhost:6543
// ─────────────────────────────────────────────────────────────────────────────

const MANAGER_URL = "http://localhost:6543";
const DEFAULT_CHUNKS = 8;

// ── State ─────────────────────────────────────────────────────────────────────
// key: url → { url, type, filename, timestamp, tabId, headers }
let detectedVideos = new Map();

// key: url → { headers: [{name,value}], tabId, initiator }
let requestHeadersCache = new Map();

// ─── 1. Capture outgoing request headers for every request ───────────────────
// This gives us cookies, auth tokens, referer etc. for any URL
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    requestHeadersCache.set(details.url, {
      headers: details.requestHeaders || [],
      tabId: details.tabId,
      initiator: details.initiator || "",
    });

    // Prune old entries (older than 5 min)
    const cutoff = Date.now() - 300_000;
    for (const [url, data] of requestHeadersCache) {
      if (data.timestamp && data.timestamp < cutoff) {
        requestHeadersCache.delete(url);
      }
    }
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders"],
);

// ─── 2. Sniff video URLs from network requests (catches iframes too) ──────────
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const url = details.url;
    if (details.tabId < 0) return {};

    if (isVideoUrl(url)) {
      storeVideo(
        url,
        getTypeFromUrl(url),
        null,
        details.tabId,
        details.requestHeaders || [],
      );
    }

    return {};
  },
  { urls: ["<all_urls>"] },
  ["requestBody"],
);

// ─── 3. Also sniff from response Content-Type (catches dynamic/signed URLs) ──
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;

    const contentType = getHeader(details.responseHeaders, "content-type");
    const contentDisposition = getHeader(
      details.responseHeaders,
      "content-disposition",
    );

    if (contentType && isVideoContentType(contentType)) {
      const filename = extractFilename(details.url, contentDisposition);
      // Merge response headers with any cached request headers
      const cached = requestHeadersCache.get(details.url) || {};
      const allHeaders = [
        ...(cached.headers || []),
        ...(details.responseHeaders || []),
      ];
      storeVideo(details.url, contentType, filename, details.tabId, allHeaders);
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"],
);

// ─── 4. Intercept browser downloads → redirect to SwiftDL manager ────────────
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    // Only intercept main-frame/sub-frame GET requests that look like files
    // (downloads triggered by the browser show up here as type "main_frame" with
    //  a Content-Disposition: attachment response — we handle that separately)
    return {};
  },
  { urls: ["<all_urls>"] },
  ["blocking"],
);

chrome.downloads.onCreated.addListener(async (downloadItem) => {
  const { enabled } = await storageGet({ enabled: true });
  if (!enabled) return;

  const url = downloadItem.url;
  if (url.startsWith("blob:") || url.startsWith("data:")) return;

  console.log("[SwiftDL] Intercepted download:", url);

  chrome.downloads.cancel(downloadItem.id, async () => {
    chrome.downloads.erase({ id: downloadItem.id });

    const alive = await pingManager();
    if (!alive) {
      notify(
        "SwiftDL — Manager offline",
        "Start the SwiftDL app first, then try again.",
      );
      return;
    }

    const job = await buildJob(url, null, downloadItem.tabId || -1);
    const result = await sendToManager(job);

    if (result.success) {
      notify("SwiftDL — Download started", extractFilename(url) || url);
    } else {
      notify("SwiftDL — Error", result.message);
    }
  });
});

// ─── 5. Store a detected video, notify popup ──────────────────────────────────
function storeVideo(url, type, filename, tabId, headers) {
  // Skip tiny segment files (.ts chunks in HLS — we want the .m3u8 playlist)
  // but keep individual .mp4 etc.
  if (url.includes(".ts?") || url.match(/\/seg\d+\.ts$/)) return;
  if (detectedVideos.has(url)) return; // already stored

  const name = filename || extractFilename(url) || `video_${Date.now()}`;

  detectedVideos.set(url, {
    url,
    type: type || "video/unknown",
    filename: name,
    timestamp: Date.now(),
    tabId,
    headers, // raw [{name, value}] array
  });

  console.log("[SwiftDL] Video detected:", url);

  // Notify popup if open
  chrome.runtime
    .sendMessage({
      action: "videoDetected",
      video: { url, type, filename: name, timestamp: Date.now() },
    })
    .catch(() => {});
}

// ─── 6. Build a SwiftDL job — attach all available headers ───────────────────
async function buildJob(url, filename, tabId) {
  const cached = requestHeadersCache.get(url) || {};
  const videoData = detectedVideos.get(url) || {};

  // Merge: cached request headers + video-specific headers
  let headers = [...(cached.headers || []), ...(videoData.headers || [])];

  // Add cookies for the URL's domain
  const cookieHeader = await getCookiesForUrl(url);
  if (cookieHeader) {
    headers = headers.filter((h) => h.name.toLowerCase() !== "cookie");
    headers.push({ name: "Cookie", value: cookieHeader });
  }

  // Add Referer from the tab that triggered the video
  const effectiveTabId =
    tabId >= 0 ? tabId : cached.tabId || videoData.tabId || -1;
  const pageUrl = await getTabUrl(effectiveTabId);
  if (pageUrl) {
    headers = headers.filter((h) => h.name.toLowerCase() !== "referer");
    headers.push({ name: "Referer", value: pageUrl });
    headers = headers.filter((h) => h.name.toLowerCase() !== "origin");
    headers.push({ name: "Origin", value: new URL(pageUrl).origin });
  }

  // Convert [{name,value}] → [[name,value]] and strip forbidden headers
  const headerPairs = headers
    .filter((h) => h.name && h.value)
    .filter((h) => !isForbiddenHeader(h.name))
    .map((h) => [h.name, h.value]);

  // Deduplicate header pairs (keep last value for each name)
  const headerMap = new Map();
  for (const [k, v] of headerPairs) {
    headerMap.set(k.toLowerCase(), [k, v]);
  }

  const { chunks } = await storageGet({ chunks: DEFAULT_CHUNKS });

  return {
    url,
    filename: filename || videoData.filename || extractFilename(url),
    headers: Array.from(headerMap.values()),
    chunks: parseInt(chunks),
  };
}

// ─── 7. Send job to Rust manager ──────────────────────────────────────────────
async function sendToManager(job) {
  try {
    const res = await fetch(`${MANAGER_URL}/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(job),
    });
    if (!res.ok) return { success: false, message: `HTTP ${res.status}` };
    return await res.json();
  } catch (err) {
    return { success: false, message: err.message };
  }
}

// ─── 8. Message handler — popup communicates here ────────────────────────────
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "videoDetected") {
    // From content.js — store video detected in the page DOM
    const v = request.video;
    if (v && v.url) {
      const cached = requestHeadersCache.get(v.url) || {};
      storeVideo(
        v.url,
        v.type,
        v.filename || null,
        sender.tab?.id || -1,
        cached.headers || [],
      );
    }
    return false;
  }

  if (request.action === "getVideos") {
    sendResponse({ videos: Array.from(detectedVideos.values()) });
    return false;
  }

  if (request.action === "clearVideos") {
    detectedVideos.clear();
    sendResponse({ success: true });
    return false;
  }

  if (request.action === "pingManager") {
    pingManager().then(sendResponse);
    return true; // async
  }

  if (request.action === "getStatus") {
    fetch(`${MANAGER_URL}/status`)
      .then((r) => r.json())
      .then(sendResponse)
      .catch(() => sendResponse([]));
    return true; // async
  }

  if (request.action === "downloadVideo") {
    // Popup clicked Download on a detected video
    const { url, filename, tabId } = request;

    pingManager().then((alive) => {
      if (!alive) {
        notify("SwiftDL — Manager offline", "Start the SwiftDL app first.");
        sendResponse({ success: false, message: "Manager offline" });
        return;
      }

      buildJob(url, filename, tabId || -1).then((job) => {
        sendToManager(job).then((result) => {
          if (result.success) {
            notify("SwiftDL — Download started", job.filename || url);
          } else {
            notify("SwiftDL — Error", result.message);
          }
          sendResponse(result);
        });
      });
    });

    return true; // async
  }

  if (request.action === "downloadDirect") {
    // Extension-intercepted regular download
    const { url, tabId } = request;
    buildJob(url, null, tabId || -1).then((job) => {
      sendToManager(job).then(sendResponse);
    });
    return true;
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isVideoUrl(url) {
  const u = url.toLowerCase().split("?")[0];
  return /\.(mp4|webm|mkv|mov|m4v|avi|flv|wmv|ogv|m3u8|mpd|m3u|f4v|f4m)$/.test(
    u,
  );
}

function isVideoContentType(ct) {
  const t = ct.toLowerCase();
  return (
    t.startsWith("video/") ||
    t.includes("application/vnd.apple.mpegurl") ||
    t.includes("application/x-mpegurl") ||
    t.includes("application/dash+xml") ||
    t.includes("video/mp2t")
  );
}

function getTypeFromUrl(url) {
  const u = url.toLowerCase();
  if (u.includes(".mp4")) return "video/mp4";
  if (u.includes(".webm")) return "video/webm";
  if (u.includes(".mkv")) return "video/x-matroska";
  if (u.includes(".m3u8")) return "application/x-mpegURL";
  if (u.includes(".mpd")) return "application/dash+xml";
  if (u.includes(".ts")) return "video/mp2t";
  return "video/unknown";
}

function getHeader(headers, name) {
  if (!headers) return null;
  const n = name.toLowerCase();
  const h = headers.find((h) => h.name.toLowerCase() === n);
  return h ? h.value : null;
}

function extractFilename(url, contentDisposition) {
  // Try Content-Disposition first
  if (contentDisposition) {
    const m = contentDisposition.match(
      /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/,
    );
    if (m && m[1]) return m[1].replace(/['"]/g, "").trim();
  }
  // From URL path
  try {
    const path = new URL(url).pathname;
    const seg = path.split("/").filter(Boolean).pop() || "";
    if (seg.includes(".")) return decodeURIComponent(seg);
  } catch {}
  return null;
}

async function getCookiesForUrl(url) {
  try {
    const { hostname } = new URL(url);
    const cookies = await new Promise((r) =>
      chrome.cookies.getAll({ domain: hostname }, r),
    );
    if (!cookies || cookies.length === 0) return null;
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch {
    return null;
  }
}

async function getTabUrl(tabId) {
  if (!tabId || tabId < 0) return null;
  try {
    const tab = await new Promise((r) => chrome.tabs.get(tabId, r));
    return tab?.url || null;
  } catch {
    return null;
  }
}

function isForbiddenHeader(name) {
  const forbidden = new Set([
    "accept-charset",
    "accept-encoding",
    "access-control-request-headers",
    "access-control-request-method",
    "connection",
    "content-length",
    "date",
    "expect",
    "host",
    "keep-alive",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "via",
  ]);
  return forbidden.has(name.toLowerCase());
}

function notify(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon48.png",
    title,
    message,
  });
}

async function pingManager() {
  try {
    const res = await fetch(`${MANAGER_URL}/ping`);
    return res.ok;
  } catch {
    return false;
  }
}

function storageGet(defaults) {
  return new Promise((resolve) => chrome.storage.local.get(defaults, resolve));
}

// ─── Clean up old video entries every 5 minutes ───────────────────────────────
setInterval(() => {
  const cutoff = Date.now() - 3_600_000; // 1 hour
  for (const [url, data] of detectedVideos) {
    if (data.timestamp < cutoff) detectedVideos.delete(url);
  }
}, 300_000);
