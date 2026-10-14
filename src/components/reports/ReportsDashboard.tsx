import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Button } from '@/components/ui/button';

// FIREBASE IMPORTS
import { onAuthStateChanged } from 'firebase/auth';
import { auth, db } from '@/lib/firebase';
import {
  calculateMonthlyStudentMetrics,
  getFeeStatusForStudent,
  getMonthlyFeeRecords,
  getReportMonthDateRange,
  isAuthorizedTeacherProfile,
  normalizeReportMonth,
  normalizeReportRoster,
  normalizeTenantEmail,
  type ReportDocument,
  type StudentReportMetrics,
} from '@/components/reports/ReportsDashboard.logic';
import { 
  collection,
  onSnapshot,
  doc,
  setDoc,
  deleteDoc,
  getDocs,
  addDoc,
  serverTimestamp,
  query,
  where,
  documentId,
  Timestamp,
} from 'firebase/firestore';

// UI ICONS (Lucide React)
import {
  Home,
  GraduationCap,
  Users,
  Wallet,
  Settings,
  ArrowLeft,
  Check,
  Zap,
  BookOpen,
  Award,
  AlertCircle,
  TrendingUp,
  ThumbsUp,
  Loader2,
  Sun,
  Moon,
  Search,
  AlertTriangle,
  ExternalLink,
  ShieldAlert,
  X,
  ChevronLeft,
  ChevronRight,
  Printer,
  Sparkles,
  FileCheck,
  UserCheck,
  Calendar,
  Send
} from 'lucide-react';

