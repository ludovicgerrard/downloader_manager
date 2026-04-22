mod server;
mod downloader;
mod merger;
mod models;

use tracing::info;
use tracing_subscriber;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Initialize logging
    tracing_subscriber::fmt()
        .with_target(false)
        .compact()
        .init();

    info!("🚀 Download Manager starting...");
    info!("📂 Files will be saved to your default Downloads folder");
    info!("🌐 Listening on http://localhost:6543");
    info!("   Waiting for downloads from the browser extension...\n");

    // Start the HTTP server (receives jobs from the extension)
    server::start().await?;

    Ok(())
}
