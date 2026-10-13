import { initializeApp, FirebaseApp } from 'firebase/app';
import { getFirestore, Firestore } from 'firebase/firestore';
import { getAuth, Auth } from 'firebase/auth';

// Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyD6VYcdJh2hjmFt7yObebzgcXkxyPAJsDU",
  authDomain: "edutrack-toba.firebaseapp.com",
  projectId: "edutrack-toba",
  storageBucket: "edutrack-toba.firebasestorage.app",
  messagingSenderId: "281644282518",
  appId: "1:281644282518:web:7a4bcaa5a97da2035808b7",
  measurementId: "G-EG30GVMXSH"
};

// Check if Firebase is configured
const isFirebaseConfigured = Boolean(
  firebaseConfig.apiKey && 
  firebaseConfig.projectId && 
  firebaseConfig.authDomain
);

let app: FirebaseApp | null = null;
let db: Firestore | null = null;
let auth: Auth | null = null;

if (isFirebaseConfigured) {
  try {
    // Initialize Firebase
    app = initializeApp(firebaseConfig);
    // Initialize Firestore
    db = getFirestore(app);
    // Initialize Auth  
    auth = getAuth(app);
  } catch (error) {
    console.error('Firebase initialization error:', error);
  }
}

export { db, auth };
export default app;
