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
