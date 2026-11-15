'use strict';

/**
 * Fully local embeddings via transformers.js (ONNX runtime under the hood).
 * Model weights (~90MB) are downloaded once on first use and cached by the
 * library in the OS cache dir - after that this runs 100% offline.
 */
let pipelinePromise = null;

async function getPipeline() {
  if (!pipelinePromise) {
    const { pipeline } = await import('@xenova/transformers');
    pipelinePromise = pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  return pipelinePromise;
}

const EMBEDDING_DIM = 384;

/**
 * Query-embedding memo. A single agent task tends to re-search the same
 * handful of phrases - refining a query, brain_context calling through to
 * search, the same lookup repeated after an edit - and each repeat used to
 * re-pay the full ONNX forward pass (~16ms warm, and the whole ~1.7s model
 * load if the process was cold).
 *
 * Only embedText (query side) is memoized, never embedBatch: build-time
 * embedding walks each symbol exactly once, so caching it would retain
 * every symbol body in memory for no reuse at all.
 *
 * Keyed on the exact text after whitespace normalization - semantically
 * "near-identical" is not safe to collapse, since a one-word difference is
 * exactly what the embedding is being asked to distinguish.
 */
const MAX_CACHED_QUERY_EMBEDDINGS = 256;
const queryEmbeddingCache = new Map();

function cacheKey(text) {
  return String(text).trim().replace(/\s+/g, ' ');
}

async function embedText(text) {
  const key = cacheKey(text);
  const cached = queryEmbeddingCache.get(key);
  if (cached) {
    // Refresh recency: Map preserves insertion order, so re-inserting moves
    // this key to the end and keeps the eviction below a true LRU.
    queryEmbeddingCache.delete(key);
    queryEmbeddingCache.set(key, cached);
    // A copy, so a caller that mutates its vector can't corrupt the cache.
    return Float32Array.from(cached);
  }

  const extractor = await getPipeline();
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  const vec = Float32Array.from(output.data);

  queryEmbeddingCache.set(key, vec);
  if (queryEmbeddingCache.size > MAX_CACHED_QUERY_EMBEDDINGS) {
    queryEmbeddingCache.delete(queryEmbeddingCache.keys().next().value);
  }
  return Float32Array.from(vec);
}

/**
 * Embeds many texts in one batched forward pass instead of one await per
 * text - transformers.js accepts an array directly and returns a single
 * tensor of shape [texts.length, EMBEDDING_DIM], which is what actually
 * makes this a batch rather than just a loop the caller doesn't see.
 */
async function embedBatch(texts) {
  if (!texts.length) return [];
  const extractor = await getPipeline();
  const output = await extractor(texts, { pooling: 'mean', normalize: true });
  const out = [];
  for (let i = 0; i < texts.length; i++) {
    out.push(Float32Array.from(output.data.subarray(i * EMBEDDING_DIM, (i + 1) * EMBEDDING_DIM)));
  }
  return out;
}

module.exports = { embedText, embedBatch, EMBEDDING_DIM };
