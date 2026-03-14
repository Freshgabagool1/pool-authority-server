-- ============================================================
-- Pool Authority AI - Knowledge Base Migration
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- ============================================================

-- 1. Enable the vector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Knowledge base documents table
CREATE TABLE IF NOT EXISTS knowledge_base (
  id            BIGSERIAL PRIMARY KEY,
  content       TEXT NOT NULL,
  embedding     vector(1536),
  metadata      JSONB DEFAULT '{}',
  source_type   TEXT,
  manufacturer  TEXT,
  equipment     TEXT,
  model_name    TEXT,
  tags          TEXT[] DEFAULT '{}',
  source_url    TEXT,
  source_title  TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Vector similarity search index
CREATE INDEX IF NOT EXISTS knowledge_base_embedding_idx
  ON knowledge_base
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- 4. Indexes on structured fields
CREATE INDEX IF NOT EXISTS idx_kb_source_type ON knowledge_base(source_type);
CREATE INDEX IF NOT EXISTS idx_kb_manufacturer ON knowledge_base(manufacturer);
CREATE INDEX IF NOT EXISTS idx_kb_equipment ON knowledge_base(equipment);
CREATE INDEX IF NOT EXISTS idx_kb_tags ON knowledge_base USING GIN(tags);

-- 5. RPC function for vector similarity search
CREATE OR REPLACE FUNCTION match_knowledge(
  query_embedding vector(1536),
  match_count INT DEFAULT 5,
  match_threshold FLOAT DEFAULT 0.3,
  filter_manufacturer TEXT DEFAULT NULL,
  filter_equipment TEXT DEFAULT NULL,
  filter_source_type TEXT DEFAULT NULL
)
RETURNS TABLE (
  id BIGINT,
  content TEXT,
  metadata JSONB,
  source_type TEXT,
  manufacturer TEXT,
  equipment TEXT,
  model_name TEXT,
  tags TEXT[],
  source_title TEXT,
  source_url TEXT,
  similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    kb.id,
    kb.content,
    kb.metadata,
    kb.source_type,
    kb.manufacturer,
    kb.equipment,
    kb.model_name,
    kb.tags,
    kb.source_title,
    kb.source_url,
    1 - (kb.embedding <=> query_embedding) AS similarity
  FROM knowledge_base kb
  WHERE
    1 - (kb.embedding <=> query_embedding) > match_threshold
    AND (filter_manufacturer IS NULL OR kb.manufacturer = filter_manufacturer)
    AND (filter_equipment IS NULL OR kb.equipment = filter_equipment)
    AND (filter_source_type IS NULL OR kb.source_type = filter_source_type)
  ORDER BY kb.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- 6. Diagnostic sessions table
CREATE TABLE IF NOT EXISTS diagnostic_sessions (
  id            BIGSERIAL PRIMARY KEY,
  tech_id       UUID REFERENCES auth.users(id),
  question      TEXT NOT NULL,
  has_image     BOOLEAN DEFAULT FALSE,
  image_url     TEXT,
  response      TEXT,
  knowledge_ids BIGINT[] DEFAULT '{}',
  rating        SMALLINT CHECK (rating BETWEEN 1 AND 5),
  resolved      BOOLEAN DEFAULT FALSE,
  equipment_tag TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- 7. Stats view
CREATE OR REPLACE VIEW diagnostic_stats AS
SELECT
  COUNT(*) AS total_queries,
  COUNT(*) FILTER (WHERE has_image) AS queries_with_images,
  AVG(rating) FILTER (WHERE rating IS NOT NULL) AS avg_rating,
  COUNT(*) FILTER (WHERE resolved) AS resolved_count,
  DATE_TRUNC('day', created_at) AS query_date
FROM diagnostic_sessions
GROUP BY DATE_TRUNC('day', created_at)
ORDER BY query_date DESC;
