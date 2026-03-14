/**
 * Pool Authority AI - Knowledge Base Ingestion Script
 *
 * Reads your pool knowledge documents (JSON format), generates embeddings
 * via OpenAI, and stores them in Supabase pgvector for similarity search.
 *
 * Usage:
 *   node ingest.js ./sample-data/sample-docs.json
 *
 * Environment variables required:
 *   OPENAI_API_KEY
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai').default || require('openai');
const fs = require('fs');
const path = require('path');

// Config
const EMBEDDING_MODEL = 'text-embedding-3-small';
const CHUNK_SIZE = 1500;
const CHUNK_OVERLAP = 200;
const BATCH_SIZE = 50;

// Check CLI args and env vars early
const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: node ingest.js <path-to-documents.json>');
  console.error('Example: node ingest.js ./sample-data/sample-docs.json');
  process.exit(1);
}
if (!process.env.OPENAI_API_KEY || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing environment variables. Required:');
  console.error('  OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

// Initialize clients
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Text chunking — splits long documents into overlapping chunks
function chunkText(text, maxLength = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  if (text.length <= maxLength) return [text];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = start + maxLength;
    if (end < text.length) {
      const lastPeriod = text.lastIndexOf('.', end);
      const lastNewline = text.lastIndexOf('\n', end);
      const breakPoint = Math.max(lastPeriod, lastNewline);
      if (breakPoint > start + maxLength * 0.5) end = breakPoint + 1;
    }
    chunks.push(text.slice(start, end).trim());
    start = end - overlap;
  }
  return chunks;
}

// Generate embeddings in batches
async function generateEmbeddings(texts) {
  const allEmbeddings = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    console.log(`  Generating embeddings ${i + 1}-${i + batch.length} of ${texts.length}...`);
    const response = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: batch });
    allEmbeddings.push(...response.data.map(item => item.embedding));
    if (i + BATCH_SIZE < texts.length) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  return allEmbeddings;
}

// Main ingestion function
async function ingestDocuments(filePath) {
  console.log(`\nPool Authority AI - Knowledge Base Ingestion`);
  console.log(`================================================\n`);

  const rawData = fs.readFileSync(filePath, 'utf-8');
  const documents = JSON.parse(rawData);
  console.log(`Loaded ${documents.length} documents from ${path.basename(filePath)}\n`);

  const rows = [];
  for (const doc of documents) {
    const chunks = chunkText(doc.content);
    for (const chunk of chunks) {
      rows.push({
        content: chunk,
        source_type: doc.source_type || null,
        manufacturer: doc.manufacturer || null,
        equipment: doc.equipment || null,
        model_name: doc.model_name || null,
        tags: doc.tags || [],
        source_title: doc.source_title || null,
        source_url: doc.source_url || null,
        metadata: doc.metadata || {},
      });
    }
  }

  console.log(`Split into ${rows.length} chunks (from ${documents.length} documents)\n`);

  console.log(`Generating embeddings...`);
  const texts = rows.map(r => r.content);
  const embeddings = await generateEmbeddings(texts);
  console.log(`Generated ${embeddings.length} embeddings\n`);

  console.log(`Inserting into Supabase knowledge_base...`);
  const insertRows = rows.map((row, i) => ({ ...row, embedding: embeddings[i] }));

  let inserted = 0;
  for (let i = 0; i < insertRows.length; i += 100) {
    const batch = insertRows.slice(i, i + 100);
    const { error } = await supabase.from('knowledge_base').insert(batch);
    if (error) {
      console.error(`Error inserting batch ${i}:`, error.message);
      continue;
    }
    inserted += batch.length;
    console.log(`  Inserted ${inserted} / ${insertRows.length}`);
  }

  console.log(`\nDone! ${inserted} chunks stored in knowledge_base.`);
  console.log(`\nNext steps:`);
  console.log(`  - Add more documents and re-run this script`);
  console.log(`  - Set ANTHROPIC_API_KEY and OPENAI_API_KEY on Render`);
  console.log(`  - The /api/tech-assist endpoint is already wired up in server.js\n`);
}

// Run
ingestDocuments(filePath).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
