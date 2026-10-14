import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { 
  collection,
  getDocsFromServer,
  getDocFromServer,
  doc,
  query,
  where,
  onSnapshot,
  runTransaction
} from 'firebase/firestore';
import { onAuthStateChanged } from 'firebase/auth';
import { db, auth } from '../lib/firebase';
import {
  Search,
  Bell,
  Sun,
  Moon,
  ChevronRight,
  ChevronLeft,
  Calendar as CalendarIcon,
  Users,
  Home,
  GraduationCap,
  Settings,
  Wallet,
  Check,
  Save,
  Sparkles,
  UserCheck,
  UserX,
  CheckCircle2,
  AlertCircle,
  ShieldCheck,
  SlidersHorizontal,
  Lock,
  AlertTriangle,
  X,
  ArrowLeft,
  CalendarDays
} from 'lucide-react';

const ITEMS_PER_PAGE = 10;
const CLASS_MODAL_ITEMS_PER_PAGE = 7;

const DEFAULT_AVATAR = 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100&auto=format&fit=crop&q=80';

// ----------------------------------------------------------------------
// ATTENDANCE DATA HELPERS (pure functions, no Firebase calls)
// Students are read in the same formats as DepartmentsPage / Fees and are NEVER rewritten here:
//   1) students: [ {...}, {...} ]        (canonical array)
//   2) students: { "0": {...}, "1": {...} }   (map, e.g. damaged by an older Fees bug)
//   3) legacy student records stored as top-level class-document fields
// ----------------------------------------------------------------------
// <<ATTENDANCE_HELPERS_START>>
// Top-level class fields that are never student records
const RESERVED_CLASS_KEYS = ['id', 'name', 'code', 'monthlyFee', 'className', 'title', 'fee', 'classFee', 'createdAt', 'createdDate', 'date', 'updatedAt', 'students'];

// True only for plain objects ({}), never for arrays, null, Timestamps or other class instances
const isPlainObject = (value: any): boolean => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

// Used only for the legacy top-level layout, where a student must carry a name or an identifier
const isStudentRecord = (value: any): boolean => {
  if (!isPlainObject(value)) return false;
  return typeof value.name === 'string' || value.id !== undefined || value.studentId !== undefined;
};

const compareStudentKeys = (a: string, b: string): number => {
  const numA = Number(a);
  const numB = Number(b);
  if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
  return a.localeCompare(b);
};

type RawStudentLayout =
  | { kind: 'array' }
  | { kind: 'studentsMap' }
  | { kind: 'topLevelMap' }
  | { kind: 'empty' }
  | { kind: 'unsupported' };

// Detects HOW students are stored in a class document
const detectRawStudentLayout = (classData: any): RawStudentLayout => {
  if (!classData) return { kind: 'empty' };
  const students = classData.students;
  if (Array.isArray(students)) return { kind: 'array' };
  if (isPlainObject(students)) return { kind: 'studentsMap' };
  if (students !== undefined && students !== null) return { kind: 'unsupported' };
  const hasTopLevelStudents = Object.keys(classData).some(
    k => !RESERVED_CLASS_KEYS.includes(k) && isStudentRecord(classData[k])
  );
  return hasTopLevelStudents ? { kind: 'topLevelMap' } : { kind: 'empty' };
};

interface RawStudentEntry {
  key: string;
  value: any;
}

// Raw student entries exactly as stored (key = array index or map key). Never modifies anything.
const getRawStudentEntries = (classData: any): RawStudentEntry[] => {
  const layout = detectRawStudentLayout(classData);

  if (layout.kind === 'array') {
    return classData.students
      .map((value: any, index: number) => ({ key: String(index), value }))
      .filter((entry: RawStudentEntry) => isPlainObject(entry.value));
  }

  if (layout.kind === 'studentsMap') {
    return Object.keys(classData.students)
      .filter(k => isPlainObject(classData.students[k]))
      .sort(compareStudentKeys)
      .map(k => ({ key: k, value: classData.students[k] }));
  }

  if (layout.kind === 'topLevelMap') {
    return Object.keys(classData)
      .filter(k => !RESERVED_CLASS_KEYS.includes(k) && isStudentRecord(classData[k]))
      .sort(compareStudentKeys)
      .map(k => ({ key: k, value: classData[k] }));
  }

  return [];
};

// Existing tenant schema is email-keyed: users/{normalized authenticated email}/...
// Never fall back to UID, localStorage, a client-supplied email, or a global collection.
const getTenantDocId = (user: { email?: string | null; uid?: string | null } | null | undefined): string | null => {
  if (!user || typeof user.email !== 'string') return null;
  const normalizedEmail = user.email.trim().toLowerCase();
  return normalizedEmail || null;
};

const isSameTenantUser = (
  user: { email?: string | null; uid?: string | null } | null | undefined,
  expectedUid: string | null | undefined,
  expectedTenantId: string | null | undefined
): boolean => Boolean(
  user && expectedUid && expectedTenantId &&
  user.uid === expectedUid && getTenantDocId(user) === expectedTenantId
);

