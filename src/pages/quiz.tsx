import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useLocation, Link, useNavigate } from 'react-router-dom';
import {
  Award, GraduationCap, Plus, ArrowLeft, Sun, Moon, Home, Users, Wallet,
  Settings, Sparkles, X, Save, Trash2, Edit3, BarChart2, ChevronDown,
  SlidersHorizontal, Calendar, Eye, Search, ChevronLeft, ChevronRight,
  Check, AlertTriangle, FileText, Download, Printer
} from 'lucide-react';

// --- FIREBASE IMPORTS ---
import { collection, getDocs, getDoc, doc, runTransaction } from "firebase/firestore";
import { onAuthStateChanged, User as FirebaseUser } from "firebase/auth";
import { db, auth } from '../lib/firebase';
import {
  acquireSubmissionLock,
  buildRosterScores,
  calculateAverageScore,
  compareStudentOrder,
  extractStudents,
  formatDateLabel,
  findOrphanedStudentIds,
  getCategoryPerformers as calculateCategoryPerformers,
  getClassCollectionPath,
  getCurrentAndPrevMonthKeys,
  getFirestoreErrorMessage,
  getQuizCollectionPath,
  normalizeEmailId,
  normalizeStoredScores,
  parseMark,
  quizRevisionSignature,
  releaseSubmissionLock,
  resolveQuizMonthKey,
  timestampToMillis,
  validateQuizInput,
  verifyTeacherTenantProfile,
  type ClassItem,
  type QuizRecord,
  type StudentScore,
} from './quiz.logic';

