use anyhow::{anyhow, Context, Result};
use bytes::Bytes;
use futures::StreamExt;
use indicatif::{MultiProgress, ProgressBar, ProgressStyle};
use reqwest::{header, Client};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::fs::File;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;
use tracing::{info, warn};

use crate::merger;
use crate::models::{Chunk, DownloadJob};
use crate::server::AppState;

/// Default number of parallel chunks
const DEFAULT_CHUNKS: usize = 8;

pub async fn run(job: DownloadJob, job_id: String, state: Arc<AppState>) -> Result<()> {
    let client = build_client(&job)?;
    let num_chunks = job.chunks.unwrap_or(DEFAULT_CHUNKS);

    // ── 1. Probe the URL ──────────────────────────────────────────────────────
    info!("🔍 Probing URL for file info...");
    let (total_size, supports_ranges, final_filename) =
        probe_url(&client, &job.url, job.filename.as_deref()).await?;

    info!("   Filename : {}", final_filename);
    info!("   Size     : {}", human_size(total_size));
    info!(
        "   Ranges   : {}",
        if supports_ranges {
            "yes ✅"
        } else {
            "no ⚠️ (single stream)"
        }
    );

    // Update job status with real info
    {
        let mut jobs = state.jobs.lock().await;
        if let Some(j) = jobs.iter_mut().find(|j| j.job_id == job_id) {
            j.filename = final_filename.clone();
            j.total_bytes = total_size;
            j.chunks_total = if supports_ranges { num_chunks } else { 1 };
        }
    }

    // ── 2. Prepare temp directory ─────────────────────────────────────────────
    let temp_dir = std::env::temp_dir().join(format!("dl_{}", &job_id[..8]));
    tokio::fs::create_dir_all(&temp_dir).await?;

    // ── 3. Build chunk list ───────────────────────────────────────────────────
    let chunks = if supports_ranges && total_size > 0 {
        build_chunks(total_size, num_chunks, &temp_dir)
    } else {
        // Server doesn't support ranges → single chunk covering everything
        vec![Chunk {
            index: 0,
            start: 0,
            end: total_size.saturating_sub(1),
            temp_path: temp_dir.join("chunk_0.tmp"),
        }]
    };

    info!("🔀 Downloading {} chunk(s) in parallel...\n", chunks.len());

    // ── 4. Progress bars ──────────────────────────────────────────────────────
    let multi = Arc::new(MultiProgress::new());
    let overall_pb = multi.add(ProgressBar::new(total_size));
    overall_pb.set_style(
        ProgressStyle::default_bar()
            .template(
                "  Overall  [{bar:45.cyan/blue}] {bytes}/{total_bytes} ({bytes_per_sec}, {eta})",
            )
            .unwrap()
            .progress_chars("█▓░"),
    );

    let downloaded_shared = Arc::new(Mutex::new(0u64));
    let chunks_done_shared = Arc::new(Mutex::new(0usize));

    // ── 5. Spawn one task per chunk ───────────────────────────────────────────
    let mut handles = vec![];

    for chunk in chunks.clone() {
        let client = client.clone();
        let url = job.url.clone();
        let multi = multi.clone();
        let overall_pb = overall_pb.clone();
        let downloaded_shared = downloaded_shared.clone();
        let chunks_done_shared = chunks_done_shared.clone();
        let state = state.clone();
        let job_id = job_id.clone();
        let headers_extra = job.headers.clone().unwrap_or_default();

        let chunk_size = chunk.end - chunk.start + 1;

        let chunk_pb = multi.add(ProgressBar::new(chunk_size));
        chunk_pb.set_style(
            ProgressStyle::default_bar()
                .template(&format!(
                    "  Chunk {:>2} [{{bar:45.green/white}}] {{bytes}}/{{total_bytes}}",
                    chunk.index
                ))
                .unwrap()
                .progress_chars("█▓░"),
        );

        let handle = tokio::spawn(async move {
            download_chunk(
                &client,
                &url,
                &chunk,
                &headers_extra,
                chunk_pb,
                overall_pb,
                downloaded_shared,
                chunks_done_shared,
                state,
                job_id,
            )
            .await
        });

        handles.push(handle);
    }

    // Wait for all chunks
    for handle in handles {
        handle.await??;
    }

    overall_pb.finish_with_message("Download complete!");
    println!();

    // ── 6. Merge chunks into final file ───────────────────────────────────────
    {
        let mut jobs = state.jobs.lock().await;
        if let Some(j) = jobs.iter_mut().find(|j| j.job_id == job_id) {
            j.status = "merging".into();
        }
    }

    let output_path = resolve_output_path(&final_filename)?;
    info!("🔧 Merging chunks → {:?}", output_path);

    merger::merge_chunks(&chunks, &output_path).await?;

    // Cleanup temp dir
    let _ = tokio::fs::remove_dir_all(&temp_dir).await;

    info!("✅ Saved to {:?}", output_path);

    Ok(())
}

