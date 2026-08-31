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

async function embedText(text) {
  const extractor = await getPipeline();
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return Float32Array.from(output.data);
}

async function embedBatch(texts) {
  const extractor = await getPipeline();
  const out = [];
  // Sequential on purpose: keeps memory flat and predictable on large repos.
  for (const t of texts) {
    const output = await extractor(t, { pooling: 'mean', normalize: true });
    out.push(Float32Array.from(output.data));
  }
  return out;
}

module.exports = { embedText, embedBatch, EMBEDDING_DIM };