// Distinguishes permission, authentication and network failures from an ordinary empty result.
const describeFirestoreError = (error: any, what: string): string => {
  const rawCode = String(error?.code || '');
  const code = rawCode.replace(/^firestore\//, '');
  if (code === 'permission-denied') return `Access denied: Firebase Security Rules denied ${what}.`;
  if (code === 'unauthenticated') return `You are signed out. Please sign in again before accessing ${what}.`;
  if (code === 'unavailable' || code === 'deadline-exceeded' || code === 'cancelled' || code === 'network-request-failed') {
    return `Network problem: could not complete ${what}. Check your connection and retry.`;
  }
  if (code === 'failed-precondition') return `Firestore rejected ${what}. Inspect the full console error; if it explicitly requests an index, deploy that index and retry.`;
  return `Could not complete ${what}${code ? ` (${code})` : ''}.`;
};

const normalizeGender = (rawGender: any): 'M' | 'F' => {
  const g = String(rawGender ?? '').trim().toLowerCase();
  if (g.startsWith('f') || g.includes('female') || g.includes('girl')) return 'F';
  return 'M';
};

interface ClassBuildResult {
  cls: { id: string; name: string; code: string; students: any[] };
  issues: string[];
}

// Builds one class (and its student roster) from a Firestore class document.
// Real student ids are preserved; ids are never generated from indexes, roll numbers or names.
const buildClassFromData = (classId: string, rawData: any): ClassBuildResult => {
  const data = rawData && typeof rawData === 'object' ? rawData : {};
  const issues: string[] = [];
  const className = String(data.name || data.className || data.title || 'Unnamed Class');
  const label = `Class "${className}" (${classId})`;

  const layout = detectRawStudentLayout(data);
  if (layout.kind === 'unsupported') {
    issues.push(`${label}: students are stored in an unsupported format (${typeof data.students}).`);
  }

  const entries = getRawStudentEntries(data);
  const seenIds = new Set<string>();
  const duplicateIds: string[] = [];
  let missingIdCount = 0;
  const students: any[] = [];

  entries.forEach((entry, index) => {
    const s = entry.value;
    const keyLooksLikeArrayIndex = /^(0|[1-9]\d*)$/.test(entry.key) && Number(entry.key) < 4294967295;
    const stableMapKey = layout.kind !== 'array' && !keyLooksLikeArrayIndex ? entry.key : undefined;
    const rawId = s.id ?? s.studentId ?? stableMapKey;
    if (rawId === undefined || rawId === null || String(rawId).trim() === '') {
      missingIdCount++;
      return;
    }
    const idKey = String(rawId);
    if (seenIds.has(idKey)) {
      duplicateIds.push(idKey);
      return;
    }
    seenIds.add(idKey);

    students.push({
      ...s,
      id: rawId,
      name: String(s.name || `Student ${index + 1}`),
      rollNo: s.rollNo ? String(s.rollNo) : String(index + 1),
      gender: normalizeGender(s.gender),
      feeStatus: String(s.feeStatus || 'Unpaid'),
      avatar: s.avatar || DEFAULT_AVATAR,
    });
  });

  if (missingIdCount > 0) {
    issues.push(`${label}: ${missingIdCount} student record(s) have no id/studentId and were skipped (attendance needs a stable student id).`);
  }
  if (duplicateIds.length > 0) {
    issues.push(`${label}: duplicate student id(s) ${duplicateIds.join(', ')}; only the first record of each id is used.`);
  }

  students.sort((a: any, b: any) => {
    const numA = parseInt(a.rollNo, 10);
    const numB = parseInt(b.rollNo, 10);
    if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
    return String(a.rollNo).localeCompare(String(b.rollNo));
  });

  return {
    cls: {
      id: classId,
      name: className,
      code: String(data.code || 'N/A'),
      students
    },
    issues
  };
};

// A student without a saved entry is Present (existing application rule); only an explicit false is Absent
const toggleAttendanceValue = (
  map: Record<string, boolean>,
  studentId: string | number
): Record<string, boolean> => ({
  ...map,
  [studentId]: map[studentId] === false
});

// Complete map (one boolean per student of the selected class) in the existing attendanceMap format
const buildAttendanceMapForSave = (
  students: { id: string | number }[],
  map: Record<string, boolean>
): Record<string, boolean> => {
  const out: Record<string, boolean> = {};
  students.forEach(s => {
    out[s.id] = map[s.id] !== false;
  });
  return out;
};

// Fee status is display-only: "Unpaid" covers everyone who is not fully paid (Unpaid or Partial)
const matchesFeeFilter = (filter: 'ALL' | 'PAID' | 'UNPAID', feeStatus: any): boolean => {
  if (filter === 'ALL') return true;
  const isPaid = String(feeStatus ?? '').toLowerCase() === 'paid';
  return filter === 'PAID' ? isPaid : !isPaid;
};

const pad2 = (n: number): string => String(n).padStart(2, '0');

// Today in the user's LOCAL calendar (toISOString() would return the UTC date)
const toLocalDateStr = (d: Date): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

const DATE_STR_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const isValidDateStr = (value: unknown): value is string => {
  if (typeof value !== 'string' || !DATE_STR_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

// Stored date-only strings are calendar dates; Firestore Timestamps and ISO datetime strings
// are instants and are converted to the browser's local calendar day consistently.
const normalizeStoredDate = (rawDate: any): string | null => {
  if (typeof rawDate === 'string') {
    const value = rawDate.trim();
    if (isValidDateStr(value)) return value;
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : toLocalDateStr(parsed);
  }
  if (rawDate instanceof Date) {
    return Number.isNaN(rawDate.getTime()) ? null : toLocalDateStr(rawDate);
  }
  if (rawDate && typeof rawDate.toDate === 'function') {
    try {
      const date = rawDate.toDate();
      return date instanceof Date && !Number.isNaN(date.getTime()) ? toLocalDateStr(date) : null;
    } catch {
      return null;
    }
  }
  return null;
};

const normalizeAttendanceValue = (rawValue: any): boolean | null => {
  if (rawValue === true || rawValue === false) return rawValue;
  if (typeof rawValue !== 'string') return null;
  const value = rawValue.trim().toLowerCase();
  if (['present', 'late', 'on-time', 'ontime', '1'].includes(value)) return true;
  if (['absent', '0'].includes(value)) return false;
  return null;
};

const normalizeAttendanceMap = (rawMap: any): Record<string, boolean> | null => {
  if (!isPlainObject(rawMap)) return null;
  const normalized: Record<string, boolean> = {};
  for (const [studentId, rawValue] of Object.entries(rawMap)) {
    const value = normalizeAttendanceValue(rawValue);
    if (value === null) return null;
    normalized[studentId] = value;
  }
  return normalized;
};

interface AttendanceRecordValidation {
  ok: boolean;
  attendanceMap: Record<string, boolean>;
  isHoliday: boolean;
  issue?: string;
}

const validateAttendanceRecord = (
  data: any,
  expectedClassId: string,
  expectedDate: string
): AttendanceRecordValidation => {
  if (!isPlainObject(data)) {
    return { ok: false, attendanceMap: {}, isHoliday: false, issue: 'record is not an object' };
  }
  if (data.classId !== expectedClassId) {
    return { ok: false, attendanceMap: {}, isHoliday: false, issue: 'classId does not match its document path' };
  }
  const normalizedDate = normalizeStoredDate(data.date);
  if (!normalizedDate || normalizedDate !== expectedDate) {
    return { ok: false, attendanceMap: {}, isHoliday: false, issue: 'date is missing, malformed, or does not match its document path' };
  }
  if (data.className !== undefined && (typeof data.className !== 'string' || !data.className.trim())) {
    return { ok: false, attendanceMap: {}, isHoliday: false, issue: 'className is malformed' };
  }
  const isHoliday = data.isHoliday === true || String(data.status ?? '').trim().toLowerCase() === 'holiday';
  if (isHoliday) {
    return { ok: true, attendanceMap: {}, isHoliday: true };
  }
  const normalizedMap = normalizeAttendanceMap(data.attendanceMap);
  if (!normalizedMap) {
    return { ok: false, attendanceMap: {}, isHoliday: false, issue: 'attendanceMap is missing or contains unsupported status values' };
  }
  return { ok: true, attendanceMap: normalizedMap, isHoliday: false };
};

// Calendar-day arithmetic on YYYY-MM-DD strings, independent of the browser time zone.
const shiftDateStr = (dateStr: string, days: number): string => {
  if (!isValidDateStr(dateStr) || !Number.isFinite(days)) return dateStr;
  const [y, m, d] = dateStr.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + Math.trunc(days)));
  return shifted.toISOString().slice(0, 10);
};

// Dates strictly between two saved dates.
const listSkippedDates = (startStr: string, endStr: string): string[] => {
  if (!isValidDateStr(startStr) || !isValidDateStr(endStr) || startStr >= endStr) return [];
  const dates: string[] = [];
  let curr = shiftDateStr(startStr, 1);
  while (curr < endStr && dates.length < 5000) {
    dates.push(curr);
    curr = shiftDateStr(curr, 1);
  }
  return dates;
};
// <<ATTENDANCE_HELPERS_END>>

const processClassDoc = (docSnap: any): ClassBuildResult => buildClassFromData(docSnap.id, docSnap.data());

export default function Attendance() {
  // Tenant identity comes ONLY from Firebase Auth (never from localStorage)
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [authUserUid, setAuthUserUid] = useState<string | null>(null);
  const authContextRef = useRef<{ uid: string | null; tenantId: string | null }>({ uid: null, tenantId: null });
  const saveInFlightRef = useRef(false);
  const errorToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readyToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [authResolved, setAuthResolved] = useState(false);
  const [attendanceStatus, setAttendanceStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attendanceError, setAttendanceError] = useState('');
  const [attendanceRetryNonce, setAttendanceRetryNonce] = useState(0);
  const reportedCurrentErrorRef = useRef<string>('');
  const reportedHistoryErrorRef = useRef<string>('');
  const lastErrorToastRef = useRef<{ message: string; at: number } | null>(null);
  const reportedIssuesRef = useRef<string>('');
  const [isDark, setIsDark] = useState(false);
  const [activeTab, setActiveTab] = useState('attendance');
  const [classes, setClasses] = useState<any[]>([]);
  const [selectedClassId, setSelectedClassId] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoadingClasses, setIsLoadingClasses] = useState<boolean>(true);
  
  // Class Selection Modal States
  const [isClassModalOpen, setIsClassModalOpen] = useState<boolean>(false);
  const [classModalPage, setClassModalPage] = useState<number>(1);
  const [classModalSearch, setClassModalSearch] = useState<string>('');

  // Filters
  const [genderFilter, setGenderFilter] = useState<'ALL' | 'M' | 'F'>('ALL');
  const [feeFilter, setFeeFilter] = useState<'ALL' | 'PAID' | 'UNPAID'>('ALL');
  const [attendanceFilter, setAttendanceFilter] = useState<'ALL' | 'PRESENT' | 'ABSENT'>('ALL');
  
  // Confirmation Checkbox before save
  const [isReadyToSave, setIsReadyToSave] = useState(false);
  const [showReadyToast, setShowReadyToast] = useState(false);
  
  // Pagination State
  const [currentPage, setCurrentPage] = useState(1);

  // States for Lock & Duplicate Save Control
  const [isAlreadySaved, setIsAlreadySaved] = useState(false);
  const [showErrorToast, setShowErrorToast] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const [isSaved, setIsSaved] = useState(false);
  const [showTickOverlay, setShowTickOverlay] = useState(false);

  // Dynamic Date Setup
  const [selectedDate, setSelectedDate] = useState('');

  // Skipped Dates Modal States
  const [lastSavedDate, setLastSavedDate] = useState<string | null>(null);
  const [historyStatus, setHistoryStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [historyError, setHistoryError] = useState('');
  const [historyCheckedScope, setHistoryCheckedScope] = useState('');
  const [historyRetryNonce, setHistoryRetryNonce] = useState(0);
  const [skippedDates, setSkippedDates] = useState<string[]>([]);
  const [holidaySelections, setHolidaySelections] = useState<Record<string, boolean>>({});
  const [showSkipModal, setShowSkipModal] = useState<boolean>(false);
  const [isSavingSkipped, setIsSavingSkipped] = useState<boolean>(false);

  // The result is valid only for this exact tenant/class/date/auth scope.
  // This closes the render-to-effect window when a class or date changes.
  const historyScopeKey = JSON.stringify([tenantId, authUserUid, selectedClassId, selectedDate]);
  const isHistoryReadyForCurrentScope = historyStatus === 'ready' && historyCheckedScope === historyScopeKey;
  const isHistoryErrorForCurrentScope = historyStatus === 'error' && historyCheckedScope === historyScopeKey;

  // 1. LISTEN TO FIREBASE AUTH & RESOLVE THE TENANT (single source of truth: the signed-in user)
  useEffect(() => {
    if (!auth) {
      authContextRef.current = { uid: null, tenantId: null };
      setTenantId(null);
      setAuthUserUid(null);
      setClasses([]);
      setSelectedClassId('');
      setAttendanceMap({});
      setYesterdayAttendanceMap({});
      setIsAlreadySaved(false);
      setLastSavedDate(null);
      setHistoryStatus('loading');
      setHistoryError('');
      setHistoryCheckedScope('');
      setAuthResolved(true);
      setIsLoadingClasses(false);
      setAttendanceStatus('error');
      return;
    }

    const unsubscribe = onAuthStateChanged(auth, (user) => {
      const nextTenantId = getTenantDocId(user);
      const nextUid = user?.uid ?? null;
      const previous = authContextRef.current;
      const scopeChanged = previous.uid !== nextUid || previous.tenantId !== nextTenantId;

      // Update the ref synchronously so callbacks from an old listener cannot mutate state.
      authContextRef.current = { uid: nextUid, tenantId: nextTenantId };
      setTenantId(nextTenantId);
      setAuthUserUid(nextUid);

      if (scopeChanged || !user || !nextTenantId) {
        setClasses([]);
        setSelectedClassId('');
        setAttendanceMap({});
        setYesterdayAttendanceMap({});
        setIsAlreadySaved(false);
        setLastSavedDate(null);
        setHistoryStatus('loading');
        setHistoryError('');
        setHistoryCheckedScope('');
        setSkippedDates([]);
        setHolidaySelections({});
        setIsReadyToSave(false);
        setShowSkipModal(false);
        setIsSaved(false);
        setShowTickOverlay(false);
        setAttendanceStatus('loading');
        reportedIssuesRef.current = '';
      }

      // These values may help legacy pages but are never trusted for this page's scope.
      try {
        if (user && nextTenantId) {
          localStorage.setItem('userEmail', nextTenantId);
          localStorage.setItem('userUid', user.uid);
        } else {
          localStorage.removeItem('userEmail');
          localStorage.removeItem('userUid');
        }
      } catch (storageError) {
        console.warn('[Attendance] Could not update legacy localStorage hints:', storageError);
      }

      setIsLoadingClasses(Boolean(user && nextTenantId));
      setAuthResolved(true);
      if (user && !nextTenantId) {
        setAttendanceStatus('error');
        triggerErrorToast('Your signed-in account has no email. Attendance requires the existing email-keyed tenant profile.');
      } else if (!user) {
        setAttendanceStatus('error');
      }
    });

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    setSelectedDate(toLocalDateStr(new Date()));
  }, []);

  // 2. REAL-TIME FETCHING OF CLASSES & STUDENTS FROM FIREBASE
  // Only the signed-in tenant's own collection is read: users/{tenantId}/classes
  useEffect(() => {
    if (!db) {
      setIsLoadingClasses(false);
      setAttendanceStatus('error');
      return;
    }

    if (!authResolved) {
      setIsLoadingClasses(true);
      return;
    }

    // Always drop the previous tenant's data first (sign-out / account switch)
    setClasses([]);
    setSelectedClassId('');

    if (!tenantId || !authUserUid || !isSameTenantUser(auth?.currentUser, authUserUid, tenantId)) {
      setIsLoadingClasses(false);
      return;
    }

    setIsLoadingClasses(true);
    let cancelled = false;
    const subscribedUid = authUserUid;

    const classesRef = collection(db, 'users', tenantId, 'classes');
    const unsubscribe = onSnapshot(
      classesRef,
      (snapshot) => {
        if (cancelled || !isSameTenantUser(auth?.currentUser, subscribedUid, tenantId) ||
            authContextRef.current.uid !== subscribedUid || authContextRef.current.tenantId !== tenantId) return;

        const builtClasses: any[] = [];
        const issues: string[] = [];

        snapshot.docs.forEach((docSnap) => {
          try {
            const result = processClassDoc(docSnap);
            builtClasses.push(result.cls);
            issues.push(...result.issues);
          } catch (error) {
            console.error(`[Attendance] Could not read class document ${docSnap.id}:`, error);
            issues.push(`Class ${docSnap.id} could not be read (see console).`);
          }
        });

        builtClasses.sort((a: any, b: any) =>
          a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
        );

        setClasses(builtClasses);
        setSelectedClassId((prev) => {
          if (prev && builtClasses.some((c: any) => c.id === prev)) {
            return prev;
          }
          return builtClasses.length > 0 ? builtClasses[0].id : '';
        });
        setIsLoadingClasses(false);

        if (issues.length > 0) {
          issues.forEach((issue) => console.error(`[Attendance] ${issue}`));
          const signature = issues.join('|');
          if (reportedIssuesRef.current !== signature) {
            reportedIssuesRef.current = signature;
            triggerErrorToast(issues[0] + (issues.length > 1 ? ` (+${issues.length - 1} more, see console)` : ''));
          }
        } else {
          reportedIssuesRef.current = '';
        }
      },
      (error) => {
        if (cancelled || !isSameTenantUser(auth?.currentUser, subscribedUid, tenantId) ||
            authContextRef.current.uid !== subscribedUid || authContextRef.current.tenantId !== tenantId) return;
        console.error(`[Attendance] Class listener failed for users/${tenantId}/classes:`, error);
        setClasses([]);
        setSelectedClassId('');
        setIsLoadingClasses(false);
        triggerErrorToast(describeFirestoreError(error, 'your classes'));
      }
    );

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [authResolved, tenantId, authUserUid]);

  const currentClass = useMemo(() => {
    return classes.find((c) => c.id === selectedClassId) || { id: '', name: '', code: '', students: [] };
  }, [classes, selectedClassId]);

  const [attendanceMap, setAttendanceMap] = useState<Record<string | number, boolean>>({});
  const [yesterdayAttendanceMap, setYesterdayAttendanceMap] = useState<Record<string | number, boolean>>({});

  // 3. FETCH THE CURRENT REGISTER AND YESTERDAY'S METRIC.
  // Cache snapshots are never authoritative for the current-date existence check.
  // A direct getDocFromServer read makes genuine network/permission failures observable,
  // while includeMetadataChanges lets the listener report the cache -> server transition.
  useEffect(() => {
    setAttendanceMap({});
    setYesterdayAttendanceMap({});
    setIsAlreadySaved(false);
    setSkippedDates([]);
    setHolidaySelections({});
    setIsReadyToSave(false);
    setAttendanceError('');
    setAttendanceStatus('loading');
    reportedCurrentErrorRef.current = '';

    if (!db) {
      const message = 'Firebase DB is not initialized. Check the Firebase configuration.';
      setAttendanceStatus('error');
      setAttendanceError(message);
      return;
    }
    if (!authResolved || !tenantId || !authUserUid || !selectedClassId || !selectedDate) {
      if (authResolved && (!tenantId || !authUserUid)) {
        setAttendanceStatus('error');
        setAttendanceError('You are signed out or your account has no email. Sign in again to access attendance.');
      } else if (authResolved && tenantId && authUserUid && !selectedClassId && !isLoadingClasses) {
        setAttendanceStatus('ready');
      }
      return;
    }
    if (!isValidDateStr(selectedDate)) {
      const message = 'Selected date is invalid. Please choose a valid calendar date.';
      setAttendanceStatus('error');
      setAttendanceError(message);
      triggerErrorToast(message);
      return;
    }
    if (!isSameTenantUser(auth?.currentUser, authUserUid, tenantId)) {
      const message = 'Your login session changed. Please sign in again before accessing attendance.';
      setAttendanceStatus('error');
      setAttendanceError(message);
      return;
    }

    let cancelled = false;
    let serverConfirmed = false;
    const subscribedUid = authUserUid;
    const yesterdayStr = shiftDateStr(selectedDate, -1);
    const attendancePath = ['users', tenantId, 'attendance'] as const;
    const todayRef = doc(db, ...attendancePath, `${selectedClassId}_${selectedDate}`);

    const isActiveScope = () => !cancelled &&
      isSameTenantUser(auth?.currentUser, subscribedUid, tenantId) &&
      authContextRef.current.uid === subscribedUid && authContextRef.current.tenantId === tenantId;

    const applyServerConfirmedSnapshot = (todaySnap: any) => {
      if (!isActiveScope()) return;
      serverConfirmed = true;

      if (!todaySnap.exists()) {
        // Only a server-confirmed missing document creates a new editable register.
        setAttendanceError('');
        reportedCurrentErrorRef.current = '';
        setAttendanceMap({});
        setIsAlreadySaved(false);
        setAttendanceStatus('ready');
        return;
      }

      const validation = validateAttendanceRecord(todaySnap.data(), selectedClassId, selectedDate);
      if (!validation.ok) {
        const message = `Existing attendance record is malformed (${validation.issue}). It was not changed.`;
        console.error(
          `[Attendance] Malformed record at users/${tenantId}/attendance/${selectedClassId}_${selectedDate}: ${validation.issue}`,
          { classId: selectedClassId, date: selectedDate, tenantId, documentData: todaySnap.data() }
        );
        setAttendanceMap({});
        setIsAlreadySaved(true); // Existing malformed records are locked, never treated as new.
        setAttendanceStatus('error');
        setAttendanceError(message);
        if (reportedCurrentErrorRef.current !== message) {
          reportedCurrentErrorRef.current = message;
          triggerErrorToast(message);
        }
        return;
      }

      setAttendanceError('');
      reportedCurrentErrorRef.current = '';
      setAttendanceMap(validation.attendanceMap);
      setIsAlreadySaved(true);
      setAttendanceStatus('ready');
    };

    const unsubToday = onSnapshot(
      todayRef,
      { includeMetadataChanges: true },
      (todaySnap) => {
        if (!isActiveScope()) return;
        if (todaySnap.metadata.fromCache || todaySnap.metadata.hasPendingWrites) {
          // Cache snapshots and snapshots containing uncommitted local writes are inconclusive.
          // Keep the page unconfirmed until a server-confirmed, committed snapshot resolves existence.
          return;
        }
        applyServerConfirmedSnapshot(todaySnap);
      },
      (error) => {
        if (!isActiveScope()) return;
        console.error(
          `[Attendance] Current-date listener failed for users/${tenantId}/attendance/${selectedClassId}_${selectedDate}:`,
          {
            code: error?.code,
            name: error?.name,
            message: error?.message,
            customData: error?.customData,
            error
          }
        );
        const message = describeFirestoreError(error, 'attendance for the selected date');
        setAttendanceStatus('error');
        setAttendanceError(message);
        if (reportedCurrentErrorRef.current !== message) {
          reportedCurrentErrorRef.current = message;
          triggerErrorToast(message);
        }
      }
    );

    // A server-only read guarantees that a cached empty result cannot enable editing or saving.
    void getDocFromServer(todayRef).then((serverSnap) => {
      if (!isActiveScope()) return;
      if (serverSnap.metadata.fromCache || serverSnap.metadata.hasPendingWrites) return;
      applyServerConfirmedSnapshot(serverSnap);
    }).catch((error: any) => {
      if (!isActiveScope() || serverConfirmed) return;
      console.error(
        `[Attendance] Server confirmation failed for users/${tenantId}/attendance/${selectedClassId}_${selectedDate}:`,
        {
          code: error?.code,
          name: error?.name,
          message: error?.message,
          customData: error?.customData,
          error
        }
      );
      const message = describeFirestoreError(error, 'server confirmation of the selected attendance date');
      setAttendanceStatus('error');
      setAttendanceError(message);
      if (reportedCurrentErrorRef.current !== message) {
        reportedCurrentErrorRef.current = message;
        triggerErrorToast(message);
      }
    });

    // Yesterday's record is read only for the existing absent-yesterday metric.
    const ydayRef = doc(db, ...attendancePath, `${selectedClassId}_${yesterdayStr}`);
    const unsubYday = onSnapshot(
      ydayRef,
      (ydaySnap) => {
        if (!isActiveScope()) return;
        if (ydaySnap.metadata.fromCache && !ydaySnap.exists()) {
          setYesterdayAttendanceMap({});
          return;
        }
        if (!ydaySnap.exists()) {
          setYesterdayAttendanceMap({});
          return;
        }
        const validation = validateAttendanceRecord(ydaySnap.data(), selectedClassId, yesterdayStr);
        if (!validation.ok) {
          console.warn(`[Attendance] Ignoring malformed previous-day record ${selectedClassId}_${yesterdayStr}: ${validation.issue}`);
          setYesterdayAttendanceMap({});
          return;
        }
        setYesterdayAttendanceMap(validation.attendanceMap);
      },
      (error) => {
        if (!isActiveScope()) return;
        console.error(`[Attendance] Yesterday attendance listener failed for ${selectedClassId}_${yesterdayStr}:`, error);
        setYesterdayAttendanceMap({});
      }
    );

    return () => {
      cancelled = true;
      unsubToday();
      unsubYday();
    };
  }, [authResolved, tenantId, authUserUid, selectedClassId, selectedDate, isLoadingClasses, attendanceRetryNonce]);

  // 4. VERIFY HISTORICAL ATTENDANCE INDEPENDENTLY FROM THE EDITABLE CURRENT REGISTER.
  // Query just classId (the default single-field index) and normalize both legacy string
  // dates and Timestamp dates locally. This avoids the compound classId/date range index
  // and cannot silently ignore one format if a second query fails.
  useEffect(() => {
    let cancelled = false;
    const checkedScope = JSON.stringify([tenantId, authUserUid, selectedClassId, selectedDate]);
    setHistoryStatus('loading');
    setHistoryError('');
    setHistoryCheckedScope('');
    setLastSavedDate(null);
    reportedHistoryErrorRef.current = '';

    const isActiveHistoryScope = () => !cancelled &&
      isSameTenantUser(auth?.currentUser, authUserUid, tenantId) &&
      authContextRef.current.uid === authUserUid && authContextRef.current.tenantId === tenantId;

    const failHistoryLookup = (message: string, error?: any) => {
      if (cancelled) return;
      if (error) {
        console.error('[Attendance] Historical attendance verification failed:', {
          tenantId,
          classId: selectedClassId,
          selectedDate,
          code: error?.code,
          name: error?.name,
          message: error?.message,
          customData: error?.customData,
          error
        });
      }
      setLastSavedDate(null);
      setHistoryStatus('error');
      setHistoryError(message);
      setHistoryCheckedScope(checkedScope);
      if (reportedHistoryErrorRef.current !== message) {
        reportedHistoryErrorRef.current = message;
        triggerErrorToast(message);
      }
    };

    if (!db) {
      failHistoryLookup('Firebase DB is not initialized. Historical attendance cannot be verified.');
      return () => { cancelled = true; };
    }
    if (!authResolved || !tenantId || !authUserUid || !selectedDate) {
      return () => { cancelled = true; };
    }
    if (!selectedClassId) {
      if (!isLoadingClasses) {
        setLastSavedDate(null);
        setHistoryStatus('ready');
        setHistoryCheckedScope(checkedScope);
      }
      return () => { cancelled = true; };
    }
    if (!isValidDateStr(selectedDate)) {
      failHistoryLookup('Selected date is invalid. Historical attendance cannot be verified.');
      return () => { cancelled = true; };
    }
    if (!isActiveHistoryScope()) {
      failHistoryLookup('Your login session changed. Sign in again before verifying historical attendance.');
      return () => { cancelled = true; };
    }

    const runHistoricalLookup = async () => {
      try {
        const attendanceCollection = collection(db, 'users', tenantId, 'attendance');
        const attendanceQuery = query(
          attendanceCollection,
          where('classId', '==', selectedClassId)
        );
        const snapshot = await getDocsFromServer(attendanceQuery);
        if (!isActiveHistoryScope()) return;

        const candidateDates: string[] = [];
        for (const savedDoc of snapshot.docs) {
          const data = savedDoc.data();
          const normalizedDate = normalizeStoredDate(data?.date);

          // A class record whose date cannot be interpreted makes the history check
          // inconclusive: do not silently ignore it and then permit a save.
          if (!normalizedDate) {
            failHistoryLookup(
              `Historical attendance record ${savedDoc.id} has a missing or malformed date. Correct that record before saving this register.`
            );
            return;
          }

          if (normalizedDate >= selectedDate) continue;

          const validation = validateAttendanceRecord(data, selectedClassId, normalizedDate);
          if (!validation.ok) {
            failHistoryLookup(
              `Historical attendance record ${savedDoc.id} is malformed (${validation.issue}). Correct it before saving this register.`
            );
            return;
          }
          candidateDates.push(normalizedDate);
        }

        if (!isActiveHistoryScope()) return;
        candidateDates.sort((a, b) => b.localeCompare(a));
        setLastSavedDate(candidateDates[0] ?? null);
        setHistoryError('');
        setHistoryStatus('ready');
        setHistoryCheckedScope(checkedScope);
        reportedHistoryErrorRef.current = '';
      } catch (error: any) {
        if (!isActiveHistoryScope()) return;
        failHistoryLookup(
          `${describeFirestoreError(error, 'historical attendance verification')} Saving is blocked until this check succeeds.`,
          error
        );
      }
    };

    void runHistoricalLookup();
    return () => { cancelled = true; };
  }, [authResolved, tenantId, authUserUid, selectedClassId, selectedDate, isLoadingClasses, historyRetryNonce]);

  const handleClassChange = (classId: string) => {
    setSelectedClassId(classId);
    setCurrentPage(1);
    setIsReadyToSave(false);
  };

  // Class Selection Modal Filtered List & Pagination
  const filteredModalClasses = useMemo(() => {
    return classes.filter(cls => 
      cls.name.toLowerCase().includes(classModalSearch.toLowerCase()) ||
      cls.code.toLowerCase().includes(classModalSearch.toLowerCase())
    );
  }, [classes, classModalSearch]);

  const classModalTotalPages = Math.ceil(filteredModalClasses.length / CLASS_MODAL_ITEMS_PER_PAGE) || 1;
  
  const paginatedModalClasses = useMemo(() => {
    const start = (classModalPage - 1) * CLASS_MODAL_ITEMS_PER_PAGE;
    return filteredModalClasses.slice(start, start + CLASS_MODAL_ITEMS_PER_PAGE);
  }, [filteredModalClasses, classModalPage]);

  useEffect(() => {
    setClassModalPage(1);
  }, [classModalSearch]);

  // Blocks edits/saves while the register for the selected class + date is still loading or failed to load
  const ensureAttendanceReady = (): boolean => {
    if (attendanceStatus === 'ready') return true;
    triggerErrorToast(
      attendanceStatus === 'error'
        ? (attendanceError || 'Attendance could not be verified. Use Retry attendance check and try again.')
        : 'Attendance is still being verified with Firebase. Please wait a moment.'
    );
    return false;
  };

  const toggleStudentStatus = (studentId: string | number) => {
    if (!ensureAttendanceReady()) return;
    if (isAlreadySaved) {
      triggerErrorToast("Attendance for this date is locked!");
      return;
    }
    setAttendanceMap((prev) => toggleAttendanceValue(prev as Record<string, boolean>, studentId));
  };

  const markAllPresent = () => {
    if (!ensureAttendanceReady()) return;
    if (isAlreadySaved) {
      triggerErrorToast("Attendance is locked!");
      return;
    }
    const updated = { ...attendanceMap };
    currentClass.students.forEach((s: any) => { updated[s.id] = true; });
    setAttendanceMap(updated);
  };

  const markAllAbsent = () => {
    if (!ensureAttendanceReady()) return;
    if (isAlreadySaved) {
      triggerErrorToast("Attendance is locked!");
      return;
    }
    const updated = { ...attendanceMap };
    currentClass.students.forEach((s: any) => { updated[s.id] = false; });
    setAttendanceMap(updated);
  };

  const triggerErrorToast = (msg: string) => {
    const now = Date.now();
    const lastToast = lastErrorToastRef.current;
    if (lastToast && lastToast.message === msg && now - lastToast.at < 2500) return;
    lastErrorToastRef.current = { message: msg, at: now };
    setErrorMessage(msg);
    setShowErrorToast(true);
    if (errorToastTimerRef.current) clearTimeout(errorToastTimerRef.current);
    errorToastTimerRef.current = setTimeout(() => {
      setShowErrorToast(false);
      errorToastTimerRef.current = null;
    }, 3500);
  };

  const handleToggleReady = () => {
    if (!ensureAttendanceReady()) return;
    if (isAlreadySaved) {
      triggerErrorToast("Attendance is locked.");
      return;
    }
    if (!isHistoryReadyForCurrentScope) {
      triggerErrorToast(
        isHistoryErrorForCurrentScope
          ? (historyError || 'Historical attendance could not be verified. Retry the history check before submitting.')
          : 'Historical attendance is still being verified. Please wait before confirming submission.'
      );
      return;
    }

    const nextState = !isReadyToSave;
    setIsReadyToSave(nextState);

    if (nextState) {
      setShowReadyToast(true);
      if (readyToastTimerRef.current) clearTimeout(readyToastTimerRef.current);
      readyToastTimerRef.current = setTimeout(() => {
        setShowReadyToast(false);
        readyToastTimerRef.current = null;
      }, 3000);
    }
  };

  const calculateSkippedDates = (startStr: string, endStr: string): string[] => {
    return listSkippedDates(startStr, endStr);
  };

  const getDayDetails = (dateStr: string) => {
    // Parsed as a LOCAL calendar date so the weekday never shifts with the browser time zone
    const [year, month, day] = dateStr.split('-').map(Number);
    const d = new Date(year, (month || 1) - 1, day || 1);
    const dayName = d.toLocaleDateString('en-US', { weekday: 'long' });
    const formattedDate = d.toLocaleDateString('en-US', {
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    });
    const isSunday = d.getDay() === 0;
    const isSaturday = d.getDay() === 6;

    return { dayName, formattedDate, isSunday, isSaturday, isWeekend: isSunday || isSaturday };
  };

  // Metrics Calculation
  const totalStudents = currentClass.students ? currentClass.students.length : 0;
  
  const presentCount = useMemo(() => {
    if (!currentClass.students) return 0;
    return currentClass.students.filter((s: any) => attendanceMap[s.id] !== false).length;
  }, [currentClass, attendanceMap]);

  const absentCount = totalStudents - presentCount;

  const absentYesterdayCount = useMemo(() => {
    if (!currentClass.students) return 0;
    return currentClass.students.filter((s: any) => yesterdayAttendanceMap[s.id] === false).length;
  }, [currentClass, yesterdayAttendanceMap]);

  // FILTERED STUDENTS LIST
  const filteredStudents = useMemo(() => {
    if (!currentClass.students) return [];
    
    return currentClass.students.filter((student: any) => {
      const matchesSearch = student.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
                            student.rollNo.includes(searchQuery);
      
      let matchesGender = true;
      if (genderFilter !== 'ALL') {
        matchesGender = student.gender === genderFilter;
      }

      const matchesFee = matchesFeeFilter(feeFilter, student.feeStatus);

      const isPresent = attendanceMap[student.id] !== false;
      let matchesAttendance = true;
      if (attendanceFilter === 'PRESENT') matchesAttendance = isPresent;
      if (attendanceFilter === 'ABSENT') matchesAttendance = !isPresent;

      return matchesSearch && matchesGender && matchesFee && matchesAttendance;
    });
  }, [currentClass, searchQuery, genderFilter, feeFilter, attendanceFilter, attendanceMap]);

  // Pagination Logic
  const totalPages = Math.ceil(filteredStudents.length / ITEMS_PER_PAGE) || 1;
  const paginatedStudents = useMemo(() => {
    const start = (currentPage - 1) * ITEMS_PER_PAGE;
    return filteredStudents.slice(start, start + ITEMS_PER_PAGE);
  }, [filteredStudents, currentPage]);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, genderFilter, feeFilter, attendanceFilter]);

  // Keep the page inside range when the filtered list shrinks (class/date/filter change or roster update)
  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  const toggleHolidaySelection = (dateStr: string) => {
    setHolidaySelections((prev) => ({
      ...prev,
      [dateStr]: !prev[dateStr]
    }));
  };

  const handleSaveAttendance = async () => {
    if (saveInFlightRef.current) {
      triggerErrorToast('Attendance save is already in progress. Please wait.');
      return;
    }
    if (!ensureAttendanceReady()) return;
    if (isAlreadySaved) {
      triggerErrorToast('Attendance is ALREADY saved for this date!');
      return;
    }
    if (!isHistoryReadyForCurrentScope) {
      triggerErrorToast(
        isHistoryErrorForCurrentScope
          ? (historyError || 'Historical attendance could not be verified. Retry the history check before saving.')
          : 'Historical attendance is still being verified. Saving is blocked until the check completes.'
      );
      return;
    }
    if (!isReadyToSave) {
      triggerErrorToast('Please check the verification box below before saving!');
      return;
    }
    if (!selectedClassId || !currentClass.students || currentClass.students.length === 0) {
      triggerErrorToast('There are no students in this class to save attendance for.');
      return;
    }
    if (!isValidDateStr(selectedDate)) {
      triggerErrorToast('Selected date is invalid. Please choose a valid calendar date.');
      return;
    }
    if (!authUserUid || !tenantId || !isSameTenantUser(auth?.currentUser, authUserUid, tenantId)) {
      triggerErrorToast('Your login session changed. Please sign in again before saving attendance.');
      return;
    }
    if (lastSavedDate) {
      const skipped = calculateSkippedDates(lastSavedDate, selectedDate);
      if (skipped.length > 0) {
        if (skipped.length > 499) {
          triggerErrorToast('There are too many skipped dates to process safely in one save. Choose a closer date first.');
          return;
        }
        setSkippedDates(skipped);
        const initialSelections: Record<string, boolean> = {};
        skipped.forEach((d) => { initialSelections[d] = true; });
        setHolidaySelections(initialSelections);
        setShowSkipModal(true);
        return;
      }
    }
    await executeFinalSave();
  };

  const executeFinalSave = async () => {
    if (saveInFlightRef.current) {
      triggerErrorToast('Attendance save is already in progress. Please wait.');
      return;
    }
    if (!db) {
      triggerErrorToast('Firebase DB is not initialized.');
      return;
    }
    if (!tenantId || !authUserUid || !isSameTenantUser(auth?.currentUser, authUserUid, tenantId)) {
      triggerErrorToast('You are signed out or your tenant session changed. Please sign in again before saving attendance.');
      return;
    }
    if (attendanceStatus !== 'ready' || !selectedClassId || !isValidDateStr(selectedDate)) {
      triggerErrorToast('Attendance is not ready to be saved yet. Please wait and try again.');
      return;
    }
    if (!isHistoryReadyForCurrentScope) {
      triggerErrorToast(
        isHistoryErrorForCurrentScope
          ? (historyError || 'Historical attendance could not be verified. Retry the history check before saving.')
          : 'Historical attendance is still being verified. Saving is blocked until the check completes.'
      );
      return;
    }
    if (!currentClass.students || currentClass.students.length === 0) {
      triggerErrorToast('There are no students in this class to save attendance for.');
      return;
    }

    const saveTenantId = tenantId;
    const saveUid = authUserUid;
    const saveClassId = selectedClassId;
    const saveClassName = currentClass.name;
    const saveDate = selectedDate;
    const capturedStudentIds = currentClass.students.map((student: any) => String(student.id)).sort();
    const mapToSave = buildAttendanceMapForSave(currentClass.students, attendanceMap as Record<string, boolean>);
    const holidayDatesToSave = skippedDates.filter((date) => holidaySelections[date]);

    if (holidayDatesToSave.some((date) => !isValidDateStr(date))) {
      triggerErrorToast('A skipped date is malformed. Nothing was saved.');
      return;
    }
    if (holidayDatesToSave.length > 499) {
      triggerErrorToast('Too many holiday records were selected for one atomic save. Nothing was saved.');
      return;
    }

    saveInFlightRef.current = true;
    setIsSavingSkipped(true);
    setIsSaved(false);
    try {
      const classRef = doc(db, 'users', saveTenantId, 'classes', saveClassId);
      const attendanceRef = doc(db, 'users', saveTenantId, 'attendance', `${saveClassId}_${saveDate}`);
      const holidayEntries = holidayDatesToSave.map((date) => ({
        date,
        ref: doc(db, 'users', saveTenantId, 'attendance', `${saveClassId}_${date}`)
      }));

      await runTransaction(db, async (transaction) => {
        if (!isSameTenantUser(auth?.currentUser, saveUid, saveTenantId) ||
            authContextRef.current.uid !== saveUid || authContextRef.current.tenantId !== saveTenantId) {
          throw new Error('attendance-auth-context-changed');
        }
        // Read everything before writing. Create-only transactions prevent cross-tab overwrites.
        const refs = [classRef, attendanceRef, ...holidayEntries.map((entry) => entry.ref)];
        const snapshots = await Promise.all(refs.map((ref) => transaction.get(ref)));
        const classSnapshot = snapshots[0];
        const attendanceSnapshot = snapshots[1];
        const holidaySnapshots = snapshots.slice(2);

        if (!classSnapshot.exists()) throw new Error('attendance-class-missing');
        const liveClassBuild = buildClassFromData(classSnapshot.id, classSnapshot.data());
        const liveStudentIds = liveClassBuild.cls.students.map((student: any) => String(student.id)).sort();
        if (liveClassBuild.issues.length > 0 || liveClassBuild.cls.name !== saveClassName ||
            JSON.stringify(liveStudentIds) !== JSON.stringify(capturedStudentIds)) {
          throw new Error('attendance-roster-changed');
        }
        if (attendanceSnapshot.exists()) throw new Error('attendance-already-exists');

        const nowIso = new Date().toISOString();
        const holidayWrites: Array<{ ref: any; data: Record<string, any> }> = [];
        holidayEntries.forEach((entry, index) => {
          const holidaySnapshot = holidaySnapshots[index];
          if (holidaySnapshot.exists()) {
            const validation = validateAttendanceRecord(holidaySnapshot.data(), saveClassId, entry.date);
            if (!validation.ok) throw new Error(`attendance-existing-holiday-record-malformed:${entry.date}`);
            // Preserve a valid record for this date; never replace attendance with a holiday.
            return;
          }
          const { dayName } = getDayDetails(entry.date);
          holidayWrites.push({ ref: entry.ref, data: {
            classId: saveClassId,
            className: saveClassName,
            date: entry.date,
            isHoliday: true,
            status: 'Holiday',
            note: `Marked as Holiday (${dayName})`,
            updatedAt: nowIso
          }});
        });
        for (const holiday of holidayWrites) transaction.set(holiday.ref, holiday.data);
        transaction.set(attendanceRef, {
          classId: saveClassId,
          className: saveClassName,
          date: saveDate,
          attendanceMap: mapToSave,
          updatedAt: nowIso
        });
      });

      if (!isSameTenantUser(auth?.currentUser, saveUid, saveTenantId) ||
          authContextRef.current.uid !== saveUid || authContextRef.current.tenantId !== saveTenantId) {
        setShowSkipModal(false);
        setShowTickOverlay(false);
        setIsSaved(false);
        triggerErrorToast('The login session changed after the save. Please verify the record before retrying.');
        return;
      }
      setShowSkipModal(false);
      setShowTickOverlay(true);
      setIsSaved(true);
      setIsAlreadySaved(true);
      setAttendanceStatus('ready');
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
      successTimerRef.current = setTimeout(() => {
        setShowTickOverlay(false);
        setIsSaved(false);
        setIsSavingSkipped(false);
        setSelectedDate((prev) => (prev === saveDate ? shiftDateStr(saveDate, 1) : prev));
        setIsReadyToSave(false);
        setSkippedDates([]);
        successTimerRef.current = null;
      }, 2200);
    } catch (error: any) {
      console.error('Error saving attendance to Firebase:', error);
      setIsSaved(false);
      setShowTickOverlay(false);
      const message = String(error?.message || '');
      const code = String(error?.code || '');
      if (message === 'attendance-already-exists') {
        setIsAlreadySaved(true);
        triggerErrorToast('Attendance was saved by another session. The existing record was not changed.');
      } else if (message === 'attendance-roster-changed') {
        triggerErrorToast('The class roster changed while this page was open. Refresh the class and review attendance again.');
      } else if (message === 'attendance-class-missing') {
        triggerErrorToast('This class no longer exists in your tenant. No attendance was saved.');
      } else if (message === 'attendance-auth-context-changed' || code === 'unauthenticated') {
        triggerErrorToast('Your login session changed or expired. Please sign in again.');
      } else if (message.startsWith('attendance-existing-holiday-record-malformed:')) {
        triggerErrorToast(`A skipped-date record is malformed (${message.split(':').pop()}). No attendance was saved.`);
      } else {
        triggerErrorToast(describeFirestoreError(error, 'save attendance'));
      }
    } finally {
      saveInFlightRef.current = false;
      setIsSavingSkipped(false);
    }
  };

  // Clean up timeouts to prevent state updates after unmount.
  useEffect(() => () => {
    if (errorToastTimerRef.current) clearTimeout(errorToastTimerRef.current);
    if (readyToastTimerRef.current) clearTimeout(readyToastTimerRef.current);
    if (successTimerRef.current) clearTimeout(successTimerRef.current);
  }, []);

  const navigationTabs = [
    { id: 'home', label: 'Home', icon: Home, href: '/' },
    { id: 'classes', label: 'Classes', icon: GraduationCap, href: '/departments' },
    { id: 'attendance', label: 'Attendance', icon: Users, href: '/attendance' },
    { id: 'fees', label: 'Fees', icon: Wallet, href: '/fees' },
    { id: 'settings', label: 'Settings', icon: Settings, href: '/settings' },
  ];

  return (
    <div className={`min-h-screen bg-[#f8fafc] dark:bg-[#070b13] text-slate-900 dark:text-slate-100 transition-colors duration-300 pb-32 ${isDark ? 'dark' : ''}`}>
      
      {/* ERROR TOAST NOTIFICATION */}
      {showErrorToast && (
        <div className="fixed top-5 left-1/2 -translate-x-1/2 z-[110] bg-rose-600 text-white font-extrabold text-xs sm:text-sm px-5 py-3 rounded-2xl shadow-[0_0_30px_rgba(225,29,72,0.5)] flex items-center gap-3 border border-rose-400">
          <AlertTriangle className="h-5 w-5 shrink-0" />
          <span>{errorMessage}</span>
          <button onClick={() => setShowErrorToast(false)} className="ml-2 hover:opacity-80">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* GLOWING ACTIVATION NOTIFICATION TOAST */}
      {showReadyToast && (
        <div className="fixed top-5 left-1/2 -translate-x-1/2 z-[110] bg-gradient-to-r from-orange-500 to-amber-500 text-white font-black text-xs sm:text-sm px-6 py-3.5 rounded-2xl shadow-[0_0_30px_rgba(249,115,22,0.6)] flex items-center gap-3 border border-orange-300">
          <Sparkles className="h-5 w-5 shrink-0 animate-bounce" />
          <span>Verification Confirmed! Save Register button is now ACTIVE.</span>
        </div>
      )}

      {/* GLOWING SUCCESS TICK OVERLAY */}
      {showTickOverlay && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-md">
          <div className="bg-white dark:bg-[#0c1222] p-8 rounded-3xl shadow-[0_0_80px_rgba(16,185,129,0.5)] flex flex-col items-center justify-center animate-bounce border border-emerald-500/40">
            <div className="w-24 h-24 bg-emerald-100 dark:bg-emerald-900/40 rounded-full flex items-center justify-center mb-4 ring-4 ring-emerald-500/30">
              <CheckCircle2 className="h-14 w-14 text-emerald-500 drop-shadow-[0_0_20px_rgba(16,185,129,0.9)]" />
            </div>
            <h2 className="text-2xl font-black text-slate-800 dark:text-white">Attendance Saved!</h2>
            <p className="text-sm font-medium text-slate-500 mt-2">{selectedDate} record updated successfully.</p>
            <p className="text-xs font-bold text-orange-500 mt-1">Advancing to Next Day...</p>
          </div>
        </div>
      )}

      {/* HEADER */}
      <div className="w-full bg-white/70 dark:bg-[#070b13]/80 backdrop-blur-md border-b border-slate-200/50 dark:border-slate-800/60 sticky top-0 z-40">
        <div className="mx-auto max-w-7xl flex h-16 items-center justify-between px-4 sm:px-6 lg:px-8">
          
          <div className="flex items-center gap-3">
            <Link
              to="/"
              className="flex items-center justify-center h-10 w-10 rounded-full bg-gradient-to-br from-orange-500 to-amber-500 text-white shadow-[0_0_20px_rgba(249,115,22,0.5)] hover:scale-105 active:scale-95 transition-all"
              title="Back to Home"
            >
              <ArrowLeft className="h-5 w-5 stroke-[2.5]" />
            </Link>
            <span className="font-black text-lg tracking-tight hidden sm:block bg-gradient-to-r from-orange-500 to-amber-500 bg-clip-text text-transparent">
              EduTrack
            </span>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => setIsDark(!isDark)}
              className="flex h-8 w-14 items-center rounded-full bg-slate-200/80 p-1 dark:bg-slate-800 border border-slate-300/50 dark:border-slate-700/50"
            >
              <div className={`flex h-6 w-6 items-center justify-center rounded-full bg-white shadow-md transition-transform duration-300 ${isDark ? 'translate-x-6 bg-slate-900 text-yellow-400' : 'text-orange-500'}`}>
                {isDark ? <Moon className="h-3.5 w-3.5 fill-current" /> : <Sun className="h-3.5 w-3.5 fill-current" />}
              </div>
            </button>

            <Link
              to="/"
              className="relative rounded-2xl p-2.5 text-slate-500 hover:text-orange-500 dark:text-slate-400 dark:hover:text-orange-400 transition-all"
            >
              <Bell className="h-5 w-5" />
              <span className="absolute right-2 top-2 flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-orange-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-orange-500"></span>
              </span>
            </Link>
          </div>
        </div>
      </div>

      {/* MAIN WORKSPACE */}
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 space-y-6">
        
        {/* HERO CONTAINER */}
        <div className="relative overflow-hidden rounded-[2rem] bg-gradient-to-br from-amber-50/80 via-white to-orange-50/40 dark:from-[#0c1222] dark:via-[#0e162a] dark:to-[#070b13] p-6 md:p-8 border-2 border-orange-500/80 shadow-[0_0_25px_rgba(249,115,22,0.25)]">
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 relative z-10">
            <div className="space-y-4 w-full max-w-md">
              <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-orange-500/10 text-orange-600 dark:text-orange-400 border border-orange-500/30">
                <Sparkles className="h-3.5 w-3.5 animate-pulse" />
                <span className="text-[10px] font-black uppercase tracking-wider">LIVE ATTENDANCE</span>
              </div>

              <h1 className="text-3xl sm:text-4xl font-black tracking-tight text-slate-900 dark:text-white">
                Select Class
              </h1>

              {/* CUSTOM ANIMATED CLASS TRIGGER BUTTON */}
              <div className="relative pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setClassModalPage(1);
                    setIsClassModalOpen(true);
                  }}
                  disabled={isLoadingClasses}
                  className="w-full flex items-center justify-between rounded-2xl border-2 border-orange-500/80 bg-white/95 dark:bg-[#070b13] px-5 py-3.5 text-sm font-extrabold text-slate-800 dark:text-slate-100 shadow-[0_0_20px_rgba(249,115,22,0.15)] hover:border-orange-500 hover:shadow-[0_0_25px_rgba(249,115,22,0.3)] transition-all duration-300 active:scale-[0.99] group text-left disabled:opacity-60"
                >
                  <div className="flex items-center gap-3 truncate">
                    <div className="h-8 w-8 rounded-xl bg-orange-500/10 text-orange-500 flex items-center justify-center shrink-0 border border-orange-500/20 group-hover:scale-110 transition-transform">
                      <GraduationCap className="h-4 w-4" />
                    </div>
                    <span className="truncate">
                      {isLoadingClasses 
                        ? 'Fetching classes from Firebase...' 
                        : currentClass.name 
                          ? `${currentClass.name} (${currentClass.code})` 
                          : 'No Classes Found'}
                    </span>
                  </div>
                  <ChevronRight className="h-5 w-5 text-orange-500 shrink-0 group-hover:translate-x-1 transition-transform" />
                </button>
              </div>
            </div>

            <div className="bg-white/90 dark:bg-[#070b13]/90 backdrop-blur-md border border-slate-200/80 dark:border-slate-800/80 rounded-2xl p-4 flex flex-col gap-2 w-full md:w-auto shadow-md">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider">Select Date</span>
                {isAlreadySaved && (
                  <span className="inline-flex items-center gap-1 text-[10px] font-black text-emerald-500 bg-emerald-500/10 px-2 py-0.5 rounded-md border border-emerald-500/30">
                    <Lock className="h-3 w-3" /> Saved & Locked
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3 bg-slate-50 dark:bg-[#0c1222] px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-800">
                <CalendarIcon className="h-4 w-4 text-orange-500" />
                <input 
                  type="date" 
                  value={selectedDate}
                  onChange={(e) => setSelectedDate(e.target.value)}
                  className="bg-transparent text-sm font-black text-slate-800 dark:text-slate-100 outline-none cursor-pointer"
                />
              </div>
            </div>
          </div>
        </div>

        {/* METRICS ROW */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
          <div className="bg-white dark:bg-[#0c1222] border border-slate-200/80 dark:border-slate-800/60 rounded-3xl p-4 text-center">
            <span className="text-[10px] sm:text-xs font-extrabold text-slate-400 block tracking-wide uppercase">Total</span>
            <span className="text-2xl sm:text-3xl font-black text-slate-900 dark:text-white mt-1 block">{totalStudents}</span>
          </div>
          <div className="bg-emerald-50/80 dark:bg-emerald-950/20 border border-emerald-200/60 dark:border-emerald-900/40 rounded-3xl p-4 text-center">
            <span className="text-[10px] sm:text-xs font-extrabold text-emerald-600 dark:text-emerald-400 block tracking-wide uppercase">Present</span>
            <span className="text-2xl sm:text-3xl font-black text-emerald-600 dark:text-emerald-400 mt-1 block">{presentCount}</span>
          </div>
          <div className="bg-rose-50/80 dark:bg-rose-950/20 border border-rose-200/60 dark:border-rose-900/40 rounded-3xl p-4 text-center">
            <span className="text-[10px] sm:text-xs font-extrabold text-rose-600 dark:text-rose-400 block tracking-wide uppercase">Absent</span>
            <span className="text-2xl sm:text-3xl font-black text-rose-600 dark:text-rose-400 mt-1 block">{absentCount}</span>
          </div>
          <div className="bg-amber-50/80 dark:bg-amber-950/20 border border-amber-200/60 dark:border-amber-900/40 rounded-3xl p-4 text-center">
            <span className="text-[10px] sm:text-xs font-extrabold text-amber-600 dark:text-amber-400 block tracking-wide uppercase truncate">Absent Yesterday</span>
            <span className="text-2xl sm:text-3xl font-black text-amber-600 dark:text-amber-400 mt-1 block">{absentYesterdayCount}</span>
          </div>
        </div>

        {/* ALREADY SAVED BANNER */}
        {isAlreadySaved && (
          <div className="bg-amber-500/10 border border-amber-500/30 p-4 rounded-2xl flex items-center justify-between gap-3 text-amber-700 dark:text-amber-300">
            <div className="flex items-center gap-2.5 text-xs sm:text-sm font-bold">
              <Lock className="h-5 w-5 text-amber-500 shrink-0" />
              <span>Attendance for <strong>{selectedDate}</strong> is already saved and locked.</span>
            </div>
            <button 
              onClick={() => {
                const nextDate = new Date(selectedDate);
                nextDate.setDate(nextDate.getDate() + 1);
                setSelectedDate(nextDate.toISOString().split('T')[0]);
              }}
              className="text-xs font-black bg-amber-500 text-white px-3.5 py-2 rounded-xl hover:bg-amber-600 transition-all shrink-0"
            >
              Go to Next Day &rarr;
            </button>
          </div>
        )}

        {/* CURRENT REGISTER / HISTORICAL SAFETY STATUS */}
        {selectedClassId && selectedDate && attendanceStatus === 'loading' && (
          <div className="bg-white dark:bg-[#0c1222] border border-orange-500/30 p-4 rounded-2xl text-orange-700 dark:text-orange-300 text-xs sm:text-sm font-bold" role="status" aria-live="polite">
            <span className="animate-pulse">Verifying attendance for the selected date with Firebase. Editing and saving will remain disabled If an attendance record already exists..</span>
          </div>
        )}
        {selectedClassId && selectedDate && attendanceStatus === 'error' && (
          <div className="bg-rose-50 dark:bg-rose-950/20 border border-rose-300/70 dark:border-rose-900/50 p-4 rounded-2xl flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-rose-700 dark:text-rose-300" role="alert">
            <span className="text-xs sm:text-sm font-bold">{attendanceError || 'The current-date attendance record could not be confirmed.'}</span>
            <button type="button" onClick={() => { setAttendanceError(''); setAttendanceStatus('loading'); setAttendanceRetryNonce((n) => n + 1); }} className="shrink-0 rounded-xl bg-rose-600 hover:bg-rose-700 text-white px-3.5 py-2 text-xs font-black transition-all">Retry attendance check</button>
          </div>
        )}
        {selectedClassId && selectedDate && !isHistoryReadyForCurrentScope && !isHistoryErrorForCurrentScope && (
          <div className="bg-white dark:bg-[#0c1222] border border-slate-200 dark:border-slate-800 p-4 rounded-2xl text-slate-500 dark:text-slate-300 text-xs sm:text-sm font-bold" role="status" aria-live="polite">
            <span className="animate-pulse">Checking previous attendance dates and holiday history…</span>
          </div>
        )}
        {selectedClassId && selectedDate && isHistoryErrorForCurrentScope && (
          <div className="bg-amber-50 dark:bg-amber-950/20 border border-amber-300/70 dark:border-amber-900/50 p-4 rounded-2xl flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-amber-800 dark:text-amber-200" role="alert">
            <span className="text-xs sm:text-sm font-bold">{historyError || 'Historical attendance could not be verified. Saving is blocked.'}</span>
            <button type="button" onClick={() => { setHistoryError(''); setHistoryStatus('loading'); setHistoryCheckedScope(''); setHistoryRetryNonce((n) => n + 1); }} className="shrink-0 rounded-xl bg-amber-600 hover:bg-amber-700 text-white px-3.5 py-2 text-xs font-black transition-all">Retry history check</button>
          </div>
        )}

        {/* FILTER CONTROL CARD */}
        <div className="bg-white dark:bg-[#0c1222] p-4 sm:p-5 rounded-3xl border border-slate-200/80 dark:border-slate-800/60 space-y-4">
          <div className="flex items-center gap-2 text-slate-800 dark:text-slate-100 font-extrabold text-base">
            <SlidersHorizontal className="h-5 w-5 text-orange-500" />
            <span>Filters</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            
            {/* Search Input */}
            <div className="relative">
              <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                placeholder="Search name or roll..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-slate-50 dark:bg-[#070b13] border border-slate-200 dark:border-slate-800 rounded-2xl py-2.5 pl-10 pr-4 text-xs font-bold text-slate-800 dark:text-slate-100 outline-none focus:border-orange-500"
              />
            </div>

            {/* Gender Filters Pill */}
            <div className="flex items-center gap-1 bg-slate-100 dark:bg-[#070b13] p-1 rounded-2xl border border-slate-200/60 dark:border-slate-800/60">
              <span className="text-[10px] font-black text-slate-400 uppercase px-2">Gender:</span>
              {(['ALL', 'M', 'F'] as const).map((g) => (
                <button
                  key={g}
                  onClick={() => setGenderFilter(g)}
                  className={`flex-1 py-1.5 rounded-xl text-xs font-black transition-all ${
                    genderFilter === g
                      ? 'bg-orange-500 text-white shadow-md'
                      : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
                  }`}
                >
                  {g === 'ALL' ? 'All' : g === 'M' ? 'Male ' : 'Female '}
                </button>
              ))}
            </div>

            {/* Fee Status Filter Pill */}
            <div className="flex items-center gap-1 bg-slate-100 dark:bg-[#070b13] p-1 rounded-2xl border border-slate-200/60 dark:border-slate-800/60">
              <span className="text-[10px] font-black text-slate-400 uppercase px-2">Fee:</span>
              {(['ALL', 'PAID', 'UNPAID'] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setFeeFilter(f)}
                  className={`flex-1 py-1.5 rounded-xl text-xs font-black transition-all ${
                    feeFilter === f
                      ? 'bg-orange-500 text-white shadow-md'
                      : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
                  }`}
                >
                  {f === 'ALL' ? 'All' : f === 'PAID' ? 'Paid' : 'Unpaid'}
                </button>
              ))}
            </div>

          </div>
        </div>

        {/* BULK ACTIONS */}
        <div className="flex items-center gap-2 justify-end">
          <button onClick={markAllPresent} className="flex items-center gap-1.5 text-xs font-bold px-3.5 py-2 rounded-xl bg-emerald-50 text-emerald-600 hover:bg-emerald-100 dark:bg-emerald-950/30 dark:text-emerald-400">
            <UserCheck className="h-3.5 w-3.5" /> Mark All Present
          </button>
          <button onClick={markAllAbsent} className="flex items-center gap-1.5 text-xs font-bold px-3.5 py-2 rounded-xl bg-rose-50 text-rose-600 hover:bg-rose-100 dark:bg-rose-950/30 dark:text-rose-400">
            <UserX className="h-3.5 w-3.5" /> Mark All Absent
          </button>
        </div>

        {/* STUDENT LIST */}
        <div className="space-y-3">
          {isLoadingClasses ? (
            <div className="text-center py-16 bg-white dark:bg-[#0c1222] rounded-3xl border border-slate-200/60 dark:border-slate-800/40">
              <p className="text-sm font-bold text-orange-500 animate-pulse">Fetching class data from Firebase database...</p>
            </div>
          ) : paginatedStudents.length === 0 ? (
            <div className="text-center py-16 bg-white dark:bg-[#0c1222] rounded-3xl border border-slate-200/60 dark:border-slate-800/40">
              <p className="text-sm font-bold text-slate-400">No students found matching your selected filters or class.</p>
            </div>
          ) : (
            paginatedStudents.map((student: any) => {
              const isPresent = attendanceMap[student.id] !== false;
              const wasAbsentYesterday = yesterdayAttendanceMap[student.id] === false;
              const isPaid = student.feeStatus?.toLowerCase() === 'paid';

              return (
                <div
                  key={student.id}
                  onClick={() => toggleStudentStatus(student.id)}
                  className={`group bg-white dark:bg-[#0c1222] border p-3.5 sm:p-4 rounded-[1.25rem] flex items-center justify-between gap-3 shadow-sm transition-all duration-300 cursor-pointer ${
                    isPresent
                      ? 'border-slate-200/70 dark:border-slate-800/50 hover:border-emerald-400'
                      : 'border-rose-300 dark:border-rose-900/60 bg-rose-50/30 dark:bg-rose-950/20'
                  }`}
                >
                  <div className="flex items-center gap-3.5 min-w-0">
                    <div className="relative">
                      <img
                        src={student.avatar}
                        alt={student.name}
                        className="h-12 w-12 rounded-full object-cover ring-2 ring-slate-100 dark:ring-slate-800 shrink-0"
                      />
                      <div className={`absolute -bottom-1 -right-1 h-4 w-4 rounded-full border-2 border-white dark:border-[#0c1222] flex items-center justify-center ${isPresent ? 'bg-emerald-500' : 'bg-rose-500'}`}>
                        {isPresent ? <Check className="h-2.5 w-2.5 text-white" /> : <UserX className="h-2.5 w-2.5 text-white" />}
                      </div>
                    </div>
                    
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h4 className="text-sm sm:text-base font-extrabold text-slate-800 dark:text-slate-100 truncate">
                          {student.name}
                        </h4>

                        {wasAbsentYesterday && (
                          <span className="inline-flex items-center gap-1 text-[9px] font-black px-2 py-0.5 rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
                            <AlertCircle className="h-2.5 w-2.5" /> Absent Yesterday
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-[#070b13] px-2 py-0.5 rounded-md">
                          Roll #{student.rollNo}
                        </span>
                        
                        <span className={`text-[10px] font-extrabold px-1.5 py-0.5 rounded-md ${
                          student.gender === 'F'
                            ? 'bg-pink-500/10 text-pink-600 dark:text-pink-400'
                            : 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
                        }`}>
                          {student.gender === 'F' ? 'Female' : 'Male'}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 sm:gap-3 shrink-0">
                    <span className={`text-[11px] font-black px-2.5 py-1 rounded-xl ${
                      isPaid 
                        ? 'bg-emerald-100/70 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400' 
                        : 'bg-rose-100/70 text-rose-700 dark:bg-rose-950/50 dark:text-rose-400'
                    }`}>
                      {isPaid ? 'Paid' : 'Unpaid'}
                    </span>

                    <button
                      type="button"
                      disabled={attendanceStatus !== 'ready' || isAlreadySaved}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleStudentStatus(student.id);
                      }}
                      className={`relative inline-flex h-7 w-12 sm:h-8 sm:w-14 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-all duration-300 ${
                        attendanceStatus !== 'ready' || isAlreadySaved ? 'opacity-60 cursor-not-allowed' : ''
                      } ${isPresent ? 'bg-emerald-500' : 'bg-rose-500'}`}
                    >
                      <span
                        className={`pointer-events-none inline-block h-6 w-6 sm:h-7 sm:w-7 transform rounded-full bg-white shadow-md transition-transform duration-300 ${
                          isPresent ? 'translate-x-5 sm:translate-x-6' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* PAGINATION CONTROLS */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between bg-white dark:bg-[#0c1222] p-4 rounded-2xl border border-slate-200/60 dark:border-slate-800/40">
            <button
              onClick={() => setCurrentPage((p) => Math.max(p - 1, 1))}
              disabled={currentPage === 1}
              className="flex items-center gap-1 px-3.5 py-2 rounded-xl text-xs font-extrabold bg-slate-100 dark:bg-[#070b13] disabled:opacity-40"
            >
              <ChevronLeft className="h-4 w-4" /> Previous
            </button>

            <span className="text-xs font-black text-slate-500">
              Page <span className="text-orange-500">{currentPage}</span> of {totalPages}
            </span>

            <button
              onClick={() => setCurrentPage((p) => Math.min(p + 1, totalPages))}
              disabled={currentPage === totalPages}
              className="flex items-center gap-1 px-3.5 py-2 rounded-xl text-xs font-extrabold bg-slate-100 dark:bg-[#070b13] disabled:opacity-40"
            >
              Next <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* VERIFICATION CHECKBOX CONTAINER */}
        <div 
          onClick={handleToggleReady}
          aria-disabled={attendanceStatus !== 'ready' || isAlreadySaved || !isHistoryReadyForCurrentScope}
          className={`cursor-pointer transition-all duration-300 p-5 rounded-[1.75rem] border-2 flex items-center gap-4 select-none ${
            isReadyToSave
              ? 'bg-gradient-to-r from-orange-50/90 to-amber-50/70 dark:from-orange-950/30 dark:to-amber-950/20 border-orange-500 shadow-[0_0_30px_rgba(249,115,22,0.25)]'
              : 'bg-white/90 dark:bg-[#0c1222]/90 border-slate-200 dark:border-slate-800'
          }`}
        >
          <div className={`h-8 w-8 rounded-xl flex items-center justify-center shrink-0 border-2 ${
            isReadyToSave 
              ? 'bg-orange-500 border-orange-500 text-white' 
              : 'border-slate-300 dark:border-slate-700 bg-slate-100/80 dark:bg-slate-900/80'
          }`}>
            <Check className="h-5 w-5 stroke-[3]" />
          </div>

          <div className="flex items-center gap-2.5">
            <ShieldCheck className={`h-5 w-5 shrink-0 ${isReadyToSave ? 'text-orange-500' : 'text-slate-400'}`} />
            <span className={`text-xs sm:text-sm font-black ${isReadyToSave ? 'text-orange-950 dark:text-orange-200' : 'text-slate-700 dark:text-slate-300'}`}>
              I confirm that all student records for today are verified and ready to submit.
            </span>
          </div>
        </div>

        {/* SAVE BUTTON */}
        <div>
          <button
            onClick={handleSaveAttendance}
            disabled={!isReadyToSave || isAlreadySaved || attendanceStatus !== 'ready' || !isHistoryReadyForCurrentScope}
            className={`w-full py-4 sm:py-5 rounded-full font-black text-sm sm:text-base tracking-wide transition-all duration-300 flex items-center justify-center gap-2 ${
              isAlreadySaved
                ? 'bg-slate-300 dark:bg-slate-800 text-slate-500 cursor-not-allowed opacity-80'
                : !isReadyToSave
                ? 'bg-[#6f7682] dark:bg-[#333a48] text-slate-200 cursor-not-allowed opacity-90'
                : 'bg-gradient-to-r from-[#ff6c00] to-[#f97316] text-white shadow-[0_10px_30px_rgba(255,108,0,0.4)] hover:scale-[1.01]'
            }`}
          >
            {isAlreadySaved ? (
              <>
                <Lock className="h-5 w-5 text-amber-500" />
                Attendance Already Saved for {selectedDate}
              </>
            ) : isSaved ? (
              <>
                <CheckCircle2 className="h-6 w-6 animate-pulse" /> 
                Record Saved Successfully!
              </>
            ) : (
              <>
                <Save className="h-5 w-5" /> 
                Save Register for {selectedDate}
              </>
            )}
          </button>
        </div>
      </main>

      {/* CLASS SELECTION MODAL CARD WITH 7 ITEMS PAGINATION */}
      {isClassModalOpen && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-md animate-in fade-in duration-300">
          
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-80 h-80 bg-orange-500/20 rounded-full blur-3xl pointer-events-none" />

          <div className="relative bg-white/95 dark:bg-[#0c1222]/95 border-2 border-orange-500/60 rounded-[2.5rem] p-6 max-w-md w-full shadow-[0_0_50px_rgba(249,115,22,0.35)] space-y-5 transform transition-all duration-300 scale-100 overflow-hidden">
            
            <div className="flex items-center justify-between border-b border-orange-500/20 pb-4">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-2xl bg-gradient-to-br from-orange-500 to-amber-500 text-white flex items-center justify-center shadow-lg shadow-orange-500/30 ring-2 ring-orange-500/20">
                  <GraduationCap className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-xl font-black text-slate-900 dark:text-white tracking-tight">
                    Select Class
                  </h3>
                  <p className="text-[11px] font-bold text-slate-500 dark:text-slate-400">
                    Choose class to load roster ({classes.length} Available)
                  </p>
                </div>
              </div>

              <button
                onClick={() => setIsClassModalOpen(false)}
                className="p-2 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-500 hover:text-orange-500 dark:hover:text-orange-400 hover:bg-orange-500/10 transition-all"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="relative">
              <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-orange-500" />
              <input
                type="text"
                placeholder="Filter classes by name or code..."
                value={classModalSearch}
                onChange={(e) => setClassModalSearch(e.target.value)}
                className="w-full bg-orange-50/40 dark:bg-[#070b13] border border-orange-500/30 dark:border-slate-800 rounded-2xl py-2.5 pl-10 pr-4 text-xs font-bold text-slate-800 dark:text-slate-100 outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 transition-all"
              />
              {classModalSearch && (
                <button 
                  onClick={() => setClassModalSearch('')} 
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            <div className="space-y-2 min-h-[350px]">
              {paginatedModalClasses.length === 0 ? (
                <div className="text-center py-12 text-xs font-bold text-slate-400">
                  No classes match "{classModalSearch}"
                </div>
              ) : (
                paginatedModalClasses.map((cls) => {
                  const isSelected = cls.id === selectedClassId;

                  return (
                    <button
                      key={cls.id}
                      onClick={() => {
                        handleClassChange(cls.id);
                        setIsClassModalOpen(false);
                      }}
                      className={`w-full p-3.5 rounded-2xl border transition-all duration-200 flex items-center justify-between group active:scale-[0.98] ${
                        isSelected
                          ? 'bg-gradient-to-r from-orange-500/15 via-amber-500/10 to-transparent border-orange-500 text-orange-950 dark:text-orange-200 shadow-[0_0_15px_rgba(249,115,22,0.2)]'
                          : 'bg-white dark:bg-[#070b13]/60 border-slate-200 dark:border-slate-800 hover:border-orange-500/50 text-slate-800 dark:text-slate-200 hover:bg-orange-50/30'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <div className={`h-5 w-5 rounded-full border-2 flex items-center justify-center transition-all ${
                          isSelected 
                            ? 'border-orange-500 bg-orange-500 text-white ring-4 ring-orange-500/20' 
                            : 'border-slate-300 dark:border-slate-600 bg-transparent'
                        }`}>
                          {isSelected && <Check className="h-3 w-3 stroke-[3]" />}
                        </div>

                        <div className="text-left">
                          <h4 className="text-sm font-black tracking-tight leading-tight">
                            {cls.name}
                          </h4>
                          <span className="text-[10px] font-extrabold text-slate-400 dark:text-slate-500">
                            Code: {cls.code}
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <span className={`text-[10px] font-black px-2.5 py-1 rounded-xl transition-all ${
                          isSelected
                            ? 'bg-orange-500 text-white shadow-sm'
                            : 'bg-slate-100 dark:bg-slate-800 text-slate-500 group-hover:bg-orange-500/20 group-hover:text-orange-600'
                        }`}>
                          {cls.students ? cls.students.length : 0} Students
                        </span>
                      </div>
                    </button>
                  );
                })
              )}
            </div>

            {classModalTotalPages > 1 && (
              <div className="flex items-center justify-between border-t border-orange-500/20 pt-4">
                <button
                  onClick={() => setClassModalPage((p) => Math.max(p - 1, 1))}
                  disabled={classModalPage === 1}
                  className="flex items-center gap-1 px-3.5 py-2 rounded-xl text-xs font-black bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 disabled:opacity-40 hover:bg-orange-500 hover:text-white transition-all"
                >
                  <ChevronLeft className="h-4 w-4" /> Prev
                </button>

                <div className="flex items-center gap-1 text-xs font-black text-slate-500">
                  <span>Page</span>
                  <span className="px-2 py-0.5 rounded-md bg-orange-500/10 text-orange-600 dark:text-orange-400 border border-orange-500/20">
                    {classModalPage}
                  </span>
                  <span>of {classModalTotalPages}</span>
                </div>

                <button
                  onClick={() => setClassModalPage((p) => Math.min(p + 1, classModalTotalPages))}
                  disabled={classModalPage === classModalTotalPages}
                  className="flex items-center gap-1 px-3.5 py-2 rounded-xl text-xs font-black bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 disabled:opacity-40 hover:bg-orange-500 hover:text-white transition-all"
                >
                  Next <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            )}

          </div>
        </div>
      )}

      {/* SKIPPED DATES MODAL */}
      {showSkipModal && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/75 backdrop-blur-md animate-in fade-in duration-200">
          <div className="bg-white dark:bg-[#0c1222] border-2 border-orange-500/50 rounded-[2.5rem] p-6 max-w-md w-full shadow-[0_0_50px_rgba(249,115,22,0.3)] space-y-5 text-center transform transition-all scale-100">
            
            <div className="w-16 h-16 bg-gradient-to-br from-orange-500 to-amber-500 text-white rounded-2xl flex items-center justify-center mx-auto shadow-lg shadow-orange-500/40 ring-4 ring-orange-500/20">
              <CalendarDays className="w-8 h-8 animate-pulse" />
            </div>

            <div className="space-y-2">
              <h3 className="text-2xl font-black text-slate-900 dark:text-white">
                Skipped Dates Notification
              </h3>
              <p className="text-xs font-extrabold text-slate-600 dark:text-slate-300 leading-relaxed">
                Aap <span className="text-orange-500 font-black">{selectedDate}</span> ki attendance save kar rahe hain. 
                System ne missing date(s) detect ki hain:
              </p>
            </div>

            <div className="space-y-2.5 text-left bg-slate-50 dark:bg-[#070b13] p-4 rounded-2xl border border-slate-200 dark:border-slate-800 max-h-52 overflow-y-auto">
              {skippedDates.map((dateStr) => {
                const { dayName, formattedDate, isSunday, isWeekend } = getDayDetails(dateStr);
                const isHoliday = holidaySelections[dateStr] ?? true;

                return (
                  <div
                    key={dateStr}
                    onClick={() => toggleHolidaySelection(dateStr)}
                    className={`flex items-center justify-between p-3.5 rounded-xl border transition-all cursor-pointer ${
                      isHoliday
                        ? 'bg-orange-500/10 border-orange-500/40 text-orange-950 dark:text-orange-200'
                        : 'bg-white dark:bg-[#0c1222] border-slate-200 dark:border-slate-800 text-slate-500'
                    }`}
                  >
                    <div className="flex flex-col gap-0.5">
                      <div className="flex items-center gap-2 text-xs font-black">
                        <span className={`w-2.5 h-2.5 rounded-full ${isHoliday ? 'bg-orange-500 shadow-[0_0_8px_rgba(249,115,22,0.8)]' : 'bg-slate-300 dark:bg-slate-700'}`} />
                        <span>{formattedDate} ({dayName})</span>
                      </div>
                      
                      {isSunday && (
                        <span className="text-[10px] font-black text-rose-500 ml-4">
                          * Sunday (Weekend Off)
                        </span>
                      )}
                      {isWeekend && !isSunday && (
                        <span className="text-[10px] font-black text-amber-500 ml-4">
                          * Saturday (Weekend)
                        </span>
                      )}
                    </div>

                    <span className={`text-[10px] font-black px-2.5 py-1 rounded-lg transition-all ${
                      isHoliday
                        ? 'bg-orange-500 text-white shadow-md shadow-orange-500/30'
                        : 'bg-slate-200 dark:bg-slate-800 text-slate-500'
                    }`}>
                      {isHoliday ? 'Save as Holiday' : 'Ignore'}
                    </span>
                  </div>
                );
              })}
            </div>

            <p className="text-[11px] font-extrabold text-slate-500 dark:text-slate-400">
              System missing date(s) par automatically <strong className="text-orange-500">Holiday Record</strong> save karega.
            </p>

            <div className="space-y-2 pt-1">
              <button
                onClick={executeFinalSave}
                disabled={isSavingSkipped}
                className="w-full py-4 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 text-white text-xs sm:text-sm font-black rounded-2xl shadow-xl shadow-orange-500/30 transition-all active:scale-[0.99] disabled:opacity-50"
              >
                {isSavingSkipped ? 'Saving Missing Records...' : 'Confirm Holiday & Proceed'}
              </button>

              <button
                onClick={() => setShowSkipModal(false)}
                disabled={isSavingSkipped}
                className="w-full py-2.5 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 text-xs font-extrabold rounded-2xl transition-all"
              >
                Cancel & Change Date
              </button>
            </div>

          </div>
        </div>
      )}

      {/* BOTTOM NAVIGATION NAVBAR */}
        <div className="fixed bottom-0 left-0 right-0 z-40 px-4 pb-4 pt-2 bg-gradient-to-t from-[#f8fafc] via-[#f8fafc]/90 to-transparent dark:from-[#070b13] dark:via-[#070b13]/90">
        <nav className="mx-auto max-w-md bg-white/80 dark:bg-[#0c1222]/90 backdrop-blur-xl border border-slate-200/50 dark:border-slate-800/40 rounded-3xl shadow-[0_15px_35px_-5px_rgba(0,0,0,0.08)] dark:shadow-[0_20px_40px_rgba(0,0,0,0.4)] px-3 py-2 flex items-center justify-between">
          {navigationTabs.map((tab) => {
            const IconComponent = tab.icon;
            const isActive = activeTab === tab.id;

            return (
              <Link
                key={tab.id}
                to={tab.href}
                onClick={() => {
                  setActiveTab(tab.id);
                  if (tab.id === 'classes' && activeClassId) {
                    handleBackToClasses();
                  }
                }}
                className="flex flex-col items-center justify-center flex-1 py-1 relative group"
              >
                <div
                  className={`p-2 rounded-2xl transition-all duration-300 relative ${
                    isActive
                      ? 'bg-orange-500 text-white shadow-md shadow-orange-500/30 scale-105'
                      : 'text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300'
                  }`}
                >
                  <IconComponent className="h-4 w-4" />
                </div>

                <span
                  className={`text-[9px] font-bold tracking-tight mt-1 transition-colors ${
                    isActive
                      ? 'text-orange-600 dark:text-orange-400 font-extrabold'
                      : 'text-slate-400 dark:text-slate-500'
                  }`}
                >
                  {tab.label}
                </span>

                {isActive && (
                  <div className="absolute top-0 h-1 w-1 bg-orange-500 rounded-full shadow-[0_0_8px_#f97316]" />
                )}
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
