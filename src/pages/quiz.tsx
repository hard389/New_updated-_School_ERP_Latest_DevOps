import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useLocation, Link, useNavigate } from 'react-router-dom';
import {
  Award, GraduationCap, Plus, ArrowLeft, Sun, Moon, Home, Users, Wallet,
  Settings, Sparkles, X, Save, Trash2, Edit3, BarChart2, ChevronDown,
  SlidersHorizontal, Calendar, Eye, Search, ChevronLeft, ChevronRight,
  Check, AlertTriangle
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

// --- FIXED BOTTOM NAVBAR (Fit 5 Icons inside Card) ---
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
      <nav className="pointer-events-auto bg-white/95 dark:bg-[#0c1222]/95 backdrop-blur-xl border border-slate-200/80 dark:border-slate-800 shadow-[0_10px_40px_rgba(0,0,0,0.15)] rounded-full px-3 py-1.5 flex items-center justify-between max-w-sm w-full">
        {navigationTabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = location.pathname === tab.href;
          return (
            <Link
              key={tab.id}
              to={tab.href}
              className="flex flex-col items-center justify-center flex-1 py-0.5 transition-all group"
            >
              <div
                className={`p-2 rounded-full transition-all duration-300 flex items-center justify-center ${
                  isActive
                    ? 'bg-orange-500 text-white shadow-md scale-105'
                    : 'text-slate-400 bg-transparent group-hover:text-slate-600 dark:group-hover:text-slate-300 group-hover:bg-slate-100 dark:group-hover:bg-slate-800'
                }`}
              >
                <Icon className="h-4 w-4" />
              </div>
              <span
                className={`text-[9px] font-bold mt-0.5 transition-colors tracking-tight ${
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

  // Keep the existing render JSX unchanged while validating legacy marks against each quiz total.
  const getCategoryPerformers = (scores: StudentScore[]) => {
    const quiz = quizzes.find((item) => item.studentScores === scores);
    return calculateCategoryPerformers(scores, quiz?.totalMarks ?? Number.POSITIVE_INFINITY);
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
    if (parsed.kind === 'valid' && parsed.value >= 0 && parsed.value <= totalMarks) {
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
      <main className="mx-auto max-w-2xl px-4 py-5 space-y-5">
        
        {loading ? (
          <div className="flex flex-col items-center justify-center py-20 text-slate-400">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-orange-500 mb-4"></div>
            <p className="text-sm font-bold">Fetching Classes & Quizzes...</p>
          </div>
        ) : (
          <>
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
                    SELECT ACTIVE CLASS, MERE JAAN
                  </label>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="font-black text-slate-900 dark:text-white text-base">
                      {currentClass ? `${currentClass.className} (${currentClass.classCode})` : 'Select Class'}
                    </span>
                    <ChevronDown className="h-4 w-4 text-orange-500 group-hover:translate-y-0.5 transition-transform" />
                  </div>
                </div>
              </div>

              {!isCreatingQuiz && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleOpenNewQuiz();
                  }}
                  className="bg-orange-500 text-white hover:bg-orange-600 px-4 py-2.5 rounded-2xl text-xs font-black flex items-center justify-center gap-2 shadow-[0_0_15px_rgba(249,115,22,0.4)] transition-all active:scale-95"
                >
                  <Plus className="h-4 w-4" /> New Quiz
                </button>
              )}
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
                    <div className="h-12 w-12 rounded-full bg-orange-500/10 text-orange-500 mx-auto flex items-center justify-center animate-pulse">
                      <Award className="h-6 w-6" />
                    </div>
                    <div>
                      <h4 className="text-sm font-black text-slate-900 dark:text-white">No Quizzes Recorded in {selectedMonth}</h4>
                      <p className="text-xs text-slate-400 font-medium mt-1">
                        Click "New Quiz" to add marks for this month, mere jaan.
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

                      return (
                        <div
                          key={quiz.id}
                          onClick={() => handleOpenDetailModal(quiz)}
                          style={{ animationDelay: `${index * 50}ms` }}
                          className="relative bg-white dark:bg-[#0c1222] border-2 border-orange-500/40 dark:border-orange-500/50 rounded-3xl p-4 shadow-[0_0_15px_rgba(249,115,22,0.15)] hover:shadow-[0_0_25px_rgba(249,115,22,0.3)] hover:border-orange-500 transition-all duration-300 space-y-3 cursor-pointer group animate-in fade-in"
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
                                <p className="text-[10px] font-bold text-slate-400 mt-0.5">
                                  Date: {quiz.date} • Avg Score: {quiz.averageScore}/{quiz.totalMarks}
                                </p>
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
