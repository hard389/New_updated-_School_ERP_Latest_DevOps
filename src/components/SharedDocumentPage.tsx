import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { 
  FileText, Download, CheckCircle, AlertCircle, 
  Sparkles, Copy, Sun, Moon, User 
} from 'lucide-react';
import { initializeApp, getApps, getApp } from "firebase/app";
import { getFirestore, collection, getDocs, doc, getDoc } from "firebase/firestore";

// Firebase Config
const firebaseConfig = {
  apiKey: "AIzaSyAmHi2OOGNteUXjuX0_weF8XKEa3KP7OYE",
  authDomain: "tuition-management-b9e2f.firebaseapp.com",
  projectId: "tuition-management-b9e2f",
  storageBucket: "tuition-management-b9e2f.firebasestorage.app",
  messagingSenderId: "634395063857",
  appId: "1:634395063857:web:24d5e9c303845557f1c710"
};

const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();
const db = getFirestore(app);

interface LibraryResource {
  id: string;
  title: string;
  category: string;
  fileSize?: string;
  fileName?: string;
  fileDataUrl?: string;
  uploadDate: string;
  contentPreview?: string;
}

interface TeacherProfile {
  name: string;
  avatarUrl?: string;
  title?: string;
  email?: string;
}

export default function SharedDocumentPage() {
  const [searchParams] = useSearchParams();
  const documentId = searchParams.get('id');

  const [document, setDocument] = useState<LibraryResource | null>(null);
  const [teacher, setTeacher] = useState<TeacherProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const [copied, setCopied] = useState(false);
  
  // Theme Toggle State (Default Night Mode)
  const [isDarkMode, setIsDarkMode] = useState(true);

  useEffect(() => {
    const fetchSharedDocumentAndTeacher = async () => {
      if (!documentId) {
        setError('Invalid or missing document link.');
        setLoading(false);
        return;
      }

      try {
        setLoading(true);
        const userId = 'X1Q76ib1XXPWcPp3FSQPLLaTzL83';

        // 1. FETCH TEACHER PROFILE DIRECTLY FROM users/{userId}/settings/profile_data
        try {
          const profileDocRef = doc(db, 'users', userId, 'settings', 'profile_data');
          const profileSnap = await getDoc(profileDocRef);

          if (profileSnap.exists()) {
            const data = profileSnap.data();
            setTeacher({
              name: data.fullName || data.name || data.displayName || 'Ali Tahir',
              avatarUrl: data.photoURL || data.avatar || data.image || data.profileImage || data.avatarUrl,
              title: data.title || data.designation || data.role || 'Professor',
              email: data.email
            });
          } else {
            // Fallback: fetch main user doc if settings/profile_data doesn't exist
            const userDocRef = doc(db, 'users', userId);
            const userSnap = await getDoc(userDocRef);
            if (userSnap.exists()) {
              const userData = userSnap.data();
              setTeacher({
                name: userData.displayName || userData.name || 'Ali Tahir',
                avatarUrl: userData.photoURL || userData.avatar,
                title: 'Professor'
              });
            }
          }
        } catch (e) {
          console.error('Error fetching profile_data:', e);
          setTeacher({ name: 'Ali Tahir', title: 'Professor' });
        }

        // 2. FETCH DOCUMENT FROM CLASS DOCUMENTS
        const classesRef = collection(db, 'users', userId, 'classes');
        const classesSnapshot = await getDocs(classesRef);

        let foundDoc: LibraryResource | null = null;

        for (const classDoc of classesSnapshot.docs) {
          const docsRef = collection(db, 'users', userId, 'classes', classDoc.id, 'documents');
          const docsSnapshot = await getDocs(docsRef);

          for (const docItem of docsSnapshot.docs) {
            if (docItem.id === documentId) {
              foundDoc = docItem.data() as LibraryResource;
              break;
            }
          }
          if (foundDoc) break;
        }

        if (foundDoc) {
          setDocument(foundDoc);
        } else {
          setError('Document not found or has been removed.');
        }
      } catch (err) {
        console.error('Error fetching document:', err);
        setError('Failed to load document.');
      } finally {
        setLoading(false);
      }
    };

    fetchSharedDocumentAndTeacher();
  }, [documentId]);

  const handleDownload = () => {
    if (!document) return;

    if (document.fileDataUrl) {
      const link = window.document.createElement('a');
      link.href = document.fileDataUrl;
      link.download = document.fileName || `${document.title}.pdf`;
      window.document.body.appendChild(link);
      link.click();
      window.document.body.removeChild(link);
    } else {
      const fileContent = `Document Title: ${document.title}\nCategory: ${document.category}\n\nNotes:\n${document.contentPreview || 'No preview text.'}`;
      const blob = new Blob([fileContent], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const link = window.document.createElement('a');
      link.href = url;
      link.download = `${document.title.replace(/\s+/g, '_')}.txt`;
      window.document.body.appendChild(link);
      link.click();
      window.document.body.removeChild(link);
      URL.revokeObjectURL(url);
    }

    setDownloaded(true);
    setTimeout(() => setDownloaded(false), 3000);
  };

  const handleCopyLink = () => {
    navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className={`min-h-screen flex flex-col h-screen w-screen overflow-hidden font-sans transition-colors duration-300 ${
      isDarkMode ? 'bg-[#0f0f12] text-white' : 'bg-slate-100 text-slate-900'
    }`}>
      
      {/* TOP HEADER BAR */}
      <header className={`h-16 px-4 md:px-6 flex items-center justify-between flex-shrink-0 z-30 transition-colors duration-300 border-b ${
        isDarkMode 
          ? 'bg-[#18181c]/90 border-[#2a2a30] backdrop-blur-md' 
          : 'bg-white/90 border-slate-200 backdrop-blur-md shadow-sm'
      }`}>
        
        {/* LEFT: EDUTRACK LOGO */}
        <div className="flex items-center gap-3">
          <img 
            src="/logo.png" 
            alt="EduTrack Logo" 
            className="h-10 w-10 rounded-xl object-contain bg-white/5 p-1 border border-orange-500/20 shadow-md"
          />
          <div className="hidden sm:block">
            <div className="flex items-center gap-1.5">
              <span className="font-extrabold text-base tracking-tight bg-gradient-to-r from-orange-500 to-amber-500 bg-clip-text text-transparent">
                EduTrack
              </span>
              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                isDarkMode ? 'bg-orange-500/10 text-orange-400 border border-orange-500/20' : 'bg-orange-100 text-orange-600'
              }`}>
                DOC VIEW
              </span>
            </div>
            <p className={`text-[10px] ${isDarkMode ? 'text-gray-400' : 'text-slate-500'}`}>
              Intelligent Portal
            </p>
          </div>
        </div>

        {/* CENTER: DOCUMENT TITLE */}
        {document && (
          <div className={`hidden lg:flex items-center gap-3 max-w-md mx-4 px-4 py-1.5 rounded-full border transition-all ${
            isDarkMode ? 'bg-[#222228] border-[#32323a]' : 'bg-slate-50 border-slate-200'
          }`}>
            <FileText className="h-4 w-4 text-orange-500 flex-shrink-0" />
            <div className="truncate text-xs font-semibold">
              <span className={isDarkMode ? 'text-gray-200' : 'text-slate-800'}>
                {document.title}
              </span>
              <span className={`ml-2 text-[10px] px-2 py-0.5 rounded font-bold uppercase ${
                isDarkMode ? 'bg-orange-500/20 text-orange-400' : 'bg-orange-100 text-orange-600'
              }`}>
                {document.category}
              </span>
            </div>
          </div>
        )}

        {/* RIGHT: ACTIONS + TEACHER PROFILE + THEME TOGGLE */}
        <div className="flex items-center gap-2 md:gap-3">
          
          {/* TEACHER PROFILE BADGE (FETCHED FROM settings/profile_data) */}
          {teacher && (
            <div className={`flex items-center gap-2.5 px-3 py-1 rounded-full border transition-all shadow-sm ${
              isDarkMode ? 'bg-[#222228] border-[#32323a]' : 'bg-slate-100 border-slate-200'
            }`}>
              {teacher.avatarUrl ? (
                <img 
                  src={teacher.avatarUrl} 
                  alt={teacher.name} 
                  className="h-8 w-8 rounded-full object-cover border-2 border-orange-500 shadow"
                />
              ) : (
                <div className="h-8 w-8 rounded-full bg-gradient-to-tr from-orange-500 to-amber-500 text-white flex items-center justify-center font-bold text-xs shadow">
                  <User className="h-4 w-4" />
                </div>
              )}
              <div className="hidden sm:block text-left pr-1">
                <p className={`text-xs font-extrabold leading-tight ${isDarkMode ? 'text-gray-100' : 'text-slate-900'}`}>
                  {teacher.name}
                </p>
                <p className="text-[10px] font-semibold text-orange-500 leading-tight">
                  {teacher.title || 'Faculty'}
                </p>
              </div>
            </div>
          )}

          {/* DAY / NIGHT MODE TOGGLE */}
          <button
            onClick={() => setIsDarkMode(!isDarkMode)}
            className={`p-2.5 rounded-xl transition-all border ${
              isDarkMode 
                ? 'bg-[#222228] text-amber-400 border-[#32323a] hover:bg-[#2c2c34]' 
                : 'bg-slate-100 text-slate-700 border-slate-200 hover:bg-slate-200'
            }`}
            title={isDarkMode ? "Switch to Day Mode" : "Switch to Night Mode"}
          >
            {isDarkMode ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>

          {/* COPY LINK BUTTON */}
          <button
            onClick={handleCopyLink}
            className={`px-3 py-2 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-all border ${
              isDarkMode 
                ? 'bg-[#222228] text-gray-300 border-[#32323a] hover:bg-[#2c2c34]' 
                : 'bg-slate-100 text-slate-700 border-slate-200 hover:bg-slate-200'
            }`}
          >
            {copied ? <CheckCircle className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
            <span className="hidden md:inline">{copied ? 'Copied' : 'Share Link'}</span>
          </button>

          {/* DOWNLOAD BUTTON */}
          <button
            onClick={handleDownload}
            disabled={!document}
            className={`px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-2 transition-all shadow-lg ${
              downloaded
                ? 'bg-emerald-600 text-white shadow-emerald-900/30'
                : 'bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 text-white shadow-orange-500/25 hover:scale-105 active:scale-95'
            }`}
          >
            {downloaded ? (
              <>
                <CheckCircle className="h-4 w-4" />
                <span>Downloaded</span>
              </>
            ) : (
              <>
                <Download className="h-4 w-4" />
                <span className="hidden sm:inline">Download</span>
              </>
            )}
          </button>
        </div>
      </header>

      {/* MAIN DOCUMENT VIEWPORT */}
      <main className={`flex-1 overflow-auto p-4 md:p-8 flex items-center justify-center relative transition-colors duration-300 ${
        isDarkMode ? 'bg-[#0a0a0d]' : 'bg-slate-200/60'
      }`}>
        
        {/* Loading State */}
        {loading && (
          <div className="text-center space-y-4">
            <div className="relative flex items-center justify-center">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-orange-500"></div>
              <img src="/logo.png" alt="Loading" className="h-5 w-5 absolute object-contain" />
            </div>
            <p className={`text-xs font-bold ${isDarkMode ? 'text-gray-400' : 'text-slate-600'}`}>
              Preparing your document preview...
            </p>
          </div>
        )}

        {/* Error State */}
        {!loading && error && (
          <div className={`max-w-md w-full rounded-2xl p-6 text-center space-y-3 shadow-2xl border ${
            isDarkMode ? 'bg-[#18181c] border-red-500/30 text-white' : 'bg-white border-red-200 text-slate-800'
          }`}>
            <div className="h-12 w-12 bg-red-500/10 text-red-400 rounded-full flex items-center justify-center mx-auto border border-red-500/20">
              <AlertCircle className="h-6 w-6" />
            </div>
            <h3 className="text-sm font-bold text-red-500">{error}</h3>
            <p className={`text-xs ${isDarkMode ? 'text-gray-400' : 'text-slate-500'}`}>
              Please check if the URL is correct or contact your teacher.
            </p>
          </div>
        )}

        {/* Document Viewer Frame */}
        {!loading && document && (
          <div className="w-full h-full max-w-6xl mx-auto flex flex-col items-center justify-center">
            {document.fileDataUrl ? (
              <iframe
                src={document.fileDataUrl}
                title={document.title}
                className={`w-full h-full rounded-2xl shadow-2xl border transition-all ${
                  isDarkMode ? 'bg-white border-gray-800' : 'bg-white border-slate-300'
                }`}
              />
            ) : (
              /* A4 Paper Card View */
              <div className={`w-full max-w-2xl rounded-2xl shadow-2xl p-8 md:p-12 min-h-[600px] flex flex-col justify-between border transition-colors ${
                isDarkMode ? 'bg-[#18181c] border-[#2a2a30] text-gray-100' : 'bg-white border-slate-200 text-slate-900'
              }`}>
                <div className="space-y-6">
                  <div className="border-b pb-4 flex items-center justify-between border-orange-500/30">
                    <div>
                      <span className="text-[10px] font-black uppercase tracking-widest text-orange-500 bg-orange-500/10 px-2 py-0.5 rounded border border-orange-500/20">
                        {document.category}
                      </span>
                      <h2 className="text-xl font-extrabold mt-2">{document.title}</h2>
                    </div>
                    <Sparkles className="h-6 w-6 text-orange-500 animate-pulse" />
                  </div>

                  <div className="space-y-2 text-sm leading-relaxed">
                    <p className={`font-semibold text-xs uppercase tracking-wider ${isDarkMode ? 'text-gray-400' : 'text-slate-500'}`}>
                      Notes & Content Preview:
                    </p>
                    <div className={`p-5 rounded-xl border whitespace-pre-wrap font-serif text-sm ${
                      isDarkMode ? 'bg-[#101014] border-[#222228] text-gray-300' : 'bg-slate-50 border-slate-200 text-slate-800'
                    }`}>
                      {document.contentPreview || 'No additional text description provided for this document.'}
                    </div>
                  </div>
                </div>

                <div className={`pt-6 border-t flex items-center justify-between text-xs ${
                  isDarkMode ? 'border-[#2a2a30] text-gray-400' : 'border-slate-200 text-slate-500'
                }`}>
                  <span>Uploaded: {document.uploadDate}</span>
                  <button
                    onClick={handleDownload}
                    className="bg-gradient-to-r from-orange-500 to-amber-500 text-white px-4 py-2 rounded-xl font-bold flex items-center gap-1.5 hover:scale-105 transition-all shadow-md"
                  >
                    <Download className="h-3.5 w-3.5" /> Download File
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

      </main>
    </div>
  );
}