/// Download a single byte-range chunk and write it to a temp file
async fn download_chunk(
    client: &Client,
    url: &str,
    chunk: &Chunk,
    extra_headers: &[(String, String)],
    chunk_pb: ProgressBar,
    overall_pb: ProgressBar,
    downloaded_shared: Arc<Mutex<u64>>,
    chunks_done_shared: Arc<Mutex<usize>>,
    state: Arc<AppState>,
    job_id: String,
) -> Result<()> {
    let mut req = client.get(url);

    // Add Range header if this isn't a full-file single chunk
    if chunk.end > 0 {
        req = req.header(
            header::RANGE,
            format!("bytes={}-{}", chunk.start, chunk.end),
        );
    }

    // Forward any extra headers from the browser (cookies, auth, etc.)
    for (k, v) in extra_headers {
        req = req.header(k.as_str(), v.as_str());
    }

    let response = req.send().await?.error_for_status()?;
    let mut stream = response.bytes_stream();
    let mut file = File::create(&chunk.temp_path).await?;

    while let Some(item) = stream.next().await {
        let bytes: Bytes = item?;
        let len = bytes.len() as u64;

        file.write_all(&bytes).await?;

        chunk_pb.inc(len);
        overall_pb.inc(len);

        // Update shared state
        {
            let mut dl = downloaded_shared.lock().await;
            *dl += len;
            let mut jobs = state.jobs.lock().await;
            if let Some(j) = jobs.iter_mut().find(|j| j.job_id == job_id) {
                j.downloaded_bytes = *dl;
            }
        }
    }

    chunk_pb.finish_with_message("done");

    {
        let mut done = chunks_done_shared.lock().await;
        *done += 1;
        let mut jobs = state.jobs.lock().await;
        if let Some(j) = jobs.iter_mut().find(|j| j.job_id == job_id) {
            j.chunks_done = *done;
        }
    }

    Ok(())
}

/// Probe the URL to get file size, filename, and range support.
/// Tries HEAD first; if the server rejects it (405 / error), falls back to
/// a GET with "Range: bytes=0-0" which is universally supported.
async fn probe_url(
    client: &Client,
    url: &str,
    hint_filename: Option<&str>,
) -> Result<(u64, bool, String)> {
    // ── Try HEAD first ────────────────────────────────────────────────────────
    if let Ok(resp) = client.head(url).send().await {
        if resp.status().is_success() {
            let headers = resp.headers().clone();
            let total_size = parse_content_length(&headers);
            let supports_ranges = parse_accept_ranges(&headers);
            let filename = resolve_filename(hint_filename, &headers, url);
            info!("   Probe method : HEAD");
            return Ok((total_size, supports_ranges, filename));
        }
    }

    // ── Fall back: GET with Range: bytes=0-0 ─────────────────────────────────
    // This fetches only the first byte but gives us all the headers we need.
    warn!("   HEAD failed or rejected — falling back to GET probe");
    let resp = client
        .get(url)
        .header(header::RANGE, "bytes=0-0")
        .send()
        .await
        .context("Failed to probe URL (both HEAD and GET failed)")?;

    // 206 Partial Content → range supported; 200 → no range support
    let supports_ranges = resp.status() == reqwest::StatusCode::PARTIAL_CONTENT;

    let headers = resp.headers().clone();

    // With a range request the server replies with Content-Range: bytes 0-0/TOTAL
    // e.g.  Content-Range: bytes 0-0/104857600
    let total_size = headers
        .get(header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split('/').last())
        .and_then(|s| s.parse::<u64>().ok())
        // Fallback: Content-Length of full response (server returned 200)
        .unwrap_or_else(|| parse_content_length(&headers));

    let filename = resolve_filename(hint_filename, &headers, url);

    info!("   Probe method : GET range");
    Ok((total_size, supports_ranges, filename))
}