// --- FIXED BOTTOM NAVBAR — MATCHES THE CLASSES PAGE ---
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
    <div className="fixed bottom-0 left-0 right-0 z-40 px-4 pb-4 pt-2 bg-gradient-to-t from-[#f8fafc] via-[#f8fafc]/90 to-transparent dark:from-[#070b13] dark:via-[#070b13]/90">
      <nav className="mx-auto max-w-md bg-white/80 dark:bg-[#0c1222]/90 backdrop-blur-xl border border-slate-200/50 dark:border-slate-800/40 rounded-3xl shadow-[0_15px_35px_-5px_rgba(0,0,0,0.08)] dark:shadow-[0_20px_40px_rgba(0,0,0,0.4)] px-3 py-2 flex items-center justify-between">
        {navigationTabs.map((tab) => {
          const IconComponent = tab.icon;
          const isActive = location.pathname === tab.href;
          return (
            <Link
              key={tab.id}
              to={tab.href}
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
  );
}

// --- MAIN PAGE ---
export default function QuizManagementPage() {
  const navigate = useNavigate();
  const [isDark, setIsDark] = useState(false);
  const [loading, setLoading] = useState(true);
  const [currentUser, setCurrentUser] = useState<FirebaseUser | null>(null);
  const [tenantState, setTenantState] = useState<{
    status: 'resolving' | 'ready' | 'unauthenticated' | 'denied' | 'error';
    tenantId?: string;
    uid?: string;
    profileFound?: boolean;
    reason?: string;
  }>({ status: 'resolving' });

  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [selectedClassId, setSelectedClassId] = useState<string>('');
  const selectedClassIdRef = useRef(selectedClassId);
  selectedClassIdRef.current = selectedClassId;

  // Class & Month Modal Selectors State
  const [isClassModalOpen, setIsClassModalOpen] = useState(false);
  const [classSearchText, setClassSearchText] = useState('');
  const [isMonthModalOpen, setIsMonthModalOpen] = useState(false);

  // Month keys follow the teacher's local calendar, never a UTC ISO date boundary.
  const [monthKeys, setMonthKeys] = useState(() => getCurrentAndPrevMonthKeys());
  const { currentMonthKey, prevMonthKey } = monthKeys;
  const [availableMonths, setAvailableMonths] = useState<string[]>([currentMonthKey]);
  const [selectedMonth, setSelectedMonth] = useState<string>(currentMonthKey);

  // Quizzes State
  const [quizzes, setQuizzes] = useState<QuizRecord[]>([]);

  // View & Form States
  const [isCreatingQuiz, setIsCreatingQuiz] = useState(false);
  const [editingQuizId, setEditingQuizId] = useState<string | null>(null);
  const [editingClassId, setEditingClassId] = useState<string | null>(null);
  const [editingUserUid, setEditingUserUid] = useState<string | null>(null);
  const [editingRevisionSignature, setEditingRevisionSignature] = useState<string | null>(null);

  // Form Inputs
  const [quizTopic, setQuizTopic] = useState('');
  const [totalMarks, setTotalMarks] = useState<number>(10);
  const [studentScores, setStudentScores] = useState<StudentScore[]>([]);

  // Refs array for auto-moving cursor down student inputs
  const scoreInputRefs = useRef<(HTMLInputElement | null)[]>([]);

  // Form Filters & Dynamic Pagination (Page 1 = 7 Students, Page 2+ = 9 Students)
  const [genderFilter, setGenderFilter] = useState<'All' | 'Male' | 'Female'>('All');
  const [belowThreshold, setBelowThreshold] = useState<string>('');
  const [formPage, setFormPage] = useState(1);
  const PAGE_1_SIZE = 7;
  const PAGE_SUBSEQUENT_SIZE = 9;
  const [isSaving, setIsSaving] = useState(false);
  const savingRef = useRef(false);
  const deletingRef = useRef(false);

  // Modal State for Viewing Full Quiz Details (5 per page)
  const [detailModalQuiz, setDetailModalQuiz] = useState<QuizRecord | null>(null);
  const [detailSearch, setDetailSearch] = useState('');
  const [detailGenderFilter, setDetailGenderFilter] = useState<'All' | 'Male' | 'Female'>('All');
  const [detailPage, setDetailPage] = useState(1);
  const DETAIL_PAGE_SIZE = 5;

  // Report configuration and the generated PDF stay within this existing page.
  const [isReportModalOpen, setIsReportModalOpen] = useState(false);
  const [reportScope, setReportScope] = useState<'individual' | 'month' | 'history' | 'range'>('history');
  const [reportQuizId, setReportQuizId] = useState('');
  const [reportStartMonth, setReportStartMonth] = useState(currentMonthKey);
  const [reportEndMonth, setReportEndMonth] = useState(currentMonthKey);
  const [isReportGenerating, setIsReportGenerating] = useState(false);
  const [reportProgress, setReportProgress] = useState<string | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [reportNotice, setReportNotice] = useState<string | null>(null);
  const [reportPdf, setReportPdf] = useState<{ url: string; filename: string; title: string } | null>(null);
  // Internal diagnostics only; this ref does not affect the rendered UI.
  const reportStageRef = useRef<string>('Idle');

  // Confirmation Modal for Deleting Quiz Card
  const [deleteConfirmQuiz, setDeleteConfirmQuiz] = useState<QuizRecord | null>(null);
  const [deleteConfirmClassId, setDeleteConfirmClassId] = useState<string | null>(null);
  const [deleteConfirmUserUid, setDeleteConfirmUserUid] = useState<string | null>(null);

  // Glowing Notification State
  const [centerNotification, setCenterNotification] = useState<string | null>(null);
  const notificationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showCenterNotification = (msg: string) => {
    if (notificationTimerRef.current) clearTimeout(notificationTimerRef.current);
    setCenterNotification(msg);
    notificationTimerRef.current = setTimeout(() => {
      setCenterNotification(null);
      notificationTimerRef.current = null;
    }, 3500);
  };

  /**
   * Re-check the current Firebase identity and its resolved tenant before each operation.
   * Tenant profile ownership is verified before class/quiz reads; Firestore Rules still provide
   * the actual server-side authorization boundary.
   */
  const assertActiveTeacher = (expectedUser: FirebaseUser, expectedTenantId: string): string => {
    const liveUser = auth.currentUser;
    if (
      !liveUser ||
      liveUser.uid !== expectedUser.uid ||
      liveUser.email !== expectedUser.email ||
      tenantState.status !== 'ready' ||
      tenantState.uid !== expectedUser.uid ||
      tenantState.tenantId !== expectedTenantId
    ) {
      throw new Error('AUTH_CONTEXT_CHANGED');
    }
    if (!expectedTenantId || expectedTenantId.includes('/')) throw new Error('INVALID_TENANT');
    return expectedTenantId;
  };

  const tenantKey = tenantState.status === 'ready' ? tenantState.tenantId || '' : '';
  const userUid = currentUser?.uid || '';
  const identityKey = userUid && tenantKey && tenantState.uid === userUid
    ? `${userUid}|${tenantKey}`
    : '';

  // Update month labels if the page stays open across a local month boundary.
  useEffect(() => {
    const refreshMonthKeys = () => {
      const next = getCurrentAndPrevMonthKeys(new Date());
      setMonthKeys((previous) =>
        previous.currentMonthKey === next.currentMonthKey && previous.prevMonthKey === next.prevMonthKey
          ? previous
          : next,
      );
    };
    const intervalId = window.setInterval(refreshMonthKeys, 60_000);
    window.addEventListener('focus', refreshMonthKeys);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('focus', refreshMonthKeys);
    };
  }, []);

  // 1. Auth Listener: clear tenant data as soon as the signed-in identity changes.
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setCurrentUser(user);
      setTenantState(user ? { status: 'resolving' } : { status: 'unauthenticated' });
      setClasses([]);
      setSelectedClassId('');
      setQuizzes([]);
      setStudentScores([]);
      setIsCreatingQuiz(false);
      setEditingQuizId(null);
      setEditingClassId(null);
      setEditingUserUid(null);
      setEditingRevisionSignature(null);
      setDetailModalQuiz(null);
      setDeleteConfirmQuiz(null);
      setDeleteConfirmClassId(null);
      setDeleteConfirmUserUid(null);
      setLoading(Boolean(user));
      if (!user) {
        const months = getCurrentAndPrevMonthKeys();
        setAvailableMonths([months.currentMonthKey]);
        setSelectedMonth(months.currentMonthKey);
      }
    });
    return () => unsubscribe();
  }, []);

  // Resolve the normalized email tenant and verify its users/{tenantId} profile before reading classes.
  // Existing email-keyed subcollections are retained when the profile document is absent (legacy tenant).
  useEffect(() => {
    let cancelled = false;
    setTenantState(currentUser ? { status: 'resolving' } : { status: 'unauthenticated' });
    setClasses([]);
    setSelectedClassId('');
    setQuizzes([]);

    if (!currentUser || !currentUser.uid) {
      setLoading(false);
      return () => { cancelled = true; };
    }

    setLoading(true);
    const resolveTenant = async () => {
      // EduTrack stores tenant data under normalized email-keyed paths. Never fall back
      // to users/{uid}, which is a different tenant namespace.
      const candidateId = normalizeEmailId(currentUser.email);
      if (!candidateId || candidateId.includes('/')) {
        if (!cancelled) {
          setTenantState({ status: 'denied', reason: 'Your account does not have a valid teacher workspace.' });
          setLoading(false);
        }
        return;
      }

      try {
        const profileSnapshot = await getDoc(doc(db, 'users', candidateId));
        if (cancelled || auth.currentUser?.uid !== currentUser.uid || auth.currentUser?.email !== currentUser.email) return;

        if (profileSnapshot.exists()) {
          const verification = verifyTeacherTenantProfile(profileSnapshot.data(), {
            uid: currentUser.uid,
            email: currentUser.email,
          });
          if (!verification.ok) {
            console.error('Quiz tenant verification failed:', verification.reason);
            setTenantState({ status: 'denied', reason: 'This teacher workspace is not assigned to the signed-in account.' });
            setClasses([]);
            setSelectedClassId('');
            setQuizzes([]);
            setLoading(false);
            showCenterNotification('This teacher workspace is not assigned to the signed-in account.');
            return;
          }
        } else {
          // Fail closed: a valid email alone is not proof of ownership of a tenant workspace.
          setTenantState({ status: 'denied', reason: 'No verified teacher profile was found for this account.' });
          setClasses([]);
          setSelectedClassId('');
          setQuizzes([]);
          setLoading(false);
          showCenterNotification('No verified teacher profile was found for this account.');
          return;
        }

        setTenantState({
          status: 'ready',
          tenantId: candidateId,
          uid: currentUser.uid,
          profileFound: profileSnapshot.exists(),
        });
      } catch (error) {
        if (cancelled) return;
        console.error('Error verifying teacher tenant:', error);
        setTenantState({ status: 'error', reason: getFirestoreErrorMessage(error, 'load classes') });
        setClasses([]);
        setSelectedClassId('');
        setQuizzes([]);
        setLoading(false);
        showCenterNotification(getFirestoreErrorMessage(error, 'load classes'));
      }
    };

    void resolveTenant();
    return () => { cancelled = true; };
  }, [currentUser]);

  useEffect(() => () => {
    if (notificationTimerRef.current) clearTimeout(notificationTimerRef.current);
  }, []);

  // 2. Fetch only this authenticated teacher's classes.
  useEffect(() => {
    let cancelled = false;
    setClasses([]);
    setSelectedClassId('');
    setQuizzes([]);

    if (!currentUser || !identityKey || !tenantKey) {
      setLoading(tenantState.status === 'resolving');
      return () => { cancelled = true; };
    }

    setLoading(true);
    const fetchClasses = async () => {
      try {
        const activeTenantId = assertActiveTeacher(currentUser, tenantKey);
        const classesRef = collection(db, ...getClassCollectionPath(activeTenantId));
        const querySnapshot = await getDocs(classesRef);
        assertActiveTeacher(currentUser, tenantKey);
        if (cancelled) return;

        const fetchedClasses: ClassItem[] = [];
        querySnapshot.forEach((classSnapshot) => {
          const data = classSnapshot.data();
          const extracted = extractStudents(data.students);

          if (extracted.format === 'unsupported') {
            console.error(
              `[Quiz] Class "${classSnapshot.id}" has an unsupported "students" value. Expected an array or map of student objects.`,
            );
          } else if (extracted.skipped > 0) {
            console.error(
              `[Quiz] Class "${classSnapshot.id}": ${extracted.skipped} student entr${extracted.skipped === 1 ? 'y was' : 'ies were'} skipped because its real, stable student ID was missing or duplicated.`,
            );
          }

          fetchedClasses.push({
            id: classSnapshot.id,
            className: typeof data.className === 'string' ? data.className :
              typeof data.name === 'string' ? data.name : 'Unnamed Class',
            classCode: typeof data.classCode === 'string' ? data.classCode :
              typeof data.code === 'string' ? data.code : 'N/A',
            students: [...extracted.students].sort(compareStudentOrder),
          });
        });

        fetchedClasses.sort((a, b) => a.className.localeCompare(b.className));
        if (cancelled || auth.currentUser?.uid !== currentUser.uid || auth.currentUser?.email !== currentUser.email) return;
        setClasses(fetchedClasses);
        setSelectedClassId((previous) =>
          fetchedClasses.some((item) => item.id === previous) ? previous : fetchedClasses[0]?.id || '',
        );
      } catch (error) {
        if (cancelled) return;
        console.error('Error loading teacher classes:', error);
        setClasses([]);
        setSelectedClassId('');
        if (auth.currentUser?.uid === currentUser.uid) {
          showCenterNotification(getFirestoreErrorMessage(error, 'load classes'));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void fetchClasses();
    return () => { cancelled = true; };
  }, [currentUser, identityKey, tenantKey, tenantState.status]);

  const currentClass = useMemo(() => {
    return classes.find((item) => item.id === selectedClassId) || null;
  }, [classes, selectedClassId]);

  // Filtered Classes for Selection Modal
  const filteredClassesModal = useMemo(() => {
    return classes.filter(
      (item) =>
        item.className.toLowerCase().includes(classSearchText.toLowerCase()) ||
        item.classCode.toLowerCase().includes(classSearchText.toLowerCase()),
    );
  }, [classes, classSearchText]);

  // 3. Fetch this class's quizzes. Reads never perform destructive cleanup.
  useEffect(() => {
    let cancelled = false;
    setQuizzes([]);

    if (!currentUser || !identityKey || !tenantKey || !selectedClassId) {
      setIsCreatingQuiz(false);
      setEditingQuizId(null);
      setEditingClassId(null);
      setEditingUserUid(null);
      setEditingRevisionSignature(null);
      return () => { cancelled = true; };
    }

    const targetClassId = selectedClassId;
    setIsCreatingQuiz(false);
    setEditingQuizId(null);
    setEditingClassId(null);
    setEditingUserUid(null);
    setEditingRevisionSignature(null);
    setDetailModalQuiz(null);
    setDeleteConfirmQuiz(null);
    setDeleteConfirmClassId(null);
    setDeleteConfirmUserUid(null);

    const fetchQuizzes = async () => {
      try {
        const activeTenantId = assertActiveTeacher(currentUser, tenantKey);
        const quizCollectionRef = collection(db, ...getQuizCollectionPath(activeTenantId, targetClassId));
        const querySnapshot = await getDocs(quizCollectionRef);
        assertActiveTeacher(currentUser, tenantKey);
        if (cancelled) return;

        const fetchedQuizzes: QuizRecord[] = querySnapshot.docs.map((quizSnapshot) => {
          const data = quizSnapshot.data() as Record<string, unknown>;
          const createdAt = timestampToMillis(data.createdAt) ?? 0;
          const date = typeof data.date === 'string' && data.date.trim()
            ? data.date
            : createdAt > 0 ? formatDateLabel(new Date(createdAt)) : '';
          const resolvedMonthKey = resolveQuizMonthKey(date, data.createdAt, data.monthKey)
            ?? (typeof data.monthKey === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(data.monthKey) ? data.monthKey : currentMonthKey);
          const total = typeof data.totalMarks === 'number' && Number.isFinite(data.totalMarks)
            ? data.totalMarks
            : Number(data.totalMarks);
          const safeTotal = Number.isFinite(total) && total > 0 ? total : 0;
          const rawScoreRows = Array.isArray(data.studentScores) ? data.studentScores : [];
          const normalizedScores = normalizeStoredScores(rawScoreRows);
          const unidentifiableScoreCount = Math.max(0, rawScoreRows.length - normalizedScores.length);
          const scores = normalizedScores.sort(compareStudentOrder);
          const topic = typeof data.topic === 'string' ? data.topic : '';

          return {
            id: quizSnapshot.id,
            topic,
            totalMarks: safeTotal,
            date,
            monthKey: resolvedMonthKey,
            createdAt,
            studentScores: scores,
            averageScore: calculateAverageScore(scores, safeTotal),
            unidentifiableScoreCount,
            updatedAt: timestampToMillis(data.updatedAt) ?? undefined,
            updatedByUid: typeof data.updatedByUid === 'string' ? data.updatedByUid : undefined,
            revisionSignature: quizRevisionSignature(data),
          };
        });

        if (cancelled || auth.currentUser?.uid !== currentUser.uid || auth.currentUser?.email !== currentUser.email) return;
        const hasPreviousMonthData = fetchedQuizzes.some((quiz) => quiz.monthKey === prevMonthKey);
        const nextAvailableMonths = hasPreviousMonthData
          ? [currentMonthKey, prevMonthKey]
          : [currentMonthKey];
        setAvailableMonths(nextAvailableMonths);
        setSelectedMonth((previous) => nextAvailableMonths.includes(previous) ? previous : currentMonthKey);
        fetchedQuizzes.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        setQuizzes(fetchedQuizzes);
      } catch (error) {
        if (cancelled) return;
        console.error('Error loading class quizzes:', error);
        setQuizzes([]);
        if (auth.currentUser?.uid === currentUser.uid) {
          showCenterNotification(getFirestoreErrorMessage(error, 'load quizzes'));
        }
      }
    };

    void fetchQuizzes();
    return () => { cancelled = true; };
  }, [currentUser, identityKey, tenantKey, tenantState.status, selectedClassId, currentMonthKey, prevMonthKey]);

  // Filter quizzes by selected month
  const filteredQuizzesByMonth = useMemo(() => {
    return quizzes.filter((quiz) => quiz.monthKey === selectedMonth);
  }, [quizzes, selectedMonth]);


  const selectedMonthValidAttempts = useMemo(() => {
    return filteredQuizzesByMonth.reduce((count, quiz) => {
      if (!Number.isFinite(quiz.totalMarks) || quiz.totalMarks <= 0) return count;
      return count + quiz.studentScores.filter((student) => {
        const mark = parseMark(student.marksObtained);
        return mark.kind === 'valid' && mark.value !== undefined && mark.value <= quiz.totalMarks;
      }).length;
    }, 0);
  }, [filteredQuizzesByMonth]);

  const selectedMonthAveragePercentage = useMemo(() => {
    const percentages: number[] = [];
    filteredQuizzesByMonth.forEach((quiz) => {
      if (!Number.isFinite(quiz.totalMarks) || quiz.totalMarks <= 0) return;
      quiz.studentScores.forEach((student) => {
        const mark = parseMark(student.marksObtained);
        if (mark.kind === 'valid' && mark.value !== undefined && mark.value <= quiz.totalMarks) {
          percentages.push((mark.value / quiz.totalMarks) * 100);
        }
      });
    });
    return percentages.length
      ? percentages.reduce((sum, value) => sum + value, 0) / percentages.length
      : null;
  }, [filteredQuizzesByMonth]);

  useEffect(() => {
    setReportError(null);
    setReportNotice(null);
    setReportPdf(null);
    setReportQuizId((previous) => quizzes.some((quiz) => quiz.id === previous) ? previous : quizzes[0]?.id || '');
  }, [selectedClassId]);

  useEffect(() => {
    return () => {
      if (reportPdf?.url) URL.revokeObjectURL(reportPdf.url);
    };
  }, [reportPdf]);

  useEffect(() => {
    setReportQuizId((previous) => quizzes.some((quiz) => quiz.id === previous) ? previous : quizzes[0]?.id || '');
  }, [quizzes]);

  // Keep the existing render JSX unchanged while validating legacy marks against each quiz total.
  const getCategoryPerformers = (scores: StudentScore[]) => {
    const quiz = quizzes.find((item) => item.studentScores === scores);
    return calculateCategoryPerformers(scores, quiz?.totalMarks ?? Number.POSITIVE_INFINITY);
  };

  // Record non-sensitive report diagnostics without logging authentication tokens or student data.
  const logReportFailure = (stage: string, failureDomain: string, error: unknown, extraContext: Record<string, unknown> = {}) => {
    const source = error && typeof error === 'object' ? error as { code?: unknown; message?: unknown; name?: unknown; stack?: unknown } : null;
    const context = {
      scope: reportScope,
      classId: selectedClassIdRef.current || null,
      selectedMonth,
      startMonth: reportStartMonth,
      endMonth: reportEndMonth,
      tenantPathTemplate: selectedClassIdRef.current
        ? `users/{normalizedTeacherEmail}/classes/${selectedClassIdRef.current}/quizzes`
        : 'users/{normalizedTeacherEmail}/classes/{classId}/quizzes',
      ...extraContext,
    };
    console.error('[EduTrack Quiz Report Diagnostic]', {
      reportStage: stage,
      failureDomain,
      firebaseErrorCode: typeof source?.code === 'string' ? source.code : null,
      originalErrorMessage: typeof source?.message === 'string' ? source.message : String(error ?? 'Unknown error'),
      errorName: typeof source?.name === 'string' ? source.name : typeof error,
      errorStack: typeof source?.stack === 'string' ? source.stack : null,
      context,
    }, error);
  };

  // Generate a tenant-verified PDF from a fresh Firestore read. All reporting code is kept here.
  const handleGenerateReport = async () => {
    if (isReportGenerating) return;
    let reportStage = 'Validating report request';
    let reportFailureDomain = 'input-validation';
    let quizDocumentsRead: number | null = null;
    let includedQuizCount: number | null = null;
    let pdfByteLength: number | null = null;
    let pendingReportObjectUrl: string | null = null;
    const moveReportStage = (stage: string, failureDomain: string) => {
      reportStage = stage;
      reportFailureDomain = failureDomain;
      reportStageRef.current = stage;
    };
    moveReportStage(reportStage, reportFailureDomain);
    const expectedUser = currentUser;
    const expectedTenantId = tenantKey;
    const targetClassId = selectedClassIdRef.current;
    if (!expectedUser || !expectedTenantId || !targetClassId || !classes.some((item) => item.id === targetClassId)) {
      setReportError('Select a verified class and sign in again before generating a report.');
      return;
    }
    if (reportScope === 'individual' && !reportQuizId) {
      setReportError('Select a quiz for the individual report.');
      return;
    }
    if (reportScope === 'range' && (!/^\d{4}-(0[1-9]|1[0-2])$/.test(reportStartMonth) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(reportEndMonth) || reportStartMonth > reportEndMonth)) {
      setReportError('Choose a valid inclusive month range; the starting month must not be after the ending month.');
      return;
    }

    const assertReportContext = () => {
      assertActiveTeacher(expectedUser, expectedTenantId);
      if (
        auth.currentUser?.uid !== expectedUser.uid ||
        auth.currentUser?.email !== expectedUser.email ||
        selectedClassIdRef.current !== targetClassId ||
        !classes.some((item) => item.id === targetClassId)
      ) {
        throw new Error('REPORT_CONTEXT_CHANGED');
      }
    };

    setIsReportGenerating(true);
    moveReportStage('Verifying teacher workspace', 'context-validation');
    setReportProgress('Verifying teacher workspace...');
    setReportError(null);
    setReportNotice(null);
    setReportPdf(null);

    // Firestore reads should never leave the modal spinning forever. A timeout does not
    // bypass authorization or produce a partial report; it exits with a clear retry message.
    const withReportReadTimeout = <T,>(request: Promise<T>, step: string): Promise<T> => {
      let timeoutId: number | undefined;
      const timeout = new Promise<T>((_resolve, reject) => {
        timeoutId = window.setTimeout(() => reject(new Error(`REPORT_READ_TIMEOUT:${step}`)), 25000);
      });
      return Promise.race([request, timeout]).finally(() => {
        if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      });
    };

    try {
      assertReportContext();
      moveReportStage('Reading teacher profile (initial verification)', 'firestore-read');
      const profileBefore = await withReportReadTimeout(getDoc(doc(db, 'users', expectedTenantId)), 'teacher profile');
      moveReportStage('Validating teacher profile ownership', 'profile-validation');
      assertReportContext();
      if (!profileBefore.exists()) throw new Error('REPORT_PROFILE_UNVERIFIED');
      const profileData = profileBefore.data() as Record<string, unknown>;
      const initialVerification = verifyTeacherTenantProfile(profileData, { uid: expectedUser.uid, email: expectedUser.email });
      if (!initialVerification.ok) throw new Error('REPORT_PROFILE_UNVERIFIED');

      moveReportStage('Reading selected class document', 'firestore-read');
      setReportProgress('Refreshing the selected class...');
      const classSnapshot = await withReportReadTimeout(
        getDoc(doc(db, ...getClassCollectionPath(expectedTenantId), targetClassId)),
        'selected class',
      );
      moveReportStage('Validating selected class document', 'report-data-validation');
      assertReportContext();
      if (!classSnapshot.exists()) throw new Error('REPORT_CLASS_NOT_FOUND');

      // Query the full class quiz collection, not the selected-month list or visible/paginated cards.
      moveReportStage('Reading all saved quizzes for the selected class', 'firestore-read');
      setReportProgress('Refreshing all saved quizzes across every month...');
      const quizSnapshot = await withReportReadTimeout(
        getDocs(collection(db, ...getQuizCollectionPath(expectedTenantId, targetClassId))),
        'class quiz history',
      );
      quizDocumentsRead = quizSnapshot.size;
      moveReportStage('Rechecking teacher profile after quiz history read', 'firestore-read');
      assertReportContext();
      setReportProgress('Rechecking teacher access and validating saved score rows...');
      const profileAfter = await withReportReadTimeout(getDoc(doc(db, 'users', expectedTenantId)), 'teacher profile recheck');
      moveReportStage('Validating refreshed teacher ownership and historical records', 'report-data-validation');
      assertReportContext();
      if (!profileAfter.exists()) throw new Error('REPORT_PROFILE_UNVERIFIED');
      const finalVerification = verifyTeacherTenantProfile(profileAfter.data() as Record<string, unknown>, { uid: expectedUser.uid, email: expectedUser.email });
      if (!finalVerification.ok) throw new Error('REPORT_PROFILE_UNVERIFIED');

      moveReportStage('Normalizing saved quiz records and auditing score rows', 'report-data-validation');
      type AuditedScore = StudentScore & { reportMarkKind: 'valid' | 'empty' | 'invalid' };
      type AuditedQuiz = QuizRecord & {
        reportRows: AuditedScore[];
        rawRowCount: number;
        unidentifiableRows: number;
        invalidMarkCount: number;
        dataIssues: string[];
        monthResolved: boolean;
      };
      const fetchedForReport: AuditedQuiz[] = quizSnapshot.docs.map((quizDoc) => {
        const raw = quizDoc.data() as Record<string, unknown>;
        const issues: string[] = [];
        const topic = typeof raw.topic === 'string' && raw.topic.trim() ? raw.topic.trim() : '(Untitled Quiz)';
        if (topic === '(Untitled Quiz)') issues.push('Quiz title is missing.');
        const totalCandidate = typeof raw.totalMarks === 'number' ? raw.totalMarks : Number(raw.totalMarks);
        const totalMarks = Number.isFinite(totalCandidate) && totalCandidate > 0 ? totalCandidate : 0;
        if (totalMarks <= 0) issues.push('Total marks are missing or invalid; marks cannot be normalized safely.');
        const createdAt = timestampToMillis(raw.createdAt) ?? 0;
        const date = typeof raw.date === 'string' && raw.date.trim()
          ? raw.date.trim()
          : createdAt > 0 ? formatDateLabel(new Date(createdAt)) : '';
        const safeStoredMonth = typeof raw.monthKey === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(raw.monthKey) ? raw.monthKey : undefined;
        const resolved = resolveQuizMonthKey(date, raw.createdAt, safeStoredMonth);
        const isoDateMatch = date.match(/^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/);
        let isoFallbackMonth = '';
        if (isoDateMatch) {
          const isoDate = new Date(Number(isoDateMatch[1]), Number(isoDateMatch[2]) - 1, Number(isoDateMatch[3]));
          if (isoDate.getFullYear() === Number(isoDateMatch[1]) && isoDate.getMonth() === Number(isoDateMatch[2]) - 1 && isoDate.getDate() === Number(isoDateMatch[3])) {
            isoFallbackMonth = `${isoDateMatch[1]}-${isoDateMatch[2]}`;
          }
        }
        const monthKey = typeof resolved === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(resolved) ? resolved : isoFallbackMonth;
        if (!monthKey) issues.push('Month could not be resolved from the saved month/date/createdAt fields.');
        if (!date) issues.push('Quiz date is unavailable.');

        const hasScoreArray = Array.isArray(raw.studentScores);
        const rawRows: unknown[] = hasScoreArray ? raw.studentScores as unknown[] : [];
        if (!hasScoreArray) issues.push('studentScores is missing or is not an array.');
        const seenIds = new Set<string>();
        const reportRows: AuditedScore[] = [];
        let unidentifiableRows = 0;
        let invalidMarkCount = 0;
        rawRows.forEach((rawRow) => {
          if (!rawRow || typeof rawRow !== 'object' || Array.isArray(rawRow)) {
            unidentifiableRows++;
            return;
          }
          const row = rawRow as Record<string, unknown>;
          const id = (typeof row.id === 'string' && row.id.trim() ? row.id : typeof row.studentId === 'string' ? row.studentId : '').trim();
          if (!id || seenIds.has(id)) {
            unidentifiableRows++;
            return;
          }
          seenIds.add(id);
          const parsed = parseMark(row.marksObtained);
          let reportMarkKind: AuditedScore['reportMarkKind'];
          if (parsed.kind === 'empty') reportMarkKind = 'empty';
          else if (parsed.kind === 'valid' && totalMarks > 0 && parsed.value !== undefined && parsed.value <= totalMarks) reportMarkKind = 'valid';
          else {
            reportMarkKind = 'invalid';
            invalidMarkCount++;
          }
          const marksObtained = parsed.kind === 'valid'
            ? parsed.value!
            : parsed.kind === 'empty' ? '' : String(row.marksObtained ?? '');
          reportRows.push({
            ...row,
            id,
            name: typeof row.name === 'string' && row.name.trim() ? row.name.trim() : 'Unknown student',
            rollNo: String(row.rollNo ?? row.rollNumber ?? ''),
            gender: typeof row.gender === 'string' ? row.gender : '',
            marksObtained,
            reportMarkKind,
          } as AuditedScore);
        });
        if (unidentifiableRows > 0) issues.push(`${unidentifiableRows} saved score row(s) had missing/duplicate IDs or malformed row data and cannot be joined safely by student ID.`);
        if (invalidMarkCount > 0) issues.push(`${invalidMarkCount} score value(s) were invalid or exceeded this quiz's total marks and were excluded from statistics.`);

        const plainRows = reportRows.map((row) => ({
          ...row,
          reportMarkKind: undefined,
        } as StudentScore));
        return {
          id: quizDoc.id,
          topic,
          totalMarks,
          date,
          monthKey,
          createdAt,
          studentScores: plainRows,
          averageScore: calculateAverageScore(plainRows, totalMarks),
          unidentifiableScoreCount: unidentifiableRows,
          updatedAt: timestampToMillis(raw.updatedAt) ?? undefined,
          updatedByUid: typeof raw.updatedByUid === 'string' ? raw.updatedByUid : undefined,
          revisionSignature: quizRevisionSignature(raw),
          reportRows,
          rawRowCount: rawRows.length,
          unidentifiableRows,
          invalidMarkCount,
          dataIssues: issues,
          monthResolved: Boolean(monthKey),
        };
      });

      // Month/range reports cannot truthfully assert completeness when a saved quiz's month is unknown.
      if ((reportScope === 'month' || reportScope === 'range') && fetchedForReport.some((quiz) => !quiz.monthResolved)) {
        throw new Error('REPORT_UNKNOWN_MONTHS');
      }

      moveReportStage('Applying report scope to refreshed class history', 'report-data-validation');
      let reportQuizzes: AuditedQuiz[];
      if (reportScope === 'individual') {
        const chosen = fetchedForReport.find((quiz) => quiz.id === reportQuizId);
        if (!chosen) throw new Error('REPORT_QUIZ_NOT_FOUND');
        reportQuizzes = [chosen];
      } else if (reportScope === 'month') {
        reportQuizzes = fetchedForReport.filter((quiz) => quiz.monthKey === selectedMonth);
      } else if (reportScope === 'range') {
        reportQuizzes = fetchedForReport.filter((quiz) => quiz.monthKey >= reportStartMonth && quiz.monthKey <= reportEndMonth);
      } else {
        reportQuizzes = [...fetchedForReport];
      }
      reportQuizzes.sort((a, b) => (a.monthKey || '9999-99').localeCompare(b.monthKey || '9999-99') || (a.createdAt - b.createdAt) || a.topic.localeCompare(b.topic));
      includedQuizCount = reportQuizzes.length;
      const reportWarnings = reportQuizzes.flatMap((quiz) => quiz.dataIssues.map((issue) => `${quiz.topic} (${quiz.id}): ${issue}`));

      // Refresh the page's cache only after a successful, tenant-verified read. Keep raw marks out of UI state if invalid.
      assertReportContext();
      setQuizzes([...fetchedForReport].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map((quiz) => {
        const safeScores = quiz.reportRows.map((row) => ({
          id: row.id,
          name: row.name,
          rollNo: row.rollNo,
          gender: row.gender,
          marksObtained: row.reportMarkKind === 'valid' ? row.marksObtained : '',
        } as StudentScore));
        return {
          id: quiz.id,
          topic: quiz.topic,
          totalMarks: quiz.totalMarks,
          date: quiz.date,
          monthKey: quiz.monthKey,
          createdAt: quiz.createdAt,
          studentScores: safeScores,
          averageScore: calculateAverageScore(safeScores, quiz.totalMarks),
          unidentifiableScoreCount: quiz.unidentifiableRows,
          updatedAt: quiz.updatedAt,
          updatedByUid: quiz.updatedByUid,
          revisionSignature: quiz.revisionSignature,
        };
      }));

      const liveClassData = classSnapshot.data() as Record<string, unknown>;
      const liveRosterExtraction = extractStudents(liveClassData.students);
      const liveRosterForReport = liveRosterExtraction.students;
      if (liveRosterExtraction.format === 'unsupported') reportWarnings.push('Current class roster has an unsupported format and could not be used to enrich historical student identity details.');
      else if (liveRosterExtraction.skipped > 0) reportWarnings.push(`Current class roster: ${liveRosterExtraction.skipped} malformed/missing/duplicate student identity record(s) were not used for identity enrichment.`);
      const className = typeof liveClassData.className === 'string' ? liveClassData.className : typeof liveClassData.name === 'string' ? liveClassData.name : currentClass?.className || 'Unnamed Class';
      const classCode = typeof liveClassData.classCode === 'string' ? liveClassData.classCode : typeof liveClassData.code === 'string' ? liveClassData.code : currentClass?.classCode || 'N/A';
      const profileForHeader = profileAfter.data() as Record<string, unknown>;
      const teacherName = typeof profileForHeader.teacherName === 'string' && profileForHeader.teacherName.trim()
        ? profileForHeader.teacherName.trim()
        : typeof profileForHeader.fullName === 'string' && profileForHeader.fullName.trim()
          ? profileForHeader.fullName.trim()
          : expectedUser.displayName || expectedUser.email || 'Teacher';
      const schoolNameValue = [profileForHeader.schoolName, profileForHeader.institutionName, profileForHeader.organizationName]
        .find((value) => typeof value === 'string' && value.trim());
      const schoolName = typeof schoolNameValue === 'string' ? schoolNameValue.trim() : '';
      const generatedAt = new Date();
      const generatedAtLabel = generatedAt.toLocaleString();
      const monthLabel = (key: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(key)
        ? new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
        : 'Unknown period';
      let periodLabel = 'All available saved quiz history';
      if (reportScope === 'individual') periodLabel = reportQuizzes[0]?.monthKey ? monthLabel(reportQuizzes[0].monthKey) : (reportQuizzes[0]?.date || 'Unknown period');
      else if (reportScope === 'month') periodLabel = monthLabel(selectedMonth);
      else if (reportScope === 'range') periodLabel = `${monthLabel(reportStartMonth)} to ${monthLabel(reportEndMonth)} (inclusive)`;
      else {
        const knownMonths = reportQuizzes.map((quiz) => quiz.monthKey).filter(Boolean).sort();
        periodLabel = knownMonths.length ? `${monthLabel(knownMonths[0])} to ${monthLabel(knownMonths[knownMonths.length - 1])}` : 'All saved records; dates unavailable';
        if (reportQuizzes.some((quiz) => !quiz.monthResolved)) periodLabel += ' (some dates unresolved)';
      }

      moveReportStage('Preparing report metadata, tables and performance calculations', 'report-data-validation');
      setReportProgress('Preparing report tables and performance calculations...');
      const isIndividual = reportScope === 'individual';
      const pdfTitle = isIndividual ? 'Quiz Result Report' : reportScope === 'month'
        ? 'Selected Month Quiz Report'
        : reportScope === 'range' ? 'Custom Month Range Quiz Report' : 'Complete Class Quiz History & Performance Report';
      const classSlug = (classCode && classCode !== 'N/A' ? classCode : className)
        .normalize('NFKD').replace(/[^\x00-\x7F]/g, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 45) || 'Class';
      const filenameSlug = (value: string) => value.normalize('NFKD').replace(/[^\x00-\x7F]/g, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'Report';
      const individualQuiz = isIndividual ? reportQuizzes[0] : null;
      const filename = isIndividual
        ? `EduTrack_Quiz_${classSlug}_${filenameSlug(individualQuiz?.topic || 'Quiz')}_${filenameSlug(individualQuiz?.monthKey || 'UnknownPeriod')}.pdf`
        : reportScope === 'history'
          ? `EduTrack_Complete_Quiz_History_${classSlug}.pdf`
          : reportScope === 'month'
            ? `EduTrack_Quiz_Month_${classSlug}_${selectedMonth}.pdf`
            : `EduTrack_Quiz_Range_${classSlug}_${reportStartMonth}_to_${reportEndMonth}.pdf`;

      // Small built-in PDF writer: searchable text, vector rules, repeating table headers and automatic pages; no new dependency.
      const PAGE_W = 842;
      const PAGE_H = 595;
      const MARGIN_X = 16;
      const CONTENT_W = PAGE_W - MARGIN_X * 2;
      type PdfPage = { section: string; commands: string[] };
      type PdfColumn = { label: string; width: number };
      const pdfPages: PdfPage[] = [];
      let pdfPage: PdfPage = { section: '', commands: [] };
      let cursorY = 100;
      let currentSection = 'Report Overview';
      const ascii = (value: unknown) => String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[—–]/g, '-')
        .replace(/[’‘]/g, "'")
        .replace(/[“”]/g, '"')
        .replace(/•/g, '|')
        .replace(/×/g, 'x')
        .replace(/≤/g, '<=')
        .replace(/≥/g, '>=')
        .replace(/%/g, '%')
        .replace(/[^\x20-\x7E]/g, '?')
        .replace(/[\r\n\t]+/g, ' ');
      const pdfEscape = (value: unknown) => ascii(value).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
      const colorString = (color: [number, number, number]) => color.map((component) => component.toFixed(3)).join(' ');
      const addRect = (x: number, y: number, width: number, height: number, fill: [number, number, number], stroke?: [number, number, number]) => {
        if (!pdfPage) return;
        const command = [`q ${colorString(fill)} rg ${x.toFixed(2)} ${(PAGE_H - y - height).toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)} re f`];
        if (stroke) command.push(`${colorString(stroke)} RG 0.5 w ${x.toFixed(2)} ${(PAGE_H - y - height).toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)} re S`);
        command.push('Q');
        pdfPage.commands.push(command.join('\n'));
      };
      const addLine = (x1: number, y1: number, x2: number, y2: number, color: [number, number, number] = [0.88, 0.90, 0.93], thickness = 0.5) => {
        if (!pdfPage) return;
        pdfPage.commands.push(`q ${colorString(color)} RG ${thickness} w ${x1.toFixed(2)} ${(PAGE_H - y1).toFixed(2)} m ${x2.toFixed(2)} ${(PAGE_H - y2).toFixed(2)} l S Q`);
      };
      const addText = (x: number, y: number, value: unknown, size = 8, bold = false, color: [number, number, number] = [0.16, 0.20, 0.27]) => {
        if (!pdfPage) return;
        const textValue = pdfEscape(value);
        pdfPage.commands.push(`BT /${bold ? 'F2' : 'F1'} ${size.toFixed(2)} Tf ${colorString(color)} rg 1 0 0 1 ${x.toFixed(2)} ${(PAGE_H - y - size).toFixed(2)} Tm (${textValue}) Tj ET`);
      };
      const wrapPdfText = (value: unknown, maxChars: number, maxLines = 4) => {
        const clean = ascii(value).trim();
        if (!clean) return [''];
        const lines: string[] = [];
        let line = '';
        clean.split(/\s+/).forEach((word) => {
          while (word.length > maxChars) {
            if (line) { lines.push(line); line = ''; }
            lines.push(word.slice(0, maxChars));
            word = word.slice(maxChars);
          }
          if (!word) return;
          const candidate = line ? `${line} ${word}` : word;
          if (candidate.length > maxChars && line) { lines.push(line); line = word; }
          else line = candidate;
        });
        if (line) lines.push(line);
        if (lines.length > maxLines) {
          const limited = lines.slice(0, maxLines);
          const last = limited[maxLines - 1];
          limited[maxLines - 1] = last.length >= maxChars ? `${last.slice(0, Math.max(0, maxChars - 3))}...` : `${last}...`;
          return limited;
        }
        return lines;
      };
      const startPdfPage = (section: string) => {
        currentSection = section;
        pdfPage = { section, commands: [] };
        pdfPages.push(pdfPage);
        addRect(0, 0, PAGE_W, 7, [0.96, 0.38, 0.06]);
        addText(20, 15, 'EduTrack', 18, true, [0.11, 0.15, 0.22]);
        addText(115, 23, 'EDUCATION MANAGEMENT', 7, true, [0.48, 0.52, 0.58]);
        addText(20, 43, pdfTitle, pdfTitle.length > 44 ? 11 : 13, true, [0.13, 0.17, 0.23]);
        addText(20, 63, `${className} (${classCode}) | ${periodLabel}`, 7.4, false, [0.40, 0.44, 0.50]);
        addLine(20, 82, PAGE_W - 20, 82, [0.91, 0.92, 0.94], 0.8);
        if (section && section !== 'Report Overview') addText(PAGE_W - 230, 23, section.slice(0, 36), 7, false, [0.67, 0.36, 0.10]);
        cursorY = 98;
      };
      const ensurePdfSpace = (height: number, section = currentSection) => {
        if (cursorY + height > PAGE_H - 32) startPdfPage(section);
      };
      const addSectionTitle = (title: string) => {
        ensurePdfSpace(25, title);
        addRect(MARGIN_X, cursorY + 1, 3, 14, [0.96, 0.38, 0.06]);
        addText(MARGIN_X + 10, cursorY, title, 10, true, [0.15, 0.19, 0.25]);
        cursorY += 22;
      };
      const addParagraph = (value: unknown, size = 7.5, color: [number, number, number] = [0.31, 0.35, 0.41], indent = 0) => {
        const chars = Math.floor((CONTENT_W - indent) / (size * 0.52));
        const lines = wrapPdfText(value, Math.max(24, chars), 7);
        lines.forEach((line) => {
          ensurePdfSpace(size + 4);
          addText(MARGIN_X + indent, cursorY, line, size, false, color);
          cursorY += size + 3;
        });
        cursorY += 2;
      };
      const addSummaryCards = (cards: Array<{ label: string; value: string; detail?: string }>) => {
        const columns = 4;
        const gap = 8;
        const cardWidth = (CONTENT_W - gap * (columns - 1)) / columns;
        const cardHeight = 52;
        for (let i = 0; i < cards.length; i += columns) {
          ensurePdfSpace(cardHeight + 10);
          const row = cards.slice(i, i + columns);
          row.forEach((card, index) => {
            const x = MARGIN_X + index * (cardWidth + gap);
            addRect(x, cursorY, cardWidth, cardHeight, [0.985, 0.987, 0.991], [0.88, 0.90, 0.93]);
            addRect(x, cursorY, 3, cardHeight, [0.96, 0.38, 0.06]);
            addText(x + 10, cursorY + 7, card.label.toUpperCase(), 6.2, true, [0.47, 0.50, 0.56]);
            addText(x + 10, cursorY + 19, card.value, card.value.length > 18 ? 9 : 12, true, [0.13, 0.17, 0.23]);
            if (card.detail) addText(x + 10, cursorY + 38, card.detail.slice(0, 44), 6.2, false, [0.45, 0.48, 0.54]);
          });
          cursorY += cardHeight + 8;
        }
        cursorY += 2;
      };
      const addTable = (title: string, columns: PdfColumn[], inputRows: string[][]) => {
        addSectionTitle(title);
        const sumWidths = columns.reduce((sum, column) => sum + column.width, 0) || CONTENT_W;
        const scaledColumns = columns.map((column) => ({ ...column, width: column.width * CONTENT_W / sumWidths }));
        const fontSize = columns.length >= 12 ? 5.5 : columns.length >= 9 ? 6.0 : 6.5;
        const lineHeight = fontSize + 2;
        const drawTableHeader = () => {
          const headerHeight = 25;
          addRect(MARGIN_X, cursorY, CONTENT_W, headerHeight, [1.0, 0.94, 0.89], [0.94, 0.78, 0.67]);
          let x = MARGIN_X;
          scaledColumns.forEach((column) => {
            const lines = wrapPdfText(column.label, Math.max(4, Math.floor((column.width - 8) / (fontSize * 0.5))), 2);
            lines.forEach((line, lineIndex) => addText(x + 4, cursorY + 5 + lineIndex * (fontSize + 1), line, fontSize, true, [0.48, 0.25, 0.12]));
            x += column.width;
          });
          cursorY += headerHeight;
        };
        drawTableHeader();
        const rows = inputRows.length ? inputRows : [[`No rows available for this selection.`, ...columns.slice(1).map(() => '')]];
        rows.forEach((row, rowIndex) => {
          const wrappedCells = scaledColumns.map((column, cellIndex) => wrapPdfText(row[cellIndex] ?? '', Math.max(4, Math.floor((column.width - 8) / (fontSize * 0.50))), 3));
          const lineCount = Math.max(1, ...wrappedCells.map((lines) => lines.length));
          const rowHeight = Math.max(18, lineCount * lineHeight + 7);
          if (cursorY + rowHeight > PAGE_H - 34) {
            startPdfPage(`${title} (continued)`);
            addSectionTitle(`${title} (continued)`);
            drawTableHeader();
          }
          addRect(MARGIN_X, cursorY, CONTENT_W, rowHeight, rowIndex % 2 === 0 ? [1, 1, 1] : [0.975, 0.980, 0.986]);
          addLine(MARGIN_X, cursorY + rowHeight, PAGE_W - MARGIN_X, cursorY + rowHeight, [0.89, 0.91, 0.93], 0.35);
          let x = MARGIN_X;
          wrappedCells.forEach((lines, cellIndex) => {
            lines.forEach((line, lineIndex) => addText(x + 4, cursorY + 4 + lineIndex * lineHeight, line, fontSize, false, [0.18, 0.22, 0.29]));
            x += scaledColumns[cellIndex].width;
          });
          cursorY += rowHeight;
        });
        cursorY += 10;
      };
      const pdfEncoder = new TextEncoder();
      const encodePdfAscii = (value: string, part: string) => {
        // Built-in Helvetica fonts use WinAnsi; all visible text is deliberately reduced to ASCII above.
        // Fail closed if a new field bypasses that escaping/sanitization rather than emitting a fragile PDF.
        if (/[\u0080-\uFFFF]/.test(value)) throw new Error(`REPORT_PDF_NON_ASCII:${part}`);
        return pdfEncoder.encode(value);
      };

      const buildPdfText = (): Uint8Array => {
        moveReportStage('Serializing PDF page content and font resources', 'pdf-serialization');
        pdfPages.forEach((page, index) => {
          page.commands.push(`q 0.88 0.90 0.93 RG 0.5 w 20 ${(PAGE_H - 570).toFixed(2)} m ${(PAGE_W - 20).toFixed(2)} ${(PAGE_H - 570).toFixed(2)} l S Q`);
          page.commands.push(`BT /F1 6.50 Tf 0.42 0.45 0.50 rg 1 0 0 1 20 ${(PAGE_H - 580 - 6.5).toFixed(2)} Tm (${pdfEscape(`${className} | ${pdfTitle} | ${periodLabel}`)}) Tj ET`);
          page.commands.push(`BT /F2 6.50 Tf 0.42 0.45 0.50 rg 1 0 0 1 ${(PAGE_W - 90).toFixed(2)} ${(PAGE_H - 580 - 6.5).toFixed(2)} Tm (${pdfEscape(`Page ${index + 1} of ${pdfPages.length}`)}) Tj ET`);
        });
        const objects: string[] = [];
        objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
        objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
        objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
        const pageRefs: string[] = [];
        pdfPages.forEach((page, index) => {
          const pageObjectId = 5 + index * 2;
          const contentObjectId = pageObjectId + 1;
          pageRefs.push(`${pageObjectId} 0 R`);
          const stream = page.commands.join('\n');
          const streamBytes = encodePdfAscii(stream, `page ${index + 1} content stream`);
          const pageObject = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObjectId} 0 R >>`;
          objects[pageObjectId] = pageObject;
          objects[contentObjectId] = `<< /Length ${streamBytes.byteLength} >>\nstream\n${stream}\nendstream`;
        });
        objects[2] = `<< /Type /Pages /Kids [${pageRefs.join(' ')}] /Count ${pageRefs.length} >>`;
        const maxObjectId = objects.length - 1;
        const header = '%PDF-1.4\n%EduTrack Report\n';
        let document = header;
        let byteOffset = encodePdfAscii(header, 'header').byteLength;
        const offsets = new Array(maxObjectId + 1).fill(0);
        for (let objectId = 1; objectId <= maxObjectId; objectId++) {
          const objectSource = `${objectId} 0 obj\n${objects[objectId]}\nendobj\n`;
          const objectBytes = encodePdfAscii(objectSource, `object ${objectId}`);
          offsets[objectId] = byteOffset;
          document += objectSource;
          byteOffset += objectBytes.byteLength;
        }
        moveReportStage('Writing PDF cross-reference table and trailer', 'pdf-serialization');
        const xrefOffset = byteOffset;
        let xrefAndTrailer = `xref\n0 ${maxObjectId + 1}\n0000000000 65535 f \n`;
        for (let objectId = 1; objectId <= maxObjectId; objectId++) {
          xrefAndTrailer += `${String(offsets[objectId]).padStart(10, '0')} 00000 n \n`;
        }
        xrefAndTrailer += `trailer\n<< /Size ${maxObjectId + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
        document += xrefAndTrailer;
        byteOffset += encodePdfAscii(xrefAndTrailer, 'xref and trailer').byteLength;
        const pdfBytes = encodePdfAscii(document, 'completed PDF');
        if (pdfBytes.byteLength !== byteOffset) throw new Error('REPORT_PDF_BYTE_OFFSET_MISMATCH');
        return pdfBytes;
      };

      const validatePdfStructure = (pdfBytes: Uint8Array, expectedPages: number) => {
        moveReportStage('Validating PDF objects, content-stream lengths, cross-reference offsets and trailer', 'pdf-structure-validation');
        const text = new TextDecoder('ascii', { fatal: true }).decode(pdfBytes);
        if (!text.startsWith('%PDF-1.4\n') || !text.endsWith('%%EOF') || expectedPages < 1) {
          throw new Error('REPORT_PDF_STRUCTURE_INVALID:header-or-eof');
        }
        const startXrefMatches = [...text.matchAll(/startxref\n(\d+)\n%%EOF/g)];
        const startXrefMatch = startXrefMatches[startXrefMatches.length - 1];
        if (!startXrefMatch) throw new Error('REPORT_PDF_STRUCTURE_INVALID:startxref-missing');
        const xrefOffset = Number(startXrefMatch[1]);
        if (!Number.isSafeInteger(xrefOffset) || text.slice(xrefOffset, xrefOffset + 5) !== 'xref\n') {
          throw new Error('REPORT_PDF_STRUCTURE_INVALID:startxref-offset');
        }
        let cursor = xrefOffset + 5;
        const readLine = () => {
          const end = text.indexOf('\n', cursor);
          if (end < 0) throw new Error('REPORT_PDF_STRUCTURE_INVALID:truncated-xref');
          const line = text.slice(cursor, end);
          cursor = end + 1;
          return line;
        };
        const subsection = readLine().match(/^0 (\d+)$/);
        if (!subsection) throw new Error('REPORT_PDF_STRUCTURE_INVALID:xref-subsection');
        const objectCount = Number(subsection[1]);
        if (!Number.isSafeInteger(objectCount) || objectCount < 6) throw new Error('REPORT_PDF_STRUCTURE_INVALID:object-count');
        const objectOffsets = new Array<number>(objectCount).fill(0);
        for (let objectId = 0; objectId < objectCount; objectId++) {
          const line = readLine();
          const entry = line.match(/^(\d{10}) (\d{5}) ([fn]) ?$/);
          if (!entry) throw new Error(`REPORT_PDF_STRUCTURE_INVALID:xref-entry-${objectId}`);
          if (objectId === 0) {
            if (entry[3] !== 'f') throw new Error('REPORT_PDF_STRUCTURE_INVALID:object-zero');
            continue;
          }
          const offset = Number(entry[1]);
          if (!Number.isSafeInteger(offset) || offset <= 0 || text.slice(offset, offset + `${objectId} 0 obj\n`.length) !== `${objectId} 0 obj\n`) {
            throw new Error(`REPORT_PDF_STRUCTURE_INVALID:object-offset-${objectId}`);
          }
          if (entry[3] !== 'n') throw new Error(`REPORT_PDF_STRUCTURE_INVALID:object-entry-${objectId}`);
          objectOffsets[objectId] = offset;
        }
        if (readLine() !== 'trailer') throw new Error('REPORT_PDF_STRUCTURE_INVALID:trailer-missing');
        const trailerLine = readLine();
        if (!trailerLine.includes(`/Size ${objectCount}`) || !trailerLine.includes('/Root 1 0 R')) {
          throw new Error('REPORT_PDF_STRUCTURE_INVALID:trailer-references');
        }
        if (text.split('/Type /Page /Parent 2 0 R').length - 1 !== expectedPages) {
          throw new Error('REPORT_PDF_STRUCTURE_INVALID:page-count');
        }
        // Validate each stream's declared byte length. The writer above guarantees ASCII, so byte and string
        // positions coincide; the explicit byte-length checks protect that invariant on future changes.
        const streamPattern = /(\d+) 0 obj\n<< \/Length (\d+) >>\nstream\n/g;
        let streamMatch: RegExpExecArray | null;
        let streamCount = 0;
        while ((streamMatch = streamPattern.exec(text)) !== null) {
          const objectId = Number(streamMatch[1]);
          const declaredLength = Number(streamMatch[2]);
          const streamStart = streamPattern.lastIndex;
          const streamEnd = streamStart + declaredLength;
          if (objectOffsets[objectId] <= 0 || text.slice(streamEnd, streamEnd + 10) !== '\nendstream') {
            throw new Error(`REPORT_PDF_STRUCTURE_INVALID:stream-length-${objectId}`);
          }
          streamCount++;
        }
        if (streamCount !== expectedPages) throw new Error('REPORT_PDF_STRUCTURE_INVALID:stream-count');
        // Verify direct references used by catalog/pages/font/page dictionaries all target a live object.
        const dictionaryObjects = [1, 2, 3, 4, ...Array.from({ length: expectedPages }, (_, index) => 5 + index * 2)];
        dictionaryObjects.forEach((objectId) => {
          if (!objectOffsets[objectId]) throw new Error(`REPORT_PDF_STRUCTURE_INVALID:dictionary-object-${objectId}`);
          const objectStart = objectOffsets[objectId];
          const objectEnd = text.indexOf('endobj', objectStart);
          if (objectEnd < 0) throw new Error(`REPORT_PDF_STRUCTURE_INVALID:object-terminator-${objectId}`);
          const dictionary = text.slice(objectStart, objectEnd);
          for (const reference of dictionary.matchAll(/(\d+) 0 R/g)) {
            const referenceId = Number(reference[1]);
            if (referenceId <= 0 || referenceId >= objectCount || !objectOffsets[referenceId]) {
              throw new Error(`REPORT_PDF_STRUCTURE_INVALID:reference-${objectId}-to-${referenceId}`);
            }
          }
        });
        return { pageCount: expectedPages, objectCount: objectCount - 1, byteLength: pdfBytes.byteLength };
      };
      const percentLabel = (value: number | null) => value === null || !Number.isFinite(value) ? 'N/A' : `${value.toFixed(1)}%`;
      const markLabel = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? String(Number(value.toFixed(2))) : String(value ?? '');
      const isValidAuditScore = (row: AuditedScore, quiz: AuditedQuiz) => row.reportMarkKind === 'valid' && Number.isFinite(quiz.totalMarks) && quiz.totalMarks > 0 && typeof row.marksObtained === 'number' && row.marksObtained >= 0 && row.marksObtained <= quiz.totalMarks;
      const validAttempts = reportQuizzes.flatMap((quiz) => quiz.reportRows.filter((row) => isValidAuditScore(row, quiz)).map((row) => ({ quiz, row, percentage: (Number(row.marksObtained) / quiz.totalMarks) * 100 })));
      const averageAcrossAttempts = validAttempts.length ? validAttempts.reduce((sum, attempt) => sum + attempt.percentage, 0) / validAttempts.length : null;
      const monthToDate = (key: string) => monthLabel(key);

      moveReportStage('Composing searchable PDF pages, summaries and score tables', 'pdf-content-generation');
      startPdfPage('Report Overview');
      if (schoolName) addParagraph(`Institution: ${schoolName}`, 8, [0.25, 0.29, 0.35]);
      addParagraph(`Teacher: ${teacherName} | Class: ${className} (${classCode}) | Period: ${periodLabel} | Generated: ${generatedAtLabel}`, 7.5);

      if (isIndividual && individualQuiz) {
        const quiz = individualQuiz;
        const recorded = quiz.reportRows.filter((row) => isValidAuditScore(row, quiz));
        const noScore = quiz.reportRows.filter((row) => row.reportMarkKind === 'empty').length;
        const invalidRows = quiz.reportRows.filter((row) => row.reportMarkKind === 'invalid').length;
        const percentages = recorded.map((row) => (Number(row.marksObtained) / quiz.totalMarks) * 100);
        const averagePct = percentages.length ? percentages.reduce((sum, value) => sum + value, 0) / percentages.length : null;
        const sortedScored = [...recorded].sort((a, b) => Number(b.marksObtained) - Number(a.marksObtained) || compareStudentOrder(a, b));
        const top = sortedScored[0];
        const low = sortedScored[sortedScored.length - 1];
        const ranks = new Map<string, number>();
        let lastPct: number | null = null;
        let lastRank = 0;
        sortedScored.forEach((row, index) => {
          const value = (Number(row.marksObtained) / quiz.totalMarks) * 100;
          const rank = lastPct !== null && Math.abs(value - lastPct) < 0.000001 ? lastRank : index + 1;
          ranks.set(row.id, rank);
          lastPct = value;
          lastRank = rank;
        });
        const categoryCount = { Excellent: 0, Good: 0, Average: 0, Poor: 0 };
        recorded.forEach((row) => {
          const percentage = (Number(row.marksObtained) / quiz.totalMarks) * 100;
          if (percentage >= 80) categoryCount.Excellent++;
          else if (percentage >= 60) categoryCount.Good++;
          else if (percentage >= 40) categoryCount.Average++;
          else categoryCount.Poor++;
        });
        addSectionTitle('Quiz Details');
        addParagraph(`Topic/Chapter: ${quiz.topic} | Date: ${quiz.date || 'N/A'} | Month: ${quiz.monthKey ? monthToDate(quiz.monthKey) : 'Unknown period'} | Total Marks: ${quiz.totalMarks || 'Invalid'}`, 8, [0.20, 0.24, 0.31]);
        addSummaryCards([
          { label: 'Identifiable score rows', value: String(quiz.reportRows.length), detail: 'Saved rows with unique student IDs' },
          { label: 'Recorded marks', value: String(recorded.length), detail: 'Valid numeric marks, including zero' },
          { label: 'Unrecorded marks', value: String(noScore), detail: 'Blank saved marks; not treated as zero' },
          { label: 'Average performance', value: percentLabel(averagePct), detail: 'Mean of valid attempt percentages' },
          { label: 'Highest score', value: top ? `${markLabel(top.marksObtained)}/${quiz.totalMarks}` : 'N/A', detail: top ? `${top.name} (${percentLabel((Number(top.marksObtained) / quiz.totalMarks) * 100)})` : 'No valid recorded score' },
          { label: 'Lowest score', value: low ? `${markLabel(low.marksObtained)}/${quiz.totalMarks}` : 'N/A', detail: low ? `${low.name} (${percentLabel((Number(low.marksObtained) / quiz.totalMarks) * 100)})` : 'No valid recorded score' },
          { label: 'Unidentifiable rows', value: String(quiz.unidentifiableRows), detail: 'Excluded from student matching' },
          { label: 'Invalid marks', value: String(invalidRows), detail: 'Excluded from averages and ranks' },
        ]);
        addSectionTitle('Performance Distribution');
        addParagraph(`Excellent (80%+): ${categoryCount.Excellent} | Good (60-79.9%): ${categoryCount.Good} | Average (40-59.9%): ${categoryCount.Average} | Poor (<40%): ${categoryCount.Poor} | No Score: ${noScore}`, 8);
        const detailRows = [...quiz.reportRows].sort((a, b) => {
          const av = isValidAuditScore(a, quiz) ? Number(a.marksObtained) / quiz.totalMarks : -1;
          const bv = isValidAuditScore(b, quiz) ? Number(b.marksObtained) / quiz.totalMarks : -1;
          return bv - av || compareStudentOrder(a, b);
        }).map((row, index) => {
          const valid = isValidAuditScore(row, quiz);
          const percentage = valid ? (Number(row.marksObtained) / quiz.totalMarks) * 100 : null;
          const category = !valid ? (row.reportMarkKind === 'empty' ? 'No Score' : 'Invalid') : percentage! >= 80 ? 'Excellent' : percentage! >= 60 ? 'Good' : percentage! >= 40 ? 'Average' : 'Poor';
          return [String(index + 1), row.rollNo || 'N/A', row.name || 'Unknown student', row.id, row.gender || 'N/A', valid ? markLabel(row.marksObtained) : row.reportMarkKind === 'empty' ? 'Not Recorded' : 'Invalid', quiz.totalMarks > 0 ? String(quiz.totalMarks) : 'N/A', percentLabel(percentage), category, valid ? String(ranks.get(row.id) ?? '') : ''];
        });
        addTable('Full Student Marks, Categories & Ranking', [
          { label: '#', width: 30 }, { label: 'Roll No.', width: 60 }, { label: 'Student Name', width: 150 }, { label: 'Student ID', width: 160 },
          { label: 'Gender', width: 55 }, { label: 'Marks', width: 70 }, { label: 'Total', width: 50 }, { label: 'Percentage', width: 70 }, { label: 'Category', width: 110 }, { label: 'Rank', width: 45 },
        ], detailRows);
      } else {
        const historyScores = new Map<string, { id: string; name: string; rollNo: string; gender: string; marksByQuiz: Map<string, AuditedScore>; earned: number; possible: number; attempts: number; unrecorded: number; invalid: number }>();
        reportQuizzes.forEach((quiz) => quiz.reportRows.forEach((row) => {
          let item = historyScores.get(row.id);
          if (!item) {
            item = { id: row.id, name: row.name || 'Unknown student', rollNo: row.rollNo || '', gender: row.gender || '', marksByQuiz: new Map<string, AuditedScore>(), earned: 0, possible: 0, attempts: 0, unrecorded: 0, invalid: 0 };
            historyScores.set(row.id, item);
          } else {
            if ((!item.name || item.name === 'Unknown student') && row.name) item.name = row.name;
            if (!item.rollNo && row.rollNo) item.rollNo = row.rollNo;
            if (!item.gender && row.gender) item.gender = row.gender;
          }
          item.marksByQuiz.set(quiz.id, row);
          if (isValidAuditScore(row, quiz)) {
            item.earned += Number(row.marksObtained);
            item.possible += quiz.totalMarks;
            item.attempts++;
          } else if (row.reportMarkKind === 'empty') item.unrecorded++;
          else item.invalid++;
        }));
        // Current roster details may enrich a historical ID match, but never create a student with no saved quiz row.
        liveRosterForReport.forEach((rosterStudent) => {
          const historical = historyScores.get(rosterStudent.id);
          if (historical) {
            if (rosterStudent.name && rosterStudent.name !== 'Unknown student') historical.name = rosterStudent.name;
            historical.rollNo = rosterStudent.rollNo || historical.rollNo;
            historical.gender = rosterStudent.gender || historical.gender;
          }
        });
        const historyStudents = [...historyScores.values()].sort((a, b) => {
          const ap = a.possible > 0 ? a.earned / a.possible : -1;
          const bp = b.possible > 0 ? b.earned / b.possible : -1;
          return bp - ap || compareStudentOrder(
            { id: a.id, name: a.name, rollNo: a.rollNo, gender: a.gender, marksObtained: '' },
            { id: b.id, name: b.name, rollNo: b.rollNo, gender: b.gender, marksObtained: '' },
          );
        });
        let previousStudentPct: number | null = null;
        let previousStudentRank = 0;
        historyStudents.forEach((student, index) => {
          const pct = student.possible > 0 ? student.earned / student.possible * 100 : null;
          (student as typeof student & { rank?: number }).rank = pct === null ? undefined : previousStudentPct !== null && Math.abs(pct - previousStudentPct) < 0.000001 ? previousStudentRank : index + 1;
          if (pct !== null) { previousStudentPct = pct; previousStudentRank = index + 1; }
        });
        const overallBest = historyStudents.find((student) => student.possible > 0) || null;
        const multiQuizStudents = historyStudents.filter((student) => student.attempts > 1).length;
        const quizAverage = (quiz: AuditedQuiz) => {
          if (quiz.totalMarks <= 0) return null;
          const values = quiz.reportRows.filter((row) => isValidAuditScore(row, quiz)).map((row) => Number(row.marksObtained) / quiz.totalMarks * 100);
          return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
        };
        const quizzesWithAverage = reportQuizzes.map((quiz) => ({ quiz, average: quizAverage(quiz) })).filter((entry): entry is { quiz: AuditedQuiz; average: number } => entry.average !== null);
        const bestQuiz = [...quizzesWithAverage].sort((a, b) => b.average - a.average || a.quiz.topic.localeCompare(b.quiz.topic))[0];
        const lowestQuiz = [...quizzesWithAverage].sort((a, b) => a.average - b.average || a.quiz.topic.localeCompare(b.quiz.topic))[0];
        const totalUnrecorded = reportQuizzes.reduce((sum, quiz) => sum + quiz.reportRows.filter((row) => row.reportMarkKind === 'empty').length, 0);
        const totalValid = validAttempts.length;
        const topStudent = overallBest ? `${overallBest.name} (${percentLabel(overallBest.possible > 0 ? overallBest.earned / overallBest.possible * 100 : null)})` : 'N/A';

        addSectionTitle('Consolidated Class Overview');
        addParagraph('Consolidated Quiz Performance History. Statistics use valid recorded marks only; blank marks are not zero and do not enter averages or ranks.', 8);
        addSummaryCards([
          { label: 'Included quizzes', value: String(reportQuizzes.length), detail: 'All saved quizzes in selected scope' },
          { label: 'Unique students', value: String(historyStudents.length), detail: 'Matched by stable student ID' },
          { label: 'Valid attempts', value: String(totalValid), detail: 'Recorded numeric quiz scores' },
          { label: 'Unrecorded rows', value: String(totalUnrecorded), detail: 'Explicitly blank saved marks' },
          { label: 'Average attempt %', value: percentLabel(averageAcrossAttempts), detail: 'Mean normalized percentage per attempt' },
          { label: 'Students with >1 score', value: String(multiQuizStudents), detail: 'More than one valid scored quiz' },
          { label: 'Top overall student', value: topStudent, detail: overallBest ? `${overallBest.attempts} valid scored quiz(es)` : 'No valid recorded scores' },
          { label: 'Best class-average quiz', value: bestQuiz ? bestQuiz.quiz.topic : 'N/A', detail: bestQuiz ? percentLabel(bestQuiz.average) : 'No valid class average' },
          { label: 'Lowest class-average quiz', value: lowestQuiz ? lowestQuiz.quiz.topic : 'N/A', detail: lowestQuiz ? percentLabel(lowestQuiz.average) : 'No valid class average' },
          { label: 'Unidentifiable rows', value: String(reportQuizzes.reduce((sum, quiz) => sum + quiz.unidentifiableRows, 0)), detail: 'Excluded from cross-quiz matching' },
        ]);
        addParagraph(`Historical coverage: ${periodLabel}. Teacher: ${teacherName}. Generated: ${generatedAtLabel}. Overall student percentage is total valid marks earned divided by total possible marks for that student's valid recorded attempts. Overall average above is the arithmetic mean of normalized attempt percentages.`, 7.2);

        const quizSummaryRows = reportQuizzes.map((quiz, index) => {
          const validRows = quiz.reportRows.filter((row) => isValidAuditScore(row, quiz));
          const percentages = validRows.map((row) => Number(row.marksObtained) / quiz.totalMarks * 100);
          const high = validRows.reduce<AuditedScore | null>((best, row) => !best || Number(row.marksObtained) > Number(best.marksObtained) ? row : best, null);
          const low = validRows.reduce<AuditedScore | null>((worst, row) => !worst || Number(row.marksObtained) < Number(worst.marksObtained) ? row : worst, null);
          const avg = percentages.length ? percentages.reduce((sum, value) => sum + value, 0) / percentages.length : null;
          return [String(index + 1), quiz.topic, quiz.date || 'N/A', quiz.monthKey ? monthToDate(quiz.monthKey) : 'Unknown', quiz.totalMarks > 0 ? String(quiz.totalMarks) : 'Invalid', String(quiz.reportRows.length), String(validRows.length), String(quiz.reportRows.filter((row) => row.reportMarkKind === 'empty').length), percentLabel(avg), high ? `${markLabel(high.marksObtained)}/${quiz.totalMarks} (${percentLabel(Number(high.marksObtained) / quiz.totalMarks * 100)})` : 'N/A', low ? `${markLabel(low.marksObtained)}/${quiz.totalMarks} (${percentLabel(Number(low.marksObtained) / quiz.totalMarks * 100)})` : 'N/A'];
        });
        addTable('Quiz-wise Summary (every included quiz)', [
          { label: '#', width: 30 }, { label: 'Quiz Topic', width: 128 }, { label: 'Date', width: 65 }, { label: 'Month', width: 80 }, { label: 'Total', width: 45 },
          { label: 'ID Rows', width: 48 }, { label: 'Valid', width: 42 }, { label: 'No Score', width: 48 }, { label: 'Avg %', width: 48 }, { label: 'Highest Score / %', width: 95 }, { label: 'Lowest Score / %', width: 95 },
        ], quizSummaryRows);

        const matrixChunkSize = 4;
        for (let start = 0; start < reportQuizzes.length; start += matrixChunkSize) {
          const chunk = reportQuizzes.slice(start, start + matrixChunkSize);
          const matrixColumns: PdfColumn[] = [
            { label: 'Rank', width: 30 }, { label: 'Roll No.', width: 50 }, { label: 'Student Name', width: 104 }, { label: 'Student ID', width: 120 },
            ...chunk.map((quiz) => ({ label: `${quiz.topic.slice(0, 18)} ${quiz.monthKey || ''}`.trim(), width: 64 })),
            { label: 'Earned', width: 52 }, { label: 'Possible', width: 55 }, { label: 'Overall %', width: 53 }, { label: 'Scored', width: 44 }, { label: 'No Score', width: 48 },
          ];
          const matrixRows = historyStudents.map((student) => [
            student.possible > 0 ? String((student as typeof student & { rank?: number }).rank ?? '') : '',
            student.rollNo || 'N/A', student.name || 'Unknown student', student.id,
            ...chunk.map((quiz) => {
              const row = student.marksByQuiz.get(quiz.id);
              if (!row) return '-';
              if (row.reportMarkKind === 'empty') return 'N/R';
              if (!isValidAuditScore(row, quiz)) return 'Invalid';
              return `${markLabel(row.marksObtained)}/${quiz.totalMarks}`;
            }),
            markLabel(student.earned), markLabel(student.possible), percentLabel(student.possible > 0 ? student.earned / student.possible * 100 : null), String(student.attempts), String(student.unrecorded),
          ]);
          addTable(`Student-wise Consolidated Matrix - Quizzes ${start + 1}-${start + chunk.length} of ${reportQuizzes.length}`, matrixColumns, matrixRows);
          if (chunk.length) addParagraph('Matrix key: a/b = recorded marks/quiz total; N/R = a saved row with blank marks; - = no saved row for this student and quiz; Invalid = excluded score value. Percentages and ranks use valid recorded marks only.', 6.8);
        }

        // Each included quiz receives a complete detail table; pages repeat the column headings automatically.
        reportQuizzes.forEach((quiz, quizIndex) => {
          addSectionTitle(`Quiz Detail ${quizIndex + 1} of ${reportQuizzes.length}: ${quiz.topic}`);
          addParagraph(`Date: ${quiz.date || 'N/A'} | Month: ${quiz.monthKey ? monthToDate(quiz.monthKey) : 'Unknown'} | Total marks: ${quiz.totalMarks || 'Invalid'} | Identifiable rows: ${quiz.reportRows.length} | Unidentifiable saved rows: ${quiz.unidentifiableRows}`, 7.2);
          const scored = quiz.reportRows.filter((row) => isValidAuditScore(row, quiz)).sort((a, b) => Number(b.marksObtained) - Number(a.marksObtained) || compareStudentOrder(a, b));
          const rankMap = new Map<string, number>();
          let previousPct: number | null = null;
          let previousRank = 0;
          scored.forEach((row, index) => {
            const pct = Number(row.marksObtained) / quiz.totalMarks * 100;
            const rank = previousPct !== null && Math.abs(pct - previousPct) < 0.000001 ? previousRank : index + 1;
            rankMap.set(row.id, rank);
            previousPct = pct;
            previousRank = rank;
          });
          const sortedRows = [...quiz.reportRows].sort((a, b) => {
            const av = isValidAuditScore(a, quiz) ? Number(a.marksObtained) / quiz.totalMarks : -1;
            const bv = isValidAuditScore(b, quiz) ? Number(b.marksObtained) / quiz.totalMarks : -1;
            return bv - av || compareStudentOrder(a, b);
          });
          const rows = sortedRows.map((row, index) => {
            const valid = isValidAuditScore(row, quiz);
            const pct = valid ? Number(row.marksObtained) / quiz.totalMarks * 100 : null;
            const category = !valid ? row.reportMarkKind === 'empty' ? 'No Score' : 'Invalid' : pct! >= 80 ? 'Excellent' : pct! >= 60 ? 'Good' : pct! >= 40 ? 'Average' : 'Poor';
            return [String(index + 1), row.rollNo || 'N/A', row.name || 'Unknown student', row.id, row.gender || 'N/A', valid ? markLabel(row.marksObtained) : row.reportMarkKind === 'empty' ? 'Not Recorded' : 'Invalid', quiz.totalMarks > 0 ? String(quiz.totalMarks) : 'N/A', percentLabel(pct), category, valid ? String(rankMap.get(row.id) ?? '') : ''];
          });
          addTable(`Full Saved Student Scores - ${quiz.topic}`, [
            { label: '#', width: 30 }, { label: 'Roll No.', width: 60 }, { label: 'Student Name', width: 150 }, { label: 'Student ID', width: 160 }, { label: 'Gender', width: 55 },
            { label: 'Marks', width: 70 }, { label: 'Total', width: 50 }, { label: 'Percentage', width: 70 }, { label: 'Category', width: 110 }, { label: 'Rank', width: 45 },
          ], rows);
        });
      }

      if (reportWarnings.length > 0) {
        addSectionTitle('Data Integrity Notes - Review Before Relying on Completeness');
        addParagraph(`This report contains ${reportWarnings.length} data-quality warning(s). The affected saved records were not silently repaired. Unidentifiable rows are not assigned to a student, invalid marks are excluded from calculations, and reports requiring a month range are blocked when a quiz's month cannot be resolved.`, 7.5, [0.58, 0.25, 0.12]);
        addTable('Warnings from saved records', [{ label: '#', width: 36 }, { label: 'Saved record warning', width: 764 }], reportWarnings.map((warning, index) => [String(index + 1), warning]));
      } else {
        addParagraph('Data checks found no missing/duplicate score IDs, invalid marks, or unresolved quiz month keys in the included records. Statistics use valid recorded scores only; blank marks are not zero.', 7.2, [0.22, 0.42, 0.30]);
      }

      assertReportContext();
      moveReportStage('Checking report size before PDF serialization', 'pdf-serialization');
      const estimatedContentBytes = pdfPages.reduce(
        (pageTotal, page) => pageTotal + page.commands.reduce((commandTotal, command) => commandTotal + command.length + 1, 0),
        0,
      );
      // Keep client-side string/byte validation bounded; a very large historical export should fail clearly,
      // rather than multiply tens or hundreds of megabytes in memory and risk crashing the tab.
      const MAX_CLIENT_PDF_BYTES = 32 * 1024 * 1024;
      if (estimatedContentBytes > MAX_CLIENT_PDF_BYTES) throw new Error('REPORT_PDF_SIZE_LIMIT');
      moveReportStage('Generating PDF bytes from the completed report tables', 'pdf-serialization');
      setReportProgress('Building the searchable PDF...');
      const pdfBytes = buildPdfText();
      pdfByteLength = pdfBytes.byteLength;
      const pdfStructure = validatePdfStructure(pdfBytes, pdfPages.length);

      moveReportStage('Constructing and verifying application/pdf Blob', 'blob-creation');
      const exactPdfArrayBuffer = pdfBytes.buffer.slice(pdfBytes.byteOffset, pdfBytes.byteOffset + pdfBytes.byteLength) as ArrayBuffer;
      const pdfBlob = new Blob([exactPdfArrayBuffer], { type: 'application/pdf' });
      if (pdfBlob.size !== pdfBytes.byteLength || pdfBlob.size < 100 || pdfBlob.type !== 'application/pdf') {
        throw new Error('REPORT_PDF_BUILD_FAILED:blob-metadata');
      }
      let blobByteOffset = 0;
      let blobBytesMatch = true;
      if (typeof pdfBlob.stream === 'function') {
        const blobReader = pdfBlob.stream().getReader();
        try {
          while (true) {
            const { done, value } = await blobReader.read();
            if (done) break;
            for (let index = 0; index < value.byteLength; index++) {
              if (pdfBytes[blobByteOffset + index] !== value[index]) blobBytesMatch = false;
            }
            blobByteOffset += value.byteLength;
            if (!blobBytesMatch || blobByteOffset > pdfBytes.byteLength) break;
          }
        } finally {
          blobReader.releaseLock();
        }
      } else {
        // Compatibility fallback for older browsers without Blob.stream().
        const blobBytes = new Uint8Array(await pdfBlob.arrayBuffer());
        blobByteOffset = blobBytes.byteLength;
        blobBytesMatch = blobBytes.byteLength === pdfBytes.byteLength && !blobBytes.some((byte, index) => byte !== pdfBytes[index]);
      }
      if (!blobBytesMatch || blobByteOffset !== pdfBytes.byteLength) {
        throw new Error('REPORT_PDF_BUILD_FAILED:blob-byte-mismatch');
      }

      moveReportStage('Creating the PDF object URL for browser delivery', 'object-url-creation');
      const pdfUrl = URL.createObjectURL(pdfBlob);
      pendingReportObjectUrl = pdfUrl;
      if (typeof pdfUrl !== 'string' || !pdfUrl.startsWith('blob:')) {
        if (pdfUrl) URL.revokeObjectURL(pdfUrl);
        throw new Error('REPORT_PDF_BUILD_FAILED:invalid-object-url');
      }
      assertReportContext();
      moveReportStage('PDF ready for view, download and print', 'completed');
      console.info('[EduTrack Quiz Report Diagnostic] PDF generated and byte-validated', {
        reportStage,
        pageCount: pdfStructure.pageCount,
        objectCount: pdfStructure.objectCount,
        byteLength: pdfStructure.byteLength,
        sourceQuizDocuments: quizDocumentsRead,
        includedQuizCount,
        scope: reportScope,
        classId: targetClassId,
      });
      setReportPdf({ url: pdfUrl, filename, title: pdfTitle });
      pendingReportObjectUrl = null;
      setReportNotice(reportWarnings.length
        ? `PDF generated with ${reportWarnings.length} data-quality warning(s). Read the Data Integrity Notes in the report; completeness cannot be guaranteed for flagged legacy data.`
        : `PDF generated from a fresh, tenant-verified read: ${reportQuizzes.length} quiz record(s).`);
    } catch (error) {
      if (pendingReportObjectUrl) {
        try { URL.revokeObjectURL(pendingReportObjectUrl); } catch (revokeError) {
          console.warn('[EduTrack Quiz Report Diagnostic] Failed to revoke an unpublished PDF object URL.', revokeError);
        }
        pendingReportObjectUrl = null;
      }
      logReportFailure(reportStage, reportFailureDomain, error, {
        sourceQuizDocuments: quizDocumentsRead,
        includedQuizCount,
        generatedPdfByteLength: pdfByteLength,
        classCollectionPath: 'users/{normalizedTeacherEmail}/classes',
        quizCollectionPath: selectedClassIdRef.current
          ? `users/{normalizedTeacherEmail}/classes/${selectedClassIdRef.current}/quizzes`
          : 'users/{normalizedTeacherEmail}/classes/{classId}/quizzes',
      });
      const message = error instanceof Error ? error.message : String(error ?? 'Unknown error');
      if (message === 'REPORT_CONTEXT_CHANGED' || message === 'AUTH_CONTEXT_CHANGED') {
        setReportError('Your login or selected class changed while the report was being prepared. Nothing was exported; select the class again and retry.');
      } else if (message === 'REPORT_PROFILE_UNVERIFIED') {
        setReportError('The authenticated teacher profile could not be verified. No report was generated.');
      } else if (message === 'REPORT_CLASS_NOT_FOUND') {
        setReportError('The selected class no longer exists in this teacher workspace. Reload the class list and try again.');
      } else if (message === 'REPORT_UNKNOWN_MONTHS') {
        setReportError('At least one saved quiz has no safely resolvable month. To avoid claiming a selected-month/range report is complete, reconcile its date/month metadata or generate the complete history report with its warning.');
      } else if (message === 'REPORT_PDF_SIZE_LIMIT') {
        setReportError('This report is too large to assemble safely in one browser tab. Choose a smaller month range or generate separate month reports; no incomplete PDF was exported.');
      } else if (message === 'REPORT_QUIZ_NOT_FOUND') {
        setReportError('The selected quiz no longer exists in the refreshed class history. Select another quiz and retry.');
      } else if (message.startsWith('REPORT_READ_TIMEOUT:')) {
        const failedStep = message.split(':').slice(1).join(':') || 'Firestore';
        setReportError(`The ${failedStep} read did not finish within 25 seconds. No incomplete PDF was exported. Check your connection and teacher/class access, then retry. If this repeats, inspect the browser console and Firestore Network requests for the underlying error.`);
      } else if (message.startsWith('REPORT_PDF_BUILD_FAILED') || message.startsWith('REPORT_PDF_STRUCTURE_INVALID') || message.startsWith('REPORT_PDF_BYTE_OFFSET_MISMATCH') || message.startsWith('REPORT_PDF_NON_ASCII')) {
        setReportError('The PDF could not be finalized by the browser. Please retry; if it happens again, open the browser console and share the reported error.');
      } else {
        const firestoreCode = (error as { code?: unknown } | null)?.code;
        if (typeof firestoreCode === 'string' && firestoreCode) {
          setReportError(getFirestoreErrorMessage(error, 'load the selected class quiz history for reporting'));
        } else {
          setReportError(`The report failed before a PDF could be created${message ? ` (${message})` : ''}. No incomplete PDF was exported. Please retry; if it happens again, check the browser console for the underlying error.`);
        }
      }
    } finally {
      setIsReportGenerating(false);
      setReportProgress(null);
    }
  };

  const handleViewGeneratedReport = () => {
    reportStageRef.current = 'Opening generated PDF in a browser tab';
    if (!reportPdf?.url) {
      const error = new Error('REPORT_PDF_URL_MISSING');
      logReportFailure(reportStageRef.current, 'browser-delivery', error, { action: 'view' });
      setReportError('The generated PDF is not available to open. Generate the report again.');
      return;
    }
    try {
      const reportWindow = window.open(reportPdf.url, '_blank');
      if (!reportWindow) {
        const error = new Error('BROWSER_POPUP_BLOCKED');
        logReportFailure('Opening generated PDF in a browser tab', 'browser-delivery', error, { action: 'view', filename: reportPdf.filename });
        setReportError(null);
        setReportNotice('Your browser blocked the PDF viewer. Allow pop-ups for this site, then choose View PDF again. The report is still available for download.');
        return;
      }
      try { reportWindow.opener = null; } catch { /* The viewer remains usable if opener cannot be changed. */ }
    } catch (error) {
      logReportFailure('Opening generated PDF in a browser tab', 'browser-delivery', error, { action: 'view', filename: reportPdf.filename });
      setReportError(null);
      setReportNotice('The browser could not open the generated PDF. The report is still available for download.');
    }
  };

  const handlePrintGeneratedReport = () => {
    reportStageRef.current = 'Opening generated PDF for printing';
    if (!reportPdf?.url) {
      const error = new Error('REPORT_PDF_URL_MISSING');
      logReportFailure(reportStageRef.current, 'browser-delivery', error, { action: 'print' });
      setReportError('The generated PDF is not available to print. Generate the report again.');
      return;
    }
    let printWindow: Window | null = null;
    try {
      printWindow = window.open(reportPdf.url, '_blank');
    } catch (error) {
      logReportFailure('Opening generated PDF for printing', 'browser-delivery', error, { action: 'print', filename: reportPdf.filename });
      setReportError(null);
      setReportNotice('The browser could not open the generated PDF for printing. The report is still available for download.');
      return;
    }
    if (!printWindow) {
      const error = new Error('BROWSER_POPUP_BLOCKED');
      logReportFailure('Opening generated PDF for printing', 'browser-delivery', error, { action: 'print', filename: reportPdf.filename });
      setReportError(null);
      setReportNotice('Your browser blocked the report window. Allow pop-ups for this site, then choose Print again.');
      return;
    }
    let printRequested = false;
    const requestPrint = () => {
      if (printRequested) return;
      printRequested = true;
      reportStageRef.current = 'Requesting the browser PDF viewer print dialog';
      try { printWindow?.focus(); printWindow?.print(); } catch (error) {
        logReportFailure('Requesting the browser PDF viewer print dialog', 'browser-delivery', error, { action: 'print', filename: reportPdf.filename });
        setReportNotice('The generated PDF is open in a new tab. Use the PDF viewer Print control if the print dialog did not open automatically.');
      }
    };
    try {
      printWindow.addEventListener('load', requestPrint, { once: true });
      window.setTimeout(requestPrint, 1000);
    } catch (error) {
      logReportFailure('Scheduling browser PDF print dialog', 'browser-delivery', error, { action: 'print', filename: reportPdf.filename });
      setReportNotice('The generated PDF is open in a new tab. Use the PDF viewer Print control if the print dialog did not open automatically.');
    }
  };

  // Open Form for NEW QUIZ
  const handleOpenNewQuiz = () => {
    if (!currentClass || !currentUser || !tenantKey) return;
    try {
      assertActiveTeacher(currentUser, tenantKey);
    } catch {
      showCenterNotification('Your login changed. Please sign in again.');
      return;
    }
    setQuizTopic('');
    setTotalMarks(10);
    setGenderFilter('All');
    setBelowThreshold('');
    setFormPage(1);
    setEditingQuizId(null);
    setEditingClassId(currentClass.id);
    setEditingUserUid(currentUser.uid);
    setEditingRevisionSignature(null);
    setStudentScores(buildRosterScores(currentClass.students));
    setIsCreatingQuiz(true);
  };

  // Open Form for EDITING QUIZ; retain the record's revision for concurrent-edit detection.
  const handleOpenEditQuiz = (quiz: QuizRecord, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!currentClass || !currentUser || !tenantKey || !quizzes.some((item) => item.id === quiz.id)) return;
    if (!quiz.revisionSignature) {
      alert('This quiz could not be safely verified. Reload the page and try again.');
      return;
    }
    if ((quiz.unidentifiableScoreCount ?? 0) > 0) {
      alert('This quiz contains legacy score rows with missing or duplicate student IDs. The saved record has been preserved. Reconcile those student records before editing this quiz.');
      return;
    }
    const orphanedStudentIds = findOrphanedStudentIds(currentClass.students, quiz.studentScores);
    if (orphanedStudentIds.length > 0) {
      alert('This quiz contains students who are no longer in the selected class. The saved marks and student metadata have been preserved. Restore or reconcile the class roster before editing this quiz.');
      return;
    }
    try {
      assertActiveTeacher(currentUser, tenantKey);
    } catch {
      showCenterNotification('Your login changed. Please sign in again.');
      return;
    }

    setEditingQuizId(quiz.id);
    setEditingClassId(currentClass.id);
    setEditingUserUid(currentUser.uid);
    setEditingRevisionSignature(quiz.revisionSignature);
    setQuizTopic(quiz.topic);
    setTotalMarks(quiz.totalMarks);
    setStudentScores(buildRosterScores(currentClass.students, quiz.studentScores));
    setGenderFilter('All');
    setBelowThreshold('');
    setFormPage(1);
    setIsCreatingQuiz(true);
  };

  // Keep what the user typed so invalid values are rejected at save time rather than silently clamped.
  const handleScoreChange = (studentId: string, val: string, currentIndex: number) => {
    setStudentScores((previous) =>
      previous.map((student) => student.id === studentId ? { ...student, marksObtained: val } : student),
    );

    const parsed = parseMark(val);
    if (parsed.kind === 'valid' && parsed.value !== undefined && parsed.value >= 0 && parsed.value <= totalMarks) {
      setTimeout(() => {
        const nextInput = scoreInputRefs.current[currentIndex + 1];
        if (nextInput) {
          nextInput.focus();
          nextInput.select();
        }
      }, 100);
    }
  };

  // Key Down Handler for Keyboard Controls (Enter, Arrow Up, Arrow Down)
  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, currentIndex: number) => {
    if (e.key === 'Enter' || e.key === 'ArrowDown') {
      e.preventDefault();
      const nextInput = scoreInputRefs.current[currentIndex + 1];
      if (nextInput) {
        nextInput.focus();
        nextInput.select();
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prevInput = scoreInputRefs.current[currentIndex - 1];
      if (prevInput) {
        prevInput.focus();
        prevInput.select();
      }
    }
  };

  // Filtered Students inside Edit/Create form
  const filteredStudentsInForm = useMemo(() => {
    return studentScores.filter((student) => {
      const matchesGender = genderFilter === 'All' || student.gender === genderFilter;
      let matchesMarks = true;
      if (belowThreshold !== '') {
        const thresholdNum = Number(belowThreshold);
        if (student.marksObtained !== '') matchesMarks = Number(student.marksObtained) < thresholdNum;
      }
      return matchesGender && matchesMarks;
    });
  }, [studentScores, genderFilter, belowThreshold]);

  // Dynamic Pagination Logic (Page 1 = 7 items, Page 2+ = 9 items)
  const totalFormPages = useMemo(() => {
    const total = filteredStudentsInForm.length;
    if (total <= PAGE_1_SIZE) return 1;
    return 1 + Math.ceil((total - PAGE_1_SIZE) / PAGE_SUBSEQUENT_SIZE);
  }, [filteredStudentsInForm]);

  const paginatedFormStudents = useMemo(() => {
    if (formPage === 1) return filteredStudentsInForm.slice(0, PAGE_1_SIZE);
    const start = PAGE_1_SIZE + (formPage - 2) * PAGE_SUBSEQUENT_SIZE;
    return filteredStudentsInForm.slice(start, start + PAGE_SUBSEQUENT_SIZE);
  }, [filteredStudentsInForm, formPage]);

  // Reset form page when filter changes
  useEffect(() => {
    setFormPage(1);
  }, [genderFilter, belowThreshold]);

  // Save / Update Quiz: validate roster and marks, and commit atomically with revision checks.
  const handleSaveQuiz = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSaving || savingRef.current) return;
    if (!currentUser || !currentClass || !tenantKey || !quizTopic.trim() || !selectedClassId) {
      alert('Please select a class and enter a quiz topic before saving.');
      return;
    }

    const targetClassId = editingQuizId ? editingClassId : selectedClassId;
    if (
      !targetClassId || targetClassId !== selectedClassId ||
      (editingQuizId && (!editingRevisionSignature || editingUserUid !== currentUser.uid || editingClassId !== currentClass.id))
    ) {
      alert('The selected teacher or class changed while this quiz was open. Reopen the quiz and try again.');
      return;
    }

    let tenantEmail: string;
    try {
      tenantEmail = assertActiveTeacher(currentUser, tenantKey);
    } catch {
      alert('Your login changed. Please sign in again before saving.');
      return;
    }

    const validation = validateQuizInput(quizTopic, totalMarks, studentScores, currentClass.students);
    if (!validation.valid || validation.totalMarks === undefined || !validation.scores) {
      alert(validation.error || 'Please correct the quiz data before saving.');
      return;
    }

    if (!acquireSubmissionLock(savingRef)) return;
    setIsSaving(true);
    const now = new Date();
    const nowMs = now.getTime();
    const dateLabel = formatDateLabel(now);
    const monthKey = getCurrentAndPrevMonthKeys(now).currentMonthKey;
    const scoresToSave = validation.scores;
    const averageScore = calculateAverageScore(scoresToSave, validation.totalMarks);

    try {
      const quizId = editingQuizId || doc(collection(db, ...getQuizCollectionPath(tenantEmail, targetClassId))).id;
      const quizDocRef = doc(db, ...getQuizCollectionPath(tenantEmail, targetClassId), quizId);
      const classDocRef = doc(db, ...getClassCollectionPath(tenantEmail), targetClassId);
      const savedRaw = await runTransaction(db, async (transaction) => {
        const snapshot = await transaction.get(quizDocRef);
        const classSnapshot = await transaction.get(classDocRef);
        if (
          auth.currentUser?.uid !== currentUser.uid ||
          auth.currentUser?.email !== currentUser.email ||
          selectedClassIdRef.current !== targetClassId
        ) {
          throw new Error('AUTH_CONTEXT_CHANGED');
        }
        assertActiveTeacher(currentUser, tenantKey);

        if (!classSnapshot.exists()) throw new Error('CLASS_NOT_FOUND');
        const liveClassData = classSnapshot.data() as Record<string, unknown>;
        const liveRosterResult = extractStudents(liveClassData.students);
        if (liveRosterResult.format === 'unsupported') throw new Error('CLASS_ROSTER_CHANGED');

        const submittedRosterSignature = validation.scores
          .map((student) => `${String(student.id)}::${String(student.rollNo ?? '')}`)
          .sort();
        const liveRosterSignature = liveRosterResult.students
          .map((student) => `${String(student.id)}::${String(student.rollNo ?? '')}`)
          .sort();
        if (
          submittedRosterSignature.length !== liveRosterSignature.length ||
          submittedRosterSignature.some((entry, index) => entry !== liveRosterSignature[index])
        ) {
          throw new Error('CLASS_ROSTER_CHANGED');
        }

        if (editingQuizId) {
          if (!snapshot.exists()) throw new Error('QUIZ_NOT_FOUND');
          const existingRaw = snapshot.data() as Record<string, unknown>;
          if (
            !editingRevisionSignature ||
            quizRevisionSignature(existingRaw) !== editingRevisionSignature
          ) {
            throw new Error('QUIZ_CONCURRENT_MODIFICATION');
          }

          const existingCreatedAt = timestampToMillis(existingRaw.createdAt);
          const originalDate = typeof existingRaw.date === 'string' && existingRaw.date.trim()
            ? existingRaw.date
            : existingCreatedAt !== null ? formatDateLabel(new Date(existingCreatedAt)) : '';
          const originalMonthKey = resolveQuizMonthKey(originalDate, existingRaw.createdAt, existingRaw.monthKey)
            ?? (typeof existingRaw.monthKey === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(existingRaw.monthKey) ? existingRaw.monthKey : monthKey);
          const updateFields: Record<string, unknown> = {
            id: quizId,
            topic: quizTopic.trim(),
            totalMarks: validation.totalMarks,
            studentScores: scoresToSave,
            averageScore,
            monthKey: originalMonthKey,
            updatedAt: nowMs,
            updatedByUid: currentUser.uid,
          };
          transaction.update(quizDocRef, updateFields);
          return { ...existingRaw, ...updateFields, date: originalDate };
        }

        if (snapshot.exists()) throw new Error('QUIZ_ID_COLLISION');
        const newData: Record<string, unknown> = {
          id: quizId,
          topic: quizTopic.trim(),
          totalMarks: validation.totalMarks,
          date: dateLabel,
          monthKey,
          createdAt: nowMs,
          studentScores: scoresToSave,
          averageScore,
          updatedAt: nowMs,
          updatedByUid: currentUser.uid,
        };
        transaction.set(quizDocRef, newData);
        return newData;
      });

      if (
        auth.currentUser?.uid !== currentUser.uid ||
        auth.currentUser?.email !== currentUser.email ||
        selectedClassIdRef.current !== targetClassId
      ) return;

      const normalizedSavedQuiz: QuizRecord = {
        id: quizId,
        topic: String(savedRaw.topic ?? quizTopic.trim()),
        totalMarks: Number(savedRaw.totalMarks ?? validation.totalMarks),
        date: String(savedRaw.date ?? dateLabel),
        monthKey: String(savedRaw.monthKey ?? monthKey),
        createdAt: timestampToMillis(savedRaw.createdAt) ?? nowMs,
        studentScores: normalizeStoredScores(savedRaw.studentScores).sort(compareStudentOrder),
        averageScore: calculateAverageScore(normalizeStoredScores(savedRaw.studentScores), validation.totalMarks),
        updatedAt: timestampToMillis(savedRaw.updatedAt) ?? nowMs,
        updatedByUid: currentUser.uid,
        revisionSignature: quizRevisionSignature(savedRaw),
        unidentifiableScoreCount: 0,
      };

      if (editingQuizId) {
        setQuizzes((previous) => previous.map((quiz) => quiz.id === quizId ? normalizedSavedQuiz : quiz));
        showCenterNotification(' Quiz Marks Updated Successfully ');
      } else {
        setQuizzes((previous) => [normalizedSavedQuiz, ...previous]);
        const activeMonthKeys = getCurrentAndPrevMonthKeys(now);
        setMonthKeys(activeMonthKeys);
        setAvailableMonths([
          activeMonthKeys.currentMonthKey,
          ...(quizzes.some((quiz) => quiz.monthKey === activeMonthKeys.prevMonthKey) ? [activeMonthKeys.prevMonthKey] : []),
        ]);
        setSelectedMonth(monthKey);
        showCenterNotification(' Quiz Saved Successfully ');
      }

      setIsCreatingQuiz(false);
      setEditingQuizId(null);
      setEditingClassId(null);
      setEditingUserUid(null);
      setEditingRevisionSignature(null);
    } catch (error) {
      console.error('Error saving quiz:', error);
      const message = error instanceof Error ? error.message : '';
      if (message === 'QUIZ_CONCURRENT_MODIFICATION') {
        alert('This quiz was changed by another session. Reload the quiz and review the latest marks before saving.');
      } else if (message === 'QUIZ_NOT_FOUND') {
        alert('This quiz was deleted or moved by another session. Refresh the class records and try again.');
      } else if (message === 'QUIZ_ID_COLLISION') {
        alert('A quiz with this generated ID already exists. Please submit again.');
      } else if (message === 'CLASS_ROSTER_CHANGED' || message === 'CLASS_NOT_FOUND') {
        alert('The class roster changed or the class is no longer available. Reload the class and review the student IDs and roll numbers before saving.');
      } else if (message === 'AUTH_CONTEXT_CHANGED' || auth.currentUser?.uid !== currentUser.uid) {
        alert('Your login or selected class changed before the save completed. Please sign in again and retry.');
      } else {
        alert(getFirestoreErrorMessage(error, 'save quiz'));
      }
    } finally {
      releaseSubmissionLock(savingRef);
      setIsSaving(false);
    }
  };

  // Open Custom Confirmation Permission Modal
  const handleRequestDeleteQuiz = (quiz: QuizRecord, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!currentUser || !selectedClassId || !quizzes.some((item) => item.id === quiz.id)) return;
    setDeleteConfirmQuiz(quiz);
    setDeleteConfirmClassId(selectedClassId);
    setDeleteConfirmUserUid(currentUser.uid);
  };

  // Execute Confirmed Delete only if this exact tenant/class/quiz revision still exists.
  const handleConfirmDeleteQuiz = async () => {
    if (deletingRef.current || !deleteConfirmQuiz) return;
    const quizToDelete = deleteConfirmQuiz;
    const targetClassId = deleteConfirmClassId;
    const targetUserUid = deleteConfirmUserUid;
    const user = currentUser;

    if (
      !user || !tenantKey || !targetClassId || !targetUserUid || targetUserUid !== user.uid ||
      targetClassId !== selectedClassId || !quizToDelete.revisionSignature
    ) {
      alert('The selected teacher or class changed. Reopen the delete confirmation and try again.');
      return;
    }

    let tenantEmail: string;
    try {
      tenantEmail = assertActiveTeacher(user, tenantKey);
    } catch {
      alert('Your login changed. Please sign in again before deleting.');
      return;
    }

    if (!acquireSubmissionLock(deletingRef)) return;
    try {
      const quizDocRef = doc(db, ...getQuizCollectionPath(tenantEmail, targetClassId), quizToDelete.id);
      await runTransaction(db, async (transaction) => {
        const snapshot = await transaction.get(quizDocRef);
        if (
          auth.currentUser?.uid !== user.uid ||
          auth.currentUser?.email !== user.email ||
          selectedClassIdRef.current !== targetClassId
        ) {
          throw new Error('AUTH_CONTEXT_CHANGED');
        }
        assertActiveTeacher(user, tenantKey);
        if (!snapshot.exists()) throw new Error('QUIZ_NOT_FOUND');
        if (quizRevisionSignature(snapshot.data() as Record<string, unknown>) !== quizToDelete.revisionSignature) {
          throw new Error('QUIZ_CONCURRENT_MODIFICATION');
        }
        transaction.delete(quizDocRef);
      });

      if (
        auth.currentUser?.uid === user.uid &&
        auth.currentUser?.email === user.email &&
        selectedClassIdRef.current === targetClassId
      ) {
        setQuizzes((previous) => previous.filter((quiz) => quiz.id !== quizToDelete.id));
        setDeleteConfirmQuiz(null);
        setDeleteConfirmClassId(null);
        setDeleteConfirmUserUid(null);
        showCenterNotification(' Quiz Record Deleted Successfully!');
      }
    } catch (error) {
      console.error('Error deleting quiz:', error);
      const message = error instanceof Error ? error.message : '';
      if (message === 'QUIZ_CONCURRENT_MODIFICATION') {
        alert('This quiz changed in another session. Refresh the records before deleting it.');
      } else if (message === 'AUTH_CONTEXT_CHANGED') {
        alert('Your login or selected class changed before the delete completed. Please sign in again and retry.');
      } else {
        alert(getFirestoreErrorMessage(error, 'delete quiz'));
      }
    } finally {
      releaseSubmissionLock(deletingRef);
    }
  };

  // Open Modal
  const handleOpenDetailModal = (quiz: QuizRecord) => {
    if (!quizzes.some((item) => item.id === quiz.id)) return;
    setDetailModalQuiz(quiz);
    setDetailSearch('');
    setDetailGenderFilter('All');
    setDetailPage(1);
  };

  // Modal Students Filter
  const allFilteredModalStudents = useMemo(() => {
    if (!detailModalQuiz) return [];
    return [...detailModalQuiz.studentScores]
      .sort(compareStudentOrder)
      .filter((student) => {
        const matchesSearch = student.name.toLowerCase().includes(detailSearch.toLowerCase());
        const matchesGender = detailGenderFilter === 'All' || student.gender === detailGenderFilter;
        return matchesSearch && matchesGender;
      });
  }, [detailModalQuiz, detailSearch, detailGenderFilter]);

  // Modal Paginated Students
  const totalModalPages = Math.ceil(allFilteredModalStudents.length / DETAIL_PAGE_SIZE) || 1;
  const paginatedModalStudents = useMemo(() => {
    const start = (detailPage - 1) * DETAIL_PAGE_SIZE;
    return allFilteredModalStudents.slice(start, start + DETAIL_PAGE_SIZE);
  }, [allFilteredModalStudents, detailPage]);

  useEffect(() => {
    setDetailPage(1);
  }, [detailSearch, detailGenderFilter]);

  return (
    <div className={`min-h-screen bg-[#f8fafc] dark:bg-[#070b13] text-slate-900 dark:text-slate-100 transition-colors duration-300 pb-32 ${isDark ? 'dark' : ''}`}>

      {/* GLOWING NOTIFICATION */}
      {centerNotification && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 dark:bg-black/70 backdrop-blur-md animate-in fade-in zoom-in duration-300 pointer-events-none">
          <div className="bg-white dark:bg-[#0c1222] border-2 border-orange-500 rounded-3xl p-6 max-w-sm w-full text-center shadow-[0_15px_40px_rgba(249,115,22,0.3)] dark:shadow-[0_0_50px_rgba(249,115,22,0.6)] space-y-3 transform animate-bounce">
            <div className="h-16 w-16 bg-orange-500/10 dark:bg-orange-500/20 text-orange-500 dark:text-orange-400 rounded-full flex items-center justify-center mx-auto border border-orange-500/30 dark:border-orange-500/50 shadow-[0_0_20px_rgba(249,115,22,0.2)]">
              <Sparkles className="h-8 w-8 animate-pulse text-orange-500 dark:text-yellow-300" />
            </div>
            <h3 className="text-lg font-black text-slate-900 dark:text-white tracking-wide">
              {centerNotification}
            </h3>
            <p className="text-xs font-bold text-slate-500 dark:text-slate-400">
              Class: <span className="text-orange-500 dark:text-orange-400">{currentClass?.className}</span>
            </p>
          </div>
        </div>
      )}

      {/* TOP HEADER */}
      <div className="w-full bg-white/80 dark:bg-[#070b13]/80 backdrop-blur-md sticky top-0 z-40 border-b border-slate-200/50 dark:border-slate-800/50 shadow-sm">
        <div className="mx-auto max-w-2xl px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate('/')}
              className="h-10 w-10 flex items-center justify-center rounded-full bg-orange-500/10 text-orange-500 hover:bg-orange-500 hover:text-white transition-all shadow-sm"
              title="Back to Dashboard"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
            
            <div>
              <h1 className="text-xl font-black tracking-tight text-slate-900 dark:text-white flex items-center gap-2">
                <Award className="h-5 w-5 text-orange-500" /> Quiz Portal
              </h1>
              <p className="text-[10px] font-bold text-slate-400">
                Manage Quiz Marks & Monthly Records
              </p>
            </div>
          </div>

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

      {/* MAIN CONTAINER */}
      <main className="mx-auto max-w-5xl px-4 py-5 space-y-5">
        
        {loading ? (
          <div className="flex flex-col items-center justify-center py-20 text-slate-400">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-orange-500 mb-4"></div>
            <p className="text-sm font-bold">Fetching Classes & Quizzes...</p>
          </div>
        ) : (
          <>
            {/* COMPACT QUIZ PERFORMANCE INTRO */}
            <section className="rounded-3xl border border-slate-200/80 dark:border-slate-800 bg-white dark:bg-[#0c1222] px-4 py-4 sm:px-5 shadow-sm">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="mb-2 inline-flex items-center gap-1.5 rounded-full border border-orange-500/20 bg-orange-500/10 px-2.5 py-1 text-[9px] font-extrabold uppercase tracking-wider text-orange-600 dark:text-orange-400">
                    <Sparkles className="h-3 w-3" /> Academic assessment
                  </div>
                  <h2 className="text-lg sm:text-xl font-black tracking-tight text-slate-900 dark:text-white">Quiz Performance Overview</h2>
                  <p className="mt-1 max-w-2xl text-xs leading-5 text-slate-500 dark:text-slate-400">
                    Review recorded scores, monitor monthly progress and export searchable quiz reports.
                  </p>
                  <p className="mt-2 text-[11px] font-bold text-slate-500 dark:text-slate-400">
                    Selected class: <span className="text-orange-600 dark:text-orange-400">{currentClass ? `${currentClass.className} (${currentClass.classCode})` : 'No class selected'}</span>
                  </p>
                </div>
                {!isCreatingQuiz && (
                  <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-shrink-0">
                    <button
                      type="button"
                      onClick={handleOpenNewQuiz}
                      disabled={!currentClass}
                      className="inline-flex min-h-10 items-center justify-center gap-2 rounded-2xl bg-orange-500 px-4 py-2.5 text-xs font-extrabold text-white shadow-sm shadow-orange-500/20 transition-colors hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Plus className="h-4 w-4" /> New Quiz
                    </button>
                    <button
                      type="button"
                      onClick={() => { setReportError(null); setReportNotice(null); setIsReportModalOpen(true); }}
                      disabled={!currentClass}
                      className="inline-flex min-h-10 items-center justify-center gap-2 rounded-2xl border border-orange-500/30 bg-orange-50 px-4 py-2.5 text-xs font-extrabold text-orange-700 transition-colors hover:border-orange-500 hover:bg-orange-100 dark:bg-orange-500/10 dark:text-orange-300 dark:hover:bg-orange-500/15 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <FileText className="h-4 w-4" /> Generate Report
                    </button>
                  </div>
                )}
              </div>
            </section>

            {/* CLASS SELECTOR CARD BUTTON */}
            <div 
              onClick={() => setIsClassModalOpen(true)}
              className="bg-white dark:bg-[#0c1222] border-2 border-orange-500/40 hover:border-orange-500 rounded-3xl p-4 shadow-[0_0_20px_rgba(249,115,22,0.15)] hover:shadow-[0_0_25px_rgba(249,115,22,0.25)] flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 cursor-pointer transition-all duration-300 group"
            >
              <div className="flex items-center gap-3">
                <div className="p-3 bg-orange-500/10 text-orange-500 rounded-2xl border border-orange-500/20 group-hover:bg-orange-500 group-hover:text-white transition-all">
                  <GraduationCap className="h-6 w-6" />
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase text-slate-400 tracking-wider">
                    ACTIVE CLASS
                  </label>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="font-black text-slate-900 dark:text-white text-base">
                      {currentClass ? `${currentClass.className} (${currentClass.classCode})` : 'Select Class'}
                    </span>
                    <ChevronDown className="h-4 w-4 text-orange-500 group-hover:translate-y-0.5 transition-transform" />
                  </div>
                </div>
              </div>

            </div>

            {/* MONTH SELECTOR CARD BUTTON */}
            {!isCreatingQuiz && (
              <div 
                onClick={() => setIsMonthModalOpen(true)}
                className="bg-white dark:bg-[#0c1222] border-2 border-orange-500/40 hover:border-orange-500 rounded-3xl p-4 shadow-[0_0_20px_rgba(249,115,22,0.15)] hover:shadow-[0_0_25px_rgba(249,115,22,0.25)] flex items-center justify-between gap-3 cursor-pointer transition-all duration-300 group"
              >
                <div className="flex items-center gap-3">
                  <div className="p-3 bg-orange-500/10 text-orange-500 rounded-2xl border border-orange-500/20 group-hover:bg-orange-500 group-hover:text-white transition-all">
                    <Calendar className="h-6 w-6" />
                  </div>
                  <div>
                    <label className="text-[10px] font-black uppercase text-slate-400 tracking-wider">
                      SELECT MONTH RECORD
                    </label>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="font-black text-slate-900 dark:text-white text-base">
                        {selectedMonth}
                      </span>
                      <ChevronDown className="h-4 w-4 text-orange-500 group-hover:translate-y-0.5 transition-transform" />
                    </div>
                  </div>
                </div>

                <div className="text-right">
                  <span className="text-[10px] font-black text-orange-500 uppercase tracking-wider block">
                    {selectedMonth === currentMonthKey ? 'CURRENT MONTH' : 'PREVIOUS MONTH'}
                  </span>
                  <span className="text-xs font-bold text-slate-400">
                    {filteredQuizzesByMonth.length} Quizzes Found
                  </span>
                </div>
              </div>
            )}

            {!isCreatingQuiz && (
              <section aria-label="Selected month quiz summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <div className="rounded-2xl border border-slate-200/80 bg-white p-3.5 shadow-sm dark:border-slate-800 dark:bg-[#0c1222]">
                  <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400"><Calendar className="h-4 w-4 text-orange-500" /><span className="text-[10px] font-bold">Quizzes this month</span></div>
                  <div className="mt-2 text-2xl font-black tracking-tight text-slate-900 dark:text-white">{filteredQuizzesByMonth.length}</div>
                  <p className="mt-1 text-[10px] text-slate-400">Saved in {selectedMonth}</p>
                </div>
                <div className="rounded-2xl border border-slate-200/80 bg-white p-3.5 shadow-sm dark:border-slate-800 dark:bg-[#0c1222]">
                  <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400"><Users className="h-4 w-4 text-orange-500" /><span className="text-[10px] font-bold">Class students</span></div>
                  <div className="mt-2 text-2xl font-black tracking-tight text-slate-900 dark:text-white">{currentClass?.students.length ?? 0}</div>
                  <p className="mt-1 text-[10px] text-slate-400">Current verified roster</p>
                </div>
                <div className="rounded-2xl border border-slate-200/80 bg-white p-3.5 shadow-sm dark:border-slate-800 dark:bg-[#0c1222]">
                  <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400"><BarChart2 className="h-4 w-4 text-orange-500" /><span className="text-[10px] font-bold">Average performance</span></div>
                  <div className="mt-2 text-2xl font-black tracking-tight text-slate-900 dark:text-white">{selectedMonthAveragePercentage === null ? '—' : `${selectedMonthAveragePercentage.toFixed(1)}%`}</div>
                  <p className="mt-1 text-[10px] text-slate-400">Normalized valid recorded attempts</p>
                </div>
                <div className="rounded-2xl border border-slate-200/80 bg-white p-3.5 shadow-sm dark:border-slate-800 dark:bg-[#0c1222]">
                  <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400"><Check className="h-4 w-4 text-orange-500" /><span className="text-[10px] font-bold">Scored attempts</span></div>
                  <div className="mt-2 text-2xl font-black tracking-tight text-slate-900 dark:text-white">{selectedMonthValidAttempts}</div>
                  <p className="mt-1 text-[10px] text-slate-400">Blank marks are excluded</p>
                </div>
              </section>
            )}

            {/* MODE 1: CREATE OR EDIT QUIZ FORM */}
            {isCreatingQuiz ? (
              <form onSubmit={handleSaveQuiz} className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-300">
                <div className="bg-white dark:bg-[#0c1222] border-2 border-orange-500 rounded-3xl p-5 shadow-[0_0_30px_rgba(249,115,22,0.25)] space-y-4">
                  
                  <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
                    <h3 className="text-sm font-black text-slate-900 dark:text-white flex items-center gap-2">
                      <Sparkles className="h-4 w-4 text-orange-500" />
                      {editingQuizId ? 'Edit Quiz Record' : 'Create New Quiz Form'}
                    </h3>
                    <button
                      type="button"
                      onClick={() => setIsCreatingQuiz(false)}
                      className="text-xs font-bold text-slate-400 hover:text-orange-500 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>

                  {/* QUIZ TOPIC & TOTAL MARKS */}
                  {formPage === 1 && (
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 animate-in fade-in duration-300">
                      <div className="sm:col-span-2">
                        <label className="text-[11px] font-black text-slate-400 block mb-1">
                          Quiz Topic / Chapter Name *
                        </label>
                        <input
                          type="text"
                          required
                          placeholder="e.g. Chapter 10 A"
                          value={quizTopic}
                          onChange={(e) => setQuizTopic(e.target.value)}
                          className="w-full bg-slate-50 dark:bg-[#070b13] text-slate-900 dark:text-white border border-slate-200 dark:border-slate-800 rounded-2xl px-3.5 py-2.5 text-xs font-bold outline-none focus:border-orange-500 transition-all shadow-sm"
                        />
                      </div>

                      <div>
                        <label className="text-[11px] font-black text-slate-400 block mb-1">
                          Total Marks *
                        </label>
                        <input
                          type="number"
                          required
                          min={1}
                          value={totalMarks}
                          onChange={(e) => setTotalMarks(Number(e.target.value))}
                          className="w-full bg-slate-50 dark:bg-[#070b13] text-slate-900 dark:text-white border border-slate-200 dark:border-slate-800 rounded-2xl px-3.5 py-2.5 text-xs font-bold outline-none focus:border-orange-500 transition-all shadow-sm"
                        />
                      </div>
                    </div>
                  )}

                  {/* FILTERS BAR */}
                  <div className="bg-slate-50 dark:bg-[#070b13] p-3 rounded-2xl border border-slate-200/80 dark:border-slate-800 space-y-2">
                    <div className="flex items-center gap-1.5 text-xs font-black text-orange-500">
                      <SlidersHorizontal className="h-3.5 w-3.5" /> Filters
                    </div>

                    <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 pt-1">
                      <div className="flex items-center gap-1">
                        {(['All', 'Male', 'Female'] as const).map((g) => (
                          <button
                            key={g}
                            type="button"
                            onClick={() => setGenderFilter(g)}
                            className={`px-3 py-1 rounded-xl text-[11px] font-black transition-all ${
                              genderFilter === g
                                ? 'bg-orange-500 text-white shadow-sm'
                                : 'bg-white dark:bg-slate-800 text-slate-500 border border-slate-200 dark:border-slate-700'
                            }`}
                          >
                            {g}
                          </button>
                        ))}
                      </div>

                      <div className="flex items-center gap-2">
                        <span className="text-[11px] font-bold text-slate-400">Show Marks Below:</span>
                        <input
                          type="number"
                          placeholder="e.g. 8"
                          value={belowThreshold}
                          onChange={(e) => setBelowThreshold(e.target.value)}
                          className="w-20 bg-white dark:bg-slate-900 text-slate-900 dark:text-white border border-slate-200 dark:border-slate-700 rounded-xl px-2 py-1 text-xs font-bold outline-none focus:border-orange-500"
                        />
                        {belowThreshold && (
                          <button
                            type="button"
                            onClick={() => setBelowThreshold('')}
                            className="text-[10px] font-black text-rose-500"
                          >
                            Clear
                          </button>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* STUDENTS MARKS INPUT LIST (AUTO FOCUS NEXT BOX) */}
                  <div className="space-y-3 pt-1">
                    <div className="flex items-center justify-between text-xs font-black text-slate-400">
                      <span>STUDENTS IN SEQUENCE ({filteredStudentsInForm.length})</span>
                      <span>ENTER MARKS OUT OF {totalMarks}</span>
                    </div>

                    {filteredStudentsInForm.length === 0 ? (
                      <div className="text-center py-6 text-xs text-slate-400 font-bold">
                        No students match the current filter.
                      </div>
                    ) : (
                      <div className="space-y-2.5">
                        {paginatedFormStudents.map((st, idx) => (
                          <div
                            key={st.id}
                            className="bg-slate-50/90 dark:bg-[#070b13]/90 border border-slate-200 dark:border-slate-800 hover:border-orange-500/50 p-3 rounded-2xl flex items-center justify-between gap-3 transition-all animate-in fade-in slide-in-from-right-2 duration-300"
                          >
                            <div className="flex items-center gap-3">
                              <div className="h-8 w-8 rounded-full bg-orange-500/10 text-orange-500 flex items-center justify-center font-black text-xs border border-orange-500/20 shadow-sm">
                                {st.rollNo}
                              </div>
                              <div>
                                <h4 className="text-xs font-black text-slate-900 dark:text-white">
                                  {st.name}
                                </h4>
                                <span className="text-[9px] font-bold px-2 py-0.5 rounded bg-slate-200/60 dark:bg-slate-800 text-slate-500">
                                  {st.gender}
                                </span>
                              </div>
                            </div>

                            <div className="flex items-center gap-1.5">
                              <input
                                ref={(el) => (scoreInputRefs.current[idx] = el)}
                                type="number"
                                min={0}
                                max={totalMarks}
                                placeholder="0"
                                value={st.marksObtained}
                                onChange={(e) => handleScoreChange(st.id, e.target.value, idx)}
                                onKeyDown={(e) => handleInputKeyDown(e, idx)}
                                className={`w-16 text-center font-black text-sm rounded-xl py-1.5 border outline-none transition-all ${
                                  st.marksObtained !== '' && Number(st.marksObtained) < 8
                                    ? 'bg-rose-500/10 border-rose-500 text-rose-500'
                                    : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:border-orange-500'
                                }`}
                              />
                              <span className="text-[10px] font-bold text-slate-400">/{totalMarks}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* FORM PAGINATION CONTROLS */}
                    {totalFormPages > 1 && (
                      <div className="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-slate-800">
                        <button
                          type="button"
                          disabled={formPage === 1}
                          onClick={() => setFormPage((p) => Math.max(1, p - 1))}
                          className="px-3 py-1.5 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 font-black text-xs flex items-center gap-1 disabled:opacity-40 transition-all hover:bg-orange-500 hover:text-white"
                        >
                          <ChevronLeft className="h-4 w-4" /> Previous
                        </button>

                        <span className="text-xs font-black text-slate-500 dark:text-slate-400">
                          Page <span className="text-orange-500">{formPage}</span> of {totalFormPages}
                        </span>

                        <button
                          type="button"
                          disabled={formPage >= totalFormPages}
                          onClick={() => setFormPage((p) => Math.min(totalFormPages, p + 1))}
                          className="px-3 py-1.5 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 font-black text-xs flex items-center gap-1 disabled:opacity-40 transition-all hover:bg-orange-500 hover:text-white"
                        >
                          Next <ChevronRight className="h-4 w-4" />
                        </button>
                      </div>
                    )}
                  </div>

                  {/* SAVE BUTTON */}
                  <div className="pt-3 border-t border-slate-100 dark:border-slate-800">
                    <button
                      type="submit"
                      disabled={isSaving}
                      className="w-full bg-orange-500 hover:bg-orange-600 text-white font-black py-3.5 rounded-2xl text-xs flex items-center justify-center gap-2 shadow-[0_0_20px_rgba(249,115,22,0.4)] transition-all active:scale-95 disabled:opacity-50"
                    >
                      <Save className="h-4 w-4" />
                      {isSaving ? 'Saving to Database...' : editingQuizId ? 'Update Quiz Record' : 'Save Quiz Marks'}
                    </button>
                  </div>
                </div>
              </form>
            ) : (
              /* MODE 2: SAVED QUIZZES LIST */
              <div className="space-y-4 animate-in fade-in slide-in-from-top-2 duration-300">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-black uppercase text-slate-400 tracking-wider flex items-center gap-1">
                    <BarChart2 className="h-4 w-4 text-orange-500" /> Quizzes in {selectedMonth} ({filteredQuizzesByMonth.length})
                  </h3>
                  <span className="text-[11px] font-bold text-orange-500">Class: {currentClass?.className}</span>
                </div>

                {filteredQuizzesByMonth.length === 0 ? (
                  <div className="bg-white dark:bg-[#0c1222] border border-slate-200/80 dark:border-slate-800 rounded-3xl p-8 text-center space-y-3 shadow-sm">
                    <div className="h-12 w-12 rounded-2xl bg-orange-500/10 text-orange-500 mx-auto flex items-center justify-center">
                      <Award className="h-6 w-6" />
                    </div>
                    <div>
                      <h4 className="text-sm font-black text-slate-900 dark:text-white">No Quizzes Recorded in {selectedMonth}</h4>
                      <p className="text-xs text-slate-400 font-medium mt-1">
                        Create a quiz to start recording assessments for this month.
                      </p>
                    </div>
                    <button
                      onClick={handleOpenNewQuiz}
                      className="bg-orange-500 text-white px-5 py-2.5 rounded-2xl text-xs font-black shadow-[0_0_15px_rgba(249,115,22,0.3)] inline-flex items-center gap-1.5 hover:bg-orange-600 transition-all"
                    >
                      <Plus className="h-4 w-4" /> Create First Quiz
                    </button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {filteredQuizzesByMonth.map((quiz, index) => {
                      const topFourCategoryPerformers = getCategoryPerformers(quiz.studentScores);
                      const validQuizRows = Number.isFinite(quiz.totalMarks) && quiz.totalMarks > 0
                        ? quiz.studentScores.filter((student) => {
                            const mark = parseMark(student.marksObtained);
                            return mark.kind === 'valid' && mark.value !== undefined && mark.value <= quiz.totalMarks;
                          })
                        : [];
                      const blankQuizRows = quiz.studentScores.filter((student) => parseMark(student.marksObtained).kind === 'empty').length;
                      const normalizedAverage = validQuizRows.length
                        ? validQuizRows.reduce((sum, student) => sum + (Number(student.marksObtained) / quiz.totalMarks) * 100, 0) / validQuizRows.length
                        : null;

                      return (
                        <div
                          key={quiz.id}
                          onClick={() => handleOpenDetailModal(quiz)}
                          title="Open full quiz details"
                          style={{ animationDelay: `${index * 50}ms` }}
                          className="relative rounded-3xl border border-slate-200 bg-white p-4 shadow-sm transition-all duration-200 hover:border-orange-300 hover:shadow-md dark:border-slate-800 dark:bg-[#0c1222] dark:hover:border-orange-500/50 space-y-3 cursor-pointer group"
                        >
                          {/* CARD HEADER */}
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex items-start gap-3">
                              <div className="h-10 w-10 rounded-2xl bg-orange-500/10 text-orange-600 dark:text-orange-400 flex items-center justify-center flex-shrink-0 group-hover:scale-110 group-hover:bg-orange-500 group-hover:text-white transition-all duration-300">
                                <Award className="h-5 w-5" />
                              </div>
                              <div>
                                <span className="text-[9px] font-black uppercase tracking-wider bg-orange-100 dark:bg-orange-500/20 text-orange-600 dark:text-orange-400 px-2 py-0.5 rounded-md">
                                  TOTAL MARKS: {quiz.totalMarks}
                                </span>
                                <h4 className="text-sm font-black mt-1 text-slate-900 dark:text-white group-hover:text-orange-500 transition-colors">
                                  {quiz.topic}
                                </h4>
                                <p className="text-[10px] font-semibold text-slate-500 dark:text-slate-400 mt-1">
                                  {quiz.date || 'Date unavailable'} · {quiz.monthKey || 'Unknown month'} · Average: {normalizedAverage === null ? 'N/A' : `${normalizedAverage.toFixed(1)}%`} · Avg marks: {validQuizRows.length ? (validQuizRows.reduce((sum, student) => sum + Number(student.marksObtained), 0) / validQuizRows.length).toFixed(2) : 'N/A'}/{quiz.totalMarks}
                                </p>
                                <p className="mt-1 text-[10px] font-medium text-slate-400">
                                  {validQuizRows.length} scored · {blankQuizRows} not recorded · {quiz.totalMarks} total marks
                                </p>
                                {normalizedAverage !== null && (
                                  <div className="mt-2 flex max-w-xs items-center gap-2" aria-label={`Average performance ${normalizedAverage.toFixed(1)} percent`}>
                                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                                      <div className="h-full rounded-full bg-orange-500 transition-[width] duration-200" style={{ width: `${Math.max(0, Math.min(100, normalizedAverage))}%` }} />
                                    </div>
                                    <span className="text-[9px] font-extrabold tabular-nums text-orange-600 dark:text-orange-400">{normalizedAverage.toFixed(0)}%</span>
                                  </div>
                                )}
                              </div>
                            </div>

                            {/* EDIT & DELETE BUTTONS */}
                            <div className="flex items-center gap-1">
                              <button
                                onClick={(e) => handleOpenEditQuiz(quiz, e)}
                                className="text-slate-400 hover:text-orange-500 hover:bg-orange-50 dark:hover:bg-orange-500/10 p-1.5 rounded-xl transition-colors"
                                title="Edit Quiz"
                              >
                                <Edit3 className="h-4 w-4" />
                              </button>
                              <button
                                onClick={(e) => handleRequestDeleteQuiz(quiz, e)}
                                className="text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-500/10 p-1.5 rounded-xl transition-colors"
                                title="Delete Quiz"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </div>
                          </div>

                          {/* 4 CATEGORY PERFORMANCE BREAKDOWN */}
                          <div className="bg-slate-50 dark:bg-[#070b13] p-3 rounded-2xl border border-slate-100 dark:border-slate-800/80 space-y-2">
                            <div className="flex items-center justify-between text-[10px] font-black uppercase text-slate-400">
                              <span>KEY PERFORMERS BREAKDOWN:</span>
                              <span className="text-orange-500 flex items-center gap-1 group-hover:underline font-bold">
                                <Eye className="h-3 w-3" /> View All ({quiz.studentScores.length})
                              </span>
                            </div>

                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                              {topFourCategoryPerformers.map((st) => {
                                let badgeStyle = "bg-emerald-500/10 text-emerald-600 border-emerald-500/30";
                                if (st.category === 'Good') badgeStyle = "bg-blue-500/10 text-blue-600 border-blue-500/30";
                                else if (st.category === 'Average') badgeStyle = "bg-amber-500/10 text-amber-600 border-amber-500/30";
                                else if (st.category === 'Poor') badgeStyle = "bg-rose-500/10 text-rose-600 border-rose-500/30";

                                return (
                                  <div
                                    key={st.id}
                                    className={`p-2 rounded-xl border text-center space-y-0.5 ${badgeStyle}`}
                                  >
                                    <span className="text-[8px] font-black uppercase tracking-wider block opacity-80">
                                      {st.category}
                                    </span>
                                    <div className="text-[11px] font-black truncate">{st.name}</div>
                                    <div className="text-xs font-black">{st.marksObtained}/{quiz.totalMarks}</div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </main>

      {/* QUIZ REPORT CONFIGURATION AND GENERATED PDF ACTIONS */}
      {isReportModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 p-3 backdrop-blur-sm sm:p-5" role="dialog" aria-modal="true" aria-labelledby="quiz-report-dialog-title">
          <div className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-[#0c1222]">
            <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4 dark:border-slate-800">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-2xl bg-orange-500/10 text-orange-600 dark:text-orange-400">
                  <FileText className="h-5 w-5" />
                </div>
                <div>
                  <h3 id="quiz-report-dialog-title" className="text-base font-black text-slate-900 dark:text-white">Generate Quiz Report</h3>
                  <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">Searchable PDF · Fresh Firestore read · No quiz records are changed</p>
                </div>
              </div>
              <button type="button" onClick={() => setIsReportModalOpen(false)} aria-label="Close report configuration" className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-800 dark:hover:text-white">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-4 overflow-y-auto px-5 py-4">
              <div className="rounded-2xl border border-orange-500/20 bg-orange-50/70 p-3.5 dark:bg-orange-500/5">
                <div className="text-[9px] font-extrabold uppercase tracking-wider text-orange-700 dark:text-orange-300">Verified report context</div>
                <div className="mt-1 text-sm font-extrabold text-slate-900 dark:text-white">{currentClass ? `${currentClass.className} (${currentClass.classCode})` : 'No class selected'}</div>
                <p className="mt-1 text-[10px] text-slate-500 dark:text-slate-400">Reports include saved score rows for this class only. The selected month, search, gender filter and pagination do not limit history exports.</p>
              </div>

              <div>
                <label className="mb-2 block text-[11px] font-extrabold text-slate-700 dark:text-slate-200">Choose report scope</label>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {([
                    { value: 'individual', title: 'Individual Quiz Report', description: 'All identifiable saved score rows for one quiz.' },
                    { value: 'month', title: 'Selected Month', description: `Every quiz in ${selectedMonth}, with student marks.` },
                    { value: 'history', title: 'Complete Class History', description: 'All available saved quizzes across all months and years.' },
                    { value: 'range', title: 'Custom Month Range', description: 'An inclusive start and end month.' },
                  ] as const).map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => { setReportScope(option.value); setReportError(null); setReportNotice(null); setReportPdf(null); }}
                      className={`rounded-2xl border p-3 text-left transition-colors ${reportScope === option.value ? 'border-orange-500 bg-orange-500/5 ring-1 ring-orange-500/20' : 'border-slate-200 bg-white hover:border-orange-300 dark:border-slate-800 dark:bg-[#070b13] dark:hover:border-orange-500/50'}`}
                    >
                      <span className="flex items-center gap-2 text-xs font-extrabold text-slate-900 dark:text-white">
                        <span className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border ${reportScope === option.value ? 'border-orange-500 bg-orange-500 text-white' : 'border-slate-300 dark:border-slate-600'}`}>
                          {reportScope === option.value && <Check className="h-3 w-3" />}
                        </span>
                        {option.title}
                      </span>
                      <span className="mt-1.5 block pl-6 text-[10px] leading-4 text-slate-500 dark:text-slate-400">{option.description}</span>
                    </button>
                  ))}
                </div>
              </div>

              {reportScope === 'individual' && (
                <div>
                  <label htmlFor="report-quiz-choice" className="mb-1.5 block text-[11px] font-extrabold text-slate-700 dark:text-slate-200">Quiz from the full class history</label>
                  <select id="report-quiz-choice" value={reportQuizId} onChange={(event) => { setReportQuizId(event.target.value); setReportPdf(null); setReportError(null); setReportNotice(null); }} className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-xs font-semibold text-slate-800 outline-none transition-colors focus:border-orange-500 dark:border-slate-700 dark:bg-[#070b13] dark:text-slate-100" disabled={quizzes.length === 0}>
                    {quizzes.length === 0 && <option value="">No saved quizzes available</option>}
                    {quizzes.map((quiz) => <option key={quiz.id} value={quiz.id}>{quiz.topic} · {quiz.date || 'Date unavailable'} · {quiz.monthKey || 'Unknown month'}</option>)}
                  </select>
                  <p className="mt-1.5 text-[10px] text-slate-500 dark:text-slate-400">This selector includes quizzes outside the currently visible month.</p>
                </div>
              )}

              {reportScope === 'month' && (
                <div className="rounded-xl border border-slate-200 px-3.5 py-3 dark:border-slate-800">
                  <div className="text-[10px] font-bold text-slate-500 dark:text-slate-400">Selected period</div>
                  <div className="mt-1 text-sm font-black text-slate-900 dark:text-white">{selectedMonth}</div>
                  <p className="mt-1 text-[10px] text-slate-500 dark:text-slate-400">The report refreshes all class quiz records before including every record resolved to this month.</p>
                </div>
              )}

              {reportScope === 'history' && (
                <div className="rounded-xl border border-slate-200 px-3.5 py-3 dark:border-slate-800">
                  <div className="text-[10px] font-bold text-slate-500 dark:text-slate-400">Historical period</div>
                  <div className="mt-1 text-sm font-black text-slate-900 dark:text-white">All available saved quiz records</div>
                  <p className="mt-1 text-[10px] text-slate-500 dark:text-slate-400">Includes all months and years in the selected class. Unknown legacy dates are included but flagged in the PDF.</p>
                </div>
              )}

              {reportScope === 'range' && (
                <div className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 p-3.5 dark:border-slate-800 sm:grid-cols-2">
                  <div>
                    <label htmlFor="report-start-month" className="mb-1.5 block text-[11px] font-extrabold text-slate-700 dark:text-slate-200">Starting month</label>
                    <input id="report-start-month" type="month" value={reportStartMonth} onChange={(event) => { setReportStartMonth(event.target.value); setReportPdf(null); setReportError(null); setReportNotice(null); }} className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-xs text-slate-800 outline-none focus:border-orange-500 dark:border-slate-700 dark:bg-[#070b13] dark:text-slate-100" />
                  </div>
                  <div>
                    <label htmlFor="report-end-month" className="mb-1.5 block text-[11px] font-extrabold text-slate-700 dark:text-slate-200">Ending month</label>
                    <input id="report-end-month" type="month" value={reportEndMonth} onChange={(event) => { setReportEndMonth(event.target.value); setReportPdf(null); setReportError(null); setReportNotice(null); }} className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-xs text-slate-800 outline-none focus:border-orange-500 dark:border-slate-700 dark:bg-[#070b13] dark:text-slate-100" />
                  </div>
                  {reportStartMonth > reportEndMonth && <p className="sm:col-span-2 text-[10px] font-bold text-rose-600 dark:text-rose-400">The start month must be earlier than or equal to the ending month.</p>}
                  <p className="sm:col-span-2 text-[10px] text-slate-500 dark:text-slate-400">Both endpoints are included. If any saved quiz has an unknown month, this report will stop rather than incorrectly claim complete coverage.</p>
                </div>
              )}

              <div className="rounded-xl border border-slate-200 px-3.5 py-3 dark:border-slate-800">
                <div className="text-[10px] font-extrabold uppercase tracking-wider text-slate-500 dark:text-slate-400">Report preview</div>
                <div className="mt-1 text-xs font-bold text-slate-900 dark:text-white">{reportScope === 'individual' ? 'Quiz Result Report' : reportScope === 'history' ? 'Complete Class Quiz History & Performance Report' : reportScope === 'month' ? 'Selected Month Quiz Report' : 'Custom Month Range Quiz Report'}</div>
                <p className="mt-1 text-[10px] text-slate-500 dark:text-slate-400">Class: {currentClass?.className || 'N/A'} ({currentClass?.classCode || 'N/A'}) · Period: {reportScope === 'individual' ? (quizzes.find((quiz) => quiz.id === reportQuizId)?.monthKey || quizzes.find((quiz) => quiz.id === reportQuizId)?.date || 'Selected quiz') : reportScope === 'month' ? selectedMonth : reportScope === 'range' ? `${reportStartMonth || 'Start'} to ${reportEndMonth || 'End'} (inclusive)` : 'All available months/years'}.</p>
              </div>

              {isReportGenerating && (
                <div role="status" aria-live="polite" className="flex items-start gap-2 rounded-xl border border-orange-200 bg-orange-50/80 px-3.5 py-3 text-xs font-semibold leading-5 text-orange-800 dark:border-orange-900/60 dark:bg-orange-950/20 dark:text-orange-200">
                  <span className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 animate-spin rounded-full border-2 border-orange-300 border-t-orange-600" />
                  <span>{reportProgress || 'Preparing your PDF...'}</span>
                </div>
              )}

              {reportError && (
                <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-3 text-xs font-semibold leading-5 text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-300">
                  <div className="mb-1 flex items-center gap-2 font-extrabold"><AlertTriangle className="h-4 w-4" /> Report not generated</div>{reportError}
                </div>
              )}
              {reportNotice && (
                <div role="status" className="rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-3 text-xs leading-5 text-slate-700 dark:border-slate-800 dark:bg-[#070b13] dark:text-slate-300">
                  <div className="mb-1 flex items-center gap-2 font-extrabold text-slate-900 dark:text-white"><Check className="h-4 w-4 text-orange-500" /> {reportPdf ? 'PDF ready' : 'Report status'}</div>{reportNotice}
                </div>
              )}

              {reportPdf && (
                <div className="flex flex-col gap-2 rounded-2xl border border-orange-500/25 bg-orange-50/50 p-3.5 dark:bg-orange-500/5 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="truncate text-xs font-extrabold text-slate-900 dark:text-white">{reportPdf.title}</div>
                    <div className="mt-1 truncate text-[10px] text-slate-500 dark:text-slate-400">{reportPdf.filename}</div>
                  </div>
                  <div className="grid flex-shrink-0 grid-cols-1 gap-2 sm:grid-cols-3">
                    <button type="button" onClick={handleViewGeneratedReport} className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-orange-200 bg-white px-3 py-2.5 text-[10px] font-extrabold text-slate-700 transition-colors hover:border-orange-400 hover:text-orange-700 dark:border-slate-700 dark:bg-[#0c1222] dark:text-slate-200">
                      <Eye className="h-3.5 w-3.5" /> View PDF
                    </button>
                    <a href={reportPdf.url} download={reportPdf.filename} onClick={(event) => { reportStageRef.current = 'Starting browser PDF download'; try { if (!reportPdf.url.startsWith('blob:') || !reportPdf.filename.toLowerCase().endsWith('.pdf')) throw new Error('REPORT_DOWNLOAD_TARGET_INVALID'); console.info('[EduTrack Quiz Report Diagnostic] Browser download initiated', { reportStage: reportStageRef.current, filename: reportPdf.filename, scope: reportScope, classId: selectedClassIdRef.current }); } catch (error) { event.preventDefault(); logReportFailure(reportStageRef.current, 'browser-delivery', error, { action: 'download', filename: reportPdf.filename }); setReportError(null); setReportNotice('The generated PDF download link is invalid. Generate the report again.'); } }} className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-orange-500 px-3 py-2.5 text-[10px] font-extrabold text-white transition-colors hover:bg-orange-600">
                      <Download className="h-3.5 w-3.5" /> Download PDF
                    </a>
                    <button type="button" onClick={handlePrintGeneratedReport} className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-[10px] font-extrabold text-slate-700 transition-colors hover:border-orange-400 dark:border-slate-700 dark:bg-[#0c1222] dark:text-slate-200">
                      <Printer className="h-3.5 w-3.5" /> Print
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="flex flex-col-reverse gap-2 border-t border-slate-100 px-5 py-4 dark:border-slate-800 sm:flex-row sm:justify-end">
              <button type="button" onClick={() => setIsReportModalOpen(false)} className="rounded-xl border border-slate-200 px-4 py-2.5 text-xs font-extrabold text-slate-600 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">Cancel</button>
              <button
                type="button"
                onClick={handleGenerateReport}
                disabled={isReportGenerating || !currentClass || (reportScope === 'individual' && (!reportQuizId || quizzes.length === 0)) || (reportScope === 'range' && (!reportStartMonth || !reportEndMonth || reportStartMonth > reportEndMonth))}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-orange-500 px-5 py-2.5 text-xs font-extrabold text-white shadow-sm transition-colors hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isReportGenerating ? <><span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/50 border-t-white" /> {reportProgress || 'Preparing your PDF...'}</> : <><FileText className="h-4 w-4" /> Generate PDF</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* SELECT CLASS BEAUTIFUL CARD MODAL */}
      {isClassModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-md animate-in fade-in duration-200">
          <div className="bg-white dark:bg-[#0c1222] border-2 border-orange-500 rounded-3xl p-5 max-w-md w-full flex flex-col shadow-[0_0_50px_rgba(249,115,22,0.3)] space-y-4">
            
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
              <div className="flex items-center gap-3">
                <div className="p-2.5 bg-orange-500 text-white rounded-2xl shadow-md">
                  <GraduationCap className="h-6 w-6" />
                </div>
                <div>
                  <h3 className="text-base font-black text-slate-900 dark:text-white">
                    Select Class
                  </h3>
                  <p className="text-[10px] font-bold text-slate-400">
                    Choose class to load items ({classes.length} Available)
                  </p>
                </div>
              </div>

              <button
                onClick={() => setIsClassModalOpen(false)}
                className="h-8 w-8 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-400 hover:text-slate-900 dark:hover:text-white flex items-center justify-center transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="relative">
              <Search className="h-4 w-4 text-orange-500 absolute left-3.5 top-3" />
              <input
                type="text"
                placeholder="Filter classes by name or code..."
                value={classSearchText}
                onChange={(e) => setClassSearchText(e.target.value)}
                className="w-full bg-slate-50 dark:bg-[#070b13] text-slate-900 dark:text-white border border-slate-200 dark:border-slate-800 rounded-2xl pl-10 pr-4 py-2.5 text-xs font-bold outline-none focus:border-orange-500 transition-all shadow-sm"
              />
            </div>

            <div className="space-y-2.5 max-h-60 overflow-y-auto pr-1">
              {filteredClassesModal.length === 0 ? (
                <div className="text-center py-6 text-xs text-slate-400 font-bold">
                  No classes found matching search.
                </div>
              ) : (
                filteredClassesModal.map((cls) => {
                  const isSelected = selectedClassId === cls.id;
                  return (
                    <div
                      key={cls.id}
                      onClick={() => setSelectedClassId(cls.id)}
                      className={`p-3.5 rounded-2xl border-2 flex items-center justify-between cursor-pointer transition-all duration-200 ${
                        isSelected
                          ? 'border-orange-500 bg-orange-500/5 shadow-[0_0_15px_rgba(249,115,22,0.15)]'
                          : 'border-slate-200 dark:border-slate-800 hover:border-orange-500/50 bg-slate-50 dark:bg-[#070b13]'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <div className={`h-6 w-6 rounded-full flex items-center justify-center transition-all ${
                          isSelected ? 'bg-orange-500 text-white' : 'border-2 border-slate-300 dark:border-slate-700'
                        }`}>
                          {isSelected && <Check className="h-3.5 w-3.5 stroke-[3]" />}
                        </div>
                        <div>
                          <h4 className="text-sm font-black text-slate-900 dark:text-white">
                            {cls.className}
                          </h4>
                          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                            STUDENTS: {cls.students?.length || 0} UNITS • CODE: {cls.classCode}
                          </span>
                        </div>
                      </div>

                      <span className="text-xs font-black px-3 py-1 rounded-full bg-orange-500/10 text-orange-500">
                        Select
                      </span>
                    </div>
                  );
                })
              )}
            </div>

            <button
              onClick={() => setIsClassModalOpen(false)}
              className="w-full bg-orange-500 hover:bg-orange-600 text-white font-black py-3 rounded-2xl text-xs flex items-center justify-center gap-1.5 shadow-[0_0_20px_rgba(249,115,22,0.4)] transition-all active:scale-95"
            >
              <Check className="h-4 w-4" /> OK
            </button>
          </div>
        </div>
      )}

      {/* SELECT MONTH BEAUTIFUL CARD MODAL */}
      {isMonthModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-md animate-in fade-in duration-200">
          <div className="bg-white dark:bg-[#0c1222] border-2 border-orange-500 rounded-3xl p-5 max-w-md w-full flex flex-col shadow-[0_0_50px_rgba(249,115,22,0.3)] space-y-4">
            
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
              <div className="flex items-center gap-3">
                <div className="p-2.5 bg-orange-500 text-white rounded-2xl shadow-md">
                  <Calendar className="h-6 w-6" />
                </div>
                <div>
                  <h3 className="text-base font-black text-slate-900 dark:text-white">
                    Select Month Record
                  </h3>
                  <p className="text-[10px] font-bold text-slate-400">
                    Choose month to filter quiz data ({availableMonths.length} Available)
                  </p>
                </div>
              </div>

              <button
                onClick={() => setIsMonthModalOpen(false)}
                className="h-8 w-8 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-400 hover:text-slate-900 dark:hover:text-white flex items-center justify-center transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-2.5">
              {availableMonths.map((m) => {
                const isSelected = selectedMonth === m;
                return (
                  <div
                    key={m}
                    onClick={() => setSelectedMonth(m)}
                    className={`p-4 rounded-2xl border-2 flex items-center justify-between cursor-pointer transition-all duration-200 ${
                      isSelected
                        ? 'border-orange-500 bg-orange-500/5 shadow-[0_0_15px_rgba(249,115,22,0.15)]'
                        : 'border-slate-200 dark:border-slate-800 hover:border-orange-500/50 bg-slate-50 dark:bg-[#070b13]'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <div className={`h-6 w-6 rounded-full flex items-center justify-center transition-all ${
                        isSelected ? 'bg-orange-500 text-white' : 'border-2 border-slate-300 dark:border-slate-700'
                      }`}>
                        {isSelected && <Check className="h-3.5 w-3.5 stroke-[3]" />}
                      </div>
                      <div>
                        <h4 className="text-sm font-black text-slate-900 dark:text-white">
                          {m}
                        </h4>
                        <span className="text-[10px] font-bold text-orange-500 uppercase tracking-wider">
                          {m === currentMonthKey ? 'CURRENT ACTIVE MONTH' : 'PREVIOUS RECORDED MONTH'}
                        </span>
                      </div>
                    </div>

                    <span className="text-xs font-black px-3 py-1 rounded-full bg-orange-500/10 text-orange-500">
                      Select
                    </span>
                  </div>
                );
              })}
            </div>

            <button
              onClick={() => setIsMonthModalOpen(false)}
              className="w-full bg-orange-500 hover:bg-orange-600 text-white font-black py-3 rounded-2xl text-xs flex items-center justify-center gap-1.5 shadow-[0_0_20px_rgba(249,115,22,0.4)] transition-all active:scale-95"
            >
              <Check className="h-4 w-4" /> OK
            </button>
          </div>
        </div>
      )}

      {/* DELETE CONFIRMATION MODAL */}
      {deleteConfirmQuiz && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-md animate-in fade-in duration-200">
          <div className="bg-white dark:bg-[#0c1222] border-2 border-rose-500 rounded-3xl p-6 max-w-sm w-full flex flex-col items-center text-center shadow-[0_0_50px_rgba(244,63,94,0.3)] space-y-4">
            
            <div className="h-16 w-16 bg-rose-500/10 dark:bg-rose-500/20 text-rose-500 rounded-full flex items-center justify-center border border-rose-500/30">
              <AlertTriangle className="h-8 w-8 animate-bounce" />
            </div>

            <div className="space-y-1">
              <h3 className="text-base font-black text-slate-900 dark:text-white">
                Delete Quiz Card?
              </h3>
              <p className="text-xs font-bold text-slate-500 dark:text-slate-400">
                Are you sure you want to delete <span className="text-orange-500 font-black">"{deleteConfirmQuiz.topic}"</span>, Please Make Sure?
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3 w-full pt-2">
              <button
                onClick={() => setDeleteConfirmQuiz(null)}
                className="w-full bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-black py-2.5 rounded-2xl text-xs hover:bg-slate-200 transition-colors"
              >
                Cancel
              </button>

              <button
                onClick={handleConfirmDeleteQuiz}
                className="w-full bg-rose-500 hover:bg-rose-600 text-white font-black py-2.5 rounded-2xl text-xs shadow-[0_0_15px_rgba(244,63,94,0.4)] transition-all active:scale-95"
              >
                Yes, Delete Card
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL: CHAPTER DETAILS WITH PREV / NEXT FIXED SPACING */}
      {detailModalQuiz && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pb-20 bg-black/70 backdrop-blur-md animate-in fade-in duration-200">
          <div className="bg-white dark:bg-[#0c1222] border-2 border-orange-500 rounded-3xl p-5 max-w-lg w-full flex flex-col shadow-[0_0_50px_rgba(249,115,22,0.3)] max-h-[82vh] overflow-hidden">
            
            {/* Header (Flex Shrink 0) */}
            <div className="flex-shrink-0 flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3 mb-3">
              <div>
                <span className="text-[9px] font-black uppercase tracking-wider bg-orange-100 dark:bg-orange-500/20 text-orange-500 px-2 py-0.5 rounded-md">
                  TOTAL MARKS: {detailModalQuiz.totalMarks}
                </span>
                <h3 className="text-base font-black text-slate-900 dark:text-white mt-1">
                  {detailModalQuiz.topic}
                </h3>
                <p className="text-[10px] font-bold text-slate-400">
                  Date: {detailModalQuiz.date} • Class Average: {detailModalQuiz.averageScore}/{detailModalQuiz.totalMarks}
                </p>
              </div>

              <button
                onClick={() => setDetailModalQuiz(null)}
                className="h-8 w-8 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-400 hover:text-slate-900 dark:hover:text-white flex items-center justify-center transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Search & Filters (Flex Shrink 0) */}
            <div className="flex-shrink-0 space-y-2 mb-3">
              <div className="relative">
                <Search className="h-4 w-4 text-slate-400 absolute left-3 top-2.5" />
                <input
                  type="text"
                  placeholder="Search student by name..."
                  value={detailSearch}
                  onChange={(e) => setDetailSearch(e.target.value)}
                  className="w-full bg-slate-50 dark:bg-[#070b13] text-slate-900 dark:text-white border border-slate-200 dark:border-slate-800 rounded-xl pl-9 pr-3 py-2 text-xs font-bold outline-none focus:border-orange-500"
                />
              </div>

              <div className="flex items-center justify-between text-xs font-black text-slate-400">
                <div className="flex items-center gap-1">
                  {(['All', 'Male', 'Female'] as const).map((g) => (
                    <button
                      key={g}
                      onClick={() => setDetailGenderFilter(g)}
                      className={`px-3 py-1 rounded-xl text-[10px] font-black transition-all ${
                        detailGenderFilter === g
                          ? 'bg-orange-500 text-white shadow-sm'
                          : 'bg-slate-100 dark:bg-slate-800 text-slate-400'
                      }`}
                    >
                      {g}
                    </button>
                  ))}
                </div>
                <span>TOTAL STUDENTS: {allFilteredModalStudents.length}</span>
              </div>
            </div>

            {/* Scrollable Student List Container */}
            <div className="flex-1 overflow-y-auto pr-1 space-y-2 min-h-[180px]">
              {paginatedModalStudents.length === 0 ? (
                <div className="text-center py-12 text-xs text-slate-400 font-bold">
                  No students found matching search/filter.
                </div>
              ) : (
                paginatedModalStudents.map((st, idx) => (
                  <div
                    key={st.id}
                    className="bg-slate-50 dark:bg-[#070b13] border border-slate-200 dark:border-slate-800 p-3 rounded-2xl flex items-center justify-between gap-3 animate-in fade-in slide-in-from-right-2 duration-300"
                  >
                    <div className="flex items-center gap-3">
                      <div className="h-8 w-8 rounded-full bg-orange-500/10 text-orange-500 flex items-center justify-center font-black text-xs border border-orange-500/20">
                        {st.rollNo || (detailPage - 1) * DETAIL_PAGE_SIZE + idx + 1}
                      </div>
                      <div>
                        <h4 className="text-xs font-black text-slate-900 dark:text-white">
                          {st.name}
                        </h4>
                        <span className="text-[9px] font-bold text-slate-400">
                          Gender: {st.gender}
                        </span>
                      </div>
                    </div>

                    <div className="text-right">
                      <span className="text-sm font-black text-orange-500">
                        {st.marksObtained === '' ? 'N/A' : st.marksObtained}
                      </span>
                      <span className="text-[10px] font-bold text-slate-400">/{detailModalQuiz.totalMarks}</span>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Bottom Controls (Flex Shrink 0) */}
            <div className="flex-shrink-0 pt-3 border-t border-slate-100 dark:border-slate-800 space-y-3 mt-2">
              {/* Pagination controls */}
              {totalModalPages > 1 && (
                <div className="flex items-center justify-between">
                  <button
                    disabled={detailPage === 1}
                    onClick={() => setDetailPage((p) => Math.max(1, p - 1))}
                    className="px-4 py-2 rounded-xl bg-orange-500/10 text-orange-600 dark:text-orange-400 font-black text-xs flex items-center gap-1 disabled:opacity-40 transition-all hover:bg-orange-500 hover:text-white"
                  >
                    <ChevronLeft className="h-4 w-4" /> Previous
                  </button>

                  <span className="text-xs font-black text-slate-500 dark:text-slate-400">
                    Page <span className="text-orange-500 font-black">{detailPage}</span> of {totalModalPages}
                  </span>

                  <button
                    disabled={detailPage >= totalModalPages}
                    onClick={() => setDetailPage((p) => Math.min(totalModalPages, p + 1))}
                    className="px-4 py-2 rounded-xl bg-orange-500/10 text-orange-600 dark:text-orange-400 font-black text-xs flex items-center gap-1 disabled:opacity-40 transition-all hover:bg-orange-500 hover:text-white"
                  >
                    Next <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              )}

              <button
                onClick={() => setDetailModalQuiz(null)}
                className="w-full bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-black py-2.5 rounded-2xl text-xs hover:bg-orange-500 hover:text-white transition-colors"
              >
                Close Details
              </button>
            </div>

          </div>
        </div>
      )}

      <BottomNavbar />
    </div>
  );
}
