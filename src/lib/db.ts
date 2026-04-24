import { 
  collection, 
  doc, 
  setDoc, 
  getDocs, 
  query, 
  where, 
  deleteDoc, 
  serverTimestamp,
  writeBatch,
  getDocFromServer
} from 'firebase/firestore';
import { UserInfo } from 'firebase/auth';
import { db, auth } from './firebase';
import { DocumentSource, Chunk } from '../types';

export interface FirestoreErrorInfo {
  error: string;
  operationType: 'create' | 'update' | 'delete' | 'list' | 'get' | 'write';
  path: string | null;
  authInfo: {
    userId: string;
    email: string;
    emailVerified: boolean;
    isAnonymous: boolean;
    providerInfo: UserInfo[];
  }
}

export function handleFirestoreError(error: unknown, operationType: FirestoreErrorInfo['operationType'], path: string | null = null) {
  const authInfo = auth.currentUser ? {
    userId: auth.currentUser.uid,
    email: auth.currentUser.email || '',
    emailVerified: auth.currentUser.emailVerified,
    isAnonymous: auth.currentUser.isAnonymous,
    providerInfo: auth.currentUser.providerData
  } : {
    userId: 'unauthenticated',
    email: '',
    emailVerified: false,
    isAnonymous: false,
    providerInfo: []
  };

  const errorMessage = error instanceof Error ? error.message : String(error);

  const errorInfo: FirestoreErrorInfo = {
    error: errorMessage,
    operationType,
    path,
    authInfo
  };

  console.error("Firestore Error:", errorInfo);
  throw new Error(JSON.stringify(errorInfo));
}

export async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error: unknown) {
    if(error instanceof Error && error.message.includes('the client is offline')) {
      console.error("Please check your Firebase configuration.");
    }
  }
}

export async function saveDocument(docData: DocumentSource) {
  const userId = auth.currentUser?.uid;
  if (!userId) throw new Error("User not authenticated");

  try {
    const { id, ...data } = docData;
    const docRef = doc(db, 'documents', id);
    await setDoc(docRef, {
      ...data,
      ownerId: userId,
      createdAt: serverTimestamp()
    });
  } catch (error) {
    handleFirestoreError(error, 'create', `documents/${docData.id}`);
  }
}

export async function updateDocumentStatus(docId: string, status: string, chunkCount: number) {
  try {
    const docRef = doc(db, 'documents', docId);
    await setDoc(docRef, { status, chunkCount }, { merge: true });
  } catch (error) {
    handleFirestoreError(error, 'update', `documents/${docId}`);
  }
}

export async function saveChunks(chunks: Chunk[]) {
  const userId = auth.currentUser?.uid;
  if (!userId) throw new Error("User not authenticated");

  const batchSize = 500;
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = writeBatch(db);
    const slice = chunks.slice(i, i + batchSize);
    
    slice.forEach(chunk => {
      const { id, ...data } = chunk;
      const chunkRef = doc(db, 'chunks', id);
      batch.set(chunkRef, {
        ...data,
        ownerId: userId
      });
    });

    try {
      await batch.commit();
    } catch (error) {
      handleFirestoreError(error, 'write', 'chunks batch');
    }
  }
}

export async function getDocuments(): Promise<DocumentSource[]> {
  const userId = auth.currentUser?.uid;
  if (!userId) return [];

  try {
    const q = query(collection(db, 'documents'), where('ownerId', '==', userId));
    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as DocumentSource));
  } catch (error) {
    handleFirestoreError(error, 'list', 'documents');
    return [];
  }
}

export async function getChunks(): Promise<Chunk[]> {
  const userId = auth.currentUser?.uid;
  if (!userId) return [];

  try {
    const q = query(collection(db, 'chunks'), where('ownerId', '==', userId));
    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Chunk));
  } catch (error) {
    handleFirestoreError(error, 'list', 'chunks');
    return [];
  }
}

export async function deleteDocumentAndChunks(docId: string) {
  const userId = auth.currentUser?.uid;
  if (!userId) throw new Error("User not authenticated");

  try {
    // 1. Delete chunks
    const chunkQ = query(collection(db, 'chunks'), where('sourceId', '==', docId), where('ownerId', '==', userId));
    const chunkSnapshot = await getDocs(chunkQ);
    
    // Batch delete chunks
    const chunksToDelete = chunkSnapshot.docs;
    for (let i = 0; i < chunksToDelete.length; i += 500) {
      const batch = writeBatch(db);
      chunksToDelete.slice(i, i + 500).forEach(d => batch.delete(d.ref));
      await batch.commit();
    }

    // 2. Delete document
    await deleteDoc(doc(db, 'documents', docId));
  } catch (error) {
    handleFirestoreError(error, 'delete', `documents/${docId}`);
  }
}
