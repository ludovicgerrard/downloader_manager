use axum::{
    extract::State,
    http::StatusCode,
    response::Json,
    routing::{get, post},
    Router,
};
use std::sync::Arc;
use tokio::sync::Mutex;
use tower_http::cors::{Any, CorsLayer};
use tracing::{error, info};
use uuid::Uuid;

use crate::downloader;
use crate::models::{DownloadJob, DownloadResponse, JobStatus};

/// Shared application state
pub struct AppState {
    pub jobs: Mutex<Vec<JobStatus>>,
}

pub async fn start() -> anyhow::Result<()> {
    let state = Arc::new(AppState {
        jobs: Mutex::new(vec![]),
    });

    // Allow requests from the browser extension (any origin)
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/download", post(handle_download))
        .route("/status", get(handle_status))
        .route("/ping", get(handle_ping))
        .layer(cors)
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:6543").await?;
    axum::serve(listener, app).await?;

    Ok(())
}

/// POST /download — called by the browser extension
async fn handle_download(
    State(state): State<Arc<AppState>>,
    Json(job): Json<DownloadJob>,
) -> (StatusCode, Json<DownloadResponse>) {
    let job_id = Uuid::new_v4().to_string();
    let job_id_clone = job_id.clone();
    let url = job.url.clone();

    info!("📥 New download job [{}]", job_id);
    info!("   URL: {}", url);

    // Add to job list immediately
    {
        let mut jobs = state.jobs.lock().await;
        jobs.push(JobStatus {
            job_id: job_id.clone(),
            url: url.clone(),
            filename: job.filename.clone().unwrap_or_else(|| "unknown".into()),
            total_bytes: 0,
            downloaded_bytes: 0,
            chunks_total: job.chunks.unwrap_or(8),
            chunks_done: 0,
            status: "running".into(),
            error: None,
        });
    }

    // Spawn the download in background so we return immediately to the extension
    let state_clone = state.clone();
    tokio::spawn(async move {
        match downloader::run(job, job_id.clone(), state_clone.clone()).await {
            Ok(_) => {
                info!("✅ Job [{}] completed successfully", job_id);
                let mut jobs = state_clone.jobs.lock().await;
                if let Some(j) = jobs.iter_mut().find(|j| j.job_id == job_id) {
                    j.status = "done".into();
                }
            }
            Err(e) => {
                error!("❌ Job [{}] failed: {}", job_id, e);
                let mut jobs = state_clone.jobs.lock().await;
                if let Some(j) = jobs.iter_mut().find(|j| j.job_id == job_id) {
                    j.status = "error".into();
                    j.error = Some(e.to_string());
                }
            }
        }
    });

    (
        StatusCode::ACCEPTED,
        Json(DownloadResponse {
            success: true,
            message: format!("Download job started for: {}", url),
            job_id: job_id_clone,
        }),
    )
}

/// GET /status — returns list of all jobs
async fn handle_status(State(state): State<Arc<AppState>>) -> Json<Vec<JobStatus>> {
    let jobs = state.jobs.lock().await;
    Json(jobs.clone())
}

/// GET /ping — health check so the extension knows the manager is running
async fn handle_ping() -> &'static str {
    "pong"
}
