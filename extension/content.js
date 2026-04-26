// Detect video elements on the page
let videoElements = new Set();

// Monitor for dynamically added video elements
const observer = new MutationObserver((mutations) => {
  mutations.forEach((mutation) => {
    mutation.addedNodes.forEach((node) => {
      if (node.nodeName === "VIDEO" || node.nodeName === "AUDIO") {
        detectVideoSource(node);
      }

      // Check for iframes with video content
      if (node.nodeName === "IFRAME") {
        try {
          const iframeDoc = node.contentDocument || node.contentWindow.document;
          const videos = iframeDoc.querySelectorAll("video");
          videos.forEach((video) => detectVideoSource(video));
        } catch (e) {
          // Cross-origin iframe, can't access
        }
      }

      // Check descendants for video elements
      if (node.querySelectorAll) {
        const videos = node.querySelectorAll("video, audio");
        videos.forEach((video) => detectVideoSource(video));
      }
    });

    // Monitor attribute changes on existing video elements
    if (
      mutation.type === "attributes" &&
      (mutation.attributeName === "src" ||
        mutation.attributeName === "currentSrc")
    ) {
      detectVideoSource(mutation.target);
    }
  });
});

// Start observing
observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ["src", "currentSrc"],
});

// Detect video sources from video elements
function detectVideoSource(video) {
  if (!video || videoElements.has(video)) return;

  videoElements.add(video);

  // Get all possible video sources
  const sources = [];

  // Direct src attribute
  if (video.src && video.src !== window.location.href) {
    sources.push({
      url: video.src,
      type: "direct",
      element: "video",
    });
  }

  // currentSrc (currently playing source)
  if (video.currentSrc) {
    sources.push({
      url: video.currentSrc,
      type: "current",
      element: "video",
    });
  }

  // Source elements
  const sourceElements = video.querySelectorAll("source");
  sourceElements.forEach((source) => {
    if (source.src) {
      sources.push({
        url: source.src,
        type: source.type || "source",
        element: "source",
      });
    }
  });

  // Send detected sources to background script
  sources.forEach((source) => {
    chrome.runtime
      .sendMessage({
        action: "videoDetected",
        video: {
          url: source.url,
          type: source.type,
          timestamp: Date.now(),
          pageUrl: window.location.href,
        },
      })
      .catch(() => {});
  });

  // Monitor for source changes
  video.addEventListener("loadedmetadata", () => {
    if (video.currentSrc) {
      chrome.runtime
        .sendMessage({
          action: "videoDetected",
          video: {
            url: video.currentSrc,
            type: "current",
            timestamp: Date.now(),
            pageUrl: window.location.href,
          },
        })
        .catch(() => {});
    }
  });
}

// Detect existing video elements
function detectExistingVideos() {
  const videos = document.querySelectorAll("video, audio");
  videos.forEach((video) => detectVideoSource(video));

  // Also check for video element modifications
  window.addEventListener("load", () => {
    setTimeout(detectExistingVideos, 2000); // Check again after page load
  });
}

// Intercept XMLHttpRequest and Fetch API
const originalXHROpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function (method, url) {
  this._url = url;
  return originalXHROpen.apply(this, arguments);
};

const originalXHRSend = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.send = function (body) {
  this.addEventListener("load", function () {
    const contentType = this.getResponseHeader("content-type");
    if (contentType && isVideoContentType(contentType)) {
      chrome.runtime
        .sendMessage({
          action: "videoDetected",
          video: {
            url: this._url,
            type: contentType,
            timestamp: Date.now(),
            pageUrl: window.location.href,
          },
        })
        .catch(() => {});
    }
  });
  return originalXHRSend.apply(this, arguments);
};

// Intercept Fetch API
const originalFetch = window.fetch;
window.fetch = function (input, init) {
  const url = typeof input === "string" ? input : input.url;

  return originalFetch.apply(this, arguments).then((response) => {
    const contentType = response.headers.get("content-type");
    if (contentType && isVideoContentType(contentType)) {
      chrome.runtime
        .sendMessage({
          action: "videoDetected",
          video: {
            url: url,
            type: contentType,
            timestamp: Date.now(),
            pageUrl: window.location.href,
          },
        })
        .catch(() => {});
    }
    return response;
  });
};

// Helper function to check video content type
function isVideoContentType(contentType) {
  const videoTypes = [
    "video/",
    "application/vnd.apple.mpegurl",
    "application/x-mpegURL",
    "application/dash+xml",
    "video/mp2t",
  ];

  const lowerType = contentType.toLowerCase();
  return videoTypes.some((type) => lowerType.includes(type));
}

// Inject HLS.js and dash.js detection
function detectStreamingPlayers() {
  // Check for common video players
  const players = [
    "videojs",
    "jwplayer",
    "flowplayer",
    "plyr",
    "mediaelement",
    "hls",
    "dashjs",
  ];

  players.forEach((player) => {
    if (window[player]) {
      console.log(`Detected video player: ${player}`);

      // Try to get source from player
      try {
        if (window.hls && window.hls.config) {
          // HLS.js player detected
          window.hls.on("hlsManifestLoaded", (event, data) => {
            if (data && data.levels) {
              data.levels.forEach((level) => {
                if (level.url) {
                  chrome.runtime
                    .sendMessage({
                      action: "videoDetected",
                      video: {
                        url: level.url,
                        type: "application/x-mpegURL",
                        timestamp: Date.now(),
                        pageUrl: window.location.href,
                      },
                    })
                    .catch(() => {});
                }
              });
            }
          });
        }
      } catch (e) {
        console.error("Error detecting player source:", e);
      }
    }
  });
}

// Initialize
detectExistingVideos();
detectStreamingPlayers();
