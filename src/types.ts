import { Timestamp } from 'firebase/firestore';

export interface DocumentSource {
  id: string;
  name: string;
  size: number;
  type: string;
  status: 'processing' | 'processed' | 'error';
  chunkCount: number;
  ownerId?: string;
  createdAt?: Timestamp;
}

export interface Chunk {
  id: string;
  sourceId: string;
  sourceName: string;
  text: string;
  embedding?: number[];
  ownerId?: string;
  index?: number;
}

export interface QueryResult {
  answer: string;
  sources: {
    name: string;
    text: string;
    score: number;
  }[];
  latency: number;
  tokens: number;
}

export interface LogEntry {
  timestamp: string;
  message: string;
  type: 'info' | 'success' | 'error' | 'process';
  details?: string;
}