fn parse_content_length(headers: &reqwest::header::HeaderMap) -> u64 {
    headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0)
}

fn parse_accept_ranges(headers: &reqwest::header::HeaderMap) -> bool {
    headers
        .get(header::ACCEPT_RANGES)
        .map(|v| v == "bytes")
        .unwrap_or(false)
}

fn resolve_filename(hint: Option<&str>, headers: &reqwest::header::HeaderMap, url: &str) -> String {
    hint.map(|s| s.to_string())
        .or_else(|| extract_filename_from_header(headers))
        .or_else(|| extract_filename_from_url(url))
        .unwrap_or_else(|| "download".to_string())
}

/// Extract filename from Content-Disposition header
fn extract_filename_from_header(headers: &reqwest::header::HeaderMap) -> Option<String> {
    let cd = headers.get(header::CONTENT_DISPOSITION)?.to_str().ok()?;
    // e.g. attachment; filename="video.mp4"
    cd.split(';')
        .find(|s| s.trim().starts_with("filename"))
        .and_then(|s| s.split('=').nth(1))
        .map(|s| s.trim().trim_matches('"').to_string())
}

/// Extract filename from the URL path
fn extract_filename_from_url(url: &str) -> Option<String> {
    url.split('?')
        .next()? // strip query string
        .split('/')
        .last()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

/// Split the total file size into N equal byte-range chunks
fn build_chunks(total_size: u64, num_chunks: usize, temp_dir: &PathBuf) -> Vec<Chunk> {
    let chunk_size = total_size / num_chunks as u64;
    let mut chunks = vec![];

    for i in 0..num_chunks {
        let start = i as u64 * chunk_size;
        let end = if i == num_chunks - 1 {
            total_size - 1 // last chunk gets the remainder
        } else {
            start + chunk_size - 1
        };

        chunks.push(Chunk {
            index: i,
            start,
            end,
            temp_path: temp_dir.join(format!("chunk_{}.tmp", i)),
        });
    }

    chunks
}

/// Resolve final output path in the OS Downloads folder
fn resolve_output_path(filename: &str) -> Result<PathBuf> {
    let downloads =
        dirs::download_dir().ok_or_else(|| anyhow!("Could not find Downloads folder"))?;

    let mut path = downloads.join(filename);

    // Avoid overwriting existing files → append (1), (2), etc.
    if path.exists() {
        let stem = path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let ext = path
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default();

        let mut counter = 1u32;
        loop {
            path = downloads.join(format!("{} ({}){}", stem, counter, ext));
            if !path.exists() {
                break;
            }
            counter += 1;
        }

        warn!("File already exists, saving as {:?}", path);
    }

    Ok(path)
}

/// Build the HTTP client with sensible defaults
fn build_client(job: &DownloadJob) -> Result<Client> {
    let mut builder = Client::builder()
        .user_agent("Mozilla/5.0 (compatible; DownloadManager/1.0)")
        .redirect(reqwest::redirect::Policy::limited(10))
        .connection_verbose(false);

    // Forward cookies/auth if provided
    if let Some(headers) = &job.headers {
        let mut header_map = header::HeaderMap::new();
        for (k, v) in headers {
            if let (Ok(name), Ok(value)) = (
                header::HeaderName::from_bytes(k.as_bytes()),
                header::HeaderValue::from_str(v),
            ) {
                header_map.insert(name, value);
            }
        }
        builder = builder.default_headers(header_map);
    }

    Ok(builder.build()?)
}

/// Human-readable file size
pub fn human_size(bytes: u64) -> String {
    const UNITS: &[&str] = &["B", "KB", "MB", "GB", "TB"];
    let mut size = bytes as f64;
    let mut unit = 0;
    while size >= 1024.0 && unit < UNITS.len() - 1 {
        size /= 1024.0;
        unit += 1;
    }
    format!("{:.2} {}", size, UNITS[unit])
}
