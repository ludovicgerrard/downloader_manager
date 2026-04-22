# Download Manager — Step 2: Rust Downloader

A fast, multi-chunk parallel download manager that runs as a local background service.
It receives download jobs from the browser extension (Step 1) and saves files to your Downloads folder.

---

## How it works

```
Extension sends job
       ↓
POST http://localhost:6543/download
       ↓
Probe URL (HEAD request) → get file size, check Range support
       ↓
Split into N chunks (default: 8)
       ↓
Download all chunks in parallel (async Tokio tasks)
       ↓
Merge all chunks in order → final file
       ↓
Save to ~/Downloads/
```

---

## Requirements

- Rust (install from https://rustup.rs — one-time only)

---

## Build

```bash
# Clone / navigate to the project folder
cd downloader

# Build in release mode (optimized binary)
cargo build --release

# The binary will be at:
# Windows : target/release/downloader.exe
# macOS   : target/release/downloader
# Linux   : target/release/downloader
```

---

## Run

```bash
# Run the compiled binary
./target/release/downloader

# Or run directly with cargo (for development)
cargo run
```

You should see:
```
🚀 Download Manager starting...
📂 Files will be saved to your default Downloads folder
🌐 Listening on http://localhost:6543
   Waiting for downloads from the browser extension...
```

---

## API Endpoints

| Method | Path        | Description                          |
|--------|-------------|--------------------------------------|
| GET    | /ping       | Health check — returns "pong"        |
| POST   | /download   | Submit a new download job            |
| GET    | /status     | List all jobs and their status       |

### POST /download — Request body

```json
{
  "url": "https://example.com/file.zip",
  "filename": "file.zip",
  "chunks": 8,
  "headers": [
    ["Cookie", "session=abc123"],
    ["Authorization", "Bearer token"]
  ]
}
```

| Field      | Type            | Required | Description                              |
|------------|-----------------|----------|------------------------------------------|
| `url`      | string          | ✅       | The full URL to download                 |
| `filename` | string          | ❌       | Override filename (auto-detected if null)|
| `chunks`   | number          | ❌       | Number of parallel chunks (default: 8)   |
| `headers`  | [[key, value]]  | ❌       | Extra headers (cookies, auth tokens)     |

### Test manually with curl

```bash
curl -X POST http://localhost:6543/download \
  -H "Content-Type: application/json" \
  -d '{"url": "https://speed.hetzner.de/100MB.bin", "chunks": 8}'
```

---

## Chunk Strategy

| File size     | Recommended chunks |
|---------------|--------------------|
| < 10 MB       | 4                  |
| 10 – 100 MB   | 8 (default)        |
| 100 MB – 1 GB | 16                 |
| > 1 GB        | 16–32              |

You can set chunks in the job request, or the extension will use the default.

---

## Notes

- If the server does **not** support `Accept-Ranges: bytes`, the file is downloaded as a single stream (no chunking). This is normal for some servers.
- If a file with the same name already exists in Downloads, it is saved as `file (1).zip`, `file (2).zip`, etc.
- Temp files are stored in your OS temp directory and cleaned up after merge.

---

## Project Structure

```
downloader/
├── Cargo.toml          ← dependencies
└── src/
    ├── main.rs         ← entry point
    ├── models.rs       ← shared data structures
    ├── server.rs       ← HTTP server (receives jobs)
    ├── downloader.rs   ← chunk download logic
    └── merger.rs       ← merge chunks into final file
```
