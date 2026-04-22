use anyhow::Result;
use std::path::PathBuf;
use tokio::fs::File;
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufWriter};
use tracing::info;

use crate::models::Chunk;

/// Read all chunk temp files in order and write them sequentially into the final file.
pub async fn merge_chunks(chunks: &[Chunk], output_path: &PathBuf) -> Result<()> {
    let output_file = File::create(output_path).await?;
    let mut writer = BufWriter::new(output_file);

    for chunk in chunks.iter() {
        info!("  ↳ merging chunk {} / {}", chunk.index + 1, chunks.len());

        let mut chunk_file = File::open(&chunk.temp_path).await?;
        let mut buf = Vec::new();
        chunk_file.read_to_end(&mut buf).await?;
        writer.write_all(&buf).await?;

        // Remove temp file after merging
        tokio::fs::remove_file(&chunk.temp_path).await?;
    }

    writer.flush().await?;
    info!("  ✅ Merge complete → {:?}", output_path);

    Ok(())
}