// HELPER: Dynamic Month Info & Label Formatting
const getTwoMonthsInfo = () => {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();

  const currDate = new Date(currentYear, currentMonth, 1);
  const prevDate = new Date(currentYear, currentMonth - 1, 1);

  const currentKey = `${currDate.getFullYear()}-${String(currDate.getMonth() + 1).padStart(2, '0')}`;
  const previousKey = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}`;

  const currentLabel = currDate.toLocaleString('default', { month: 'long', year: 'numeric' });
  const previousLabel = prevDate.toLocaleString('default', { month: 'long', year: 'numeric' });

  return { currentKey, previousKey, currentLabel, previousLabel };
};

const formatMonthLabel = (monthKey: string) => {
  const [yearStr, monthStr] = monthKey.split('-');
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);

  if (isNaN(year) || isNaN(month)) return monthKey;

  const date = new Date(year, month - 1, 1);
  const monthName = date.toLocaleString('default', { month: 'long', year: 'numeric' });

  const now = new Date();
  const currentKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  return monthKey === currentKey ? `Current: ${monthName}` : monthName;
};

// TYPES & SCHEMAS
export type CategoryType = 'Excellent' | 'Good' | 'Average' | 'Poor';
export type NavTab = 'home' | 'classes' | 'attendance' | 'fees' | 'settings';

export interface GradingCriteria {
  homework: string;
  behavior: string;
  participation: string;
  performance: string;
}

export interface Student {
  id: string | number;
  name: string;
  rollNo: string;
  avatar?: string;
  attendanceRate?: string;
  quizScore?: string;
  category?: CategoryType | null;
  phone?: string;
  fatherPhone?: string;
  feeStatus?: string;
  homeworkGrade?: string;
  behaviorGrade?: string;
  participationGrade?: string;
  performanceGrade?: string;
  homeworkRemark?: string;
  behaviorRemark?: string;
  participationRemark?: string;
  performanceRemark?: string;
  remarks?: string;
  isConfigured?: boolean;
  lastWhatsAppSentMonth?: string;
}

export interface ClassItem {
  id: string;
  name: string;
  code: string;
  students: Student[];
}

export interface QuizStudentScore {
  id?: string | number;
  rollNo: string | number;
  name?: string;
  gender?: string;
  marksObtained: number;
}

export const CATEGORY_GRADES_MAP: Record<CategoryType, GradingCriteria> = {
  Excellent: { homework: 'A+', behavior: 'A+', participation: 'A+', performance: 'A+' },
  Good:      { homework: 'A',  behavior: 'A',  participation: 'B+', performance: 'A' },
  Average:   { homework: 'B',  behavior: 'B',  participation: 'B',  performance: 'C+' },
  Poor:      { homework: 'C',  behavior: 'D',  participation: 'C',  performance: 'D' }
};

export const CATEGORY_CONFIG: Record<CategoryType, { color: string; badgeBg: string; textColor: string; defaultRemarks: string; icon: any }> = {
  Excellent: {
    color: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-500 shadow-emerald-500/20',
    badgeBg: 'bg-emerald-500 text-white shadow-lg shadow-emerald-500/30',
    textColor: 'text-emerald-500 dark:text-emerald-400',
    defaultRemarks: 'Outstanding academic performance & active participation throughout the week!',
    icon: Award
  },
  Good: {
    color: 'border-blue-500/50 bg-blue-500/10 text-blue-500 shadow-blue-500/20',
    badgeBg: 'bg-blue-500 text-white shadow-lg shadow-blue-500/30',
    textColor: 'text-blue-500 dark:text-blue-400',
    defaultRemarks: 'Consistent performance with good attendance and homework submission.',
    icon: ThumbsUp
  },
  Average: {
    color: 'border-amber-500/50 bg-amber-500/10 text-amber-500 shadow-amber-500/20',
    badgeBg: 'bg-amber-500 text-white shadow-lg shadow-amber-500/20',
    textColor: 'text-amber-500 dark:text-amber-400',
    defaultRemarks: 'Meets basic criteria. Needs extra focus on quiz revisions and active participation.',
    icon: TrendingUp
  },
  Poor: {
    color: 'border-rose-500/50 bg-rose-500/10 text-rose-500 shadow-rose-500/20',
    badgeBg: 'bg-rose-500 text-white shadow-lg shadow-rose-500/30',
    textColor: 'text-rose-500 dark:text-rose-400',
    defaultRemarks: 'Requires immediate academic attention and parent-teacher alignment.',
    icon: AlertCircle
  }
};

export default function ReportsDashboard() {
  // userEmail is set only after the authenticated Firebase identity is verified against users/{email}.
  const [userEmail, setUserEmail] = useState<string>('');
  const authGenerationRef = useRef(0);

  const [isDarkMode, setIsDarkMode] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [rawClassDocs, setRawClassDocs] = useState<Array<{ id: string; data: Record<string, any> }>>([]);
  const [loading, setLoading] = useState(true);

  const monthsInfo = useMemo(() => getTwoMonthsInfo(), []);
  const [selectedMonth, setSelectedMonth] = useState<string>(monthsInfo.currentKey);
  const [availableMonths, setAvailableMonths] = useState<{ key: string; label: string }[]>([
    { key: monthsInfo.currentKey, label: `Current: ${monthsInfo.currentLabel}` }
  ]);

  const [realtimeMetricState, setRealtimeMetricState] = useState<{ scope: string; metrics: Record<string, StudentReportMetrics> } | null>(null);
  const [reportState, setReportState] = useState<{ scope: string; byStudent: Record<string, Record<string, any>> } | null>(null);
  const [feeRecordState, setFeeRecordState] = useState<{ scope: string; records: Record<string, any> } | null>(null);
  
  const [activeNav, setActiveNav] = useState<NavTab>('classes');
  const [activeClassId, setActiveClassId] = useState<string | null>(null);
  const [activeCategoryTab, setActiveCategoryTab] = useState<CategoryType>('Excellent');
  const [selectedStudentIds, setSelectedStudentIds] = useState<(string | number)[]>([]);

  const [currentPage, setCurrentPage] = useState<number>(1);
  const pageSize = 5;

  const [showReportPreviewModal, setShowReportPreviewModal] = useState<boolean>(false);
  const [singleStudentModal, setSingleStudentModal] = useState<Student | null>(null);

  const [isSettingsConfigured, setIsSettingsConfigured] = useState<boolean>(true);
  const [showAlertModal, setShowAlertModal] = useState<boolean>(false);
  const [notification, setNotification] = useState<{ show: boolean; title: string; message: string }>({ show: false, title: '', message: '' });

  const [dynamicCriteria, setDynamicCriteria] = useState<Record<CategoryType, GradingCriteria>>(CATEGORY_GRADES_MAP);

  const [categoryPresets, setCategoryPresets] = useState<Record<CategoryType, string>>({
    Excellent: CATEGORY_CONFIG.Excellent.defaultRemarks,
    Good: CATEGORY_CONFIG.Good.defaultRemarks,
    Average: CATEGORY_CONFIG.Average.defaultRemarks,
    Poor: CATEGORY_CONFIG.Poor.defaultRemarks,
  });

  const currentReportScope = userEmail && activeClassId
    ? `${userEmail}|${activeClassId}|${selectedMonth}`
    : '';
  const metricScope = currentReportScope;
  const activeReports = reportState?.scope === currentReportScope ? reportState.byStudent : {};
  const currentFeeRecords = feeRecordState?.scope === currentReportScope ? feeRecordState.records : {};
  const realtimeMetrics = realtimeMetricState?.scope === metricScope ? realtimeMetricState.metrics : {};
  const activeClassIsOwned = Boolean(userEmail && activeClassId && rawClassDocs.some((item) => item.id === activeClassId));
  const activeRosterIds = useMemo(() => {
    const activeDoc = rawClassDocs.find((item) => item.id === activeClassId);
    return activeDoc ? normalizeReportRoster(activeDoc.data.students, activeDoc.data).map((student) => student.id) : [];
  }, [rawClassDocs, activeClassId]);

  const classList: ClassItem[] = useMemo(() => rawClassDocs.map(({ id: classId, data }) => {
    const roster = normalizeReportRoster(data.students, data);
    const students: Student[] = roster.map(({ id: stId, data: st }, index) => {
      const metrics = classId === activeClassId ? realtimeMetrics[stId] : undefined;
      const monthlyReport = classId === activeClassId ? activeReports[stId] : undefined;
      const hasMonthlyCategory = Boolean(monthlyReport && Object.prototype.hasOwnProperty.call(monthlyReport, 'category'));
      const rawCategory = hasMonthlyCategory
        ? monthlyReport.category
        : (selectedMonth === monthsInfo.currentKey ? st.category : null);
      const category: CategoryType | null =
        rawCategory === 'Excellent' || rawCategory === 'Good' || rawCategory === 'Average' || rawCategory === 'Poor'
          ? rawCategory
          : null;
      const grades = category ? (dynamicCriteria[category] || CATEGORY_GRADES_MAP[category]) : CATEGORY_GRADES_MAP.Good;
      const feeRecord = classId === activeClassId ? currentFeeRecords[stId] : undefined;

      return {
        id: stId,
        name: typeof st.name === 'string' && st.name.trim() ? st.name : 'Unknown Student',
        rollNo: st.rollNo === undefined || st.rollNo === null ? String(index + 1) : String(st.rollNo),
        avatar: st.avatar || `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(String(st.name || index + 1))}`,
        attendanceRate: metrics?.attendancePct || '—',
        quizScore: metrics?.quizDisplay || '—',
        category,
        phone: typeof st.phone === 'string' ? st.phone : '',
        fatherPhone: typeof st.fatherPhone === 'string' ? st.fatherPhone : (typeof st.phone === 'string' ? st.phone : ''),
        feeStatus: getFeeStatusForStudent(feeRecord, st.feeStatus, selectedMonth === monthsInfo.currentKey),
        homeworkGrade: grades.homework,
        behaviorGrade: grades.behavior,
        participationGrade: grades.participation,
        performanceGrade: grades.performance,
        remarks: typeof monthlyReport?.remarks === 'string' ? monthlyReport.remarks : (typeof st.remarks === 'string' ? st.remarks : undefined),
        lastWhatsAppSentMonth: typeof monthlyReport?.lastWhatsAppSentMonth === 'string'
          ? monthlyReport.lastWhatsAppSentMonth
          : (typeof st.lastWhatsAppSentMonth === 'string' ? st.lastWhatsAppSentMonth : ''),
      };
    });

    students.sort((a, b) => {
      const numA = parseInt(a.rollNo.replace(/\D/g, ''), 10) || 0;
      const numB = parseInt(b.rollNo.replace(/\D/g, ''), 10) || 0;
      return numA - numB;
    });

    return {
      id: classId,
      name: data.className || data.name || 'Unnamed Class',
      code: data.subject || data.code || 'NO-CODE',
      students,
    };
  }), [rawClassDocs, activeClassId, realtimeMetrics, activeReports, currentFeeRecords, dynamicCriteria, selectedMonth, monthsInfo.currentKey]);

  // AUTHENTICATION + TENANT PROFILE VERIFICATION (fail closed; no email/UID fallback).
  useEffect(() => {
    let disposed = false;
    let unsubscribeProfile: (() => void) | null = null;

    const unsubscribeAuth = onAuthStateChanged(
      auth,
      (user) => {
        const generation = ++authGenerationRef.current;
        unsubscribeProfile?.();
        unsubscribeProfile = null;

        // Clear all previous-session data immediately so teacher A's records cannot flash for teacher B.
        setUserEmail('');
        setRawClassDocs([]);
        setRealtimeMetricState(null);
        setReportState(null);
        setFeeRecordState(null);
        setAvailableMonths([{ key: monthsInfo.currentKey, label: `Current: ${monthsInfo.currentLabel}` }]);
        setActiveClassId(null);
        setSelectedStudentIds([]);
        setDynamicCriteria(CATEGORY_GRADES_MAP);
        setCategoryPresets({
          Excellent: CATEGORY_CONFIG.Excellent.defaultRemarks,
          Good: CATEGORY_CONFIG.Good.defaultRemarks,
          Average: CATEGORY_CONFIG.Average.defaultRemarks,
          Poor: CATEGORY_CONFIG.Poor.defaultRemarks,
        });
        setIsSettingsConfigured(false);
        setLoading(Boolean(user));

        if (!user?.uid || !user.email) {
          setLoading(false);
          return;
        }

        const tenantEmail = normalizeTenantEmail(user.email);
        if (!tenantEmail) {
          console.error('[Reports] Refusing tenant access because the authenticated email is invalid.');
          setLoading(false);
          return;
        }

        unsubscribeProfile = onSnapshot(
          doc(db, 'users', tenantEmail),
          (profileSnapshot) => {
            if (disposed || generation !== authGenerationRef.current) return;
            const profile = profileSnapshot.exists() ? profileSnapshot.data() : null;
            if (!isAuthorizedTeacherProfile(profile, { uid: user.uid, email: tenantEmail })) {
              console.error('[Reports] Tenant profile verification failed; no tenant data will be loaded.');
              setUserEmail('');
              setRawClassDocs([]);
              setRealtimeMetricState(null);
              setReportState(null);
              setFeeRecordState(null);
              setLoading(false);
              return;
            }
            setUserEmail(tenantEmail);
          },
          (error) => {
            if (disposed || generation !== authGenerationRef.current) return;
            console.error('[Reports] Tenant profile listener failed:', error);
            setUserEmail('');
            setRawClassDocs([]);
            setRealtimeMetricState(null);
            setReportState(null);
            setFeeRecordState(null);
            setLoading(false);
          }
        );
      },
      (error) => {
        if (disposed) return;
        console.error('[Reports] Authentication state listener failed:', error);
        ++authGenerationRef.current;
        setUserEmail('');
        setRawClassDocs([]);
        setRealtimeMetricState(null);
        setReportState(null);
        setFeeRecordState(null);
        setLoading(false);
      }
    );

    return () => {
      disposed = true;
      ++authGenerationRef.current;
      unsubscribeProfile?.();
      unsubscribeAuth();
    };
  }, [monthsInfo]);

  useEffect(() => {
    if (isDarkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDarkMode]);

  const showToast = (title: string, message: string) => {
    setNotification({ show: true, title, message });
    setTimeout(() => setNotification({ show: false, title: '', message: '' }), 4000);
  };

  const getCardClass = () => {
    return isDarkMode 
      ? 'bg-[#0e131f] border-slate-800 text-slate-100 shadow-xl' 
      : 'bg-white border-slate-200 text-slate-900 shadow-sm';
  };

  const getInnerCardClass = () => {
    return isDarkMode 
      ? 'bg-[#171e2e] border-slate-700/60 text-slate-200' 
      : 'bg-slate-50 border-slate-200/60 text-slate-800';
  };

  // AUTOMATIC CLEANUP: on/after day 5, purge only the previous month's automatic report configs.
  // The deterministic notification ID prevents duplicate reset notifications when listeners refresh.
  useEffect(() => {
    if (!activeClassId || !userEmail || !activeClassIsOwned || new Date().getDate() < 5) return;

    let cancelled = false;
    const autoCleanOldReports = async () => {
      try {
        const reportsRef = collection(db, 'users', userEmail, 'classes', activeClassId, 'reports');
        const previousMonthQuery = query(reportsRef, where('monthKey', '==', monthsInfo.previousKey));
        const snapshot = await getDocs(previousMonthQuery);
        if (cancelled) return;

        for (const reportSnap of snapshot.docs) {
          if (cancelled) return;
          const data = reportSnap.data();
          if (data.monthKey === monthsInfo.previousKey && data.mode === 'automatic') {
            await deleteDoc(doc(db, 'users', userEmail, 'classes', activeClassId, 'reports', reportSnap.id));
          }
        }

        if (cancelled) return;
        const notificationRef = doc(
          db,
          'users',
          userEmail,
          'notifications',
          `reports_reset_${activeClassId}_${monthsInfo.currentKey}`
        );
        await setDoc(notificationRef, {
          title: 'Reports Reset Notification',
          message: `On Date 5, previous month Automatic reports configurations have been cleared for class ${activeClassId}. Re-generate reports required.`,
          type: 'reports_reset',
          createdAt: serverTimestamp(),
          read: false,
        }, { merge: true });
      } catch (err) {
        if (!cancelled) console.error('[Reports] Automatic report cleanup failed:', err);
      }
    };

    void autoCleanOldReports();
    return () => { cancelled = true; };
  }, [activeClassId, userEmail, activeClassIsOwned, monthsInfo]);

  // LISTEN TO TENANT-SCOPED GRADING RULES.
  useEffect(() => {
    if (!userEmail) return;

    const rulesDocRef = doc(db, 'users', userEmail, 'settings', 'grading_rules');
    const unsubscribe = onSnapshot(rulesDocRef, (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        const remarksMap = data.remarksMap || {};
        const rulesMap = data.rulesMap || data.criteriaMap || {};
        const requiredCats: CategoryType[] = ['Excellent', 'Good', 'Average', 'Poor'];
        const missing: string[] = [];

        requiredCats.forEach((cat) => {
          if (!remarksMap[cat] || (typeof remarksMap[cat] === 'string' && !remarksMap[cat].trim())) {
            missing.push(cat);
          }
        });

        if (missing.length > 0) {
          setIsSettingsConfigured(false);
        } else {
          setIsSettingsConfigured(true);
          setCategoryPresets({
            Excellent: typeof remarksMap.Excellent === 'string' ? remarksMap.Excellent : CATEGORY_CONFIG.Excellent.defaultRemarks,
            Good: typeof remarksMap.Good === 'string' ? remarksMap.Good : CATEGORY_CONFIG.Good.defaultRemarks,
            Average: typeof remarksMap.Average === 'string' ? remarksMap.Average : CATEGORY_CONFIG.Average.defaultRemarks,
            Poor: typeof remarksMap.Poor === 'string' ? remarksMap.Poor : CATEGORY_CONFIG.Poor.defaultRemarks,
          });

          if (rulesMap && typeof rulesMap === 'object') {
            const updatedCriteria = { ...CATEGORY_GRADES_MAP };
            requiredCats.forEach((cat) => {
              if (rulesMap[cat]) {
                updatedCriteria[cat] = {
                  homework: rulesMap[cat].homework || CATEGORY_GRADES_MAP[cat].homework,
                  behavior: rulesMap[cat].behavior || CATEGORY_GRADES_MAP[cat].behavior,
                  participation: rulesMap[cat].participation || CATEGORY_GRADES_MAP[cat].participation,
                  performance: rulesMap[cat].performance || CATEGORY_GRADES_MAP[cat].performance,
                };
              }
            });
            setDynamicCriteria(updatedCriteria);
          }
        }
      } else {
        setIsSettingsConfigured(false);
      }
    }, (error) => {
      console.error('[Reports] Grading rules listener failed:', error);
      setIsSettingsConfigured(false);
    });

    return () => unsubscribe();
  }, [userEmail]);

  // CLASSES: canonical roster is the `students` field on each class document (array or legacy map).
  useEffect(() => {
    if (!userEmail) {
      setRawClassDocs([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    const classesRef = collection(db, 'users', userEmail, 'classes');
    const unsubscribe = onSnapshot(classesRef, (snapshot) => {
      if (cancelled) return;
      setRawClassDocs(snapshot.docs.map((classSnap) => ({ id: classSnap.id, data: classSnap.data() })));
      setLoading(false);
    }, (error) => {
      if (cancelled) return;
      console.error('[Reports] Tenant classes listener failed:', error);
      setRawClassDocs([]);
      setLoading(false);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [userEmail]);

  // REPORT ASSIGNMENTS + MONTH MENU: reads stay under the authenticated tenant and selected class.
  useEffect(() => {
    if (!userEmail || !activeClassId || !activeClassIsOwned) {
      setReportState(null);
      return;
    }

    let cancelled = false;
    const scope = `${userEmail}|${activeClassId}|${selectedMonth}`;
    setReportState(null);
    const reportsRef = collection(db, 'users', userEmail, 'classes', activeClassId, 'reports');
    const unsubscribe = onSnapshot(reportsRef, (snapshot) => {
      if (cancelled) return;
      const byStudent: Record<string, Record<string, any>> = {};
      const monthKeys = new Set<string>([monthsInfo.currentKey, selectedMonth]);

      snapshot.docs.forEach((reportSnap) => {
        const data = reportSnap.data();
        const monthKey = normalizeReportMonth(data.monthKey);
        if (monthKey) monthKeys.add(monthKey);
        if (monthKey === selectedMonth && data.studentId !== undefined && data.studentId !== null) {
          byStudent[String(data.studentId)] = data;
        }
      });

      const keys = Array.from(monthKeys).sort((a, b) => b.localeCompare(a));
      setAvailableMonths(keys.map((key) => ({ key, label: formatMonthLabel(key) })));
      setReportState({ scope, byStudent });
    }, (error) => {
      if (cancelled) return;
      console.error('[Reports] Monthly report listener failed:', error);
      setAvailableMonths([
        { key: monthsInfo.currentKey, label: `Current: ${monthsInfo.currentLabel}` },
        ...(selectedMonth !== monthsInfo.currentKey ? [{ key: selectedMonth, label: formatMonthLabel(selectedMonth) }] : []),
      ]);
      setReportState({ scope, byStudent: {} });
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [userEmail, activeClassId, activeClassIsOwned, selectedMonth, monthsInfo]);

  // MONTHLY FEES: read only users/{teacher}/fees/{classId}_{YYYY-MM}; fee status is not guessed.
  useEffect(() => {
    if (!userEmail || !activeClassId || !activeClassIsOwned) {
      setFeeRecordState(null);
      return;
    }

    let cancelled = false;
    const scope = `${userEmail}|${activeClassId}|${selectedMonth}`;
    setFeeRecordState({ scope, records: {} });
    const feeRef = doc(db, 'users', userEmail, 'fees', `${activeClassId}_${selectedMonth}`);
    const unsubscribe = onSnapshot(feeRef, (snapshot) => {
      if (cancelled) return;
      const feeData = snapshot.exists() ? snapshot.data() : null;
      const records = getMonthlyFeeRecords(feeData, activeClassId, selectedMonth);
      setFeeRecordState({ scope, records });
    }, (error) => {
      if (cancelled) return;
      console.error('[Reports] Monthly fee record listener failed:', error);
      setFeeRecordState({ scope, records: {} });
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [userEmail, activeClassId, activeClassIsOwned, selectedMonth]);

  // ATTENDANCE + QUIZZES: class-roster-only metrics for the exact selected calendar month.
  useEffect(() => {
    if (!userEmail || !activeClassId || !activeClassIsOwned || !selectedMonth) {
      setRealtimeMetricState(null);
      return;
    }

    const range = getReportMonthDateRange(selectedMonth);
    if (!range) {
      setRealtimeMetricState(null);
      return;
    }

    const scope = `${userEmail}|${activeClassId}|${selectedMonth}`;
    setRealtimeMetricState({ scope, metrics: {} });
    if (activeRosterIds.length === 0) return;

    let cancelled = false;
    let attendanceLoaded = false;
    let attendanceRows: ReportDocument[] = [];
    let quizFallbackStarted = false;
    let quizFallbackLoaded = false;
    let quizFallbackRows: ReportDocument[] = [];
    const quizRowsByQuery: Array<ReportDocument[] | null> = [null, null, null];
    const quizUnsubscribers: Array<() => void> = [];
    let unsubscribeQuizFallback: (() => void) | null = null;

    const getQuizRows = (): ReportDocument[] => {
      if (quizFallbackStarted) return quizFallbackRows;
      const byId = new Map<string, ReportDocument>();
      quizRowsByQuery.forEach((rows) => {
        (rows || []).forEach((row) => byId.set(row.id, row));
      });
      return Array.from(byId.values());
    };

    const publishMetrics = () => {
      if (cancelled || !attendanceLoaded) return;
      if (quizFallbackStarted ? !quizFallbackLoaded : quizRowsByQuery.some((rows) => rows === null)) return;
      const quizRows = getQuizRows();
      const metrics = calculateMonthlyStudentMetrics(
        activeRosterIds,
        attendanceRows,
        quizRows,
        activeClassId,
        selectedMonth
      );
      setRealtimeMetricState({ scope, metrics });
    };

    const attendanceRef = collection(db, 'users', userEmail, 'attendance');
    // The documented schema IDs are `{classId}_{YYYY-MM-DD}`. Query by the bounded
    // document-ID interval so legacy records without `classId`/`date` fields are not missed,
    // while still reading only the selected tenant, class and month.
    const monthlyAttendanceQuery = query(
      attendanceRef,
      where(documentId(), '>=', `${activeClassId}_${range.startDate}`),
      where(documentId(), '<', `${activeClassId}_${range.nextMonthStartDate}`)
    );
    const unsubscribeAttendance = onSnapshot(monthlyAttendanceQuery, (snapshot) => {
      if (cancelled) return;
      attendanceRows = snapshot.docs.map((item) => ({ id: item.id, data: item.data() }));
      attendanceLoaded = true;
      publishMetrics();
    }, (error) => {
      if (cancelled) return;
      console.error('[Reports] Monthly attendance listener failed:', error);
      attendanceRows = [];
      attendanceLoaded = true;
      publishMetrics();
    });

    const quizRef = collection(db, 'users', userEmail, 'classes', activeClassId, 'quizzes');
    const monthLabel = range.start.toLocaleString('en-US', { month: 'long', year: 'numeric' });
    const quizQueries = [
      query(quizRef, where('monthKey', 'in', [selectedMonth, monthLabel])),
      query(quizRef, where('date', '>=', range.startDate), where('date', '<=', range.endDate)),
      query(quizRef, where('createdAt', '>=', Timestamp.fromDate(range.start)), where('createdAt', '<', Timestamp.fromDate(range.nextMonthStart))),
    ];

    const startQuizFallback = () => {
      if (cancelled || quizFallbackStarted) return;
      quizFallbackStarted = true;
      quizUnsubscribers.forEach((unsubscribe) => unsubscribe());
      quizFallbackRows = [];
      unsubscribeQuizFallback = onSnapshot(quizRef, (snapshot) => {
        if (cancelled) return;
        quizFallbackRows = snapshot.docs.map((item) => ({ id: item.id, data: item.data() }));
        quizFallbackLoaded = true;
        publishMetrics();
      }, (error) => {
        if (cancelled) return;
        console.error('[Reports] Class quiz listener failed:', error);
        quizFallbackRows = [];
        quizFallbackLoaded = true;
        publishMetrics();
      });
    };

    quizQueries.forEach((quizQuery, queryIndex) => {
      const unsubscribe = onSnapshot(quizQuery, (snapshot) => {
        if (cancelled || quizFallbackStarted) return;
        quizRowsByQuery[queryIndex] = snapshot.docs.map((item) => ({ id: item.id, data: item.data() }));
        publishMetrics();
      }, (error) => {
        if (cancelled) return;
        console.warn('[Reports] Monthly quiz query failed; switching to the selected class fallback query:', error);
        startQuizFallback();
      });
      quizUnsubscribers.push(unsubscribe);
    });

    return () => {
      cancelled = true;
      unsubscribeAttendance();
      quizUnsubscribers.forEach((unsubscribe) => unsubscribe());
      unsubscribeQuizFallback?.();
    };
  }, [userEmail, activeClassId, activeClassIsOwned, activeRosterIds, selectedMonth]);

  const filteredClasses = useMemo(() => {
    return classList.filter(c => 
      c.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
      c.code.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [classList, searchQuery]);

  const currentClass = useMemo(() => {
    return classList.find((c) => c.id === activeClassId) || null;
  }, [classList, activeClassId]);

  const unassignedStudents = useMemo(() => {
    if (!currentClass) return [];
    return currentClass.students.filter((s) => !s.category);
  }, [currentClass]);

  const totalPages = Math.ceil(unassignedStudents.length / pageSize) || 1;
  const paginatedUnassignedStudents = useMemo(() => {
    const startIdx = (currentPage - 1) * pageSize;
    return unassignedStudents.slice(startIdx, startIdx + pageSize);
  }, [unassignedStudents, currentPage]);

  useEffect(() => {
    setCurrentPage(1);
  }, [activeCategoryTab, activeClassId, selectedMonth]);

  const toggleStudentSelection = (studentId: string | number) => {
    setSelectedStudentIds((prev) =>
      prev.some((id) => String(id) === String(studentId))
        ? prev.filter((id) => String(id) !== String(studentId))
        : [...prev, studentId]
    );
  };

  const handleSendWhatsAppAutomated = async (student: Student) => {
    if (student.lastWhatsAppSentMonth === selectedMonth) {
      showToast("Restriction Alert", `Report for ${student.name} was already forwarded via WhatsApp this month (${selectedMonth}). Restricted to 1 time/month.`);
      return;
    }

    if (!userEmail) return;
    const fatherNumber = (student.fatherPhone || student.phone || '').replace(/[^0-9]/g, '');

    if (!fatherNumber) {
      showToast("Phone Missing", `Father number not found in database for ${student.name}.`);
      return;
    }

    if (!activeClassId || !activeClassIsOwned || !currentClass?.students.some((item) => String(item.id) === String(student.id))) {
      showToast('Report Unavailable', 'The selected student is not part of the authorized class.');
      return;
    }

    const cat = student.category || 'Good';
    const msg = `Dear Parent,\nHere is the Weekly Report for *${student.name}* (Roll No: ${student.rollNo}):\n*Category:* ${cat}\n*Remarks:* ${student.remarks || categoryPresets[cat]}\n*Quiz:* ${student.quizScore}\n*Attendance:* ${student.attendanceRate}\n\nGenerated automatically via Tuition Management System.`;
    const url = `https://wa.me/${fatherNumber}?text=${encodeURIComponent(msg)}`;

    try {
      {
        const reportDocId = `${student.id}_${selectedMonth}`;
        const autoRef = doc(db, 'users', userEmail, 'classes', activeClassId, 'reports', reportDocId);
        await setDoc(autoRef, {
          studentId: String(student.id),
          studentName: student.name,
          rollNo: student.rollNo,
          monthKey: selectedMonth,
          mode: 'automatic',
          lastWhatsAppSentMonth: selectedMonth,
          updatedAt: serverTimestamp(),
        }, { merge: true });
        setReportState((previous) => {
          const scope = `${userEmail}|${activeClassId}|${selectedMonth}`;
          const byStudent = previous?.scope === scope ? { ...previous.byStudent } : {};
          byStudent[String(student.id)] = { ...(byStudent[String(student.id)] || {}), studentId: String(student.id), studentName: student.name, rollNo: student.rollNo, monthKey: selectedMonth, mode: 'automatic', lastWhatsAppSentMonth: selectedMonth };
          return { scope, byStudent };
        });

        const notifRef = collection(db, 'users', userEmail, 'notifications');
        await addDoc(notifRef, {
          title: "WhatsApp Report Forwarded",
          message: `Report for ${student.name} sent to father number (${fatherNumber}) for ${selectedMonth}.`,
          type: "whatsapp_sent",
          createdAt: serverTimestamp(),
          read: false
        });
      }

      window.open(url, '_blank');
      showToast("WhatsApp Sent", `Report automatically prepared and opened for ${student.name}.`);
    } catch (e) {
      console.error("WhatsApp update error:", e);
    }
  };

  const handleSaveCategoryAssignment = async () => {
    if (!isSettingsConfigured) {
      setShowAlertModal(true);
      return;
    }

    if (!activeClassId || !currentClass || selectedStudentIds.length === 0 || !userEmail) return;

    if (!activeClassIsOwned || !classList.some((cls) => cls.id === activeClassId)) return;

    const selectedIdsCopy = selectedStudentIds.filter((studentId) =>
      currentClass.students.some((student) => String(student.id) === String(studentId))
    );
    if (selectedIdsCopy.length === 0) {
      setSelectedStudentIds([]);
      return;
    }
    const scope = `${userEmail}|${activeClassId}|${selectedMonth}`;
    setReportState((previous) => {
      const byStudent = previous?.scope === scope ? { ...previous.byStudent } : {};
      selectedIdsCopy.forEach((studentId) => {
        const student = currentClass.students.find((item) => String(item.id) === String(studentId));
        if (!student) return;
        byStudent[String(student.id)] = {
          ...(byStudent[String(student.id)] || {}),
          studentId: String(student.id),
          studentName: student.name,
          rollNo: student.rollNo,
          category: activeCategoryTab,
          monthKey: selectedMonth,
          remarks: categoryPresets[activeCategoryTab] || CATEGORY_CONFIG[activeCategoryTab].defaultRemarks,
          mode: 'automatic',
        };
      });
      return { scope, byStudent };
    });

    setSelectedStudentIds([]);

    try {
      for (const studentId of selectedIdsCopy) {
        const stObj = currentClass.students.find((s) => String(s.id) === String(studentId));
        if (stObj) {
          const reportDocId = `${studentId}_${selectedMonth}`;
          const reportDocRef = doc(db, 'users', userEmail, 'classes', activeClassId, 'reports', reportDocId);
          await setDoc(
            reportDocRef,
            {
              studentId: String(stObj.id),
              studentName: stObj.name,
              rollNo: stObj.rollNo,
              category: activeCategoryTab,
              monthKey: selectedMonth,
              remarks: categoryPresets[activeCategoryTab] || CATEGORY_CONFIG[activeCategoryTab].defaultRemarks,
              updatedAt: serverTimestamp(),
              mode: 'automatic',
            },
            { merge: true }
          );

          const notifRef = collection(db, 'users', userEmail, 'notifications');
          await addDoc(notifRef, {
            title: "Automatic Report Generated",
            message: `Automatic Report generated for ${stObj.name} (Roll: ${stObj.rollNo}) in category ${activeCategoryTab}.`,
            type: "report_generated",
            createdAt: serverTimestamp(),
            read: false
          });
        }
      }
      showToast("Report Saved!", `Successfully assigned ${selectedIdsCopy.length} student(s) to ${activeCategoryTab}.`);
    } catch (err) {
      console.error("Failed to update Firestore category assignment:", err);
    }
  };

  const handleRemoveFromCategory = async (studentId: string | number) => {
    if (!activeClassId || !currentClass || !userEmail) return;

    if (!activeClassIsOwned || !currentClass.students.some((item) => String(item.id) === String(studentId))) return;
    const student = currentClass.students.find((item) => String(item.id) === String(studentId));
    if (!student) return;
    const scope = `${userEmail}|${activeClassId}|${selectedMonth}`;
    setReportState((previous) => {
      const byStudent = previous?.scope === scope ? { ...previous.byStudent } : {};
      byStudent[String(studentId)] = {
        ...(byStudent[String(studentId)] || {}),
        studentId: String(studentId),
        studentName: student.name,
        rollNo: student.rollNo,
        monthKey: selectedMonth,
        category: null,
        mode: 'automatic',
      };
      return { scope, byStudent };
    });

    try {
      const reportDocId = `${studentId}_${selectedMonth}`;
      const reportDocRef = doc(db, 'users', userEmail, 'classes', activeClassId, 'reports', reportDocId);
      // Persist an explicit unassigned state. Deleting the record let the legacy class.category
      // reappear on refresh and made a monthly category reset non-deterministic.
      await setDoc(reportDocRef, {
        studentId: String(student.id),
        studentName: student.name,
        rollNo: student.rollNo,
        monthKey: selectedMonth,
        category: null,
        mode: 'automatic',
        updatedAt: serverTimestamp(),
      }, { merge: true });
      showToast("Category Reset", "Student moved back to unassigned list.");
    } catch (err) {
      console.error("Failed to remove student from category:", err);
    }
  };

  const navItems: { id: NavTab; label: string; icon: any }[] = [
    { id: "home", label: "Home", icon: Home },
    { id: "classes", label: "Classes", icon: GraduationCap },
    { id: "attendance", label: "Attendance", icon: Users },
    { id: "fees", label: "Fees", icon: Wallet },
    { id: "settings", label: "Settings", icon: Settings },
  ];

  const RenderReportCard = ({ student }: { student: Student }) => {
    const cat = student.category || 'Average';
    const catConfig = CATEGORY_CONFIG[cat];
    const catCriteria = dynamicCriteria[cat] || CATEGORY_GRADES_MAP[cat];

    const metrics = realtimeMetrics[String(student.id)] || {
      presentDays: 0,
      totalDays: 0,
      attendancePct: '—',
      quizDisplay: '—',
    };

    return (
      <div className="max-w-md mx-auto bg-white text-slate-900 rounded-3xl p-6 border border-slate-200 shadow-xl space-y-4 font-sans print:shadow-none print:border-slate-300 print:rounded-none">
        <div className="flex items-center justify-center gap-3 relative border-b pb-3 border-slate-100">
          <div className="h-8 w-8 rounded-full bg-orange-500 text-white font-black text-xs flex items-center justify-center absolute left-0 shadow-md shadow-orange-500/30">
            10
          </div>
          <div className="text-center">
            <h2 className="text-base font-black text-slate-800 tracking-tight">Student Weekly Report</h2>
            <p className="text-[10px] text-orange-600 font-extrabold uppercase">{formatMonthLabel(selectedMonth)}</p>
          </div>
        </div>

        <div className="grid grid-cols-4 gap-2 text-center text-[10px] font-bold bg-slate-50 p-2.5 rounded-2xl border border-slate-100">
          <div>
            <span className="text-slate-400 block font-normal text-[9px]">Student Name</span>
            <span className="text-slate-900 font-extrabold truncate block">{student.name}</span>
          </div>
          <div>
            <span className="text-slate-400 block font-normal text-[9px]">Class</span>
            <span className="text-slate-900 font-extrabold truncate block">{currentClass?.name || 'Class'}</span>
          </div>
          <div>
            <span className="text-slate-400 block font-normal text-[9px]">Roll No.</span>
            <span className="text-slate-900 font-extrabold block">{student.rollNo}</span>
          </div>
          <div>
            <span className="text-slate-400 block font-normal text-[9px]">Live Quiz Marks</span>
            <span className="text-orange-600 font-black block">{metrics.quizDisplay}</span>
          </div>
        </div>

        <div className="space-y-1.5">
          <h4 className="text-[11px] font-black text-slate-800">Attendance Summary</h4>
          <div className="grid grid-cols-2 gap-3">
            <div className="border border-slate-200 rounded-2xl p-2.5 flex items-center justify-between bg-white shadow-sm">
              <span className="text-[10px] text-slate-500 font-bold">Days Attended</span>
              <span className="text-xs font-black text-slate-900">{metrics.presentDays} / {metrics.totalDays}</span>
            </div>
            <div className="border border-slate-200 rounded-2xl p-2.5 flex items-center justify-between bg-white shadow-sm">
              <span className="text-[10px] text-slate-500 font-bold">Percentage</span>
              <span className="text-xs font-black text-slate-900">{metrics.attendancePct}</span>
            </div>
          </div>
        </div>

        <div className="space-y-1.5">
          <h4 className="text-[11px] font-black text-slate-800">Evaluation Criteria ({cat})</h4>
          <div className="border border-slate-200 rounded-2xl overflow-hidden text-xs">
            <div className="grid grid-cols-2 bg-slate-50 p-2 font-black text-[10px] text-slate-500 border-b border-slate-200">
              <span>Criteria</span>
              <span className="text-center">Grade</span>
            </div>
            <div className="divide-y divide-slate-100 font-bold text-[11px]">
              <div className="grid grid-cols-2 p-2">
                <span className="text-slate-600">Homework</span>
                <span className="text-center font-black text-slate-900">{catCriteria.homework}</span>
              </div>
              <div className="grid grid-cols-2 p-2">
                <span className="text-slate-600">Behavior</span>
                <span className="text-center font-black text-slate-900">{catCriteria.behavior}</span>
              </div>
              <div className="grid grid-cols-2 p-2">
                <span className="text-slate-600">Participation</span>
                <span className="text-center font-black text-slate-900">{catCriteria.participation}</span>
              </div>
              <div className="grid grid-cols-2 p-2">
                <span className="text-slate-600">Performance</span>
                <span className="text-center font-black text-slate-900">{catCriteria.performance}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-1.5">
          <h4 className="text-[11px] font-black text-slate-800">Teacher Remarks</h4>
          <div className="border border-slate-200 rounded-2xl p-3 bg-slate-50/50 text-[11px] text-slate-700 font-medium italic leading-relaxed">
            "{student.remarks || categoryPresets[cat] || catConfig.defaultRemarks}"
          </div>
        </div>

        <div className="pt-2">
          <Button
            onClick={() => handleSendWhatsAppAutomated(student)}
            className="w-full bg-emerald-600 hover:bg-emerald-700 text-white rounded-2xl text-xs font-black py-2.5 flex items-center justify-center gap-2 shadow-lg shadow-emerald-600/20"
          >
            <Send className="h-4 w-4" />
            <span>Send Via WhatsApp</span>
          </Button>
        </div>

        <div className="flex items-center justify-between pt-2 border-t border-slate-100">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-black text-slate-800">Fee Status</span>
            <span className="bg-emerald-100 text-emerald-700 text-[10px] font-black px-3 py-0.5 rounded-full">
              {student.feeStatus || 'Unrecorded'}
            </span>
          </div>

          <div className="text-right">
            <span className="text-[10px] font-black text-slate-800 block">Teacher Signature</span>
            <span className="font-serif italic text-xs font-bold text-slate-700 underline decoration-slate-300">
              Instructor Sign
            </span>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className={`min-h-screen ${isDarkMode ? 'dark bg-[#080c14] text-slate-100' : 'bg-[#faf9f6] text-slate-900'} pb-32 font-sans relative`}>

      {/* TOAST NOTIFICATION */}
      {notification.show && (
        <div className="fixed top-5 right-5 z-[200] bg-orange-500 text-white px-5 py-3.5 rounded-2xl shadow-2xl shadow-orange-500/40 flex items-center gap-3">
          <Sparkles className="h-5 w-5" />
          <div>
            <h5 className="text-xs font-black uppercase tracking-wider">{notification.title}</h5>
            <p className="text-[11px] font-bold text-orange-100">{notification.message}</p>
          </div>
        </div>
      )}

      {/* MISSING SETTINGS WARNING MODAL */}
      {showAlertModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/75 backdrop-blur-md">
          <div className={`max-w-md w-full rounded-3xl p-6 border-2 border-rose-500 shadow-[0_0_40px_rgba(244,63,94,0.35)] relative ${
            isDarkMode ? 'bg-[#0e131f] text-white' : 'bg-white text-slate-900'
          }`}>
            <button
              onClick={() => setShowAlertModal(false)}
              className="absolute top-4 right-4 p-2 rounded-full hover:bg-slate-200 dark:hover:bg-slate-800"
            >
              <X className="h-4 w-4 text-slate-400" />
            </button>

            <div className="flex items-center gap-3 mb-4">
              <div className="h-12 w-12 rounded-2xl bg-rose-500/10 border border-rose-500/30 flex items-center justify-center text-rose-500 flex-shrink-0">
                <ShieldAlert className="h-6 w-6" />
              </div>
              <div>
                <h3 className="text-base font-black text-rose-500 uppercase tracking-tight">System Alert: Rules Missing!</h3>
                <p className="text-[11px] text-slate-400 font-bold">Action Required in Firestore Database</p>
              </div>
            </div>

            <p className="text-xs font-semibold leading-relaxed mb-4 text-slate-600 dark:text-slate-300">
              Ager yeh rules save nahi honge to system reports generate nahi kar sake ga! <strong className="text-orange-500 font-black">First add Grading Rules in Setting Page!</strong>
            </p>

            <div className={`p-3 rounded-2xl border mb-5 font-mono text-[11px] space-y-1 ${getInnerCardClass()}`}>
              <div className="text-[10px] uppercase tracking-wider font-extrabold text-orange-500">
                📁 Database Document Path:
              </div>
              <div className="truncate font-bold text-slate-700 dark:text-slate-200">
                users / {userEmail || 'LOGGED_IN_USER_EMAIL'} / settings / grading_rules
              </div>
            </div>

            <div className="flex items-center justify-end gap-3">
              <button
                onClick={() => setShowAlertModal(false)}
                className="px-4 py-2 rounded-xl text-xs font-black text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
              >
                Cancel
              </button>
              <Button
                onClick={() => window.location.href = '/settings'}
                className="bg-orange-500 hover:bg-orange-600 text-white rounded-xl text-xs font-black px-5 py-2.5 shadow-lg shadow-orange-500/30 flex items-center gap-2"
              >
                <span>Go To Setting Page</span>
                <ExternalLink className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* SINGLE STUDENT PERFORMANCE REPORT MODAL */}
      {singleStudentModal && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
          <div className={`max-w-2xl w-full max-h-[90vh] overflow-y-auto rounded-3xl p-6 border-2 border-orange-500 shadow-[0_0_50px_rgba(249,115,22,0.3)] relative ${
            isDarkMode ? 'bg-[#0e131f] text-white' : 'bg-white text-slate-900'
          }`}>
            <div className="flex items-center justify-between pb-4 border-b border-slate-200 dark:border-slate-800 mb-4">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-2xl bg-orange-500/10 text-orange-500 flex items-center justify-center font-black">
                  <UserCheck className="h-6 w-6" />
                </div>
                <div>
                  <h3 className="text-base font-black">Student Performance Report</h3>
                  <p className="text-[11px] text-slate-400 font-bold">{singleStudentModal.name} • Roll No: {singleStudentModal.rollNo}</p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  onClick={() => window.print()}
                  className="bg-orange-500 hover:bg-orange-600 text-white rounded-xl text-xs font-black px-4 py-2 shadow-lg shadow-orange-500/20 flex items-center gap-1.5"
                >
                  <Printer className="h-4 w-4" />
                  <span>Print Card</span>
                </Button>
                <button
                  onClick={() => setSingleStudentModal(null)}
                  className="p-2 rounded-xl border border-slate-700 hover:bg-slate-800"
                >
                  <X className="h-5 w-5 text-slate-400" />
                </button>
              </div>
            </div>

            <RenderReportCard student={singleStudentModal} />
          </div>
        </div>
      )}

      {/* ALL REPORTS PREVIEW MODAL */}
      {showReportPreviewModal && currentClass && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
          <div className={`max-w-4xl w-full max-h-[90vh] overflow-y-auto rounded-3xl p-6 border-2 border-orange-500 shadow-[0_0_50px_rgba(249,115,22,0.3)] relative ${
            isDarkMode ? 'bg-[#0e131f] text-white' : 'bg-white text-slate-900'
          }`}>
            <div className="flex items-center justify-between pb-4 border-b border-slate-200 dark:border-slate-800">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-2xl bg-orange-500/10 text-orange-500 flex items-center justify-center font-black">
                  <FileCheck className="h-6 w-6" />
                </div>
                <div>
                  <h3 className="text-base font-black">All Class Reports</h3>
                  <p className="text-[11px] text-slate-400 font-bold">{currentClass.name} • Total: {currentClass.students.length} Students</p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  onClick={() => window.print()}
                  className="bg-orange-500 hover:bg-orange-600 text-white rounded-xl text-xs font-black px-4 py-2 shadow-lg shadow-orange-500/20 flex items-center gap-1.5"
                >
                  <Printer className="h-4 w-4" />
                  <span>Print All</span>
                </Button>
                <button
                  onClick={() => setShowReportPreviewModal(false)}
                  className="p-2 rounded-xl border border-slate-700 hover:bg-slate-800"
                >
                  <X className="h-5 w-5 text-slate-400" />
                </button>
              </div>
            </div>

            <div className="py-6 space-y-8">
              {currentClass.students.map((s) => (
                <RenderReportCard key={s.id} student={s} />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* TOP HEADER */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 pt-6">
        <div className={`w-full px-5 py-4 rounded-3xl border-2 border-orange-500/80 shadow-[0_0_20px_rgba(249,115,22,0.25)] flex flex-wrap items-center justify-between gap-4 ${
          isDarkMode ? 'bg-[#0e131f] text-white' : 'bg-white text-slate-900'
        }`}>
          <div className="flex items-center gap-3.5">
            <button 
              onClick={() => setActiveClassId(null)}
              className="flex items-center justify-center h-10 w-10 rounded-2xl bg-orange-500 text-white shadow-md shadow-orange-500/30"
            >
              <ArrowLeft className="h-5 w-5 stroke-[2.5]" />
            </button>

            <div>
              <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full border border-orange-500/40 bg-orange-500/10 text-orange-500 dark:text-orange-400 text-[10px] font-extrabold uppercase mb-1">
                <span className="h-1.5 w-1.5 rounded-full bg-orange-500"></span>
                LIVE FIRESTORE ENGINE
              </div>
              <h1 className="text-base sm:text-lg font-black tracking-wide uppercase">
                ACADEMIC REPORTS DASHBOARD
              </h1>
            </div>
          </div>

          <div className="flex items-center gap-2 bg-orange-500/10 border border-orange-500/40 rounded-2xl px-3 py-1.5">
            <Calendar className="h-4 w-4 text-orange-500" />
            <select
              value={selectedMonth}
              onChange={(e) => setSelectedMonth(e.target.value)}
              className="bg-transparent text-xs font-black outline-none cursor-pointer text-slate-800 dark:text-slate-100"
            >
              {availableMonths.map((m) => (
                <option key={m.key} value={m.key} className="bg-white dark:bg-[#0e131f] text-slate-900 dark:text-white">
                  {m.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* MAIN CONTENT AREA */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">

        {!isSettingsConfigured && (
          <div className="w-full bg-rose-500/10 border-2 border-rose-500/80 rounded-2xl p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 shadow-lg shadow-rose-500/10">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-xl bg-rose-500 text-white font-black">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div>
                <h4 className="text-xs font-black text-rose-500">First Add Grading Rules In Setting Page!</h4>
                <p className="text-[11px] text-slate-500 dark:text-slate-300 font-bold">
                  Document Path: 
                </p>
              </div>
            </div>

            <Button
              onClick={() => window.location.href = '/settings'}
              className="bg-rose-500 hover:bg-rose-600 text-white rounded-xl text-xs font-black px-4 py-2 shadow-md shadow-rose-500/20 whitespace-nowrap flex items-center gap-1.5"
            >
              <span>Go to Settings Page</span>
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}

        <div className={`w-full px-4 py-3 rounded-2xl border-2 border-orange-500/70 shadow-[0_0_15px_rgba(249,115,22,0.2)] flex items-center justify-between gap-3 ${
          isDarkMode ? 'bg-[#0e131f]' : 'bg-white'
        }`}>
          <div className={`relative flex-1 max-w-md flex items-center rounded-xl border px-3 py-2 ${getCardClass()}`}>
            <Search className="h-4 w-4 text-slate-400 mr-2" />
            <input
              type="text"
              placeholder="Search class or student..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="bg-transparent text-xs font-bold outline-none w-full text-slate-900 dark:text-slate-100"
            />
          </div>

          <button
            onClick={() => setIsDarkMode((prev) => !prev)}
            className={`h-8 w-14 rounded-full p-1 flex items-center border shadow-sm ${
              isDarkMode ? 'bg-slate-800 border-slate-600 justify-end' : 'bg-slate-200 border-slate-300 justify-start'
            }`}
          >
            <div className={`h-6 w-6 rounded-full flex items-center justify-center shadow-sm ${
              isDarkMode ? 'bg-orange-500 text-white' : 'bg-white text-slate-700'
            }`}>
              {isDarkMode ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
            </div>
          </button>
        </div>

        {loading && (
          <div className="flex flex-col items-center justify-center py-20 space-y-4">
            <Loader2 className="h-10 w-10 text-orange-500 animate-spin" />
            <p className="text-xs font-bold text-slate-400">Loading Firestore Realtime Database...</p>
          </div>
        )}

        {!loading && !activeClassId && (
          <div className="space-y-6">
            <div className={`relative overflow-hidden rounded-3xl p-6 sm:p-8 border-2 border-orange-500 shadow-[0_0_25px_rgba(249,115,22,0.25)] ${
              isDarkMode ? 'bg-[#0e131f] text-white' : 'bg-white text-slate-900'
            }`}>
              <div className="relative z-10 space-y-3">
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-orange-500/50 bg-orange-500/10 text-orange-500 dark:text-orange-400 text-xs font-black uppercase tracking-wider">
                  <span className="h-2 w-2 rounded-full bg-orange-500"></span>
                  LIVE ENGINE ACTIVE
                </div>
                <h2 className="text-2xl sm:text-4xl font-black tracking-tight">Tuition Management System</h2>
                <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-300 max-w-xl font-medium">
                  Select a class to generate automated weekly performance report cards with live quiz marks for <span className="text-orange-500 font-bold">{formatMonthLabel(selectedMonth)}</span>.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
              {filteredClasses.length === 0 ? (
                <div className={`col-span-full text-center py-12 text-slate-400 font-bold text-xs ${getCardClass()} rounded-3xl border border-dashed`}>
                  No classes found in Firebase database.
                </div>
              ) : (
                filteredClasses.map((cls) => (
                  <div
                    key={cls.id}
                    onClick={() => setActiveClassId(cls.id)}
                    className={`group border-2 border-orange-500/60 hover:border-orange-500 shadow-[0_0_15px_rgba(249,115,22,0.15)] hover:shadow-[0_0_20px_rgba(249,115,22,0.3)] rounded-3xl p-6 cursor-pointer relative overflow-hidden ${
                      isDarkMode ? 'bg-[#0e131f] text-white' : 'bg-white text-slate-900'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-4">
                      <div className="h-12 w-12 rounded-2xl bg-orange-500/10 text-orange-500 flex items-center justify-center font-black">
                        <BookOpen className="h-6 w-6" />
                      </div>
                      <span className="text-[10px] font-black text-orange-500 dark:text-orange-400 bg-orange-500/10 px-3 py-1 rounded-xl uppercase border border-orange-500/20">
                        {cls.code}
                      </span>
                    </div>

                    <h3 className="text-base font-black group-hover:text-orange-500 mb-1">
                      {cls.name}
                    </h3>
                    <p className="text-xs text-slate-400 font-medium mb-4">Realtime Enrolled Roster</p>

                    <div className={`flex items-center justify-between pt-4 border-t text-xs font-bold ${
                      isDarkMode ? 'border-slate-800' : 'border-slate-100'
                    }`}>
                      <span className="text-slate-400">Total Students:</span>
                      <span className={`px-3 py-1 rounded-lg border border-orange-500/20 text-orange-500 font-black ${getInnerCardClass()}`}>
                        {cls.students.length} Enrolled
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {!loading && activeClassId && currentClass && (
          <div className="space-y-6 max-w-5xl mx-auto">

            <div className="flex items-center justify-between gap-4 pb-4 border-b border-slate-200 dark:border-slate-800">
              <button
                onClick={() => setActiveClassId(null)}
                className="group inline-flex items-center gap-2 px-4 py-2.5 rounded-2xl bg-orange-500 text-white font-extrabold text-xs shadow-lg shadow-orange-500/20 hover:bg-orange-600"
              >
                <ArrowLeft className="h-4 w-4 stroke-[2.5]" />
                <span>Move to Class Directory</span>
              </button>

              <div className="p-2 rounded-2xl border-2 border-orange-500/80 shadow-[0_0_15px_rgba(249,115,22,0.25)] flex items-center gap-2 text-xs font-black text-orange-500">
                <Zap className="h-4 w-4" /> Automatic Reporting Mode Active
              </div>
            </div>

            <div className="space-y-6">
              <div className="space-y-3">
                <div className="inline-flex items-center gap-2.5 px-3.5 py-1.5 rounded-xl border border-orange-500/40 bg-orange-500/10">
                  <span className="px-2 py-0.5 rounded-lg bg-orange-500 text-white text-[10px] font-black uppercase">
                    Step 1
                  </span>
                  <span className="text-xs font-black text-orange-500 dark:text-orange-400 uppercase tracking-wider">
                    Select Category ({formatMonthLabel(selectedMonth)})
                  </span>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {(['Excellent', 'Good', 'Average', 'Poor'] as CategoryType[]).map((cat) => {
                    const isSelected = activeCategoryTab === cat;
                    const count = currentClass.students.filter((s) => s.category === cat).length;
                    const config = CATEGORY_CONFIG[cat];

                    return (
                      <button
                        key={cat}
                        onClick={() => {
                          setActiveCategoryTab(cat);
                          setSelectedStudentIds([]);
                        }}
                        className={`p-4 rounded-2xl border-2 font-black text-xs flex flex-col items-center justify-center gap-1.5 relative overflow-hidden ${
                          isSelected
                            ? `${config.color} border-orange-500 shadow-lg shadow-orange-500/20`
                            : `${getCardClass()}`
                        }`}
                      >
                        <span className="text-sm font-black">{cat}</span>
                        <span className={`text-[10px] font-bold ${getInnerCardClass()} px-2 py-0.5 rounded-full`}>
                          {count} Assigned
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className={`border-2 border-orange-500/70 shadow-[0_0_20px_rgba(249,115,22,0.2)] rounded-3xl p-5 space-y-4 ${
                isDarkMode ? 'bg-[#0e131f] text-white' : 'bg-white text-slate-900'
              }`}>
                <div className={`flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b ${
                  isDarkMode ? 'border-slate-800' : 'border-slate-100'
                }`}>
                  <div>
                    <h4 className="text-xs font-black">
                      Unassigned Student Cards ({unassignedStudents.length}) - {formatMonthLabel(selectedMonth)}
                    </h4>
                    <p className="text-[10px] text-slate-400 font-bold">
                      Click student card to view report modal or check to assign to <span className={CATEGORY_CONFIG[activeCategoryTab].textColor}>"{activeCategoryTab}"</span>.
                    </p>
                  </div>

                  <Button
                    disabled={selectedStudentIds.length === 0}
                    onClick={handleSaveCategoryAssignment}
                    className="bg-orange-500 hover:bg-orange-600 text-white rounded-xl text-xs font-black px-4 py-2 shadow-md shadow-orange-500/20 disabled:opacity-40"
                  >
                    <Check className="h-3.5 w-3.5 mr-1 stroke-[3]" /> Save ({selectedStudentIds.length}) To {activeCategoryTab}
                  </Button>
                </div>

                {unassignedStudents.length === 0 ? (
                  <div className="py-8 text-center space-y-3 bg-emerald-500/10 border-2 border-dashed border-emerald-500/40 rounded-2xl p-4">
                    <div className="h-12 w-12 rounded-full bg-emerald-500 text-white mx-auto flex items-center justify-center shadow-lg shadow-emerald-500/30">
                      <Sparkles className="h-6 w-6" />
                    </div>
                    <div>
                      <h4 className="text-sm font-black text-emerald-500">All Class Students Categorized!</h4>
                      <p className="text-xs text-slate-400 font-bold mt-1">
                        You can view individual report cards by clicking any student below or click preview all.
                      </p>
                    </div>

                    <Button
                      onClick={() => setShowReportPreviewModal(true)}
                      className="bg-emerald-500 hover:bg-emerald-600 text-white rounded-2xl text-xs font-black px-6 py-3 shadow-xl shadow-emerald-500/30 inline-flex items-center gap-2"
                    >
                      <FileCheck className="h-4 w-4" />
                      <span>Preview All Performance Reports</span>
                    </Button>
                  </div>
                ) : (
                  <>
                    <div className="space-y-2.5 min-h-[280px]">
                      {paginatedUnassignedStudents.map((student) => {
                        const isChecked = selectedStudentIds.some((id) => String(id) === String(student.id));
                        
                        const liveMetrics = realtimeMetrics[String(student.id)] || {
                          attendancePct: '—',
                          quizDisplay: '—',
                        };

                        return (
                          <div
                            key={student.id}
                            className={`flex items-center justify-between p-3.5 rounded-2xl border ${
                              isChecked
                                ? 'bg-orange-500/20 border-orange-500 shadow-sm'
                                : `${getInnerCardClass()}`
                            }`}
                          >
                            <div className="flex items-center gap-3">
                              <div 
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleStudentSelection(student.id);
                                }}
                                className={`h-5 w-5 rounded-full border cursor-pointer flex items-center justify-center ${
                                  isChecked ? 'bg-orange-500 border-orange-500 text-white' : 'border-slate-400 bg-transparent'
                                }`}
                              >
                                {isChecked && <Check className="h-3 w-3 stroke-[3]" />}
                              </div>

                              <div 
                                onClick={() => setSingleStudentModal(student)}
                                className="flex items-center gap-3 cursor-pointer group"
                              >
                                <img src={student.avatar} alt="" className="h-9 w-9 rounded-full object-cover bg-slate-700 border border-slate-600" />

                                <div>
                                  <p className="text-xs font-black group-hover:text-orange-500 flex items-center gap-1.5">
                                    {student.name}
                                  </p>
                                  <p className="text-[10px] text-slate-400 font-bold">Roll No: {student.rollNo}</p>
                                </div>
                              </div>
                            </div>

                            <div 
                              onClick={() => setSingleStudentModal(student)}
                              className="flex items-center gap-2 cursor-pointer"
                            >
                              <span className="text-[10px] font-black bg-emerald-500/10 text-emerald-500 px-2.5 py-1 rounded-xl border border-emerald-500/20">
                                Att: {liveMetrics.attendancePct}
                              </span>
                              <span className="text-[10px] font-black bg-orange-500/10 text-orange-500 px-2.5 py-1 rounded-xl border border-orange-500/20">
                                Quiz: {liveMetrics.quizDisplay}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {totalPages > 1 && (
                      <div className={`flex items-center justify-between pt-3 border-t text-xs font-bold ${
                        isDarkMode ? 'border-slate-800' : 'border-slate-100'
                      }`}>
                        <span className="text-[11px] text-slate-400">
                          Page <strong className="text-orange-500">{currentPage}</strong> of {totalPages} ({unassignedStudents.length} Unassigned Students)
                        </span>

                        <div className="flex items-center gap-2">
                          <button
                            disabled={currentPage === 1}
                            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                            className="p-1.5 rounded-xl border border-slate-700 disabled:opacity-30 hover:bg-orange-500 hover:text-white"
                          >
                            <ChevronLeft className="h-4 w-4" />
                          </button>

                          <span className="text-[10px] font-black px-2.5 py-1 rounded-lg bg-orange-500/10 text-orange-500">
                            {currentPage} / {totalPages}
                          </span>

                          <button
                            disabled={currentPage === totalPages}
                            onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                            className="p-1.5 rounded-xl border border-slate-700 disabled:opacity-30 hover:bg-orange-500 hover:text-white"
                          >
                            <ChevronRight className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>

              <div className="space-y-3 pt-2">
                <div className="flex items-center justify-between">
                  <h4 className="text-[11px] font-black text-slate-400 uppercase tracking-wider">
                    Categorized Roster Cards ({formatMonthLabel(selectedMonth)})
                  </h4>

                  <Button
                    onClick={() => setShowReportPreviewModal(true)}
                    className="bg-emerald-500 hover:bg-emerald-600 text-white rounded-xl text-xs font-black px-3 py-1.5 shadow-md shadow-emerald-500/20 flex items-center gap-1"
                  >
                    <FileCheck className="h-3.5 w-3.5" />
                    <span>Preview / Print All Reports</span>
                  </Button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {(['Excellent', 'Good', 'Average', 'Poor'] as CategoryType[]).map((cat) => {
                    const catStudents = currentClass.students.filter((s) => s.category === cat);
                    const catConfig = CATEGORY_CONFIG[cat];
                    const CategoryIcon = catConfig.icon;

                    return (
                      <div
                        key={cat}
                        className={`border-2 border-orange-500/50 rounded-3xl p-5 space-y-3 relative overflow-hidden shadow-[0_0_15px_rgba(249,115,22,0.15)] ${
                          isDarkMode ? 'bg-[#0e131f] text-white' : 'bg-white text-slate-900'
                        }`}
                      >
                        <div className={`flex items-center justify-between border-b pb-3 ${
                          isDarkMode ? 'border-slate-800' : 'border-slate-100'
                        }`}>
                          <div className="flex items-center gap-2.5">
                            <div className={`p-2 rounded-xl ${catConfig.badgeBg}`}>
                              <CategoryIcon className="h-4 w-4" />
                            </div>
                            <div>
                              <h5 className={`text-sm font-black ${catConfig.textColor}`}>{cat}</h5>
                              <p className="text-[10px] text-slate-400 font-bold">{catStudents.length} Students Assigned</p>
                            </div>
                          </div>
                        </div>

                        <div className={`${getInnerCardClass()} p-3 rounded-2xl text-[11px] font-medium italic`}>
                          "{categoryPresets[cat]}"
                        </div>

                        {catStudents.length === 0 ? (
                          <p className="text-[11px] text-slate-400 font-bold py-2 text-center">No students assigned yet.</p>
                        ) : (
                          <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1">
                            {catStudents.map((s) => (
                              <div 
                                key={s.id} 
                                className={`flex items-center justify-between p-2.5 rounded-xl ${getInnerCardClass()} cursor-pointer hover:border-orange-500 border`}
                                onClick={() => setSingleStudentModal(s)}
                              >
                                <div className="flex items-center gap-2">
                                  <img src={s.avatar} className="h-7 w-7 rounded-full bg-slate-700" alt="" />
                                  <div>
                                    <span className="text-xs font-black block">{s.name}</span>
                                    <span className="text-[9px] text-slate-400 font-bold">Roll: {s.rollNo}</span>
                                  </div>
                                </div>

                                <div className="flex items-center gap-1">
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleSendWhatsAppAutomated(s);
                                    }}
                                    className="text-[10px] bg-emerald-600 text-white font-black px-2 py-1 rounded-lg hover:bg-emerald-700 flex items-center gap-1"
                                  >
                                    <Send className="h-3 w-3" /> Send
                                  </button>
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleRemoveFromCategory(s.id);
                                    }}
                                    className="text-[10px] text-rose-500 hover:text-rose-600 font-black px-2 py-1 rounded-lg hover:bg-rose-500/10"
                                  >
                                    Remove
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

          </div>
        )}

      </main>

      {/* BOTTOM NAVBAR */}
      <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2">
        <div className={`flex items-center justify-between rounded-full px-6 py-3 shadow-lg border w-[380px] ${
          isDarkMode ? 'bg-[#0e131f] border-slate-800 text-slate-200' : 'bg-white border-slate-200 text-slate-700'
        }`}>
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = activeNav === item.id;

            return (
              <button
                key={item.id}
                onClick={() => setActiveNav(item.id)}
                className={`flex flex-col items-center gap-1 w-14 ${
                  active 
                    ? 'text-orange-500 font-black' 
                    : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-200'
                }`}
              >
                <Icon className={`h-5 w-5 ${active ? 'text-orange-500' : ''}`} />
                <span className="text-[10px] font-bold">{item.label}</span>
              </button>
            );
          })}
        </div>
      </div>

    </div>
  );
}
