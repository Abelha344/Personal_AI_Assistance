-- Run once against your Neon database.
-- Enable pgvector in Neon dashboard first, or:
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS documents (
    id BIGSERIAL PRIMARY KEY,
    content TEXT NOT NULL,
    metadata JSONB DEFAULT '{}',
    embedding vector(768) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS documents_embedding_idx
    ON documents
    USING hnsw (embedding vector_cosine_ops);

-- Example seed data (optional):
-- INSERT INTO documents (content, metadata, embedding) VALUES (...);
