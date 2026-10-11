"""Download the small ONNX embedding model during the Render build."""

from pathlib import Path

from fastembed import TextEmbedding

backend_dir = Path(__file__).resolve().parents[1]
model = TextEmbedding(
    model_name="sentence-transformers/all-MiniLM-L6-v2",
    threads=1,
    cache_dir=str(backend_dir / ".model_cache"),
)
next(model.embed(["OptiRoute semantic cache ready"]))
