# SwiftDL — Browser Extension (Step 1)
 
Opera/Chrome extension that intercepts every download and routes it to the SwiftDL Rust manager.
 
---
 
## What it does
 
1. **Captures request headers** via `webRequest.onBeforeSendHeaders` — cookies, auth tokens, user-agent, referer — everything the server needs
2. **Intercepts the download** via `downloads.onCreated` — cancels the browser's built-in download instantly
3. **Sends a full job** to the Rust manager on `localhost:6543` including all headers
4. **Shows notifications** when a download starts or if the manager is offline
---
 
## Install in Opera
 
1. Open Opera and go to `opera://extensions`
2. Enable **Developer Mode** (toggle in top-right)
3. Click **Load unpacked**
4. Select this `extension/` folder
5. The SwiftDL icon appears in your toolbar
---
 
## How to use
 
1. **Start the Rust manager first** (`cargo run` or run the binary)
2. The popup will show **online** (green dot) when the manager is running
3. Click any download link in Opera — it's automatically intercepted and sent to the manager
4. Check your Downloads folder for the completed file
---
 
## Popup UI
 
| Control | Description |
|---|---|
| Green/red dot | Manager online/offline status |
| Intercept toggle | Enable or disable interception |
| Parallel Chunks | Number of chunks per download (1–32) |
| Manager Port | Port the Rust manager listens on (default: 6543) |
| Active Downloads | Live list of running/completed jobs |
 
---
 
## Headers sent with every download
 
The extension automatically collects and forwards:
- `Cookie` — all cookies for the download domain
- `Referer` — the page that triggered the download
- `User-Agent` — browser user agent
- `Authorization` — if present on the original request
- All other request headers (except forbidden ones like `Host`, `Content-Length`)
This is why downloads from sites that require login (Google Drive, Dropbox, etc.) work correctly — the session is preserved.
 
---
 
## Files
 
```
extension/
├── manifest.json    ← Extension config (Manifest V3)
├── background.js    ← Service worker: intercepts + sends jobs
├── popup.html       ← Extension popup UI
├── popup.js         ← Popup logic
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```
 