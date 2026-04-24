import { initializeApp } from 'firebase/app';
import { 
  getAuth, 
  signInAnonymously, 
  onAuthStateChanged, 
  GoogleAuthProvider, 
  signInWithPopup 
} from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);

const googleProvider = new GoogleAuthProvider();

// Sign in anonymously by default for persistence without requiring Google account immediately
export const initAuth = () => {
  return new Promise((resolve, reject) => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      unsubscribe(); // Only check once during init
      if (!user) {
        try {
          // Try anonymous first, if it fails (restricted), we'll let the UI handle it (show login)
          const cred = await signInAnonymously(auth);
          resolve(cred.user);
        } catch (error) {
          console.warn("Anonymous auth failed, likely disabled in console:", error);
          reject(error);
        }
      } else {
        resolve(user);
      }
    });
  });
};

export const loginWithGoogle = async () => {
  try {
    const result = await signInWithPopup(auth, googleProvider);
    return result.user;
  } catch (error) {
    console.error("Google Login Error:", error);
    throw error;
  }
};
