import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useLocation, Link, useNavigate } from 'react-router-dom';
import {
  Folder, BookOpen, FileText, Upload, Share2, Copy, Check, Eye, Download,
  Plus, ArrowLeft, Search, Sun, Moon, Home, GraduationCap, Users, Wallet,
  Sparkles, X, Trash2, Settings, AlertCircle, Pencil, AlertTriangle
} from 'lucide-react';

// Use the single shared Firebase project configured by the application.
// Do not initialize a second app or embed project credentials in this page.
import { auth, db } from '@/lib/firebase';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import type { User } from 'firebase/auth';
import {
  collection, getDocs, doc, getDoc, setDoc, runTransaction
} from 'firebase/firestore';
import {
  getStorage, ref as storageRef, uploadBytes, getDownloadURL, deleteObject
} from 'firebase/storage';

// Types
type ResourceCategory = 'All' | 'Notes' | 'Textbooks' | 'Past Papers' | 'Assignments';

interface LibraryResource {
  id: string;
  title: string;
  category: Exclude<ResourceCategory, 'All'>;
  fileType: 'pdf' | 'doc' | 'image' | 'link';
  fileSize?: string;
  fileName?: string;
  fileDataUrl?: string;
  uploadDate: string;
  shareUrl: string;
  contentPreview?: string;
  storagePath?: string;
  // In-memory only: indicates whether the resource is an embedded legacy record or a documents subcollection record.
  _source?: 'embedded' | 'document';
}

interface ClassLibrary {
  id: string;
  className: string;
  classCode: string;
  totalStudents: number;
  bgGradient: string;
  resources: LibraryResource[];
}

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const ALLOWED_FILE_TYPES: Record<string, { mimeType: string; fileType: LibraryResource['fileType'] }> = {
  pdf: { mimeType: 'application/pdf', fileType: 'pdf' },
  doc: { mimeType: 'application/msword', fileType: 'doc' },
  docx: { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', fileType: 'doc' },
  png: { mimeType: 'image/png', fileType: 'image' },
  jpg: { mimeType: 'image/jpeg', fileType: 'image' },
  jpeg: { mimeType: 'image/jpeg', fileType: 'image' },
};
const VALID_CATEGORIES = new Set<Exclude<ResourceCategory, 'All'>>(['Notes', 'Textbooks', 'Past Papers', 'Assignments']);

const normalizeEmail = (email?: string | null): string => String(email ?? '').trim().toLowerCase();
const isValidPathSegment = (value: string): boolean => Boolean(value.trim()) && !value.includes('/') && value !== '.' && value !== '..';
const sanitizeDisplayText = (value: unknown, maxLength = 5000): string =>
  String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, maxLength);
