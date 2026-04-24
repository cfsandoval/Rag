import { Chunk } from "../types";

export function cosineSimilarity(vecA: number[], vecB: number[]) {
  let dotProduct = 0;
  let mA = 0;
  let mB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    mA += vecA[i] * vecA[i];
    mB += vecB[i] * vecB[i];
  }
  return dotProduct / (Math.sqrt(mA) * Math.sqrt(mB));
}

export function chunkText(text: string, chunkSize: number = 1000, overlap: number = 200): string[] {
  const chunks: string[] = [];
  let start = 0;
  
  while (start < text.length) {
    const end = start + chunkSize;
    chunks.push(text.slice(start, end));
    start = end - overlap;
    if (start < 0) start = 0;
    if (start >= text.length - overlap) break;
  }
  
  return chunks;
}

export function searchChunks(queryEmbedding: number[], chunks: Chunk[], topK: number = 3) {
  const scoredChunks = chunks
    .filter(c => c.embedding)
    .map(chunk => ({
      ...chunk,
      score: cosineSimilarity(queryEmbedding, chunk.embedding!)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
    
  return scoredChunks;
}
