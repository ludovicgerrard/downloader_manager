use serde::{Deserialize, Serialize};

/// Job sent by the browser extension
#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct DownloadJob {
    /// The full URL to download
    pub url: String,

    /// Optional filename override (extension may send it from Content-Disposition)
    pub filename: Option<String>,

    /// Optional headers to forward (e.g. cookies, auth tokens)
    pub headers: Option<Vec<(String, String)>>,

    /// Number of parallel chunks (default: 8)
    pub chunks: Option<usize>,
}

/// Response sent back to the extension
#[derive(Debug, Serialize)]
pub struct DownloadResponse {
    pub success: bool,
    pub message: String,
    pub job_id: String,
}

/// Internal representation of one chunk
#[derive(Debug, Clone)]
pub struct Chunk {
    pub index: usize,
    pub start: u64,
    pub end: u64,
    pub temp_path: std::path::PathBuf,
}

/// Status of a running download job
#[derive(Debug, Clone, Serialize)]
pub struct JobStatus {
    pub job_id: String,
    pub url: String,
    pub filename: String,
    pub total_bytes: u64,
    pub downloaded_bytes: u64,
    pub chunks_total: usize,
    pub chunks_done: usize,
    pub status: String, // "running" | "merging" | "done" | "error"
    pub error: Option<String>,
}