const sanitizeFileName = (value: string): string => {
  const baseName = String(value || 'download').split(/[\\/]/).pop() || 'download';
  return baseName.replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').replace(/\s+/g, '_').slice(0, 120) || 'download';
};
const makeResourceId = (): string => {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return `res-${crypto.randomUUID()}`;
  } catch { /* Use the fallback below in older browsers. */ }
  return `res-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
};
const makeShareUrl = (id: string): string => {
  const url = new URL('/notes/share', window.location.origin);
  url.searchParams.set('id', id);
  return url.toString();
};
const friendlyError = (error: unknown, action: string): string => {
  const code = String((error as { code?: string } | null)?.code ?? '').replace(/^firestore\//, '').replace(/^storage\//, '');
  if (code === 'permission-denied' || code === 'unauthorized') {
    return `Permission denied. Your teacher account cannot ${action}.`;
  }
  if (code === 'unauthenticated') return 'Your session has expired. Please sign in again.';
  if (code === 'unavailable' || code === 'deadline-exceeded' || code === 'cancelled' || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
    return `Network problem while trying to ${action}. Check your connection and try again.`;
  }
  if (code === 'not-found' || code === 'object-not-found') return 'This resource no longer exists. Refresh the library and try again.';
  if (code === 'quota-exceeded') return 'Firebase Storage quota is exhausted. Please try again later.';
  if (error instanceof Error && !('code' in error) && error.message) return sanitizeDisplayText(error.message, 240);
  return `Could not ${action}. Please try again.`;
};

const validateUploadFile = (file: File): { extension: string; mimeType: string; fileType: LibraryResource['fileType'] } => {
  if (!file || file.size <= 0) throw new Error('The selected file is empty. Choose a valid PDF, Word document, or image.');
  if (file.size > MAX_UPLOAD_BYTES) throw new Error('File is too large. The maximum supported upload size is 20 MB.');
  const extension = String(file.name.split('.').pop() ?? '').toLowerCase();
  const definition = ALLOWED_FILE_TYPES[extension];
  if (!definition) throw new Error('Unsupported file type. Upload PDF, DOC, DOCX, PNG, JPG, or JPEG files only.');
  const actualMime = String(file.type ?? '').toLowerCase().trim();
  if (actualMime && actualMime !== definition.mimeType && actualMime !== 'application/octet-stream') {
    throw new Error('The file extension and detected file type do not match. Choose a valid file.');
  }
  return { extension, mimeType: definition.mimeType, fileType: definition.fileType };
};

const readArrayLike = (value: unknown): any[] => {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) return Object.values(value);
  return [];
};

const normalizeResource = (raw: unknown, fallbackId: string, source: 'embedded' | 'document'): LibraryResource | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const id = sanitizeDisplayText(value.id ?? fallbackId, 180) || fallbackId;
  const title = sanitizeDisplayText(value.title ?? value.fileName ?? 'Untitled resource', 180) || 'Untitled resource';
  const rawCategory = value.category;
  const category = VALID_CATEGORIES.has(rawCategory as Exclude<ResourceCategory, 'All'>)
    ? rawCategory as Exclude<ResourceCategory, 'All'> : 'Notes';
  const rawType = String(value.fileType ?? '').toLowerCase();
  const fileType: LibraryResource['fileType'] = rawType === 'pdf' || rawType === 'doc' || rawType === 'image' || rawType === 'link'
    ? rawType : 'link';
  return {
    id,
    title,
    category,
    fileType,
    fileSize: typeof value.fileSize === 'string' ? value.fileSize.slice(0, 80) : '',
    fileName: typeof value.fileName === 'string' ? sanitizeFileName(value.fileName) : undefined,
    fileDataUrl: typeof value.fileDataUrl === 'string' && value.fileDataUrl.startsWith('data:') ? value.fileDataUrl : undefined,
    storagePath: typeof value.storagePath === 'string' ? value.storagePath : undefined,
    uploadDate: typeof value.uploadDate === 'string' ? value.uploadDate.slice(0, 80) : '',
    shareUrl: makeShareUrl(id),
    contentPreview: sanitizeDisplayText(value.contentPreview ?? '', 5000),
    _source: source,
  };
};

const resolveVerifiedTenant = async (user: User): Promise<string> => {
  const email = normalizeEmail(user.email);
  if (!email || !isValidPathSegment(email)) throw new Error('This teacher account does not have a valid email tenant.');
  const authProjectId = auth.app.options.projectId;
  const firestoreProjectId = db.app.options.projectId;
  if (!authProjectId || !firestoreProjectId || authProjectId !== firestoreProjectId) {
    throw new Error('Firebase Auth and Firestore are configured for different projects. Check lib/firebase before continuing.');
  }

  const profileSnap = await getDoc(doc(db, 'users', email));
  if (!profileSnap.exists()) throw new Error('Teacher profile was not found. Access to Notes Library is blocked.');
  const profile = profileSnap.data();
  if (profile.uid !== user.uid || normalizeEmail(profile.email) !== email) {
    throw new Error('Teacher profile ownership could not be verified. Access is blocked.');
  }
  if (profile.role !== 'teacher' || profile.active !== true || profile.disabled === true || profile.deleted === true) {
    throw new Error('This teacher account is not active or is not authorized to access Notes Library.');
  }
  return email;
};

// --- FIXED BOTTOM NAVBAR COMPONENT ---
function BottomNavbar() {
  const location = useLocation();

  const navigationTabs = [
    { id: 'home', label: 'Home', icon: Home, href: '/' },
    { id: 'classes', label: 'Classes', icon: GraduationCap, href: '/departments' },
    { id: 'attendance', label: 'Attendance', icon: Users, href: '/attendance' },
    { id: 'fees', label: 'Fees', icon: Wallet, href: '/fees' },
    { id: 'settings', label: 'Settings', icon: Settings, href: '/settings' },
  ];

  return (
    <div className="fixed bottom-3 left-0 right-0 z-50 flex justify-center px-3 pointer-events-none">
      <nav className="pointer-events-auto bg-white/95 dark:bg-[#0c1222]/95 backdrop-blur-xl border border-slate-200/80 dark:border-slate-800 shadow-[0_10px_40px_rgba(0,0,0,0.12)] rounded-full px-3 py-2 flex items-center justify-around gap-1 max-w-md w-full">
        {navigationTabs.map((tab) => {
          const Icon = tab.icon;
          const isActive =
            location.pathname === tab.href ||
            (tab.id === 'fees' && location.pathname.includes('/fees'));

          return (
            <Link
              key={tab.id}
              to={tab.href}
              className="flex flex-col items-center justify-center flex-1 py-0.5 transition-all group min-w-0"
            >
              <div
                className={`p-2 rounded-full transition-all duration-300 flex items-center justify-center ${
                  isActive
                    ? 'bg-orange-500 text-white shadow-md scale-105'
                    : 'text-slate-400 bg-transparent group-hover:text-slate-600 dark:group-hover:text-slate-300 group-hover:bg-slate-100 dark:group-hover:bg-slate-800'
                }`}
              >
                <Icon className="h-5 w-5 shrink-0" />
              </div>
              <span
                className={`text-[9px] sm:text-[10px] font-bold mt-0.5 transition-colors truncate max-w-full text-center ${
                  isActive ? 'text-orange-500' : 'text-slate-400 group-hover:text-slate-600 dark:group-hover:text-slate-300'
                }`}
              >
                {tab.label}
              </span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

// --- MAIN PAGE COMPONENT ---
export default function NotesLibraryPage() {
  const navigate = useNavigate();
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [isDark, setIsDark] = useState(false);
  const [libraries, setLibraries] = useState<ClassLibrary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedClassId, setSelectedClassId] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<ResourceCategory>('All');
  const [searchQuery, setSearchQuery] = useState('');

  // Modals & States
  const [isUploadModalOpen, setIsUploadModalOpen] = useState(false);
  const [previewResource, setPreviewResource] = useState<LibraryResource | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  // Delete, Edit & Toast States
  const [deletingResId, setDeletingResId] = useState<string | null>(null);
  const [editingResource, setEditingResource] = useState<LibraryResource | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editCategory, setEditCategory] = useState<Exclude<ResourceCategory, 'All'>>('Notes');
  const [editDescription, setEditDescription] = useState('');
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Upload Form Inputs
  const [newTitle, setNewTitle] = useState('');
  const [newCategory, setNewCategory] = useState<Exclude<ResourceCategory, 'All'>>('Notes');
  const [newDescription, setNewDescription] = useState('');
  const [fileObject, setFileObject] = useState<File | null>(null);

  const authGenerationRef = useRef(0);
  const uploadInFlightRef = useRef(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = (msg: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToastMessage(msg);
    toastTimerRef.current = setTimeout(() => setToastMessage(null), 3000);
  };

  useEffect(() => () => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
  }, []);

  // Auth state is not enough by itself: verify the profile before any class/resource reads.
  useEffect(() => {
    let mounted = true;
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      const generation = ++authGenerationRef.current;
      setCurrentUser(user);
      setTenantId(null);
      setLibraries([]);
      setSelectedClassId(null);
      setPreviewResource(null);
      setEditingResource(null);
      setDeletingResId(null);
      setCopiedId(null);
      setLoading(Boolean(user));

      if (!user) {
        setLoading(false);
        navigate('/login', { replace: true });
        return;
      }

      resolveVerifiedTenant(user).then((verifiedTenant) => {
        if (!mounted || generation !== authGenerationRef.current || auth.currentUser?.uid !== user.uid) return;
        setTenantId(verifiedTenant);
      }).catch(async (error) => {
        if (!mounted || generation !== authGenerationRef.current || auth.currentUser?.uid !== user.uid) return;
        setTenantId(null);
        setLibraries([]);
        setSelectedClassId(null);
        setLoading(false);
        showToast(friendlyError(error, 'verify your teacher profile'));
        // Fail closed. Do not leave an authenticated but unverified identity on this page.
        try { await signOut(auth); } catch { /* The route still has no tenant data or access. */ }
        if (mounted && generation === authGenerationRef.current) navigate('/login', { replace: true });
      });
    });

    return () => {
      mounted = false;
      authGenerationRef.current += 1;
      unsubscribe();
    };
  }, [navigate]);

  // Read only from users/{verified email}/classes and each class's documents subcollection.
  // Query classes in bounded batches to avoid an unbounded burst for teachers with many classes.
  useEffect(() => {
    if (!currentUser) {
      setLibraries([]);
      setLoading(false);
      return;
    }
    if (!tenantId) return; // profile verification is still pending; do not read anything yet.

    let cancelled = false;
    const uid = currentUser.uid;
    setLoading(true);
    setLibraries([]);

    const isStillCurrent = () => !cancelled && auth.currentUser?.uid === uid && tenantId === normalizeEmail(currentUser.email);

    const fetchClasses = async () => {
      try {
        if (auth.app.options.projectId !== db.app.options.projectId) {
          throw new Error('Firebase Auth and Firestore projects do not match.');
        }
        const classesRef = collection(db, 'users', tenantId, 'classes');
        const querySnapshot = await getDocs(classesRef);
        const classDocs = querySnapshot.docs;
        const fetchedClasses: ClassLibrary[] = [];

        for (let offset = 0; offset < classDocs.length; offset += 8) {
          if (!isStillCurrent()) return;
          const batch = classDocs.slice(offset, offset + 8);
          const results = await Promise.all(batch.map(async (classDoc) => {
            const data = classDoc.data();
            const documentsRef = collection(db, 'users', tenantId, 'classes', classDoc.id, 'documents');
            const documentsSnapshot = await getDocs(documentsRef);

            const embeddedResources = readArrayLike(data.resources)
              .map((item, index) => normalizeResource(item, `legacy-${classDoc.id}-${index}`, 'embedded'))
              .filter((item): item is LibraryResource => item !== null);
            const documentResources = documentsSnapshot.docs
              .map((resourceDoc) => normalizeResource({ ...resourceDoc.data(), id: resourceDoc.id }, resourceDoc.id, 'document'))
              .filter((item): item is LibraryResource => item !== null);

            // Deduplicate the legacy embedded array + canonical subcollection by id; the subcollection wins.
            const resourceMap = new Map<string, LibraryResource>();
            embeddedResources.forEach((resource) => resourceMap.set(resource.id, resource));
            documentResources.forEach((resource) => resourceMap.set(resource.id, resource));
            const resources = [...resourceMap.values()];
            const studentsValue = data.students;
            const totalStudents = Array.isArray(studentsValue)
              ? studentsValue.length
              : studentsValue && typeof studentsValue === 'object'
                ? Object.keys(studentsValue).length
                : Number.isFinite(Number(data.totalStudents)) ? Math.max(0, Number(data.totalStudents)) : 0;

            return {
              id: classDoc.id,
              className: sanitizeDisplayText(data.name || data.className || 'Unnamed Class', 180),
              classCode: sanitizeDisplayText(data.code || data.classCode || 'N/A', 80),
              totalStudents,
              bgGradient: typeof data.bgGradient === 'string' ? data.bgGradient : 'from-blue-500/10 to-indigo-500/10 text-blue-600 border-blue-200',
              resources,
            } as ClassLibrary;
          }));
          if (!isStillCurrent()) return;
          fetchedClasses.push(...results);
        }

        fetchedClasses.sort((a, b) => a.className.localeCompare(b.className));
        if (!isStillCurrent()) return;
        setLibraries(fetchedClasses);
        setSelectedClassId((previous) => previous && fetchedClasses.some((cls) => cls.id === previous) ? previous : null);
      } catch (error) {
        if (!isStillCurrent()) return;
        setLibraries([]);
        setSelectedClassId(null);
        showToast(friendlyError(error, 'load your notes library'));
      } finally {
        if (isStillCurrent()) setLoading(false);
      }
    };

    void fetchClasses();
    return () => { cancelled = true; };
  }, [currentUser, tenantId]);

  const currentClass = useMemo(() => {
    return libraries.find((cls) => cls.id === selectedClassId) || null;
  }, [libraries, selectedClassId]);

  const filteredResources = useMemo(() => {
    if (!currentClass) return [];
    const query = searchQuery.trim().toLowerCase();
    return currentClass.resources.filter((res) => {
      const matchesCategory = selectedCategory === 'All' || res.category === selectedCategory;
      const matchesSearch = res.title.toLowerCase().includes(query);
      return matchesCategory && matchesSearch;
    });
  }, [currentClass, selectedCategory, searchQuery]);

  const ensureActiveTenant = (expectedUid: string, expectedTenant: string): boolean => {
    return Boolean(auth.currentUser && auth.currentUser.uid === expectedUid && tenantId === expectedTenant && normalizeEmail(currentUser?.email) === expectedTenant);
  };

  const handleCopyLink = async (shareUrl: string, id: string) => {
    try {
      const url = new URL(shareUrl, window.location.origin);
      if (url.origin !== window.location.origin || url.pathname !== '/notes/share') {
        throw new Error('Invalid resource share link.');
      }
      await navigator.clipboard.writeText(url.toString());
      setCopiedId(id);
      showToast('Share link copied to clipboard!');
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopiedId(null), 2000);
    } catch {
      showToast('Could not copy the link. Check browser clipboard permissions.');
    }
  };

  const triggerFileDownload = (url: string, fileName: string) => {
    const link = document.createElement('a');
    link.href = url;
    link.download = sanitizeFileName(fileName);
    link.rel = 'noopener noreferrer';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Legacy base64 files remain readable. New uploads are stored in Firebase Storage, not Firestore.
  const handleDownloadResource = async (resource: LibraryResource) => {
    if (!currentUser || !tenantId || !ensureActiveTenant(currentUser.uid, tenantId)) {
      showToast('Please sign in again to access this resource.');
      return;
    }
    try {
      if (resource.fileDataUrl && /^data:[a-zA-Z0-9.+/-]+(?:;[a-zA-Z0-9=+._-]+)*,/i.test(resource.fileDataUrl)) {
        triggerFileDownload(resource.fileDataUrl, resource.fileName || `${resource.title}.pdf`);
        showToast('Download started!');
        return;
      }
      if (resource.storagePath) {
        const expectedPrefix = `notes/${currentUser.uid}/classes/${selectedClassId}/`;
        if (!selectedClassId || !resource.storagePath.startsWith(expectedPrefix) || resource.storagePath.includes('..')) {
          throw new Error('Resource storage path does not belong to the selected teacher and class.');
        }
        const url = await getDownloadURL(storageRef(getStorage(auth.app), resource.storagePath));
        if (!ensureActiveTenant(currentUser.uid, tenantId)) return;
        triggerFileDownload(url, resource.fileName || `${resource.title}.pdf`);
        showToast('Download started!');
        return;
      }

      const fileContent = `Document Title: ${resource.title}\nCategory: ${resource.category}\n\nNotes:\n${resource.contentPreview || 'No notes provided.'}`;
      const blob = new Blob([fileContent], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      triggerFileDownload(url, `${resource.title.replace(/\s+/g, '_')}.txt`);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast('Text file downloaded!');
    } catch (error) {
      showToast(friendlyError(error, 'download this resource'));
    }
  };

  const handleUploadSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (uploadInFlightRef.current) return;
    const title = sanitizeDisplayText(newTitle, 180);
    if (!title || !selectedClassId || !currentClass || !currentUser || !tenantId) {
      showToast('Select a class and enter a valid title before uploading.');
      return;
    }
    if (!fileObject) {
      showToast('Choose a file before uploading.');
      return;
    }
    if (!ensureActiveTenant(currentUser.uid, tenantId)) {
      showToast('Your teacher session changed. Please sign in again.');
      return;
    }

    let fileUploaded = false;
    let storedPath = '';
    let destinationDocRef: ReturnType<typeof doc> | null = null;
    let documentSaved = false;
    uploadInFlightRef.current = true;
    setIsUploading(true);

    try {
      const fileInfo = validateUploadFile(fileObject);
      const resourceId = makeResourceId();
      const cleanFileName = sanitizeFileName(fileObject.name);
      const currentClassId = selectedClassId;
      const operationUid = currentUser.uid;
      const operationTenant = tenantId;
      storedPath = `notes/${operationUid}/classes/${currentClassId}/${resourceId}/${cleanFileName}`;
      const storage = getStorage(auth.app);
      await uploadBytes(storageRef(storage, storedPath), fileObject, {
        contentType: fileInfo.mimeType,
        contentDisposition: `attachment; filename="${cleanFileName.replace(/"/g, '_')}"`,
        customMetadata: { ownerUid: operationUid, classId: currentClassId, resourceId },
      });
      fileUploaded = true;

      if (!ensureActiveTenant(operationUid, operationTenant)) throw new Error('Your session changed while the file was uploading. Sign in again and retry.');

      const newResourceItem: LibraryResource = {
        id: resourceId,
        title,
        category: newCategory,
        fileType: fileInfo.fileType,
        fileName: cleanFileName,
        fileSize: `${(fileObject.size / (1024 * 1024)).toFixed(2)} MB`,
        storagePath: storedPath,
        uploadDate: new Date().toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }),
        shareUrl: makeShareUrl(resourceId),
        contentPreview: sanitizeDisplayText(newDescription || 'Uploaded study material/CV for students.', 5000),
        _source: 'document',
      };
      destinationDocRef = doc(db, 'users', operationTenant, 'classes', currentClassId, 'documents', resourceId);
      const storedResource = { ...newResourceItem };
      delete storedResource._source;
      await setDoc(destinationDocRef, storedResource);
      documentSaved = true;

      if (ensureActiveTenant(operationUid, operationTenant)) {
        setLibraries((prev) => prev.map((cls) => cls.id === currentClassId
          ? { ...cls, resources: [newResourceItem, ...cls.resources.filter((r) => r.id !== resourceId)] }
          : cls));
        setNewTitle('');
        setNewDescription('');
        setFileObject(null);
        setIsUploadModalOpen(false);
        showToast('Document saved to Database successfully!');
      }
    } catch (error) {
      // Avoid deleting an object if Firestore may have accepted the write despite a network error.
      if (fileUploaded && storedPath && !documentSaved && destinationDocRef) {
        try {
          const check = await getDoc(destinationDocRef);
          if (!check.exists()) await deleteObject(storageRef(getStorage(auth.app), storedPath));
        } catch { /* An orphaned private Storage object is safer than deleting a referenced file. */ }
      } else if (fileUploaded && storedPath && !documentSaved) {
        try { await deleteObject(storageRef(getStorage(auth.app), storedPath)); } catch { /* Best-effort cleanup. */ }
      }
      showToast(error instanceof Error && !('code' in error) ? error.message : friendlyError(error, 'save this resource'));
    } finally {
      uploadInFlightRef.current = false;
      setIsUploading(false);
    }
  };

  const handleOpenEdit = (res: LibraryResource) => {
    setEditingResource(res);
    setEditTitle(res.title);
    setEditCategory(res.category);
    setEditDescription(res.contentPreview || '');
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingResource || !selectedClassId || !currentClass || !currentUser || !tenantId) return;
    const title = sanitizeDisplayText(editTitle, 180);
    if (!title) { showToast('Enter a valid resource title.'); return; }
    if (!VALID_CATEGORIES.has(editCategory)) { showToast('Choose a valid category.'); return; }
    const operationUid = currentUser.uid;
    const operationTenant = tenantId;
    const classId = selectedClassId;
    const resourceId = editingResource.id;
    if (!ensureActiveTenant(operationUid, operationTenant)) { showToast('Your teacher session changed. Please sign in again.'); return; }
    setIsSavingEdit(true);

    const updatedData = {
      title,
      category: editCategory,
      contentPreview: sanitizeDisplayText(editDescription, 5000),
    };

    try {
      if (editingResource._source === 'embedded') {
        const classRef = doc(db, 'users', operationTenant, 'classes', classId);
        await runTransaction(db, async (transaction) => {
          const snap = await transaction.get(classRef);
          if (!snap.exists()) throw new Error('This class no longer exists.');
          const currentResources = snap.data().resources;
          if (!Array.isArray(currentResources)) throw new Error('The legacy resources field is malformed; no changes were saved.');
          const index = currentResources.findIndex((item: any) => String(item?.id ?? '') === resourceId);
          if (index < 0) throw new Error('This legacy resource no longer exists. Refresh the library.');
          const nextResources = currentResources.map((item: any, idx: number) => idx === index ? { ...item, ...updatedData } : item);
          transaction.update(classRef, { resources: nextResources });
        });
      } else {
        const resourceRef = doc(db, 'users', operationTenant, 'classes', classId, 'documents', resourceId);
        await runTransaction(db, async (transaction) => {
          const snap = await transaction.get(resourceRef);
          if (!snap.exists()) throw new Error('This resource no longer exists. Refresh the library.');
          transaction.update(resourceRef, updatedData);
        });
      }

      if (ensureActiveTenant(operationUid, operationTenant)) {
        setLibraries((prev) => prev.map((cls) => cls.id === classId
          ? { ...cls, resources: cls.resources.map((r) => r.id === resourceId ? { ...r, ...updatedData } : r) }
          : cls));
        setEditingResource(null);
        showToast('Document updated successfully!');
      }
    } catch (error) {
      showToast(error instanceof Error && !('code' in error) ? error.message : friendlyError(error, 'update this resource'));
    } finally {
      setIsSavingEdit(false);
    }
  };

  const confirmDeleteResource = async () => {
    if (!deletingResId || !selectedClassId || !currentClass || !currentUser || !tenantId) return;
    const operationUid = currentUser.uid;
    const operationTenant = tenantId;
    const classId = selectedClassId;
    const resourceId = deletingResId;
    const resource = currentClass.resources.find((item) => item.id === resourceId);
    if (!resource) { setDeletingResId(null); showToast('Resource was not found. Refresh the library.'); return; }
    if (!ensureActiveTenant(operationUid, operationTenant)) { showToast('Your teacher session changed. Please sign in again.'); return; }

    try {
      if (resource._source === 'embedded') {
        const classRef = doc(db, 'users', operationTenant, 'classes', classId);
        await runTransaction(db, async (transaction) => {
          const snap = await transaction.get(classRef);
          if (!snap.exists()) throw new Error('This class no longer exists.');
          const currentResources = snap.data().resources;
          if (!Array.isArray(currentResources)) throw new Error('The legacy resources field is malformed; no changes were made.');
          const hasResource = currentResources.some((item: any) => String(item?.id ?? '') === resourceId);
          if (!hasResource) throw new Error('This legacy resource no longer exists. Refresh the library.');
          transaction.update(classRef, { resources: currentResources.filter((item: any) => String(item?.id ?? '') !== resourceId) });
        });
      } else {
        const resourceRef = doc(db, 'users', operationTenant, 'classes', classId, 'documents', resourceId);
        await runTransaction(db, async (transaction) => {
          const snap = await transaction.get(resourceRef);
          if (!snap.exists()) throw new Error('This resource no longer exists. Refresh the library.');
          transaction.delete(resourceRef);
        });
      }

      let cleanupWarning = false;
      if (resource.storagePath) {
        const expectedPrefix = `notes/${operationUid}/classes/${classId}/`;
        if (!resource.storagePath.startsWith(expectedPrefix) || resource.storagePath.includes('..')) {
          cleanupWarning = true; // Do not delete an object outside the verified owner/class prefix.
        } else {
          try { await deleteObject(storageRef(getStorage(auth.app), resource.storagePath)); }
          catch { cleanupWarning = true; } // Firestore deletion has succeeded; leave private orphan for cleanup.
        }
      }

      if (ensureActiveTenant(operationUid, operationTenant)) {
        setLibraries((prev) => prev.map((cls) => cls.id === classId
          ? { ...cls, resources: cls.resources.filter((item) => item.id !== resourceId) }
          : cls));
        showToast(cleanupWarning ? 'Resource deleted, but its stored file needs cleanup.' : 'Document deleted successfully!');
      }
    } catch (error) {
      showToast(error instanceof Error && !('code' in error) ? error.message : friendlyError(error, 'delete this resource'));
    } finally {
      setDeletingResId(null);
    }
  };

  return (
    <div className={`min-h-screen bg-[#f8fafc] dark:bg-[#070b13] text-slate-900 dark:text-slate-100 transition-colors duration-300 pb-28 ${isDark ? 'dark' : ''}`}>

      {/* TOAST NOTIFICATION POPUP */}
      {toastMessage && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-50 bg-slate-900/90 dark:bg-orange-500/90 text-white border border-orange-500/50 px-4 py-2.5 rounded-2xl shadow-[0_0_20px_rgba(249,115,22,0.4)] backdrop-blur-md flex items-center gap-2 text-xs font-black animate-in fade-in slide-in-from-top-4 duration-300">
          <Sparkles className="h-4 w-4 text-yellow-300 animate-pulse" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* TOP HEADER */}
      <div className="w-full bg-white/80 dark:bg-[#070b13]/80 backdrop-blur-md sticky top-0 z-40 border-b border-slate-200/50 dark:border-slate-800/50 shadow-sm">
        <div className="mx-auto max-w-2xl px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {selectedClassId ? (
              <button
                onClick={() => setSelectedClassId(null)}
                className="h-10 w-10 flex items-center justify-center rounded-full bg-orange-500/10 text-orange-500 hover:bg-orange-500 hover:text-white transition-all shadow-sm"
                title="Back to All Classes"
              >
                <ArrowLeft className="h-5 w-5" />
              </button>
            ) : (
              <button
                onClick={() => navigate('/')}
                className="h-10 w-10 flex items-center justify-center rounded-full bg-orange-500/10 text-orange-500 hover:bg-orange-500 hover:text-white transition-all shadow-sm"
                title="Back to Dashboard"
              >
                <ArrowLeft className="h-5 w-5" />
              </button>
            )}
            
            <div>
              <h1 className="text-xl font-black tracking-tight text-slate-900 dark:text-white">
                {selectedClassId ? currentClass?.className : 'Notes & Library'}
              </h1>
              <p className="text-[10px] font-bold text-slate-400">
                {selectedClassId ? `Code: ${currentClass?.classCode}` : 'Select a class to view or upload materials'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {selectedClassId && (
              <button
                onClick={() => setIsUploadModalOpen(true)}
                className="bg-orange-500 text-white hover:bg-orange-600 px-3 py-1.5 rounded-2xl text-xs font-black flex items-center gap-1.5 shadow-[0_0_15px_rgba(249,115,22,0.4)] transition-all active:scale-95"
              >
                <Plus className="h-4 w-4" /> Upload
              </button>
            )}

            <button
              onClick={() => setIsDark(!isDark)}
              className="flex h-7 w-12 items-center rounded-full bg-slate-200/60 p-0.5 transition-all dark:bg-slate-800 border border-slate-300/30"
            >
              <div className={`flex h-5 w-5 items-center justify-center rounded-full bg-white text-orange-500 shadow-sm transition-all ${isDark ? 'translate-x-5 bg-slate-950 text-yellow-400' : ''}`}>
                {isDark ? <Moon className="h-3 w-3 fill-current" /> : <Sun className="h-3 w-3 fill-current" />}
              </div>
            </button>
          </div>
        </div>
      </div>

      {/* MAIN CONTAINER */}
      <main className="mx-auto max-w-2xl px-4 py-5 space-y-5 relative">
        
        {loading ? (
          <div className="flex flex-col items-center justify-center py-20 text-slate-400">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-orange-500 mb-4"></div>
            <p className="text-sm font-bold">Fetching classes from Database...</p>
          </div>
        ) : (
          <>
            {/* SCREEN 1: ALL CLASSES GRID */}
            {!selectedClassId && (
              <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
                
                <div className="bg-white dark:bg-[#0c1222] border-[3px] border-orange-500 rounded-3xl p-5 shadow-[0_0_20px_rgba(249,115,22,0.2)] hover:shadow-[0_0_35px_rgba(249,115,22,0.35)] transition-all duration-500 relative overflow-hidden group">
                  <div className="absolute top-0 right-0 -mr-16 -mt-16 w-48 h-48 bg-orange-500/10 blur-3xl rounded-full animate-pulse pointer-events-none"></div>

                  <div className="relative z-10 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <AlertCircle className="h-5 w-5 text-orange-500" />
                        <h2 className="text-lg font-black uppercase tracking-tight text-slate-900 dark:text-white">
                          Digital Library
                        </h2>
                      </div>
                      <span className="bg-orange-100 dark:bg-orange-500/10 text-orange-600 dark:text-orange-400 px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-wider animate-pulse border border-orange-200 dark:border-orange-500/20">
                        Live Engine
                      </span>
                    </div>
                    
                    <p className="text-sm text-slate-500 dark:text-slate-400 font-medium max-w-sm mt-1">
                      Upload PDF notes, CVs, textbooks, & past papers for students and generate instant shareable links.
                    </p>
                  </div>
                  
                  <BookOpen className="absolute -right-6 -bottom-6 h-36 w-36 text-orange-50 dark:text-orange-950/20 group-hover:scale-110 transition-transform duration-700 pointer-events-none" />
                </div>

                <div className="flex items-center justify-between pt-2">
                  <h3 className="text-xs font-black uppercase text-slate-400 tracking-wider">Your Classes</h3>
                  <span className="text-xs font-black text-orange-500">{libraries.length} Classes Available</span>
                </div>

                {libraries.length === 0 ? (
                  <div className="text-center py-10 bg-white dark:bg-slate-900 rounded-3xl border border-slate-200 dark:border-slate-800">
                    <p className="text-sm font-bold text-slate-500">No classes found in the database.</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {libraries.map((cls, index) => (
                      <div
                        key={cls.id}
                        onClick={() => {
                          setSelectedClassId(cls.id);
                          setSelectedCategory('All');
                        }}
                        style={{ animationDelay: `${index * 50}ms` }}
                        className="bg-white dark:bg-[#0c1222] border rounded-3xl p-4 shadow-sm cursor-pointer transition-all duration-300 group relative overflow-hidden border-slate-200/80 dark:border-slate-800 hover:-translate-y-1 hover:border-orange-500 hover:shadow-[0_0_25px_rgba(249,115,22,0.25)] animate-in fade-in slide-in-from-bottom-2"
                      >
                        <div className="flex items-start justify-between relative z-10">
                          <div className={`p-3 rounded-2xl border transition-colors duration-300 group-hover:bg-orange-500 group-hover:text-white group-hover:border-orange-500 ${cls.bgGradient || 'bg-slate-100 text-slate-600 border-slate-200'}`}>
                            <Folder className="h-6 w-6" />
                          </div>
                          <span className="text-[10px] font-black bg-slate-100 dark:bg-slate-800 px-2.5 py-1 rounded-full text-slate-500 dark:text-slate-400 group-hover:bg-orange-100 dark:group-hover:bg-orange-500/20 group-hover:text-orange-600 dark:group-hover:text-orange-400 transition-colors">
                            {cls.resources?.length || 0} Items
                          </span>
                        </div>

                        <div className="mt-4 space-y-1 relative z-10">
                          <h4 className="text-sm font-black text-slate-900 dark:text-white group-hover:text-orange-500 transition-colors">
                            {cls.className}
                          </h4>
                          <p className="text-[11px] font-bold text-slate-400">
                            Code: {cls.classCode} • {cls.totalStudents} Students
                          </p>
                        </div>

                        <div className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-800/80 flex items-center justify-between text-xs font-black text-slate-400 group-hover:text-orange-500 transition-colors relative z-10">
                          <span>Open Library</span>
                          <ArrowLeft className="h-3.5 w-3.5 rotate-180 group-hover:translate-x-1 transition-transform" />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* SCREEN 2: INSIDE SELECTED CLASS LIBRARY */}
            {selectedClassId && currentClass && (
              <div className="space-y-4 animate-in fade-in slide-in-from-right-4 duration-500">
                <div className="space-y-3">
                  <div className="relative">
                    <Search className="absolute left-3.5 top-3 h-4 w-4 text-slate-400" />
                    <input
                      type="text"
                      placeholder="Search notes, books, or papers..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="w-full bg-white dark:bg-[#0c1222] text-slate-900 dark:text-white border border-slate-200/80 dark:border-slate-800 rounded-2xl pl-10 pr-4 py-2.5 text-xs font-bold outline-none focus:border-orange-500 focus:shadow-[0_0_15px_rgba(249,115,22,0.2)] transition-all shadow-sm"
                    />
                  </div>

                  <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none">
                    {(['All', 'Notes', 'Textbooks', 'Past Papers', 'Assignments'] as ResourceCategory[]).map((cat) => {
                      const isActive = selectedCategory === cat;
                      return (
                        <button
                          key={cat}
                          onClick={() => setSelectedCategory(cat)}
                          className={`px-3.5 py-1.5 rounded-2xl text-xs font-black whitespace-nowrap transition-all ${
                            isActive
                              ? 'bg-orange-500 text-white shadow-[0_0_12px_rgba(249,115,22,0.4)] scale-105'
                              : 'bg-white dark:bg-[#0c1222] text-slate-500 dark:text-slate-400 border border-slate-200/80 dark:border-slate-800 hover:border-orange-500/50 hover:text-slate-900 dark:hover:text-white'
                          }`}
                        >
                          {cat}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {filteredResources.length === 0 ? (
                  <div className="bg-white dark:bg-[#0c1222] border border-slate-200/80 dark:border-slate-800 rounded-3xl p-8 text-center space-y-3 shadow-sm animate-in fade-in zoom-in-95">
                    <div className="h-12 w-12 rounded-full bg-orange-500/10 text-orange-500 mx-auto flex items-center justify-center animate-pulse">
                      <FileText className="h-6 w-6" />
                    </div>
                    <div>
                      <h4 className="text-sm font-black text-slate-900 dark:text-white">No Study Material Found</h4>
                      <p className="text-xs text-slate-400 font-medium mt-1">
                        Upload notes or books for this class to get started.
                      </p>
                    </div>
                    <button
                      onClick={() => setIsUploadModalOpen(true)}
                      className="bg-orange-500 text-white px-5 py-2.5 mt-2 rounded-2xl text-xs font-black shadow-[0_0_15px_rgba(249,115,22,0.3)] inline-flex items-center gap-1.5 hover:bg-orange-600 hover:scale-105 transition-all"
                    >
                      <Plus className="h-4 w-4" /> Upload Material
                    </button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {filteredResources.map((res, index) => (
                      <div
                        key={res.id}
                        style={{ animationDelay: `${index * 50}ms` }}
                        className="relative bg-white dark:bg-[#0c1222] border-2 border-orange-500/40 dark:border-orange-500/50 rounded-3xl p-4 shadow-[0_0_15px_rgba(249,115,22,0.15)] hover:shadow-[0_0_25px_rgba(249,115,22,0.3)] hover:border-orange-500 transition-all duration-300 space-y-3 group animate-in fade-in slide-in-from-bottom-2"
                      >
                        <div className="flex items-start justify-between gap-2 relative z-10">
                          <div className="flex items-start gap-3">
                            <div className="h-10 w-10 rounded-2xl bg-orange-500/10 text-orange-600 dark:text-orange-400 flex items-center justify-center flex-shrink-0 mt-0.5 group-hover:scale-110 group-hover:bg-orange-500 group-hover:text-white transition-all duration-300">
                              <FileText className="h-5 w-5" />
                            </div>
                            <div>
                              <span className="text-[9px] font-black uppercase tracking-wider bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 px-2 py-0.5 rounded-md">
                                {res.category}
                              </span>
                              <h4 className="text-xs font-black mt-1 text-slate-900 dark:text-white group-hover:text-orange-500 transition-colors">
                                {res.title}
                              </h4>
                              <p className="text-[10px] font-bold text-slate-400 mt-0.5">
                                {res.fileSize} • Uploaded on {res.uploadDate}
                              </p>
                            </div>
                          </div>

                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => handleOpenEdit(res)}
                              className="text-slate-400 hover:text-orange-500 hover:bg-orange-50 dark:hover:bg-orange-500/10 p-1.5 rounded-xl transition-colors"
                              title="Edit Document"
                            >
                              <Pencil className="h-4 w-4" />
                            </button>
                            <button
                              onClick={() => setDeletingResId(res.id)}
                              className="text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-500/10 p-1.5 rounded-xl transition-colors"
                              title="Delete Material"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        </div>

                        <div className="bg-slate-50 dark:bg-[#070b13] p-2.5 rounded-2xl border border-slate-100 dark:border-slate-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-2 relative z-10">
                          <div className="flex items-center gap-2 truncate text-[10px] font-mono font-bold text-slate-500 dark:text-slate-400 bg-white dark:bg-slate-900 px-2.5 py-1.5 rounded-xl border border-slate-200/60 dark:border-slate-800">
                            <Share2 className="h-3 w-3 text-orange-500 flex-shrink-0" />
                            <span className="truncate">{res.shareUrl}</span>
                          </div>

                          <div className="flex items-center gap-2 self-end sm:self-auto">
                            <button
                              onClick={() => handleCopyLink(res.shareUrl, res.id)}
                              className={`px-3 py-1.5 rounded-xl text-[11px] font-black flex items-center gap-1 transition-all ${
                                copiedId === res.id
                                  ? 'bg-emerald-500 text-white shadow-[0_0_10px_rgba(16,185,129,0.4)]'
                                  : 'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:text-orange-500 hover:border-orange-500'
                              }`}
                            >
                              {copiedId === res.id ? (
                                <>
                                  <Check className="h-3 w-3" /> Copied!
                                </>
                              ) : (
                                <>
                                  <Copy className="h-3 w-3" /> Share Link
                                </>
                              )}
                            </button>

                            <button
                              onClick={() => setPreviewResource(res)}
                              className="bg-orange-500 text-white hover:bg-orange-600 px-3 py-1.5 rounded-xl text-[11px] font-black flex items-center gap-1 shadow-md hover:shadow-[0_0_12px_rgba(249,115,22,0.4)] transition-all"
                            >
                              <Eye className="h-3 w-3" /> Preview
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </main>

      {/* DELETE CONFIRMATION DIALOG */}
      {deletingResId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md p-4 animate-in fade-in duration-200">
          <div className="bg-white dark:bg-[#0c1222] border-2 border-rose-500/50 rounded-3xl max-w-xs w-full p-6 shadow-[0_0_40px_rgba(244,63,94,0.3)] space-y-4 text-center animate-in zoom-in-95">
            <div className="h-14 w-14 rounded-2xl bg-rose-500/10 text-rose-500 mx-auto flex items-center justify-center border border-rose-500/20 shadow-inner">
              <AlertTriangle className="h-7 w-7" />
            </div>
            <div>
              <h3 className="text-base font-black text-slate-900 dark:text-white">Delete Document?</h3>
              <p className="text-xs text-slate-400 font-bold mt-1">
                Are you sure you want to delete this document?
              </p>
            </div>
            <div className="flex items-center gap-2 pt-2">
              <button
                onClick={() => setDeletingResId(null)}
                className="flex-1 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 py-3 rounded-2xl text-xs font-black hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmDeleteResource}
                className="flex-1 bg-rose-500 text-white py-3 rounded-2xl text-xs font-black hover:bg-rose-600 transition-all shadow-[0_0_15px_rgba(244,63,94,0.4)]"
              >
                Yes, Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* EDIT MATERIAL MODAL */}
      {editingResource && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="bg-white dark:bg-[#0c1222] border-2 border-orange-500/50 rounded-3xl max-w-md w-full p-6 shadow-[0_0_40px_rgba(249,115,22,0.3)] space-y-4 animate-in zoom-in-95">
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
              <h3 className="text-sm font-black text-slate-900 dark:text-white flex items-center gap-2">
                <Pencil className="h-4 w-4 text-orange-500" /> Edit Document
              </h3>
              <button
                onClick={() => setEditingResource(null)}
                className="p-1 text-slate-400 hover:text-slate-900 dark:hover:text-white transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleSaveEdit} className="space-y-4">
              <div>
                <label className="text-[11px] font-black text-slate-400 block mb-1">
                  Title / Subject Name *
                </label>
                <input
                  type="text"
                  required
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  className="w-full bg-slate-50 dark:bg-[#070b13] text-slate-900 dark:text-white border border-slate-200 dark:border-slate-800 rounded-2xl px-3.5 py-2 text-xs font-bold outline-none focus:border-orange-500 transition-all"
                />
              </div>

              <div>
                <label className="text-[11px] font-black text-slate-400 block mb-1">
                  Category *
                </label>
                <select
                  value={editCategory}
                  onChange={(e) => setEditCategory(e.target.value as Exclude<ResourceCategory, 'All'>)}
                  className="w-full bg-slate-50 dark:bg-[#070b13] text-slate-900 dark:text-white border border-slate-200 dark:border-slate-800 rounded-2xl px-3.5 py-2 text-xs font-bold outline-none focus:border-orange-500 transition-all"
                >
                  <option value="Notes">Notes</option>
                  <option value="Textbooks">Textbooks</option>
                  <option value="Past Papers">Past Papers</option>
                  <option value="Assignments">Assignments</option>
                </select>
              </div>

              <div>
                <label className="text-[11px] font-black text-slate-400 block mb-1">
                  Description / Preview Notes
                </label>
                <textarea
                  rows={3}
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  className="w-full bg-slate-50 dark:bg-[#070b13] text-slate-900 dark:text-white border border-slate-200 dark:border-slate-800 rounded-2xl px-3.5 py-2 text-xs font-bold outline-none focus:border-orange-500 transition-all resize-none"
                />
              </div>

              <div className="flex items-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setEditingResource(null)}
                  className="flex-1 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 py-3 rounded-2xl text-xs font-black hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSavingEdit || !editTitle}
                  className="flex-1 bg-orange-500 text-white py-3 rounded-2xl text-xs font-black hover:bg-orange-600 disabled:opacity-50 transition-all shadow-[0_0_15px_rgba(249,115,22,0.4)]"
                >
                  {isSavingEdit ? 'Updating...' : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* UPLOAD MATERIAL MODAL */}
      {isUploadModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="bg-white dark:bg-[#0c1222] border-2 border-orange-500/50 rounded-3xl max-w-md w-full p-6 shadow-[0_0_40px_rgba(249,115,22,0.3)] space-y-4 animate-in zoom-in-95">
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
              <h3 className="text-sm font-black text-slate-900 dark:text-white flex items-center gap-2">
                <Upload className="h-4 w-4 text-orange-500" /> Upload Study Material / CV
              </h3>
              <button
                onClick={() => setIsUploadModalOpen(false)}
                className="p-1 text-slate-400 hover:text-slate-900 dark:hover:text-white transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleUploadSubmit} className="space-y-4">
              <div>
                <label className="text-[11px] font-black text-slate-400 block mb-1">
                  Title / Subject Name *
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. My Resume / CV"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  className="w-full bg-slate-50 dark:bg-[#070b13] text-slate-900 dark:text-white border border-slate-200 dark:border-slate-800 rounded-2xl px-3.5 py-2 text-xs font-bold outline-none focus:border-orange-500 transition-all"
                />
              </div>

              <div>
                <label className="text-[11px] font-black text-slate-400 block mb-1">
                  Category *
                </label>
                <select
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value as Exclude<ResourceCategory, 'All'>)}
                  className="w-full bg-slate-50 dark:bg-[#070b13] text-slate-900 dark:text-white border border-slate-200 dark:border-slate-800 rounded-2xl px-3.5 py-2 text-xs font-bold outline-none focus:border-orange-500 transition-all"
                >
                  <option value="Notes">Notes</option>
                  <option value="Textbooks">Textbooks</option>
                  <option value="Past Papers">Past Papers</option>
                  <option value="Assignments">Assignments</option>
                </select>
              </div>

              <div>
                <label className="text-[11px] font-black text-slate-400 block mb-1">
                  Attach File (PDF / Doc) *
                </label>
                <div 
                  className="border-2 border-dashed border-slate-200 dark:border-slate-800 rounded-2xl p-5 text-center hover:border-orange-500 hover:bg-orange-50 dark:hover:bg-orange-500/5 transition-all bg-slate-50/50 dark:bg-[#070b13]/50 group cursor-pointer relative overflow-hidden"
                >
                  <input
                    type="file"
                    accept=".pdf,.doc,.docx,.png,.jpg"
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    onChange={(e) => {
                      const selectedFile = e.target.files?.[0];
                      if (!selectedFile) return;
                      try {
                        validateUploadFile(selectedFile);
                        setFileObject(selectedFile);
                      } catch (error) {
                        setFileObject(null);
                        e.currentTarget.value = '';
                        showToast(error instanceof Error ? error.message : 'This file is not supported.');
                      }
                    }}
                  />
                  <Upload className="h-6 w-6 text-orange-500 mx-auto mb-2 group-hover:scale-110 transition-transform" />
                  <p className="text-xs font-black text-slate-700 dark:text-slate-300">
                    {fileObject ? fileObject.name : 'Select PDF / Document File'}
                  </p>
                  <p className="text-[10px] text-slate-400 font-bold mt-1">Supports PDF, DOCX, PNG</p>
                </div>
              </div>

              <div>
                <label className="text-[11px] font-black text-slate-400 block mb-1">
                  Description / Quick Notes
                </label>
                <textarea
                  placeholder="Additional notes..."
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                  rows={2}
                  className="w-full bg-slate-50 dark:bg-[#070b13] text-slate-900 dark:text-white border border-slate-200 dark:border-slate-800 rounded-2xl px-3.5 py-2 text-xs font-bold outline-none focus:border-orange-500 transition-all resize-none"
                />
              </div>

              <div className="flex items-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setIsUploadModalOpen(false)}
                  className="flex-1 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 py-3 rounded-2xl text-xs font-black hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isUploading || !newTitle}
                  className="flex-1 bg-orange-500 text-white py-3 rounded-2xl text-xs font-black hover:bg-orange-600 disabled:opacity-50 transition-all shadow-[0_0_15px_rgba(249,115,22,0.4)]"
                >
                  {isUploading ? 'Saving...' : 'Save to Database'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* PREVIEW & DOWNLOAD MODAL */}
      {previewResource && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-in fade-in duration-200">
          <div className="bg-white dark:bg-[#0c1222] rounded-3xl max-w-sm w-full shadow-[0_0_40px_rgba(0,0,0,0.5)] overflow-hidden flex flex-col animate-in zoom-in-95 border border-slate-200 dark:border-slate-800">
            <div className="p-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between bg-slate-50/50 dark:bg-slate-900/50">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 bg-orange-500/10 text-orange-500 rounded-2xl flex items-center justify-center">
                  <FileText className="h-5 w-5" />
                </div>
                <div>
                  <span className="text-[9px] font-black uppercase tracking-widest text-orange-500 bg-orange-500/10 px-2 py-0.5 rounded-full mb-0.5 inline-block">
                    STUDENT VIEW • {previewResource.category}
                  </span>
                  <h3 className="text-sm font-black text-slate-900 dark:text-white truncate max-w-[200px]">
                    {previewResource.title}
                  </h3>
                </div>
              </div>
              <button
                onClick={() => setPreviewResource(null)}
                className="text-slate-400 hover:text-slate-900 dark:hover:text-white p-1"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            
            <div className="p-6 flex-1 flex flex-col items-center justify-center space-y-4 bg-slate-50 dark:bg-[#070b13]">
              <div className="w-full flex items-center justify-between text-[10px] font-mono text-slate-400 border-b border-slate-200 dark:border-slate-800 pb-2 mb-2">
                <span>PDF Document</span>
                <span>{previewResource.fileSize}</span>
              </div>
              
              <div className="text-sm text-slate-600 dark:text-slate-300 text-center font-medium my-4">
                {previewResource.contentPreview}
              </div>

              <div className="w-full pt-4">
                <button 
                  onClick={() => handleDownloadResource(previewResource)}
                  className="w-full bg-orange-500 hover:bg-orange-600 text-white font-black py-3.5 rounded-2xl text-xs flex items-center justify-center gap-2 shadow-[0_0_20px_rgba(249,115,22,0.3)] transition-all active:scale-95"
                >
                  <Download className="h-4 w-4" />
                  Download Complete File
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      <BottomNavbar />
    </div>
  );
}
