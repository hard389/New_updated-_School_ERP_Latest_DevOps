import { useState, useMemo, useEffect } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  Sun,
  Moon,
  Users,
  Wallet,
  GraduationCap,
  ChevronDown,
  TrendingUp,
  SlidersHorizontal,
  UserX,
  Home,
  Settings,
  Loader2,
  CheckCircle2,
  Calendar as CalendarIcon,
  ArrowLeft,
  AlertCircle,
  X,
  CheckCircle,
  Clock,
  Filter,
  Sparkles,
  Award,
  Search,
} from 'lucide-react';

// Firebase Firestore & Auth Imports
import { collection, documentId, onSnapshot, doc, getDoc, query, where } from 'firebase/firestore';
import { onAuthStateChanged } from 'firebase/auth';
import { auth, db } from '../lib/firebase';

// Components & Types
import { StudentCaptureSection } from '../components/analytics/StudentCaptureSection';

export type CaptureCriteria = 'Weighted Score' | 'Attendance Rate' | 'Quiz Marks' | 'overallScore' | 'manualTag';

// Pure analytics/data-contract helpers. These functions never write to Firestore.
type LiveStatus = 'idle' | 'loading' | 'ready' | 'error';

interface LiveCollectionSource {
  status: LiveStatus;
  hasSnapshot: boolean;
  serverSynced: boolean;
  docs: any[];
  error: string | null;
  scopeKey?: string;
}

interface LiveDocumentSource {
  status: LiveStatus;
  hasSnapshot: boolean;
  serverSynced: boolean;
  data: Record<string, any> | null;
  exists: boolean;
  validData: boolean;
  error: string | null;
  scopeKey?: string;
}

interface AnalyticsMetrics {
  attendanceRate: number | null;
  absentPercentage: number | null;
  presentCount: number | null;
  lateCount: number | null;
  absentCount: number | null;
  absentToday: number | null;
  feeRecoveryRate: number | null;
  paidCount: number | null;
  pendingCount: number | null;
  totalRevenue: number | null;
  dailyCollectedRevenue: number | null;
  dailyPaidCount: number | null;
  totalStudentsCount: number | null;
}

const EMPTY_METRICS: AnalyticsMetrics = {
  attendanceRate: null,
  absentPercentage: null,
  presentCount: null,
  lateCount: null,
  absentCount: null,
  absentToday: null,
  feeRecoveryRate: null,
  paidCount: null,
  pendingCount: null,
  totalRevenue: null,
  dailyCollectedRevenue: null,
  dailyPaidCount: null,
  totalStudentsCount: null,
};

const emptyCollectionSource = (status: LiveStatus = 'loading'): LiveCollectionSource => ({
  status,
  hasSnapshot: false,
  serverSynced: false,
  docs: [],
  error: null,
});

const emptyDocumentSource = (status: LiveStatus = 'loading'): LiveDocumentSource => ({
  status,
  hasSnapshot: false,
  serverSynced: false,
  data: null,
  exists: false,
  validData: false,
  error: null,
});

const describeFirestoreError = (section: string, error: any): string => {
  const code = typeof error?.code === 'string' && error.code.trim() ? `${error.code}: ` : '';
  const detail = typeof error?.message === 'string' && error.message.trim()
    ? error.message.trim()
    : 'Unknown Firestore error';
  return `${section} — ${code}${detail}`;
};

// Existing legacy IDs are class-prefixed. Probe only deterministic IDs for dates in the
// selected report window; modern class-tagged records are covered by a class-only query.
const legacyAttendanceIdsForDates = (classId: string, dateKeys: string[]): string[] => {
  const ids = new Set<string>();
  dateKeys.forEach((key) => {
    const match = key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    ids.add(`${classId}_${key}`);
    // These separators/padding variants are parseable by the existing legacy date normalizer.
    ids.add(`${classId}_${month}-${day}-${year}`);
    ids.add(`${classId}_${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}-${year}`);
  });
  return [...ids];
};

const dateKeysForMonth = (monthKey: string): string[] => {
  const match = monthKey.match(/^(\d{4})-(\d{2})$/);
  if (!match) return [];
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return [];
  const totalDays = new Date(year, month, 0).getDate();
  return Array.from({ length: totalDays }, (_, index) =>
    `${year}-${String(month).padStart(2, '0')}-${String(index + 1).padStart(2, '0')}`
  );
};

interface PaymentReceiptSummary {
  totalsByStudent: Record<string, number>;
  lastDateByStudent: Record<string, string>;
  exactDayRevenue: number;
  studentsPaidExactDay: Set<string>;
  warnings: string[];
}

const emptyPaymentReceiptSummary = (): PaymentReceiptSummary => ({
  totalsByStudent: {},
  lastDateByStudent: {},
  exactDayRevenue: 0,
  studentsPaidExactDay: new Set<string>(),
  warnings: [],
});

const summarizePaymentReceipts = (
  sourceDocs: any[],
  selectedClassId: string,
  expectedMonthKey: string,
  selectedDateKey: string,
  rosterIds: Set<string>,
): PaymentReceiptSummary => {
  const totalsByStudent: Record<string, number> = {};
  const lastDateByStudent: Record<string, string> = {};
  let exactDayRevenue = 0;
  const studentsPaidExactDay = new Set<string>();
  const seenPaymentIds = new Set<string>();
  const warnings: string[] = [];

  sourceDocs.forEach((receiptSnap: any) => {
    const receipt = receiptSnap.data() || {};
    const receiptId = String(receipt.paymentId ?? receiptSnap.id);
    if (seenPaymentIds.has(receiptId)) return;
    seenPaymentIds.add(receiptId);
    if (receipt.classId !== undefined && String(receipt.classId) !== selectedClassId) return;
    if (receipt.month !== undefined && normalizeMonthKey(receipt.month) !== expectedMonthKey) return;
    const studentIdRaw = receipt.studentId;
    if (studentIdRaw === undefined || studentIdRaw === null || String(studentIdRaw).trim() === '') {
      warnings.push(`Payment receipt ${receiptSnap.id} has no stable studentId and was excluded.`);
      return;
    }
    const studentId = String(studentIdRaw);
    if (!rosterIds.has(studentId)) return;
    const amount = parseNonNegativeNumber(receipt.amount);
    const paymentDate = normalizeDate(receipt.createdAt) || normalizeDate(receipt.paidAt) || normalizeDate(receipt.date);
    if (amount === null || amount <= 0) {
      warnings.push(`Payment receipt ${receiptSnap.id} has an invalid/non-positive amount and was excluded.`);
      console.warn(`[Analytics] Ignored malformed payment receipt ${receiptSnap.id}.`);
      return;
    }
    totalsByStudent[studentId] = (totalsByStudent[studentId] ?? 0) + amount;
    if (paymentDate && (!lastDateByStudent[studentId] || paymentDate > lastDateByStudent[studentId])) {
      lastDateByStudent[studentId] = paymentDate;
    }
    if (paymentDate === selectedDateKey) {
      exactDayRevenue += amount;
      studentsPaidExactDay.add(studentId);
    }
  });

  return { totalsByStudent, lastDateByStudent, exactDayRevenue, studentsPaidExactDay, warnings };
};

const isPlainObject = (value: any): value is Record<string, any> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const parseNonNegativeNumber = (value: any): number | null => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
};

const parseScoreOutOf100 = (value: any): number | null => {
  const score = parseNonNegativeNumber(value);
  return score !== null && score <= 100 ? score : null;
};

const toValidDate = (raw: any): Date | null => {
  try {
    let date: Date;
    if (raw instanceof Date) {
      date = new Date(raw.getTime());
    } else if (raw && typeof raw.toDate === 'function') {
      date = raw.toDate();
    } else if (raw && typeof raw.seconds === 'number') {
      date = new Date(raw.seconds * 1000);
    } else if (typeof raw === 'number') {
      date = new Date(raw);
    } else if (typeof raw === 'string' && raw.trim()) {
      date = new Date(raw.trim());
    } else {
      return null;
    }
    return Number.isFinite(date.getTime()) ? date : null;
  } catch {
    return null;
  }
};

const localDateKey = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

const getLocalTodayKey = (): string => localDateKey(new Date());

// Accepts Firestore Timestamp, Date, milliseconds, ISO/date-only strings, and legacy MM/DD/YYYY strings.
const normalizeDate = (rawDate: any): string => {
  if (rawDate === undefined || rawDate === null || rawDate === '') return '';
  if (typeof rawDate === 'string') {
    const raw = rawDate.trim();
    const ymd = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (ymd) {
      const year = Number(ymd[1]);
      const month = Number(ymd[2]);
      const day = Number(ymd[3]);
      const check = new Date(year, month - 1, day);
      if (check.getFullYear() === year && check.getMonth() === month - 1 && check.getDate() === day) {
        return `${ymd[1]}-${ymd[2]}-${ymd[3]}`;
      }
      return '';
    }
    const slash = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (slash) {
      const month = Number(slash[1]);
      const day = Number(slash[2]);
      const year = Number(slash[3]);
      const check = new Date(year, month - 1, day);
      if (month >= 1 && month <= 12 && check.getFullYear() === year && check.getMonth() === month - 1 && check.getDate() === day) {
        return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      }
      return '';
    }
  }
  const date = toValidDate(rawDate);
  return date ? localDateKey(date) : '';
};

const normalizeMonthKey = (rawMonth: any): string => {
  if (rawMonth === undefined || rawMonth === null || rawMonth === '') return '';
  if (typeof rawMonth === 'string') {
    const raw = rawMonth.trim();
    const match = raw.match(/^(\d{4})-(\d{2})$/);
    if (match) {
      const month = Number(match[2]);
      return month >= 1 && month <= 12 ? `${match[1]}-${match[2]}` : '';
    }
    const dateKey = normalizeDate(raw);
    if (dateKey) return dateKey.slice(0, 7);
  }
  const date = toValidDate(rawMonth);
  if (date) return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  // Quiz Management stores month labels such as "October 2026".
  if (typeof rawMonth === 'string' && rawMonth.trim()) {
    const date = new Date(rawMonth.trim());
    if (Number.isFinite(date.getTime())) {
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    }
  }
  return '';
};

// Last two calendar months, limited by the class creation month. Invalid old dates retain
// the legacy rolling window; future-month clock/data errors cannot leave the selector empty.
const getMonthsForClass = (createdAtValue: any) => {
  const now = new Date();
  const months: Array<{ key: string; label: string; dateObj: Date }> = [];
  for (let i = 0; i < 2; i++) {
    const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({
      key: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`,
      label: date.toLocaleString('en-US', { month: 'long', year: 'numeric' }),
      dateObj: date,
    });
  }

  if (createdAtValue === undefined || createdAtValue === null || createdAtValue === '') {
    return months.map(({ key, label }) => ({ key, label }));
  }

  const createdDate = toValidDate(createdAtValue);
  if (!createdDate) return months.map(({ key, label }) => ({ key, label }));

  const creationMonthStart = new Date(createdDate.getFullYear(), createdDate.getMonth(), 1);
  const validMonths = months.filter((month) => month.dateObj >= creationMonthStart);
  const nonEmptyMonths = validMonths.length ? validMonths : months.slice(0, 1);
  return nonEmptyMonths.map(({ key, label }) => ({ key, label }));
};

const RESERVED_CLASS_KEYS = new Set([
  'id', 'name', 'code', 'monthlyFee', 'className', 'classCode', 'title', 'fee', 'classFee',
  'createdAt', 'createdDate', 'date', 'updatedAt', 'students', 'active', 'description'
]);

// Supports the same students array, index-keyed map, and legacy top-level student map as Departments/Attendance.
// Stable stored IDs win; a map key is used only for legacy map layouts, never for an ID-less array item.
const extractAnalyticsStudents = (classData: any): any[] => {
  if (!isPlainObject(classData)) return [];
  let entries: Array<[string, any]> = [];
  let layout: 'array' | 'map' | 'top-level' | 'none' = 'none';

  if (Array.isArray(classData.students)) {
    layout = 'array';
    entries = classData.students.map((student: any, index: number) => [String(index), student]);
  } else if (isPlainObject(classData.students)) {
    layout = 'map';
    entries = Object.entries(classData.students);
  } else {
    layout = 'top-level';
    entries = Object.entries(classData).filter(([key, value]) =>
      !RESERVED_CLASS_KEYS.has(key) && isPlainObject(value) &&
      (typeof value.name === 'string' || value.id !== undefined || value.studentId !== undefined)
    );
  }

  const seen = new Set<string>();
  const students: any[] = [];
  entries.forEach(([storageKey, rawStudent], index) => {
    if (!isPlainObject(rawStudent)) return;
    const rawId = rawStudent.id ?? rawStudent.studentId;
    const id = rawId !== undefined && rawId !== null && String(rawId).trim() !== ''
      ? String(rawId)
      : layout !== 'array' ? storageKey : '';
    if (!id || seen.has(id)) {
      if (!id || seen.has(id)) console.warn('[Analytics] Skipped a student record without a stable/unique ID.', { storageKey });
      return;
    }
    seen.add(id);
    students.push({
      ...rawStudent,
      id: rawId !== undefined && rawId !== null && String(rawId).trim() !== '' ? rawId : id,
      name: String(rawStudent.name ?? `Student ${index + 1}`),
      rollNo: rawStudent.rollNo === undefined || rawStudent.rollNo === null ? '' : String(rawStudent.rollNo),
      gender: rawStudent.gender ?? 'Male',
    });
  });
  return students;
};

const normalizeAttendanceStatus = (raw: any): 'present' | 'late' | 'absent' | null => {
  let value = raw;
  if (isPlainObject(raw)) {
    if (raw.status !== undefined) value = raw.status;
    else if (raw.attendance !== undefined) value = raw.attendance;
    else if (typeof raw.present === 'boolean') value = raw.present;
    else return null;
  }
  if (value === true) return 'present';
  if (value === false) return 'absent';
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'true' || normalized === 'present' || normalized === 'p') return 'present';
  if (normalized === 'false' || normalized === 'absent' || normalized === 'a') return 'absent';
  if (normalized === 'late' || normalized === 'l') return 'late';
  return null;
};

interface AttendanceCounts {
  present: number;
  late: number;
  absent: number;
  total: number;
}

const summarizeAttendanceDocument = (data: any, rosterIds: Set<string>): { counts: AttendanceCounts; studentStatuses: Record<string, 'present' | 'late' | 'absent'> } => {
  const counts: AttendanceCounts = { present: 0, late: 0, absent: 0, total: 0 };
  const studentStatuses: Record<string, 'present' | 'late' | 'absent'> = {};
  if (rosterIds.size === 0) return { counts, studentStatuses };
  const addStatus = (studentId: string, rawStatus: any) => {
    if (!rosterIds.has(studentId) || Object.prototype.hasOwnProperty.call(studentStatuses, studentId)) return;
    const status = normalizeAttendanceStatus(rawStatus);
    if (!status) return;
    studentStatuses[studentId] = status;
    counts[status] += 1;
    counts.total += 1;
  };

  if (isPlainObject(data?.attendanceMap)) {
    Object.entries(data.attendanceMap).forEach(([studentId, value]) => addStatus(studentId, value));
    return { counts, studentStatuses };
  }

  const recordList = Array.isArray(data?.records) ? data.records : Array.isArray(data?.students) ? data.students : null;
  if (recordList) {
    recordList.forEach((record: any) => {
      if (!isPlainObject(record)) return;
      const rawId = record.id ?? record.studentId ?? record.student_id;
      if (rawId === undefined || rawId === null || String(rawId).trim() === '') return;
      addStatus(String(rawId), record);
    });
    return { counts, studentStatuses };
  }

  // Some older tenant-scoped records only contain aggregate counts. Use these only when
  // per-student data is absent, so a single day isn't counted twice.
  const present = parseNonNegativeNumber(data?.presentCount);
  const late = parseNonNegativeNumber(data?.lateCount);
  const absent = parseNonNegativeNumber(data?.absentCount);
  if (present !== null || late !== null || absent !== null) {
    const aggregatePresent = present ?? 0;
    const aggregateLate = late ?? 0;
    const aggregateAbsent = absent ?? 0;
    const aggregateTotal = aggregatePresent + aggregateLate + aggregateAbsent;
    // These are counts of students, so fractional values or totals larger than the current
    // roster indicate malformed/stale aggregate data. Skip instead of producing rates > 100%.
    if (
      !Number.isInteger(aggregatePresent) ||
      !Number.isInteger(aggregateLate) ||
      !Number.isInteger(aggregateAbsent) ||
      aggregateTotal > rosterIds.size
    ) {
      console.warn('[Analytics] Ignored malformed aggregate attendance counts.', {
        present: aggregatePresent, late: aggregateLate, absent: aggregateAbsent, rosterSize: rosterIds.size,
      });
      return { counts, studentStatuses };
    }
    counts.present = aggregatePresent;
    counts.late = aggregateLate;
    counts.absent = aggregateAbsent;
    counts.total = aggregateTotal;
  }
  return { counts, studentStatuses };
};

const attendanceDateFromDocument = (data: any, docId: string, classId: string): string => {
  const explicit = normalizeDate(data?.date);
  if (explicit) return explicit;
  const prefix = `${classId}_`;
  if (docId.startsWith(prefix)) return normalizeDate(docId.slice(prefix.length));
  return '';
};

const timestampRank = (value: any): number => {
  const date = toValidDate(value);
  return date ? date.getTime() : 0;
};

const buildAttendanceSummary = (rows: Array<{ date: string; data: any }>, rosterIds: Set<string>) => {
  const counts: AttendanceCounts = { present: 0, late: 0, absent: 0, total: 0 };
  const byStudent: Record<string, { present: number; late: number; absent: number; total: number }> = {};
  rows.forEach(({ data }) => {
    const result = summarizeAttendanceDocument(data, rosterIds);
    counts.present += result.counts.present;
    counts.late += result.counts.late;
    counts.absent += result.counts.absent;
    counts.total += result.counts.total;
    Object.entries(result.studentStatuses).forEach(([studentId, status]) => {
      const stat = byStudent[studentId] ?? { present: 0, late: 0, absent: 0, total: 0 };
      stat[status] += 1;
      stat.total += 1;
      byStudent[studentId] = stat;
    });
  });
  return { counts, byStudent };
};

const percent = (numerator: number, denominator: number): number =>
  denominator > 0 ? Math.min(100, Math.max(0, Math.round((numerator / denominator) * 100))) : 0;

const buildCaptureContextKey = (tenantId: string | null, classId: string, monthKey: string, classItem: any): string => {
  const rosterSignature = Array.isArray(classItem?.students)
    ? classItem.students.map((student: any) => [
        String(student?.id ?? student?.studentId ?? ''),
        String(student?.name ?? ''),
        String(student?.rollNo ?? ''),
        String(student?.studentFee ?? ''),
        String(student?.overallScore ?? ''),
        String(student?.manualTag ?? student?.tag ?? ''),
      ])
    : [];
  return `${tenantId ?? ''}::${classId}::${monthKey}::${String(classItem?.monthlyFee ?? '')}::${JSON.stringify(rosterSignature)}`;
};

// Quiz averages are percentages so quizzes with different total marks remain comparable.
// Blank/missing marks are excluded; numeric zero is a valid score.
const calculateAverageQuizPercent = (samples: Array<{ marksObtained: any; totalMarks: any }>): number | null => {
  let sum = 0;
  let count = 0;
  samples.forEach(({ marksObtained, totalMarks }) => {
    if (marksObtained === '' || marksObtained === null || marksObtained === undefined) return;
    const marks = parseNonNegativeNumber(marksObtained);
    const total = parseNonNegativeNumber(totalMarks);
    if (marks === null || total === null || total <= 0 || marks > total) return;
    sum += (marks / total) * 100;
    count += 1;
  });
  return count > 0 ? sum / count : null;
};

const calculateWeightedScore = (attendanceRate: number | null, quizMarks: number | null): number | null => {
  if (attendanceRate === null || quizMarks === null || !Number.isFinite(attendanceRate) || !Number.isFinite(quizMarks)) return null;
  return Math.round((attendanceRate * 0.4 + quizMarks * 0.6) * 100) / 100;
};

// Interface for Fee Modal Data
interface FeeDetailStudent {
  id: string;
  name: string;
  rollNo: string;
  status: 'PAID' | 'UNPAID';
  amountPaid: number;
  date?: string;
}

// ==========================================
// PREMIUM CLASS SELECTION MODAL
// ==========================================
interface ClassSelectModalProps {
  isOpen: boolean;
  onClose: () => void;
  classesList: any[];
  selectedClassId: string;
  onSelectClass: (id: string) => void;
}

function ClassSelectModal({
  isOpen,
  onClose,
  classesList,
  selectedClassId,
  onSelectClass,
}: ClassSelectModalProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [tempSelected, setTempSelected] = useState(selectedClassId);

  useEffect(() => {
    setTempSelected(selectedClassId);
  }, [selectedClassId, isOpen]);

  if (!isOpen) return null;

  const filteredClasses = classesList.filter((c) =>
    c.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const handleConfirm = () => {
    if (tempSelected) {
      onSelectClass(tempSelected);
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-md p-4 animate-in fade-in duration-200">
      <div className="w-full max-w-md bg-white dark:bg-[#0c1222] border-2 border-orange-500/50 rounded-3xl p-6 shadow-[0_0_50px_rgba(249,115,22,0.25)] space-y-5 text-slate-900 dark:text-slate-100 relative">
        {/* Header */}
        <div className="flex items-start justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-2xl bg-orange-500 text-white shadow-lg shadow-orange-500/30">
              <GraduationCap className="h-6 w-6 stroke-[2.2]" />
            </div>
            <div>
              <h3 className="text-base font-black tracking-tight">Select Class Product</h3>
              <p className="text-[11px] text-slate-400 font-bold">
                Choose class to load items ({classesList.length} Available)
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-full text-slate-400 hover:text-slate-200 bg-slate-100 dark:bg-slate-800 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Search Input */}
        <div className="relative">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-orange-500" />
          <input
            type="text"
            placeholder="Filter products by name or code..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-4 py-3 rounded-2xl bg-slate-50 dark:bg-[#070b13] border border-orange-500/30 dark:border-orange-500/30 text-xs font-black placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-orange-500"
          />
        </div>

        {/* Class Cards */}
        <div className="max-h-60 overflow-y-auto space-y-3 pr-1">
          {filteredClasses.length === 0 ? (
            <p className="text-center py-6 text-xs text-slate-400 font-bold">No classes found</p>
          ) : (
            filteredClasses.map((cls) => {
              const isSelected = tempSelected === cls.id;
              const studentCount = cls.students?.length || 0;

              return (
                <div
                  key={cls.id}
                  onClick={() => setTempSelected(cls.id)}
                  className={`p-4 rounded-2xl border-2 cursor-pointer transition-all flex items-center justify-between ${
                    isSelected
                      ? 'border-orange-500 bg-orange-500/5 dark:bg-orange-500/10 shadow-md shadow-orange-500/10'
                      : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div
                      className={`h-6 w-6 rounded-full flex items-center justify-center border-2 transition-all ${
                        isSelected
                          ? 'border-orange-500 bg-orange-500 text-white'
                          : 'border-slate-300 dark:border-slate-600'
                      }`}
                    >
                      {isSelected && <CheckCircle2 className="h-4 w-4 fill-current stroke-[2.5]" />}
                    </div>
                    <div>
                      <p className="text-xs font-black">{cls.name}</p>
                      <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">
                        STUDENTS: {studentCount} UNITS
                      </p>
                    </div>
                  </div>

                  <span className="px-3 py-1 rounded-xl bg-orange-500 text-white font-black text-xs shadow-md shadow-orange-500/20">
                    Rs. {cls.monthlyFee}
                  </span>
                </div>
              );
            })
          )}
        </div>

        {/* Confirm Action Button */}
        <button
          type="button"
          onClick={handleConfirm}
          className="w-full py-3.5 rounded-2xl bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 active:scale-95 text-white font-black text-xs shadow-lg shadow-orange-500/30 transition-all flex items-center justify-center gap-1.5"
        >
          <CheckCircle2 className="h-4 w-4 stroke-[2.5]" /> OK
        </button>
      </div>
    </div>
  );
}

// ==========================================
// PREMIUM MONTH SELECTION MODAL
// ==========================================
interface MonthSelectModalProps {
  isOpen: boolean;
  onClose: () => void;
  availableMonths: { key: string; label: string }[];
  selectedMonthKey: string;
  onSelectMonth: (key: string) => void;
}

function MonthSelectModal({
  isOpen,
  onClose,
  availableMonths,
  selectedMonthKey,
  onSelectMonth,
}: MonthSelectModalProps) {
  const [tempSelected, setTempSelected] = useState(selectedMonthKey);

  useEffect(() => {
    setTempSelected(selectedMonthKey);
  }, [selectedMonthKey, isOpen]);

  if (!isOpen) return null;

  const handleConfirm = () => {
    if (tempSelected) {
      onSelectMonth(tempSelected);
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-md p-4 animate-in fade-in duration-200">
      <div className="w-full max-w-md bg-white dark:bg-[#0c1222] border-2 border-orange-500/50 rounded-3xl p-6 shadow-[0_0_50px_rgba(249,115,22,0.25)] space-y-5 text-slate-900 dark:text-slate-100 relative">
        {/* Header */}
        <div className="flex items-start justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-2xl bg-orange-500 text-white shadow-lg shadow-orange-500/30">
              <Wallet className="h-6 w-6 stroke-[2.2]" />
            </div>
            <div>
              <h3 className="text-base font-black tracking-tight">Select Month</h3>
              <p className="text-[11px] text-slate-400 font-bold">
                Choose fee month ({availableMonths.length} Active Months)
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-full text-slate-400 hover:text-slate-200 bg-slate-100 dark:bg-slate-800 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Month Cards */}
        <div className="max-h-60 overflow-y-auto space-y-3 pr-1">
          {availableMonths.map((m) => {
            const isSelected = tempSelected === m.key;

            return (
              <div
                key={m.key}
                onClick={() => setTempSelected(m.key)}
                className={`p-4 rounded-2xl border-2 cursor-pointer transition-all flex items-center justify-between ${
                  isSelected
                    ? 'border-orange-500 bg-orange-500/5 dark:bg-orange-500/10 shadow-md shadow-orange-500/10'
                    : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
                }`}
              >
                <div className="flex items-center gap-3">
                  <div
                    className={`h-6 w-6 rounded-full flex items-center justify-center border-2 transition-all ${
                      isSelected
                        ? 'border-orange-500 bg-orange-500 text-white'
                        : 'border-slate-300 dark:border-slate-600'
                    }`}
                  >
                    {isSelected && <CheckCircle2 className="h-4 w-4 fill-current stroke-[2.5]" />}
                  </div>
                  <div>
                    <p className="text-xs font-black flex items-center gap-1.5">
                      📅 {m.label}
                    </p>
                    <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">
                      DYNAMIC 2-MONTH SYSTEM RECORD
                    </p>
                  </div>
                </div>

                {isSelected && (
                  <span className="px-3 py-1 rounded-xl bg-orange-500 text-white font-black text-[10px] uppercase shadow-md shadow-orange-500/20">
                    ACTIVE
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {/* Confirm Action Button */}
        <button
          type="button"
          onClick={handleConfirm}
          className="w-full py-3.5 rounded-2xl bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 active:scale-95 text-white font-black text-xs shadow-lg shadow-orange-500/30 transition-all flex items-center justify-center gap-1.5"
        >
          <CheckCircle2 className="h-4 w-4 stroke-[2.5]" /> OK
        </button>
      </div>
    </div>
  );
}

// ==========================================
// SHOWPIECE CAPTURE SETTINGS MODAL
// ==========================================
interface CaptureSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  criteria: CaptureCriteria;
  onSaveCriteria: (selected: CaptureCriteria) => void;
}

function CustomCaptureSettingsModal({
  isOpen,
  onClose,
  criteria,
  onSaveCriteria,
}: CaptureSettingsModalProps) {
  const [selected, setSelected] = useState<CaptureCriteria>(criteria);

  useEffect(() => {
    setSelected(criteria);
  }, [criteria]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-md p-4 animate-in fade-in duration-200">
      <div className="w-full max-w-md bg-white dark:bg-[#0c1222] border-2 border-orange-500/50 rounded-3xl p-6 shadow-[0_0_40px_rgba(249,115,22,0.25)] space-y-5 text-slate-900 dark:text-slate-100 relative">
        <div className="flex items-start justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-2xl bg-orange-500/10 text-orange-500 border border-orange-500/20">
              <Settings className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-black flex items-center gap-1.5">
                Capture Settings <Sparkles className="h-4 w-4 text-orange-500 fill-orange-500" />
              </h3>
              <p className="text-[10px] text-slate-400 font-bold">
                Choose evaluation rule for 4 student categories
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-full text-slate-400 hover:text-slate-200 bg-slate-100 dark:bg-slate-800 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3">
          <div
            onClick={() => setSelected('Weighted Score')}
            className={`p-4 rounded-2xl border cursor-pointer transition-all relative ${
              selected === 'Weighted Score' || selected === 'overallScore'
                ? 'border-orange-500 bg-orange-500/5 dark:bg-orange-500/10 shadow-md shadow-orange-500/10'
                : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
            }`}
          >
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <Award className="h-4 w-4 text-orange-500" />
                <span className="text-xs font-black">Weighted Score Formula</span>
                <span className="text-[9px] font-black uppercase bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-300 px-2 py-0.5 rounded-md">
                  RECOMMENDED
                </span>
              </div>
              <div
                className={`h-5 w-5 rounded-full flex items-center justify-center border ${
                  selected === 'Weighted Score' || selected === 'overallScore'
                    ? 'bg-orange-500 border-orange-500 text-white'
                    : 'border-slate-300 dark:border-slate-600'
                }`}
              >
                {(selected === 'Weighted Score' || selected === 'overallScore') && (
                  <CheckCircle2 className="h-3.5 w-3.5 fill-current" />
                )}
              </div>
            </div>
            <p className="text-[10px] text-slate-400 font-bold leading-relaxed pl-6">
              Calculates top 4 representatives using 40% Attendance + 60% Quiz Marks weighting.
            </p>
          </div>

          <div
            onClick={() => setSelected('Quiz Marks')}
            className={`p-4 rounded-2xl border cursor-pointer transition-all relative ${
              selected === 'Quiz Marks'
                ? 'border-orange-500 bg-orange-500/5 dark:bg-orange-500/10 shadow-md shadow-orange-500/10'
                : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
            }`}
          >
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <GraduationCap className="h-4 w-4 text-blue-500" />
                <span className="text-xs font-black">Quiz Marks Priority</span>
                <span className="text-[9px] font-black uppercase bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-300 px-2 py-0.5 rounded-md">
                  ACADEMIC
                </span>
              </div>
              <div
                className={`h-5 w-5 rounded-full flex items-center justify-center border ${
                  selected === 'Quiz Marks'
                    ? 'bg-orange-500 border-orange-500 text-white'
                    : 'border-slate-300 dark:border-slate-600'
                }`}
              >
                {selected === 'Quiz Marks' && <CheckCircle2 className="h-3.5 w-3.5 fill-current" />}
              </div>
            </div>
            <p className="text-[10px] text-slate-400 font-bold leading-relaxed pl-6">
              Captures representative students strictly based on their total quiz performance.
            </p>
          </div>

          <div
            onClick={() => setSelected('Attendance Rate')}
            className={`p-4 rounded-2xl border cursor-pointer transition-all relative ${
              selected === 'Attendance Rate'
                ? 'border-orange-500 bg-orange-500/5 dark:bg-orange-500/10 shadow-md shadow-orange-500/10'
                : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
            }`}
          >
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                <span className="text-xs font-black">Attendance Priority</span>
                <span className="text-[9px] font-black uppercase bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-300 px-2 py-0.5 rounded-md">
                  REGULARITY
                </span>
              </div>
              <div
                className={`h-5 w-5 rounded-full flex items-center justify-center border ${
                  selected === 'Attendance Rate'
                    ? 'bg-orange-500 border-orange-500 text-white'
                    : 'border-slate-300 dark:border-slate-600'
                }`}
              >
                {selected === 'Attendance Rate' && <CheckCircle2 className="h-3.5 w-3.5 fill-current" />}
              </div>
            </div>
            <p className="text-[10px] text-slate-400 font-bold leading-relaxed pl-6">
              Filter student categories purely based on their overall attendance logs.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 py-3 rounded-2xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 font-black text-xs transition-all"
          >
            Cancel
          </button>

          <button
            type="button"
            onClick={() => onSaveCriteria(selected)}
            className="flex-1 py-3 rounded-2xl bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 active:scale-95 text-white font-black text-xs shadow-lg shadow-orange-500/30 transition-all"
          >
            Save Criteria
          </button>
        </div>
      </div>
    </div>
  );
}

// ==========================================
// BOTTOM NAVBAR COMPONENT
// ==========================================
function BottomNavbar() {
  const location = useLocation();

  const navigationTabs = [
    { id: 'home', label: 'Home', icon: Home, href: '/' },
    {
      id: 'classes',
      label: 'Classes',
      icon: GraduationCap,
      href: '/departments',
    },
    {
      id: 'attendance',
      label: 'Attendance',
      icon: Users,
      href: '/attendance',
    },
    {
      id: 'fees',
      label: 'Fees',
      icon: Wallet,
      href: '/fees',
    },
    {
      id: 'settings',
      label: 'Settings',
      icon: Settings,
      href: '/settings',
    },
  ];

  return (
    <div className="fixed bottom-4 left-0 right-0 z-50 flex justify-center px-4 pointer-events-none">
      <nav className="pointer-events-auto bg-white/95 dark:bg-[#0c1222]/95 backdrop-blur-xl border border-slate-200/80 dark:border-slate-800 shadow-[0_10px_40px_rgba(0,0,0,0.12)] rounded-full px-5 py-2 flex items-center justify-between gap-6 max-w-md w-full">
        {navigationTabs.map((tab) => {
          const Icon = tab.icon;
          const isActive =
            location.pathname === tab.href ||
            (tab.id === 'fees' && location.pathname.includes('/fees'));

          return (
            <Link
              key={tab.id}
              to={tab.href}
              className="flex flex-col items-center relative transition-transform active:scale-95"
            >
              {isActive && (
                <span className="absolute -top-1 w-1.5 h-1.5 bg-orange-500 rounded-full animate-pulse" />
              )}

              <div
                className={`flex items-center justify-center transition-all duration-300 ${
                  isActive
                    ? 'w-10 h-10 rounded-full bg-orange-500 text-white shadow-lg shadow-orange-500/40 scale-105'
                    : 'w-10 h-10 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
                }`}
              >
                <Icon className="h-5 w-5 stroke-[2.2]" />
              </div>

              <span
                className={`text-[10px] font-bold mt-1 ${
                  isActive ? 'text-orange-500' : 'text-slate-400'
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

// ==========================================
// MAIN ANALYTICS PAGE COMPONENT
// ==========================================
export default function AnalyticsPage() {
  const navigate = useNavigate();
  const [isDark, setIsDark] = useState(false);
  const [loading, setLoading] = useState(true);
  const [fetchingMetrics, setFetchingMetrics] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const [classesSource, setClassesSource] = useState({
    status: 'loading' as LiveStatus, hasSnapshot: false, serverSynced: false, error: null as string | null, scopeKey: undefined as string | undefined,
  });
  const [attendanceSource, setAttendanceSource] = useState<LiveCollectionSource>(emptyCollectionSource());
  const [legacyAttendanceSource, setLegacyAttendanceSource] = useState<LiveCollectionSource>(emptyCollectionSource());
  const [dailyLegacyAttendanceSource, setDailyLegacyAttendanceSource] = useState<LiveCollectionSource>(emptyCollectionSource('idle'));
  const [quizSource, setQuizSource] = useState<LiveCollectionSource>(emptyCollectionSource());
  const [feeSource, setFeeSource] = useState<LiveDocumentSource>(emptyDocumentSource());
  const [monthlyPaymentsSource, setMonthlyPaymentsSource] = useState<LiveCollectionSource>(emptyCollectionSource());
  const [dailyPaymentsSource, setDailyPaymentsSource] = useState<LiveCollectionSource>(emptyCollectionSource('idle'));

  // Authenticated User Email State
  const [userEmail, setUserEmail] = useState<string | null>(null);

  // Firestore Classes State
  const [classesList, setClassesList] = useState<any[]>([]);
  const [selectedClassId, setSelectedClassId] = useState<string>('');

  // Premium Select Modal States
  const [isClassModalOpen, setIsClassModalOpen] = useState(false);
  const [isMonthModalOpen, setIsMonthModalOpen] = useState(false);

  // Resolve the current Firebase identity to its existing email-based tenant.
  // A present profile is verified against the authenticated UID/email and disabled flags.
  // A missing email profile is allowed only for legacy tenants, matching Departments.
  useEffect(() => {
    let disposed = false;
    let authGeneration = 0;

    const clearTenantData = () => {
      setUserEmail(null);
      setClassesList([]);
      setSelectedClassId('');
      setSelectedMonthKey('');
      setFeeDetailedStudents([]);
      setCaptureMetricSnapshot(null);
      setMetrics({ ...EMPTY_METRICS });
      setTrendDataPoints([0, 0, 0, 0, 0, 0, 0]);
      setNoDataNotification(null);
      setClassesSource({ status: 'loading', hasSnapshot: false, serverSynced: false, error: null, scopeKey: undefined });
      setAttendanceSource(emptyCollectionSource());
      setLegacyAttendanceSource(emptyCollectionSource());
      setDailyLegacyAttendanceSource(emptyCollectionSource('idle'));
      setQuizSource(emptyCollectionSource());
      setFeeSource(emptyDocumentSource());
      setMonthlyPaymentsSource(emptyCollectionSource());
      setDailyPaymentsSource(emptyCollectionSource('idle'));
    };

    const unsubscribeAuth = onAuthStateChanged(auth, async (user) => {
      const generation = ++authGeneration;
      clearTenantData();
      setLoading(Boolean(user));

      if (!user?.uid) {
        setLoading(false);
        return;
      }

      const normalizedEmail = String(user.email ?? '').toLowerCase().trim();
      const tenantId = normalizedEmail || user.uid;
      if (!tenantId || tenantId.includes('/')) {
        setNoDataNotification('Your account does not have a valid teacher workspace.');
        setLoading(false);
        console.error('[Analytics] Refusing to load data because the tenant path is invalid.');
        return;
      }

      try {
        const profileSnap = await getDoc(doc(db, 'users', tenantId));
        if (disposed || generation !== authGeneration) return;

        if (!profileSnap.exists() && !normalizedEmail) {
          throw new Error('No teacher profile was found for this account.');
        }

        if (profileSnap.exists()) {
          const profile = profileSnap.data() || {};
          const ownerIds = [profile.uid, profile.authUid, profile.ownerUid, profile.userId]
            .filter((value) => typeof value === 'string' && value.trim() !== '');
          if (ownerIds.length > 0 && !ownerIds.includes(user.uid)) {
            throw new Error('This workspace belongs to a different account.');
          }
          if (typeof profile.email === 'string' && profile.email.trim() && normalizedEmail &&
              profile.email.toLowerCase().trim() !== normalizedEmail) {
            throw new Error('This workspace belongs to a different account.');
          }
          if (profile.role !== undefined && String(profile.role).trim().toLowerCase() !== 'teacher') {
            throw new Error('This account is not authorized to open teacher analytics.');
          }
          if (profile.disabled === true || profile.active === false || profile.deleted === true) {
            throw new Error('This teacher account is disabled.');
          }
        }

        if (disposed || generation !== authGeneration) return;
        setUserEmail(tenantId);
        setLoading(true);
      } catch (error: any) {
        if (disposed || generation !== authGeneration) return;
        clearTenantData();
        setLoading(false);
        const message = error?.code === 'permission-denied'
          ? 'Access denied while verifying your teacher workspace. Check Firestore Security Rules.'
          : error?.code === 'unavailable' || error?.code === 'deadline-exceeded'
          ? 'Network problem while verifying your teacher workspace. Please retry.'
          : String(error?.message || 'Could not verify your teacher workspace.');
        setNoDataNotification(message);
        console.error('[Analytics] Tenant verification failed:', error);
      }
    });

    return () => {
      disposed = true;
      authGeneration++;
      unsubscribeAuth();
    };
  }, [retryNonce]);

  // Dynamic Class Creation Date Based Months
  const currentClass = useMemo(() => {
    return classesList.find((c) => c.id === selectedClassId) || null;
  }, [selectedClassId, classesList]);

  const availableMonths = useMemo(() => {
    return getMonthsForClass(currentClass?.createdAt);
  }, [currentClass]);

  const [selectedMonthKey, setSelectedMonthKey] = useState<string>('');

  // Ensure selectedMonthKey updates when availableMonths changes
  useEffect(() => {
    if (availableMonths.length > 0) {
      const exists = availableMonths.some((m) => m.key === selectedMonthKey);
      if (!exists) {
        setSelectedMonthKey(availableMonths[0].key);
      }
    }
  }, [availableMonths, selectedMonthKey]);

  // Filter Mode: 'month' vs 'daily'
  const [analyticsType, setAnalyticsType] = useState<'month' | 'daily'>('month');

  // Selected Date for Daily Analytics
  const [selectedDate, setSelectedDate] = useState<string>(() => getLocalTodayKey());

  // Dynamic No-Data Notification State
  const [noDataNotification, setNoDataNotification] = useState<string | null>(null);

  // 4 Students Capture Settings
  const [captureCriteria, setCaptureCriteria] = useState<CaptureCriteria>('Weighted Score');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  // SHOWPIECE GLOWING TOAST STATE
  const [showSuccessToast, setShowSuccessToast] = useState(false);

  // Paid/Unpaid Fee Detail Modal State
  const [isFeeModalOpen, setIsFeeModalOpen] = useState(false);
  const [feeModalFilter, setFeeModalFilter] = useState<'ALL' | 'PAID' | 'UNPAID'>('ALL');
  const [feeDetailedStudents, setFeeDetailedStudents] = useState<FeeDetailStudent[]>([]);

  // Live Weekly Trend Data Points
  const [trendDataPoints, setTrendDataPoints] = useState<number[]>([70, 65, 80, 75, 60, 85, 90]);

  // Dynamic Metrics State
  const [metrics, setMetrics] = useState({ ...EMPTY_METRICS });
  const [captureMetricSnapshot, setCaptureMetricSnapshot] = useState<{
    contextKey: string;
    values: Record<string, { attendanceRate: number | null; quizMarks: number | null; weightedScore: number | null; overallScore: number | null }>;
  } | null>(null);

  // SHOWPIECE SAVE CRITERIA HANDLER
  const handleSaveCriteriaShowpiece = (selected: CaptureCriteria) => {
    setCaptureCriteria(selected);
    setIsSettingsOpen(false);

    setShowSuccessToast(true);

    setTimeout(() => {
      setShowSuccessToast(false);
    }, 2500);
  };

  // 1. Listen only to this verified teacher's class subcollection. Cache snapshots are
  // usable as provisional data, but only a non-cache snapshot marks the source server-synced.
  useEffect(() => {
    let cancelled = false;

    if (!userEmail) {
      setClassesList([]);
      setSelectedClassId('');
      setClassesSource({ status: 'loading', hasSnapshot: false, serverSynced: false, error: null, scopeKey: undefined });
      return;
    }

    setLoading(true);
    setClassesList([]);
    setSelectedClassId('');
    setClassesSource({ status: 'loading', hasSnapshot: false, serverSynced: false, error: null, scopeKey: userEmail });
    setCaptureMetricSnapshot(null);
    setMetrics({ ...EMPTY_METRICS });

    const classesRef = collection(db, 'users', userEmail, 'classes');
    const unsubscribe = onSnapshot(
      classesRef,
      { includeMetadataChanges: true },
      (snapshot) => {
        if (cancelled) return;
        const serverSynced = !snapshot.metadata.fromCache;
        const loadedClasses = snapshot.docs.map((docSnap) => {
          const data = docSnap.data() || {};
          const fee = parseNonNegativeNumber(data.monthlyFee ?? data.fee ?? data.classFee);
          return {
            id: docSnap.id, // Firestore document ID is authoritative.
            name: String(data.name ?? data.className ?? data.title ?? 'Unnamed Class'),
            code: String(data.code ?? data.classCode ?? ''),
            monthlyFee: fee ?? 0,
            students: extractAnalyticsStudents(data),
            createdAt: data.createdAt ?? data.createdDate ?? null,
          };
        });

        loadedClasses.sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
        );
        setClassesSource({
          status: serverSynced ? 'ready' : 'loading',
          hasSnapshot: true,
          serverSynced,
          error: null,
          scopeKey: userEmail,
        });
        setClassesList(loadedClasses);
        setSelectedClassId((previous) =>
          previous && loadedClasses.some((item) => item.id === previous)
            ? previous
            : loadedClasses[0]?.id || ''
        );
        setLoading(false);
      },
      (error: any) => {
        if (cancelled) return;
        const message = describeFirestoreError(`Classes (users/${userEmail}/classes)`, error);
        console.error('[Analytics] Class listener failed:', error?.code, error?.message, error);
        setClassesSource((previous) => ({ ...previous, status: 'error', error: message }));
        setNoDataNotification(message);
        setLoading(false);
      }
    );

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [userEmail, retryNonce]);

  // Ensure selectedClassId stays valid
  useEffect(() => {
    if (classesList.length > 0) {
      const exists = classesList.some((c) => c.id === selectedClassId);
      if (!exists) {
        setSelectedClassId(classesList[0].id);
      }
    }
  }, [classesList, selectedClassId]);

  const normalizedSelectedDate = normalizeDate(selectedDate);
  const selectedDateMonth = normalizedSelectedDate ? normalizedSelectedDate.slice(0, 7) : '';
  const needsCrossMonthDailySources = analyticsType === 'daily' && Boolean(selectedDateMonth) && selectedDateMonth !== selectedMonthKey;
  const baseScopeKey = `${userEmail ?? ''}::${selectedClassId}::${selectedMonthKey}`;
  const dailySourceScopeKey = `${baseScopeKey}::${normalizedSelectedDate}::${selectedDateMonth}`;

  // 2. Live subscriptions for the current teacher, class, and Record Month.
  // All paths remain under users/{authenticatedTeacherEmail}; no global fallback is used.
  useEffect(() => {
    let cancelled = false;
    const unsubscribers: Array<() => void> = [];
    const contextIsValid = Boolean(userEmail && selectedClassId && selectedMonthKey);

    setAttendanceSource({ ...emptyCollectionSource(), scopeKey: baseScopeKey });
    setLegacyAttendanceSource({ ...emptyCollectionSource(), scopeKey: baseScopeKey });
    setQuizSource({ ...emptyCollectionSource(), scopeKey: baseScopeKey });
    setFeeSource({ ...emptyDocumentSource(), scopeKey: baseScopeKey });
    setMonthlyPaymentsSource({ ...emptyCollectionSource(), scopeKey: baseScopeKey });
    setFeeDetailedStudents([]);
    setCaptureMetricSnapshot(null);
    setMetrics({ ...EMPTY_METRICS });
    setTrendDataPoints([0, 0, 0, 0, 0, 0, 0]);

    if (!contextIsValid || !userEmail || !selectedClassId || !selectedMonthKey) {
      return () => { cancelled = true; };
    }

    const attendanceCollection = collection(db, 'users', userEmail, 'attendance');
    const classAttendanceQuery = query(attendanceCollection, where('classId', '==', selectedClassId));
    const unsubscribeAttendance = onSnapshot(
      classAttendanceQuery,
      { includeMetadataChanges: true },
      (snapshot) => {
        if (cancelled) return;
        const serverSynced = !snapshot.metadata.fromCache;
        setAttendanceSource({
          status: serverSynced ? 'ready' : 'loading',
          hasSnapshot: true,
          serverSynced,
          docs: snapshot.docs,
          error: null,
          scopeKey: baseScopeKey,
        });
      },
      (error: any) => {
        if (cancelled) return;
        const message = describeFirestoreError(`Attendance for class ${selectedClassId}`, error);
        console.error('[Analytics] Attendance listener failed:', error?.code, error?.message, error);
        setAttendanceSource((previous) => ({ ...previous, status: 'error', error: message }));
      }
    );
    unsubscribers.push(unsubscribeAttendance);

    // Legacy records are not guaranteed to have classId/date fields. Probe only document IDs
    // supported by the existing class-prefixed date normalizer for dates in this report month.
    const legacyIds = legacyAttendanceIdsForDates(selectedClassId, dateKeysForMonth(selectedMonthKey));
    const legacyChunks: string[][] = [];
    for (let i = 0; i < legacyIds.length; i += 25) legacyChunks.push(legacyIds.slice(i, i + 25));
    if (legacyChunks.length === 0) {
      setLegacyAttendanceSource({ ...emptyCollectionSource('ready'), hasSnapshot: true, serverSynced: true, scopeKey: baseScopeKey });
    } else {
      const batchDocs = new Map<number, Map<string, any>>();
      const batchCacheState = new Map<number, boolean>();
      const seenBatches = new Set<number>();
      const batchErrors = new Map<number, string>();
      const publishLegacyState = () => {
        const docsById = new Map<string, any>();
        batchDocs.forEach((docs) => docs.forEach((value, id) => docsById.set(id, value)));
        const allSeen = seenBatches.size === legacyChunks.length;
        const error = [...batchErrors.values()][0] ?? null;
        const allServerSynced = allSeen && !error && legacyChunks.every((_chunk, index) => batchCacheState.get(index) === false);
        setLegacyAttendanceSource({
          status: error ? 'error' : allServerSynced ? 'ready' : 'loading',
          hasSnapshot: allSeen,
          serverSynced: allServerSynced,
          docs: [...docsById.values()],
          error,
          scopeKey: baseScopeKey,
        });
      };
      legacyChunks.forEach((chunk, index) => {
        const legacyQuery = query(attendanceCollection, where(documentId(), 'in', chunk));
        const unsubscribe = onSnapshot(
          legacyQuery,
          { includeMetadataChanges: true },
          (snapshot) => {
            if (cancelled) return;
            const docs = new Map<string, any>();
            snapshot.docs.forEach((docSnap) => docs.set(docSnap.id, docSnap));
            batchDocs.set(index, docs);
            batchCacheState.set(index, snapshot.metadata.fromCache);
            seenBatches.add(index);
            batchErrors.delete(index);
            publishLegacyState();
          },
          (error: any) => {
            if (cancelled) return;
            const message = describeFirestoreError(`Legacy attendance compatibility query ${index + 1}`, error);
            console.error('[Analytics] Legacy attendance query failed:', error?.code, error?.message, error);
            batchErrors.set(index, message);
            publishLegacyState();
          }
        );
        unsubscribers.push(unsubscribe);
      });
    }

    const quizCollection = collection(db, 'users', userEmail, 'classes', selectedClassId, 'quizzes');
    unsubscribers.push(onSnapshot(
      quizCollection,
      { includeMetadataChanges: true },
      (snapshot) => {
        if (cancelled) return;
        const serverSynced = !snapshot.metadata.fromCache;
        setQuizSource({
          status: serverSynced ? 'ready' : 'loading',
          hasSnapshot: true,
          serverSynced,
          docs: snapshot.docs,
          error: null,
          scopeKey: baseScopeKey,
        });
      },
      (error: any) => {
        if (cancelled) return;
        const message = describeFirestoreError(`Quizzes for class ${selectedClassId}`, error);
        console.error('[Analytics] Quiz listener failed:', error?.code, error?.message, error);
        setQuizSource((previous) => ({ ...previous, status: 'error', error: message }));
      }
    ));

    const targetFeeDocId = `${selectedClassId}_${selectedMonthKey}`;
    const feeDocRef = doc(db, 'users', userEmail, 'fees', targetFeeDocId);
    unsubscribers.push(onSnapshot(
      feeDocRef,
      { includeMetadataChanges: true },
      (snapshot) => {
        if (cancelled) return;
        const serverSynced = !snapshot.metadata.fromCache;
        const data = snapshot.exists() ? (snapshot.data() || {}) : null;
        let validationError: string | null = null;
        if (data && data.classId !== undefined && String(data.classId) !== selectedClassId) {
          validationError = `Fee document ${targetFeeDocId} has classId ${String(data.classId)}, which does not match its path.`;
        } else if (data && data.month !== undefined && normalizeMonthKey(data.month) !== selectedMonthKey) {
          validationError = `Fee document ${targetFeeDocId} has month ${String(data.month)}, which does not match ${selectedMonthKey}.`;
        }
        const identityValid = !validationError;
        const message = validationError ? `Fee data — ${validationError} Analytics excluded this document.` : null;
        if (message) console.error('[Analytics] Invalid fee document:', message);
        setFeeSource({
          status: message ? 'error' : serverSynced ? 'ready' : 'loading',
          hasSnapshot: true,
          serverSynced,
          data: identityValid ? data : null,
          exists: identityValid && snapshot.exists(),
          validData: identityValid,
          error: message,
          scopeKey: baseScopeKey,
        });
      },
      (error: any) => {
        if (cancelled) return;
        const message = describeFirestoreError(`Fee document ${targetFeeDocId}`, error);
        console.error('[Analytics] Fee document listener failed:', error?.code, error?.message, error);
        setFeeSource((previous) => ({ ...previous, status: 'error', error: message }));
      }
    ));

    const paymentCollection = collection(db, 'users', userEmail, 'fees', targetFeeDocId, 'payments');
    unsubscribers.push(onSnapshot(
      paymentCollection,
      { includeMetadataChanges: true },
      (snapshot) => {
        if (cancelled) return;
        const serverSynced = !snapshot.metadata.fromCache;
        setMonthlyPaymentsSource({
          status: serverSynced ? 'ready' : 'loading',
          hasSnapshot: true,
          serverSynced,
          docs: snapshot.docs,
          error: null,
          scopeKey: baseScopeKey,
        });
      },
      (error: any) => {
        if (cancelled) return;
        const message = describeFirestoreError(`Payment receipts for ${targetFeeDocId}`, error);
        console.error('[Analytics] Monthly payment listener failed:', error?.code, error?.message, error);
        setMonthlyPaymentsSource((previous) => ({ ...previous, status: 'error', error: message }));
      }
    ));

    return () => {
      cancelled = true;
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [userEmail, selectedClassId, selectedMonthKey, baseScopeKey, retryNonce]);

  // 3. Subscribe only to legacy attendance IDs for a selected day outside Record Month, and
  // receipts beneath that day's actual fee-month document. The base month listeners are retained.
  useEffect(() => {
    let cancelled = false;
    const unsubscribers: Array<() => void> = [];
    setDailyLegacyAttendanceSource({ ...emptyCollectionSource(needsCrossMonthDailySources ? 'loading' : 'idle'), scopeKey: needsCrossMonthDailySources ? dailySourceScopeKey : undefined });
    setDailyPaymentsSource({ ...emptyCollectionSource(needsCrossMonthDailySources ? 'loading' : 'idle'), scopeKey: needsCrossMonthDailySources ? dailySourceScopeKey : undefined });

    if (!userEmail || !selectedClassId || !selectedMonthKey || !needsCrossMonthDailySources || !selectedDateMonth) {
      return () => { cancelled = true; };
    }

    const attendanceCollection = collection(db, 'users', userEmail, 'attendance');
    const dayLegacyIds = legacyAttendanceIdsForDates(selectedClassId, [normalizedSelectedDate]);
    const batches: string[][] = [];
    for (let i = 0; i < dayLegacyIds.length; i += 25) batches.push(dayLegacyIds.slice(i, i + 25));
    if (batches.length === 0) {
      setDailyLegacyAttendanceSource({ ...emptyCollectionSource('ready'), hasSnapshot: true, serverSynced: true, scopeKey: dailySourceScopeKey });
    } else {
      const batchDocs = new Map<number, Map<string, any>>();
      const batchCacheState = new Map<number, boolean>();
      const seenBatches = new Set<number>();
      const batchErrors = new Map<number, string>();
      const publish = () => {
        const docsById = new Map<string, any>();
        batchDocs.forEach((docs) => docs.forEach((value, id) => docsById.set(id, value)));
        const allSeen = seenBatches.size === batches.length;
        const error = [...batchErrors.values()][0] ?? null;
        const serverSynced = allSeen && !error && batches.every((_chunk, index) => batchCacheState.get(index) === false);
        setDailyLegacyAttendanceSource({
          status: error ? 'error' : serverSynced ? 'ready' : 'loading',
          hasSnapshot: allSeen,
          serverSynced,
          docs: [...docsById.values()],
          error,
          scopeKey: dailySourceScopeKey,
        });
      };
      batches.forEach((chunk, index) => {
        unsubscribers.push(onSnapshot(
          query(attendanceCollection, where(documentId(), 'in', chunk)),
          { includeMetadataChanges: true },
          (snapshot) => {
            if (cancelled) return;
            const docs = new Map<string, any>();
            snapshot.docs.forEach((docSnap) => docs.set(docSnap.id, docSnap));
            batchDocs.set(index, docs);
            batchCacheState.set(index, snapshot.metadata.fromCache);
            seenBatches.add(index);
            batchErrors.delete(index);
            publish();
          },
          (error: any) => {
            if (cancelled) return;
            const message = describeFirestoreError(`Legacy attendance for ${normalizedSelectedDate}`, error);
            console.error('[Analytics] Daily legacy attendance query failed:', error?.code, error?.message, error);
            batchErrors.set(index, message);
            publish();
          }
        ));
      });
    }

    const targetDailyFeeDocId = `${selectedClassId}_${selectedDateMonth}`;
    const dailyPaymentCollection = collection(db, 'users', userEmail, 'fees', targetDailyFeeDocId, 'payments');
    unsubscribers.push(onSnapshot(
      dailyPaymentCollection,
      { includeMetadataChanges: true },
      (snapshot) => {
        if (cancelled) return;
        const serverSynced = !snapshot.metadata.fromCache;
        setDailyPaymentsSource({
          status: serverSynced ? 'ready' : 'loading',
          hasSnapshot: true,
          serverSynced,
          docs: snapshot.docs,
          error: null,
          scopeKey: dailySourceScopeKey,
        });
      },
      (error: any) => {
        if (cancelled) return;
        const message = describeFirestoreError(`Daily payment receipts for ${targetDailyFeeDocId}`, error);
        console.error('[Analytics] Cross-month daily payment listener failed:', error?.code, error?.message, error);
        setDailyPaymentsSource((previous) => ({ ...previous, status: 'error', error: message }));
      }
    ));

    return () => {
      cancelled = true;
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [userEmail, selectedClassId, selectedMonthKey, normalizedSelectedDate, selectedDateMonth, needsCrossMonthDailySources, dailySourceScopeKey, retryNonce]);

  const sourceErrorNotification = useMemo(() => {
    const messages = [
      classesSource.scopeKey === userEmail ? classesSource.error : null,
      attendanceSource.scopeKey === baseScopeKey ? attendanceSource.error : null,
      legacyAttendanceSource.scopeKey === baseScopeKey ? legacyAttendanceSource.error : null,
      quizSource.scopeKey === baseScopeKey ? quizSource.error : null,
      feeSource.scopeKey === baseScopeKey ? feeSource.error : null,
      monthlyPaymentsSource.scopeKey === baseScopeKey ? monthlyPaymentsSource.error : null,
      ...(needsCrossMonthDailySources ? [
        dailyLegacyAttendanceSource.scopeKey === dailySourceScopeKey ? dailyLegacyAttendanceSource.error : null,
        dailyPaymentsSource.scopeKey === dailySourceScopeKey ? dailyPaymentsSource.error : null,
      ] : []),
    ].filter((message): message is string => Boolean(message));
    return messages[0] ?? null;
  }, [
    classesSource.error, classesSource.scopeKey, userEmail, baseScopeKey,
    attendanceSource.error, attendanceSource.scopeKey, legacyAttendanceSource.error, legacyAttendanceSource.scopeKey,
    quizSource.error, quizSource.scopeKey, feeSource.error, feeSource.scopeKey,
    monthlyPaymentsSource.error, monthlyPaymentsSource.scopeKey, needsCrossMonthDailySources,
    dailyLegacyAttendanceSource.error, dailyLegacyAttendanceSource.scopeKey,
    dailyPaymentsSource.error, dailyPaymentsSource.scopeKey, dailySourceScopeKey,
  ]);

  const canRetrySync = Boolean(sourceErrorNotification || (noDataNotification && !noDataNotification.startsWith('No recorded attendance or payment receipts found')));

  const isLiveConnected = Boolean(
    userEmail && selectedClassId && selectedMonthKey &&
    classesSource.scopeKey === userEmail && classesSource.status === 'ready' && classesSource.serverSynced &&
    attendanceSource.scopeKey === baseScopeKey && attendanceSource.status === 'ready' && attendanceSource.serverSynced &&
    legacyAttendanceSource.scopeKey === baseScopeKey && legacyAttendanceSource.status === 'ready' && legacyAttendanceSource.serverSynced &&
    quizSource.scopeKey === baseScopeKey && quizSource.status === 'ready' && quizSource.serverSynced &&
    feeSource.scopeKey === baseScopeKey && feeSource.status === 'ready' && feeSource.serverSynced && feeSource.validData &&
    monthlyPaymentsSource.scopeKey === baseScopeKey && monthlyPaymentsSource.status === 'ready' && monthlyPaymentsSource.serverSynced &&
    (!needsCrossMonthDailySources || (
      dailyLegacyAttendanceSource.scopeKey === dailySourceScopeKey && dailyLegacyAttendanceSource.status === 'ready' && dailyLegacyAttendanceSource.serverSynced &&
      dailyPaymentsSource.scopeKey === dailySourceScopeKey && dailyPaymentsSource.status === 'ready' && dailyPaymentsSource.serverSynced
    ))
  );

  useEffect(() => {
    setFetchingMetrics(Boolean(userEmail && selectedClassId && selectedMonthKey && !isLiveConnected));
  }, [userEmail, selectedClassId, selectedMonthKey, isLiveConnected]);

  // 4. Recompute locally from the latest listener snapshots. No source update triggers another read.
  // Each category has its own availability gate, so a failing quiz listener cannot erase attendance.
  const analyticsContextKey = `${userEmail ?? ''}::${selectedClassId}::${selectedMonthKey}::${analyticsType}::${analyticsType === 'daily' ? normalizedSelectedDate : ''}`;
  const [metricsContextKey, setMetricsContextKey] = useState('');

  // These memoized transforms are isolated by source/context. A fee receipt update won't
  // repeatedly process the complete class attendance history or quiz score set.
  const activeClass = useMemo(() => (
    classesSource.scopeKey === userEmail && classesSource.hasSnapshot
      ? classesList.find((item) => item.id === selectedClassId) || null
      : null
  ), [classesSource.scopeKey, classesSource.hasSnapshot, userEmail, classesList, selectedClassId]);
  const uniqueStudents = useMemo(() => {
    const byId = new Map<string, any>();
    (Array.isArray(activeClass?.students) ? activeClass.students : []).forEach((student: any) => {
      const rawId = student?.id ?? student?.studentId;
      if (rawId === undefined || rawId === null || String(rawId).trim() === '') return;
      const id = String(rawId);
      if (!byId.has(id)) byId.set(id, { ...student, id });
    });
    return [...byId.values()];
  }, [activeClass]);
  const rosterIds = useMemo(() => new Set<string>(uniqueStudents.map((student) => String(student.id))), [uniqueStudents]);
  const totalStudents = uniqueStudents.length;

  const currentAttendanceSource = useMemo(
    () => attendanceSource.scopeKey === baseScopeKey ? attendanceSource : emptyCollectionSource('idle'),
    [attendanceSource, baseScopeKey]
  );
  const currentLegacyAttendanceSource = useMemo(
    () => legacyAttendanceSource.scopeKey === baseScopeKey ? legacyAttendanceSource : emptyCollectionSource('idle'),
    [legacyAttendanceSource, baseScopeKey]
  );
  const currentDailyLegacyAttendanceSource = useMemo(
    () => dailyLegacyAttendanceSource.scopeKey === dailySourceScopeKey ? dailyLegacyAttendanceSource : emptyCollectionSource('idle'),
    [dailyLegacyAttendanceSource, dailySourceScopeKey]
  );
  const currentQuizSource = useMemo(
    () => quizSource.scopeKey === baseScopeKey ? quizSource : emptyCollectionSource('idle'),
    [quizSource, baseScopeKey]
  );
  const currentFeeSource = useMemo(
    () => feeSource.scopeKey === baseScopeKey ? feeSource : emptyDocumentSource('idle'),
    [feeSource, baseScopeKey]
  );
  const currentMonthlyPaymentsSource = useMemo(
    () => monthlyPaymentsSource.scopeKey === baseScopeKey ? monthlyPaymentsSource : emptyCollectionSource('idle'),
    [monthlyPaymentsSource, baseScopeKey]
  );
  const currentDailyPaymentsSource = useMemo(
    () => dailyPaymentsSource.scopeKey === dailySourceScopeKey ? dailyPaymentsSource : emptyCollectionSource('idle'),
    [dailyPaymentsSource, dailySourceScopeKey]
  );

  const attendanceAnalysis = useMemo(() => {
    const complete = currentAttendanceSource.hasSnapshot && currentLegacyAttendanceSource.hasSnapshot &&
      (!needsCrossMonthDailySources || currentDailyLegacyAttendanceSource.hasSnapshot);
    const docsById = new Map<string, any>();
    [...currentAttendanceSource.docs, ...currentLegacyAttendanceSource.docs,
      ...(needsCrossMonthDailySources ? currentDailyLegacyAttendanceSource.docs : [])]
      .forEach((docSnap: any) => docsById.set(docSnap.id, docSnap));
    const rowsByDate = new Map<string, { id: string; date: string; monthKey: string; data: any }>();
    const warnings: string[] = [];

    if (complete) {
      docsById.forEach((docSnap) => {
        const data = docSnap.data() || {};
        const rawClassId = data.classId;
        if (rawClassId !== undefined && rawClassId !== null && String(rawClassId).trim() !== '') {
          if (String(rawClassId) !== selectedClassId) return;
        } else if (!docSnap.id.startsWith(`${selectedClassId}_`)) {
          return;
        }
        const date = attendanceDateFromDocument(data, docSnap.id, selectedClassId);
        const monthKey = date ? date.slice(0, 7) : normalizeMonthKey(data.month);
        if (!monthKey) {
          warnings.push(`Attendance record ${docSnap.id} has no valid date/month and was excluded.`);
          console.warn(`[Analytics] Skipped attendance record with no valid date/month: ${docSnap.id}`);
          return;
        }
        const dedupeKey = date || `${monthKey}:${docSnap.id}`;
        const existing = rowsByDate.get(dedupeKey);
        // Preserve the established duplicate authority: latest updatedAt wins.
        if (!existing || timestampRank(data.updatedAt) >= timestampRank(existing.data.updatedAt)) {
          rowsByDate.set(dedupeKey, { id: docSnap.id, date, monthKey, data });
        }
      });
    }

    const allRows = [...rowsByDate.values()];
    const monthlyRows = allRows.filter((row) => row.monthKey === selectedMonthKey);
    const dailyRows = normalizedSelectedDate ? allRows.filter((row) => row.date === normalizedSelectedDate) : [];
    const monthly = buildAttendanceSummary(monthlyRows, rosterIds);
    const daily = buildAttendanceSummary(dailyRows, rosterIds);
    const active = analyticsType === 'daily' ? daily : monthly;
    const weekdaySums = [0, 0, 0, 0, 0, 0, 0];
    const weekdayCounts = [0, 0, 0, 0, 0, 0, 0];
    monthlyRows.forEach((row) => {
      if (!row.date) return;
      const day = new Date(`${row.date}T12:00:00`).getDay();
      const index = (day + 6) % 7;
      const summary = summarizeAttendanceDocument(row.data, rosterIds).counts;
      if (summary.total <= 0) return;
      weekdaySums[index] += ((summary.present + summary.late) / summary.total) * 100;
      weekdayCounts[index] += 1;
    });
    const trend = weekdaySums.map((sum, index) => weekdayCounts[index] > 0 ? Math.round(sum / weekdayCounts[index]) : 0);
    return {
      complete,
      monthlyRows,
      monthly,
      daily,
      active,
      hasRecordedStudents: active.counts.total > 0,
      trend,
      warnings,
    };
  }, [
    currentAttendanceSource, currentLegacyAttendanceSource, currentDailyLegacyAttendanceSource,
    needsCrossMonthDailySources, selectedClassId, selectedMonthKey, normalizedSelectedDate, analyticsType, rosterIds,
  ]);

  const quizAnalysis = useMemo(() => {
    const samplesByStudent: Record<string, Array<{ marksObtained: number; totalMarks: number }>> = {};
    const warnings: string[] = [];
    if (currentQuizSource.hasSnapshot) {
      currentQuizSource.docs.forEach((quizSnap: any) => {
        const quiz = quizSnap.data() || {};
        const quizMonth = normalizeMonthKey(quiz.monthKey) || normalizeMonthKey(quiz.date) || normalizeMonthKey(quiz.createdAt);
        if (quizMonth !== selectedMonthKey) return;
        const totalMarks = parseNonNegativeNumber(quiz.totalMarks);
        if (totalMarks === null || totalMarks <= 0 || !Array.isArray(quiz.studentScores)) {
          warnings.push(`Quiz ${quizSnap.id} is malformed and was excluded.`);
          console.warn(`[Analytics] Skipped malformed quiz record: ${quizSnap.id}`);
          return;
        }
        const scoredInThisQuiz = new Set<string>();
        quiz.studentScores.forEach((score: any) => {
          if (!isPlainObject(score)) return;
          const rawStudentId = score.id ?? score.studentId;
          if (rawStudentId === undefined || rawStudentId === null || String(rawStudentId).trim() === '') return;
          const studentId = String(rawStudentId);
          if (!rosterIds.has(studentId) || scoredInThisQuiz.has(studentId)) return;
          if (score.marksObtained === '' || score.marksObtained === null || score.marksObtained === undefined) return;
          const marks = parseNonNegativeNumber(score.marksObtained);
          if (marks === null || marks > totalMarks) {
            warnings.push(`Invalid score for student ${studentId} in quiz ${quizSnap.id} was excluded.`);
            console.warn(`[Analytics] Ignored invalid quiz mark for student ${studentId} in ${quizSnap.id}.`);
            return;
          }
          scoredInThisQuiz.add(studentId);
          (samplesByStudent[studentId] ??= []).push({ marksObtained: marks, totalMarks });
        });
      });
    }
    const totals: Record<string, { averagePercent: number }> = {};
    Object.entries(samplesByStudent).forEach(([studentId, samples]) => {
      const averagePercent = calculateAverageQuizPercent(samples);
      if (averagePercent !== null) totals[studentId] = { averagePercent };
    });
    return { totals, warnings };
  }, [currentQuizSource, selectedMonthKey, rosterIds]);

  const monthlyPaymentsAvailable = currentMonthlyPaymentsSource.hasSnapshot;
  const monthlyReceiptSummary = useMemo(() => monthlyPaymentsAvailable
    ? summarizePaymentReceipts(currentMonthlyPaymentsSource.docs, selectedClassId, selectedMonthKey, normalizedSelectedDate, rosterIds)
    : emptyPaymentReceiptSummary(), [
      monthlyPaymentsAvailable, currentMonthlyPaymentsSource, selectedClassId, selectedMonthKey, normalizedSelectedDate, rosterIds,
    ]);
  const dailyPaymentSourceForMetrics = selectedDateMonth === selectedMonthKey
    ? currentMonthlyPaymentsSource
    : currentDailyPaymentsSource;
  const dailyPaymentsAvailable = analyticsType === 'daily' && Boolean(normalizedSelectedDate) && dailyPaymentSourceForMetrics.hasSnapshot &&
    (selectedDateMonth === selectedMonthKey || needsCrossMonthDailySources);
  const dailyReceiptSummary = useMemo(() => dailyPaymentsAvailable
    ? summarizePaymentReceipts(dailyPaymentSourceForMetrics.docs, selectedClassId, selectedDateMonth, normalizedSelectedDate, rosterIds)
    : emptyPaymentReceiptSummary(), [
      dailyPaymentsAvailable, dailyPaymentSourceForMetrics, selectedClassId, selectedDateMonth, normalizedSelectedDate, rosterIds,
    ]);

  useEffect(() => {
    let cancelled = false;
    const captureContextKey = buildCaptureContextKey(userEmail, selectedClassId, selectedMonthKey, activeClass);

    if (!userEmail || !selectedClassId || !selectedMonthKey || !activeClass) {
      setMetrics({ ...EMPTY_METRICS });
      setMetricsContextKey(analyticsContextKey);
      setFeeDetailedStudents([]);
      setCaptureMetricSnapshot(null);
      setTrendDataPoints([0, 0, 0, 0, 0, 0, 0]);
      if (userEmail && selectedClassId && classesSource.scopeKey === userEmail && classesSource.hasSnapshot && !activeClass) {
        setNoDataNotification('The selected class is no longer available in this teacher workspace.');
      }
      return () => { cancelled = true; };
    }

    const attendanceCompleteEnoughToEvaluate = attendanceAnalysis.complete;
    const monthlyAttendance = attendanceAnalysis.monthly;
    const dailyAttendance = attendanceAnalysis.daily;
    const activeAttendance = attendanceAnalysis.active;
    const attendanceHasRecordedStudents = attendanceAnalysis.hasRecordedStudents;
    const calculatedTrend = attendanceAnalysis.trend;
    const attendanceWarnings = attendanceAnalysis.warnings;
    const quizTotals = quizAnalysis.totals;
    const quizWarnings = quizAnalysis.warnings;

    // Fee map is nested in the monthly fee document; receipts are in its payments subcollection.
    const feeData = currentFeeSource.data || {};
    const rawFeeRecords = currentFeeSource.exists
      ? (Object.prototype.hasOwnProperty.call(feeData, 'feeRecords') ? feeData.feeRecords : feeData)
      : {};
    const feeRecordsUsable = !currentFeeSource.exists || isPlainObject(rawFeeRecords);
    const feeWarnings: string[] = [];
    if (currentFeeSource.exists && !feeRecordsUsable) {
      feeWarnings.push('The selected month feeRecords value is malformed; paid/pending student metrics were withheld.');
      console.error(`[Analytics] Malformed feeRecords map in ${selectedClassId}_${selectedMonthKey}.`);
    }

    let paidStudentsCount = 0;
    let monthTotalRevenue = 0;
    const feeDetailList: FeeDetailStudent[] = [];
    if (currentFeeSource.hasSnapshot && currentFeeSource.validData && feeRecordsUsable) {
      uniqueStudents.forEach((student) => {
        const studentId = String(student.id);
        const recordRaw = rawFeeRecords[studentId];
        const record = isPlainObject(recordRaw) ? recordRaw : null;
        if (recordRaw !== undefined && record === null) {
          feeWarnings.push(`Fee record for student ${studentId} is malformed and was excluded.`);
          console.warn(`[Analytics] Ignored malformed fee record for student ${studentId}.`);
        }
        const recordPaidAmount = parseNonNegativeNumber(record?.paidAmount);
        const receiptPaidAmount = monthlyReceiptSummary.totalsByStudent[studentId] ?? 0;
        const amountPaid = Math.max(recordPaidAmount ?? 0, receiptPaidAmount);
        const feeDue = parseNonNegativeNumber(record?.monthlyFeeDue)
          ?? parseNonNegativeNumber(student.studentFee)
          ?? parseNonNegativeNumber(activeClass.monthlyFee)
          ?? 0;
        const previousDues = parseNonNegativeNumber(record?.previousMonthDues) ?? 0;
        const obligation = feeDue + previousDues;
        const remainingDues = parseNonNegativeNumber(record?.remainingDues);
        const status = String(record?.status ?? '').trim().toUpperCase();
        let isFullyPaid = false;
        if (obligation > 0) {
          if (status === 'PAID') {
            isFullyPaid = remainingDues === null || remainingDues <= 0.005;
          } else if (!status && recordPaidAmount !== null) {
            isFullyPaid = remainingDues !== null
              ? remainingDues <= 0.005 && recordPaidAmount >= obligation - 0.005
              : recordPaidAmount >= obligation - 0.005;
          }
        }
        if (isFullyPaid) paidStudentsCount++;
        const paidDate = normalizeDate(record?.paidDate) || normalizeDate(record?.paidAt) || normalizeDate(record?.date)
          || monthlyReceiptSummary.lastDateByStudent[studentId];
        if (monthlyPaymentsAvailable) {
          feeDetailList.push({
            id: studentId,
            name: String(student.name || `Student (${studentId.slice(-4)})`),
            rollNo: String(student.rollNo || student.roll_no || studentId),
            status: isFullyPaid ? 'PAID' : 'UNPAID',
            amountPaid,
            ...(isFullyPaid && paidDate ? { date: paidDate } : {}),
          });
        }
      });
    }

    if (currentFeeSource.hasSnapshot && currentFeeSource.validData && monthlyPaymentsAvailable) {
      if (feeRecordsUsable) {
        uniqueStudents.forEach((student) => {
          const recordRaw = rawFeeRecords[String(student.id)];
          const record = isPlainObject(recordRaw) ? recordRaw : null;
          const recordPaidAmount = parseNonNegativeNumber(record?.paidAmount);
          const receiptPaidAmount = monthlyReceiptSummary.totalsByStudent[String(student.id)] ?? 0;
          monthTotalRevenue += Math.max(recordPaidAmount ?? 0, receiptPaidAmount);
        });
      } else {
        // Receipts remain independently valid even when the aggregate feeRecords map is malformed.
        monthTotalRevenue = Object.values(monthlyReceiptSummary.totalsByStudent).reduce<number>((sum, value) => sum + Number(value), 0);
      }
    }

    const monthlyFeeMetricsAvailable = currentFeeSource.hasSnapshot && currentFeeSource.validData && feeRecordsUsable;
    const attendanceMetricsAvailable = attendanceCompleteEnoughToEvaluate && attendanceHasRecordedStudents;
    const dailyAttendanceAvailable = analyticsType === 'daily' && attendanceCompleteEnoughToEvaluate && dailyAttendance.counts.total > 0;
    const recoveryRate = totalStudents > 0 ? Math.round((paidStudentsCount / totalStudents) * 100) : 0;
    const pendingStudentsCount = Math.max(0, totalStudents - paidStudentsCount);

    const captureValues: Record<string, { attendanceRate: number | null; quizMarks: number | null; weightedScore: number | null; overallScore: number | null }> = {};
    uniqueStudents.forEach((student) => {
      const id = String(student.id);
      const attendance = attendanceCompleteEnoughToEvaluate ? monthlyAttendance.byStudent[id] : undefined;
      const attendanceRate = attendance && attendance.total > 0
        ? ((attendance.present + attendance.late) / attendance.total) * 100
        : null;
      const quizzes = currentQuizSource.hasSnapshot ? quizTotals[id] : undefined;
      const quizMarks = quizzes?.averagePercent ?? null;
      const roundedAttendanceRate = attendanceRate === null ? null : Math.round(attendanceRate * 100) / 100;
      const roundedQuizMarks = quizMarks === null ? null : Math.round(quizMarks * 100) / 100;
      const calculatedWeightedScore = calculateWeightedScore(roundedAttendanceRate, roundedQuizMarks);
      const storedOverallScore = parseScoreOutOf100(student.overallScore);
      captureValues[id] = {
        attendanceRate: roundedAttendanceRate,
        quizMarks: roundedQuizMarks,
        weightedScore: calculatedWeightedScore,
        overallScore: storedOverallScore ?? calculatedWeightedScore,
      };
    });

    const visibleWarnings = [
      ...(attendanceCompleteEnoughToEvaluate ? attendanceWarnings : []),
      ...(currentQuizSource.hasSnapshot ? quizWarnings : []),
      ...feeWarnings,
      ...(monthlyPaymentsAvailable ? monthlyReceiptSummary.warnings : []),
      ...(dailyPaymentsAvailable ? dailyReceiptSummary.warnings : []),
    ];
    const noDailyRecords = analyticsType === 'daily' && Boolean(normalizedSelectedDate) &&
      attendanceCompleteEnoughToEvaluate && dailyPaymentsAvailable &&
      !dailyAttendanceAvailable && dailyReceiptSummary.exactDayRevenue <= 0;

    if (cancelled) return;
    setTrendDataPoints(attendanceCompleteEnoughToEvaluate ? calculatedTrend : [0, 0, 0, 0, 0, 0, 0]);
    setFeeDetailedStudents(monthlyPaymentsAvailable && monthlyFeeMetricsAvailable ? feeDetailList : []);
    setMetrics({
      attendanceRate: attendanceMetricsAvailable
        ? percent(activeAttendance.counts.present + activeAttendance.counts.late, activeAttendance.counts.total)
        : null,
      absentPercentage: attendanceMetricsAvailable ? percent(activeAttendance.counts.absent, activeAttendance.counts.total) : null,
      presentCount: attendanceMetricsAvailable ? activeAttendance.counts.present : null,
      lateCount: attendanceMetricsAvailable ? activeAttendance.counts.late : null,
      absentCount: attendanceMetricsAvailable ? activeAttendance.counts.absent : null,
      absentToday: dailyAttendanceAvailable ? dailyAttendance.counts.absent : null,
      feeRecoveryRate: monthlyFeeMetricsAvailable ? recoveryRate : null,
      paidCount: monthlyFeeMetricsAvailable ? paidStudentsCount : null,
      pendingCount: monthlyFeeMetricsAvailable ? pendingStudentsCount : null,
      totalRevenue: currentFeeSource.hasSnapshot && currentFeeSource.validData && monthlyPaymentsAvailable
        ? Math.round(monthTotalRevenue * 100) / 100
        : null,
      dailyCollectedRevenue: dailyPaymentsAvailable ? Math.round(dailyReceiptSummary.exactDayRevenue * 100) / 100 : null,
      dailyPaidCount: dailyPaymentsAvailable ? dailyReceiptSummary.studentsPaidExactDay.size : null,
      totalStudentsCount: classesSource.scopeKey === userEmail && classesSource.hasSnapshot ? totalStudents : null,
    });
    setMetricsContextKey(analyticsContextKey);
    setCaptureMetricSnapshot({ contextKey: captureContextKey, values: captureValues });
    if (visibleWarnings.length > 0) {
      setNoDataNotification(visibleWarnings[0]);
    } else if (noDailyRecords) {
      setNoDataNotification(`No recorded attendance or payment receipts found for ${normalizedSelectedDate}. Daily collection is calculated only from dated receipts.`);
    } else {
      setNoDataNotification(null);
    }
  }, [
    userEmail, selectedClassId, selectedMonthKey, selectedDate, selectedDateMonth, normalizedSelectedDate, baseScopeKey, dailySourceScopeKey,
    analyticsType, needsCrossMonthDailySources, analyticsContextKey, classesList, classesSource.hasSnapshot, classesSource.scopeKey,
    attendanceAnalysis, quizAnalysis, currentFeeSource, currentMonthlyPaymentsSource,
    currentDailyPaymentsSource, monthlyReceiptSummary, dailyReceiptSummary, monthlyPaymentsAvailable, dailyPaymentsAvailable, dailyPaymentSourceForMetrics,
    classesSource.hasSnapshot, classesSource.scopeKey,
  ]);

  const shownMetrics = metricsContextKey === analyticsContextKey ? metrics : EMPTY_METRICS;

  const filteredFeeStudents = useMemo(() => {
    if (feeModalFilter === 'PAID') return feeDetailedStudents.filter((s) => s.status === 'PAID');
    if (feeModalFilter === 'UNPAID') return feeDetailedStudents.filter((s) => s.status === 'UNPAID');
    return feeDetailedStudents;
  }, [feeDetailedStudents, feeModalFilter]);

  const capturedStudents = useMemo(() => {
    const students = [...(currentClass?.students || [])];
    if (!students.length) return {};

    const contextKey = buildCaptureContextKey(userEmail, selectedClassId, selectedMonthKey, currentClass);
    const snapshotMatchesSelection = Boolean(
      captureMetricSnapshot && captureMetricSnapshot.contextKey === contextKey
    );
    const decorateStudent = (student: any) => {
      if (!snapshotMatchesSelection) return student;
      const rawId = student?.id ?? student?.studentId;
      if (rawId === undefined || rawId === null) return student;
      const value = captureMetricSnapshot!.values[String(rawId)];
      if (!value) return student;
      return {
        ...student,
        attendance: value.attendanceRate ?? parseScoreOutOf100(student.attendance) ?? undefined,
        quizScore: value.quizMarks ?? parseScoreOutOf100(student.quizScore) ?? undefined,
        overallScore: captureCriteria === 'Weighted Score'
          ? value.weightedScore ?? undefined
          : value.overallScore ?? value.weightedScore ?? parseScoreOutOf100(student.overallScore) ?? undefined,
      };
    };

    if (captureCriteria === 'manualTag') {
      const tagged: Record<string, any> = {};
      const tagValues: Record<string, string> = {
        excellent: 'excellent',
        good: 'good',
        average: 'average',
        poor: 'poor',
      };
      Object.entries(tagValues).forEach(([category, expected]) => {
        const student = students.find((item: any) =>
          String(item.manualTag ?? item.tag ?? '').trim().toLowerCase() === expected
        );
        tagged[category] = student ? decorateStudent(student) : undefined;
      });
      return tagged;
    }

    if (!snapshotMatchesSelection) return {};

    const metricKey = captureCriteria === 'Weighted Score'
      ? 'weightedScore'
      : captureCriteria === 'Attendance Rate'
      ? 'attendanceRate'
      : captureCriteria === 'Quiz Marks'
      ? 'quizMarks'
      : 'overallScore';
    const ranked = students
      .map((student: any) => {
        const rawId = student.id ?? student.studentId;
        if (rawId === undefined || rawId === null) return null;
        const id = String(rawId);
        const score = captureMetricSnapshot!.values[id]?.[metricKey as 'weightedScore' | 'attendanceRate' | 'quizMarks' | 'overallScore'];
        if (score === null || score === undefined || !Number.isFinite(score)) return null;
        return { student: decorateStudent(student), id, score };
      })
      .filter((item): item is { student: any; id: string; score: number } => item !== null)
      .sort((a, b) => b.score - a.score || String(a.student.name).localeCompare(String(b.student.name)));

    if (!ranked.length) return {};
    const used = new Set<number>();
    const pickNearestUnused = (target: number) => {
      let bestIndex = -1;
      let bestDistance = Number.POSITIVE_INFINITY;
      ranked.forEach((_item, index) => {
        if (used.has(index)) return;
        const distance = Math.abs(index - target);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = index;
        }
      });
      if (bestIndex < 0) return undefined;
      used.add(bestIndex);
      return ranked[bestIndex].student;
    };

    return {
      excellent: pickNearestUnused(0),
      good: pickNearestUnused(Math.floor(ranked.length * 0.25)),
      average: pickNearestUnused(Math.floor(ranked.length * 0.55)),
      poor: pickNearestUnused(ranked.length - 1),
    };
  }, [currentClass, captureCriteria, captureMetricSnapshot, userEmail, selectedClassId, selectedMonthKey]);

  const currentMonthLabel = useMemo(() => {
    const found = availableMonths.find((m) => m.key === selectedMonthKey);
    return found ? found.label : selectedMonthKey;
  }, [availableMonths, selectedMonthKey]);

  const svgPathD = useMemo(() => {
    const points = trendDataPoints;
    const xStep = 380 / (points.length - 1);
    const coords = points.map((p, idx) => {
      const x = 10 + idx * xStep;
      const y = 110 - (p / 100) * 90;
      return { x, y };
    });

    let path = `M ${coords[0].x} ${coords[0].y}`;
    for (let i = 1; i < coords.length; i++) {
      path += ` L ${coords[i].x} ${coords[i].y}`;
    }
    return { path, coords };
  }, [trendDataPoints]);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#f8fafc] flex items-center justify-center text-slate-600">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-9 w-9 animate-spin text-orange-500" />
          <p className="text-xs font-black tracking-wide text-orange-400">
            Syncing Database Analytics...
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`min-h-screen bg-[#f8fafc] dark:bg-[#070b13] text-slate-900 dark:text-slate-100 transition-colors duration-300 pb-28 ${
        isDark ? 'dark' : ''
      }`}
    >
      {showSuccessToast && (
        <div className="fixed top-5 left-1/2 -translate-x-1/2 z-[100] animate-in slide-in-from-top-6 fade-in duration-300 w-[90%] max-w-sm">
          <div className="bg-gradient-to-r from-orange-500 via-amber-500 to-orange-600 text-white font-black text-xs px-5 py-3.5 rounded-2xl shadow-[0_0_35px_rgba(249,115,22,0.85)] border-2 border-orange-300 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <Sparkles className="h-5 w-5 text-yellow-200 animate-spin" />
              <span className="tracking-wide">✨ Successfully Updated!</span>
            </div>
            <CheckCircle2 className="h-5 w-5 text-white stroke-[3] shrink-0" />
          </div>
        </div>
      )}

      {/* HEADER (FIXED NAVBAR OVERFLOW) */}
      <div className="w-full bg-white/60 dark:bg-[#070b13]/60 backdrop-blur-md sticky top-0 z-40 border-b border-slate-200/50 dark:border-slate-800/50">
        <div className="mx-auto max-w-2xl px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate('/')}
              className="h-10 w-10 rounded-full bg-orange-500 hover:bg-orange-600 active:scale-95 text-white flex items-center justify-center shadow-lg shadow-orange-500/30 transition-all border-2 border-orange-400/50 shrink-0"
              title="Back to Dashboard"
            >
              <ArrowLeft className="h-5 w-5 stroke-[2.8]" />
            </button>
            <h1 className="text-xl font-black tracking-tight truncate">Analytics</h1>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => setIsSettingsOpen(true)}
              className="p-2 rounded-2xl bg-slate-100 dark:bg-[#0c1222] border border-slate-200/60 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:text-orange-500 transition-colors"
              title="Settings"
            >
              <SlidersHorizontal className="h-4 w-4" />
            </button>

            <button
              onClick={() => setIsDark(!isDark)}
              className="flex h-7 w-12 items-center rounded-full bg-slate-200/60 p-0.5 transition-all dark:bg-slate-800 border border-slate-300/30"
            >
              <div
                className={`flex h-5 w-5 items-center justify-center rounded-full bg-white text-orange-500 shadow-sm transition-all ${
                  isDark ? 'translate-x-5 bg-slate-950 text-yellow-400' : ''
                }`}
              >
                {isDark ? (
                  <Moon className="h-3 w-3 fill-current" />
                ) : (
                  <Sun className="h-3 w-3 fill-current" />
                )}
              </div>
            </button>
          </div>
        </div>
      </div>

      {/* MAIN BODY */}
      <main className="mx-auto max-w-2xl px-4 py-5 space-y-5">
        {/* ACTIVE DATA SELECTION */}
        <div className="relative overflow-hidden bg-white dark:bg-[#0c1222] border border-slate-200/80 dark:border-slate-800/80 rounded-3xl p-4 shadow-lg shadow-orange-500/5 space-y-3">
          <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800/60 pb-2.5">
            <span className="text-[11px] font-black uppercase tracking-wider text-slate-400 dark:text-slate-300 flex items-center gap-1.5">
              <CheckCircle2 className="h-4 w-4 text-orange-500" /> ACTIVE DATA SELECTION
            </span>
            {sourceErrorNotification ? (
              <span className="flex items-center gap-1 text-[10px] font-bold text-amber-600" title={sourceErrorNotification}>
                <AlertCircle className="h-3 w-3" /> Sync issue
              </span>
            ) : fetchingMetrics || !isLiveConnected ? (
              <span className="flex items-center gap-1 text-[10px] font-bold text-orange-500 animate-pulse">
                <Loader2 className="h-3 w-3 animate-spin" /> Syncing...
              </span>
            ) : (
              <span className="flex items-center gap-1 text-[10px] font-bold text-emerald-500">
                <span className="h-2 w-2 rounded-full bg-emerald-500 animate-ping" /> Live Connected
              </span>
            )}
          </div>

          <div className="space-y-3">
            {/* Premium Class Selector Trigger */}
            <div className="relative">
              <label className="block text-[11px] font-black text-slate-400 mb-1 ml-1">
                Select Class ({classesList.length} Available)
              </label>
              <button
                type="button"
                onClick={() => setIsClassModalOpen(true)}
                className="w-full flex items-center justify-between rounded-2xl bg-slate-100 dark:bg-[#070b13] px-4 py-3 text-xs font-black text-slate-800 dark:text-slate-100 border border-orange-500/30 hover:border-orange-500 transition-all text-left shadow-sm"
              >
                <span className="truncate flex items-center gap-2">
                  🎓 {currentClass ? `${currentClass.name} — PKR ${currentClass.monthlyFee}` : 'Select Class'}
                </span>
                <ChevronDown className="h-4 w-4 text-orange-500 shrink-0 ml-2" />
              </button>
            </div>

            {/* Dynamic Premium Month Selector Trigger */}
            <div className="relative">
              <label className="block text-[11px] font-black text-slate-400 mb-1 ml-1">
                Record Month
              </label>
              <button
                type="button"
                onClick={() => setIsMonthModalOpen(true)}
                className="w-full flex items-center justify-between rounded-2xl bg-orange-50/50 dark:bg-orange-950/20 px-4 py-3 text-xs font-black text-orange-600 dark:text-orange-400 border border-orange-300 dark:border-orange-900/50 hover:border-orange-500 transition-all text-left shadow-sm"
              >
                <span className="truncate flex items-center gap-2">
                  🗓️ {currentMonthLabel || 'Select Month'}
                </span>
                <ChevronDown className="h-4 w-4 text-orange-500 shrink-0 ml-2" />
              </button>
            </div>

            {/* FULL MONTH vs DAILY ANALYTICS TOGGLE */}
            <div className="pt-2 border-t border-slate-100 dark:border-slate-800/60 space-y-2">
              <div className="flex bg-slate-100 dark:bg-[#070b13] p-1 rounded-2xl">
                <button
                  onClick={() => setAnalyticsType('month')}
                  className={`flex-1 py-2 rounded-xl text-xs font-black transition-all ${
                    analyticsType === 'month'
                      ? 'bg-orange-500 text-white shadow-md shadow-orange-500/30'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Full Month Analytics
                </button>
                <button
                  onClick={() => setAnalyticsType('daily')}
                  className={`flex-1 py-2 rounded-xl text-xs font-black transition-all ${
                    analyticsType === 'daily'
                      ? 'bg-orange-500 text-white shadow-md shadow-orange-500/30'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Daily Analytics
                </button>
              </div>

              {/* DATE PICKER */}
              {analyticsType === 'daily' && (
                <div className="space-y-2 pt-1">
                  <div className="relative">
                    <label className="block text-[11px] font-black text-orange-500 mb-1 ml-1 flex items-center gap-1">
                      <CalendarIcon className="h-3 w-3" /> Select Specific Date:
                    </label>
                    <input
                      type="date"
                      value={selectedDate}
                      onChange={(e) => setSelectedDate(e.target.value)}
                      className="w-full rounded-2xl bg-slate-100 dark:bg-[#070b13] px-4 py-2.5 text-xs font-black border border-orange-500/40 text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-orange-500/50 cursor-pointer"
                    />
                  </div>


                </div>
              )}
            </div>
            {(sourceErrorNotification || noDataNotification) && (
              <div className="p-3 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex items-center gap-2.5 text-amber-600 animate-in fade-in duration-300">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <p className="text-[11px] font-bold leading-tight flex-1">
                  {sourceErrorNotification || noDataNotification}
                </p>
                {canRetrySync && (
                  <button
                    type="button"
                    onClick={() => setRetryNonce((value) => value + 1)}
                    className="shrink-0 rounded-lg border border-amber-500/40 px-2 py-1 text-[10px] font-black hover:bg-amber-500/10"
                  >
                    Retry
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* METRICS CARDS GRID */}
        <div
          className={`grid grid-cols-2 gap-3 transition-opacity duration-300 ${
            fetchingMetrics ? 'opacity-70' : 'opacity-100'
          }`}
        >
          {/* Attendance Rate */}
          <div className="relative overflow-hidden bg-white dark:bg-[#0c1222] border border-emerald-500/30 rounded-3xl p-4 shadow-[0_0_20px_rgba(16,185,129,0.1)] hover:shadow-[0_0_25px_rgba(16,185,129,0.2)] transition-all hover:scale-[1.02] space-y-2 group">
            <div className="absolute -top-10 -right-10 w-24 h-24 bg-emerald-500/10 rounded-full blur-xl pointer-events-none group-hover:bg-emerald-500/20 transition-all" />
            <div className="flex items-center justify-between">
              <div className="h-9 w-9 rounded-2xl bg-emerald-500/10 text-emerald-500 flex items-center justify-center">
                <Users className="h-4 w-4" />
              </div>
            </div>
            <div>
              <p className="text-[11px] font-bold text-slate-400">Attendance Rate</p>
              <h2 className="text-2xl font-black text-emerald-500">
                {shownMetrics.attendanceRate === null ? '—' : `${shownMetrics.attendanceRate}%`}
              </h2>
            </div>
          </div>

          {/* Fee Recovery Card */}
          <div
            onClick={() => setIsFeeModalOpen(true)}
            className="relative overflow-hidden bg-white dark:bg-[#0c1222] border border-orange-500/40 rounded-3xl p-4 shadow-[0_0_20px_rgba(249,115,22,0.15)] hover:shadow-[0_0_30px_rgba(249,115,22,0.3)] transition-all hover:scale-[1.03] active:scale-95 cursor-pointer group space-y-2"
          >
            <div className="absolute -top-10 -right-10 w-24 h-24 bg-orange-500/15 rounded-full blur-xl pointer-events-none animate-pulse" />

            <div className="flex items-center justify-between relative z-10">
              <div className="h-9 w-9 rounded-2xl bg-orange-500/10 text-orange-500 flex items-center justify-center group-hover:bg-orange-500 group-hover:text-white transition-colors">
                <Wallet className="h-4 w-4" />
              </div>
              <span className="text-[9px] font-black uppercase text-orange-500 bg-orange-500/10 px-2 py-0.5 rounded-full border border-orange-500/20 shadow-sm animate-pulse">
                Tap to view 👁️
              </span>
            </div>
            <div className="relative z-10">
              <p className="text-[11px] font-bold text-slate-400">
                {analyticsType === 'month' ? 'Fee Recovery (Month)' : 'Fee Collected (Today)'}
              </p>
              {analyticsType === 'month' ? (
                <div className="flex items-baseline gap-1.5">
                  <h2 className="text-2xl font-black text-orange-500">
                    {shownMetrics.feeRecoveryRate === null ? '—' : `${shownMetrics.feeRecoveryRate}%`}
                  </h2>
                  <span className="text-[10px] font-extrabold text-slate-400">
                    ({shownMetrics.paidCount === null ? '—' : shownMetrics.paidCount}/{shownMetrics.totalStudentsCount === null ? '—' : shownMetrics.totalStudentsCount})
                  </span>
                </div>
              ) : (
                <div className="space-y-0.5">
                  <h2 className="text-lg font-black text-orange-500">
                    PKR {shownMetrics.dailyCollectedRevenue === null ? '—' : shownMetrics.dailyCollectedRevenue.toLocaleString()}
                  </h2>
                  <p className="text-[10px] font-extrabold text-emerald-500">
                    {shownMetrics.dailyPaidCount === null ? '—' : shownMetrics.dailyPaidCount} Paid Today
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Enrolled Students */}
          <div className="relative overflow-hidden bg-white dark:bg-[#0c1222] border border-blue-500/30 rounded-3xl p-4 shadow-[0_0_20px_rgba(59,130,246,0.1)] hover:shadow-[0_0_25px_rgba(59,130,246,0.2)] transition-all hover:scale-[1.02] space-y-2 group">
            <div className="absolute -top-10 -right-10 w-24 h-24 bg-blue-500/10 rounded-full blur-xl pointer-events-none group-hover:bg-blue-500/20 transition-all" />
            <div className="flex items-center justify-between">
              <div className="h-9 w-9 rounded-2xl bg-blue-500/10 text-blue-500 flex items-center justify-center">
                <GraduationCap className="h-4 w-4" />
              </div>
            </div>
            <div>
              <p className="text-[11px] font-bold text-slate-400">Enrolled Students</p>
              <h2 className="text-2xl font-black text-blue-500">
                {shownMetrics.totalStudentsCount === null ? '—' : shownMetrics.totalStudentsCount}
              </h2>
            </div>
          </div>

          {/* Absent Count */}
          <div className="relative overflow-hidden bg-white dark:bg-[#0c1222] border border-rose-500/30 rounded-3xl p-4 shadow-[0_0_20px_rgba(244,63,94,0.1)] hover:shadow-[0_0_25px_rgba(244,63,94,0.2)] transition-all hover:scale-[1.02] space-y-2 group">
            <div className="absolute -top-10 -right-10 w-24 h-24 bg-rose-500/10 rounded-full blur-xl pointer-events-none group-hover:bg-rose-500/20 transition-all" />
            <div className="flex items-center justify-between">
              <div className="h-9 w-9 rounded-2xl bg-rose-500/10 text-rose-500 flex items-center justify-center">
                <UserX className="h-4 w-4" />
              </div>
            </div>
            <div>
              <p className="text-[11px] font-bold text-slate-400">
                {analyticsType === 'daily' ? 'Absent Selected Day' : 'Absent Records'}
              </p>
              <div className="flex items-center gap-2">
                <h2 className="text-2xl font-black text-rose-500">
                  {(analyticsType === 'daily' ? shownMetrics.absentToday : shownMetrics.absentCount) === null ? '—' : (analyticsType === 'daily' ? shownMetrics.absentToday : shownMetrics.absentCount)}
                </h2>
                <span className="text-xs font-extrabold px-2 py-0.5 rounded-full bg-rose-500/10 text-rose-500 border border-rose-500/20">
                  ({shownMetrics.absentPercentage === null ? '—' : `${shownMetrics.absentPercentage}%`})
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* PERFORMANCE TREND GRAPH */}
        <div className="bg-white dark:bg-[#0c1222] border border-slate-200/80 dark:border-slate-800 rounded-3xl p-5 shadow-sm space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-black">Performance Trend</h3>
            <span className="text-[10px] font-black text-emerald-500 flex items-center gap-0.5">
              <TrendingUp className="h-3 w-3" /> Live Calculations
            </span>
          </div>

          <div className="relative pt-2">
            <svg viewBox="0 0 400 120" className="w-full h-28 overflow-visible">
              <defs>
                <linearGradient id="orangeGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#f97316" stopOpacity="0.4" />
                  <stop offset="100%" stopColor="#f97316" stopOpacity="0.0" />
                </linearGradient>
              </defs>

              <path
                d={`${svgPathD.path} L 390 120 L 10 120 Z`}
                fill="url(#orangeGradient)"
              />

              <path
                d={svgPathD.path}
                fill="none"
                stroke="#f97316"
                strokeWidth="3.5"
                strokeLinecap="round"
              />

              {svgPathD.coords.map((c, i) => (
                <circle key={i} cx={c.x} cy={c.y} r="4" fill="#f97316" className="transition-all duration-300" />
              ))}
            </svg>

            <div className="flex justify-between text-[10px] font-black text-slate-400 mt-1 px-1">
              <span>Mon</span>
              <span>Tue</span>
              <span>Wed</span>
              <span>Thu</span>
              <span>Fri</span>
              <span>Sat</span>
              <span>Sun</span>
            </div>
          </div>
        </div>

        {/* 4 REPRESENTATIVE STUDENTS CAPTURE SECTION */}
        <StudentCaptureSection
          classes={classesList}
          selectedClassId={selectedClassId}
          onSelectClassId={setSelectedClassId}
          captureCriteria={captureCriteria}
          onOpenSettingsModal={() => setIsSettingsOpen(true)}
          capturedStudents={capturedStudents}
        />

        {/* ATTENDANCE & FEE OVERVIEW */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="bg-white dark:bg-[#0c1222] border border-slate-200/80 dark:border-slate-800 rounded-3xl p-5 shadow-sm space-y-3">
            <h3 className="text-xs font-black">Attendance Overview</h3>
            <div className="flex items-center justify-around">
              <div className="relative h-24 w-24 flex items-center justify-center">
                <svg className="h-full w-full transform -rotate-90" viewBox="0 0 36 36">
                  <path
                    className="text-slate-100 dark:text-slate-800"
                    strokeWidth="3.8"
                    stroke="currentColor"
                    fill="none"
                    d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                  />
                  <path
                    className="text-emerald-500"
                    strokeDasharray={`${shownMetrics.attendanceRate ?? 0}, 100`}
                    strokeWidth="3.8"
                    strokeLinecap="round"
                    stroke="currentColor"
                    fill="none"
                    d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                  />
                </svg>
                <div className="absolute text-center">
                  <p className="text-base font-black text-slate-900 dark:text-slate-100">
                    {shownMetrics.attendanceRate === null ? '—' : `${shownMetrics.attendanceRate}%`}
                  </p>
                  <p className="text-[9px] font-bold text-slate-400">Present</p>
                </div>
              </div>

              <div className="space-y-1.5 text-xs font-black">
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
                  <span className="text-slate-500 dark:text-slate-400 font-extrabold">Present</span>
                  <span className="ml-auto font-black">{shownMetrics.presentCount === null ? '—' : shownMetrics.presentCount}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full bg-orange-400" />
                  <span className="text-slate-500 dark:text-slate-400 font-extrabold">Late</span>
                  <span className="ml-auto font-black">{shownMetrics.lateCount === null ? '—' : shownMetrics.lateCount}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full bg-rose-500" />
                  <span className="text-slate-500 dark:text-slate-400 font-extrabold">Absent</span>
                  <span className="ml-auto font-black">{shownMetrics.absentCount === null ? '—' : shownMetrics.absentCount}</span>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white dark:bg-[#0c1222] border border-slate-200/80 dark:border-slate-800 rounded-3xl p-5 shadow-sm space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-black">Fee Collection Summary</h3>
              <span className="text-xs font-black text-orange-500">
                {shownMetrics.feeRecoveryRate === null ? '—' : `${shownMetrics.feeRecoveryRate}%`}
              </span>
            </div>

            <div className="w-full bg-slate-100 dark:bg-slate-900 h-3.5 rounded-full overflow-hidden p-0.5">
              <div
                className="bg-gradient-to-r from-orange-500 to-amber-500 h-full rounded-full transition-all duration-500 shadow-sm"
                style={{ width: `${shownMetrics.feeRecoveryRate ?? 0}%` }}
              />
            </div>

            <div className="grid grid-cols-3 gap-2 text-center pt-1">
              <div className="bg-slate-50 dark:bg-[#070b13] p-2 rounded-2xl border border-slate-100 dark:border-slate-800">
                <p className="text-[9px] font-bold text-slate-400">Paid Students</p>
                <p className="text-xs font-black text-emerald-500">{shownMetrics.paidCount === null ? '—' : shownMetrics.paidCount}</p>
              </div>
              <div className="bg-slate-50 dark:bg-[#070b13] p-2 rounded-2xl border border-slate-100 dark:border-slate-800">
                <p className="text-[9px] font-bold text-slate-400">Pending</p>
                <p className="text-xs font-black text-orange-500">{shownMetrics.pendingCount === null ? '—' : shownMetrics.pendingCount}</p>
              </div>
              <div className="bg-slate-50 dark:bg-[#070b13] p-2 rounded-2xl border border-slate-100 dark:border-slate-800">
                <p className="text-[9px] font-bold text-slate-400">Month Revenue</p>
                <p className="text-[11px] font-black text-slate-800 dark:text-slate-200">
                  PKR {shownMetrics.totalRevenue === null ? '—' : shownMetrics.totalRevenue.toLocaleString()}
                </p>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* POPUP MODAL: PAID VS UNPAID STUDENTS */}
      {isFeeModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-md p-4 animate-in fade-in duration-200">
          <div className="w-full max-w-md bg-white dark:bg-[#0c1222] border border-slate-200 dark:border-slate-800 rounded-3xl p-5 shadow-2xl space-y-4 text-slate-900 dark:text-slate-100 relative">
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800/80 pb-3">
              <div className="flex items-center gap-2">
                <div className="p-2 rounded-xl bg-orange-500/10 text-orange-500">
                  <Wallet className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-sm font-black">Fee Payment Breakdown</h3>
                  <p className="text-[10px] text-slate-400 font-bold">
                    Class: {currentClass?.name} | {selectedMonthKey}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setIsFeeModalOpen(false)}
                className="p-1.5 rounded-full text-slate-400 hover:text-slate-200 transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* PAID / UNPAID FILTER TABS */}
            <div className="flex items-center gap-1 bg-slate-100 dark:bg-[#070b13] p-1 rounded-2xl border border-slate-200/50 dark:border-slate-800/60">
              <button
                onClick={() => setFeeModalFilter('ALL')}
                className={`flex-1 py-1.5 rounded-xl text-[11px] font-black transition-all flex items-center justify-center gap-1 ${
                  feeModalFilter === 'ALL'
                    ? 'bg-orange-500 text-white shadow-md shadow-orange-500/20'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Filter className="h-3 w-3" /> All ({feeDetailedStudents.length})
              </button>
              <button
                onClick={() => setFeeModalFilter('PAID')}
                className={`flex-1 py-1.5 rounded-xl text-[11px] font-black transition-all flex items-center justify-center gap-1 ${
                  feeModalFilter === 'PAID'
                    ? 'bg-emerald-500 text-white shadow-md shadow-emerald-500/20'
                    : 'text-slate-400 hover:text-emerald-400'
                }`}
              >
                <CheckCircle className="h-3 w-3" /> Paid ({feeDetailedStudents.filter((s) => s.status === 'PAID').length})
              </button>
              <button
                onClick={() => setFeeModalFilter('UNPAID')}
                className={`flex-1 py-1.5 rounded-xl text-[11px] font-black transition-all flex items-center justify-center gap-1 ${
                  feeModalFilter === 'UNPAID'
                    ? 'bg-rose-500 text-white shadow-md shadow-rose-500/20'
                    : 'text-slate-400 hover:text-rose-400'
                }`}
              >
                <Clock className="h-3 w-3" /> Unpaid ({feeDetailedStudents.filter((s) => s.status === 'UNPAID').length})
              </button>
            </div>

            {/* Student List */}
            <div className="max-h-72 overflow-y-auto space-y-2 pr-1">
              {filteredFeeStudents.length === 0 ? (
                <div className="text-center py-6 text-slate-400 font-bold space-y-1">
                  <p className="text-xs">
                    No {feeModalFilter !== 'ALL' ? feeModalFilter.toLowerCase() : ''} records found.
                  </p>
                </div>
              ) : (
                filteredFeeStudents.map((st) => (
                  <div
                    key={st.id}
                    className="p-3 rounded-2xl bg-slate-50 dark:bg-[#070b13] border border-slate-100 dark:border-slate-800 flex items-center justify-between hover:border-slate-300 dark:hover:border-slate-700 transition-all"
                  >
                    <div className="flex items-center gap-2.5">
                      <div
                        className={`h-8 w-8 rounded-full flex items-center justify-center font-black text-xs ${
                          st.status === 'PAID'
                            ? 'bg-emerald-500/10 text-emerald-500'
                            : 'bg-rose-500/10 text-rose-500'
                        }`}
                      >
                        {st.status === 'PAID' ? (
                          <CheckCircle className="h-4 w-4" />
                        ) : (
                          <Clock className="h-4 w-4" />
                        )}
                      </div>
                      <div>
                        <p className="text-xs font-black">{st.name}</p>
                        <p className="text-[10px] text-slate-400 font-bold">Roll: {st.rollNo}</p>
                      </div>
                    </div>

                    <div className="text-right flex flex-col items-end">
                      <span
                        className={`text-[10px] font-black px-2 py-0.5 rounded-md ${
                          st.status === 'PAID'
                            ? 'bg-emerald-500/20 text-emerald-500 border border-emerald-500/30'
                            : 'bg-rose-500/20 text-rose-500 border border-rose-500/30'
                        }`}
                      >
                        {st.status === 'PAID' ? `PKR ${st.amountPaid}` : 'UNPAID'}
                      </span>
                      {st.status === 'PAID' && st.date && (
                        <span className="text-[9px] font-bold text-slate-400 mt-1 flex items-center gap-0.5">
                          📅 {st.date}
                        </span>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>

            <button
              onClick={() => setIsFeeModalOpen(false)}
              className="w-full py-2.5 rounded-2xl bg-orange-500 hover:bg-orange-600 active:scale-95 text-white font-black text-xs shadow-lg shadow-orange-500/30 transition-all"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* BOTTOM NAVBAR */}
      <BottomNavbar />

      {/* CUSTOM CLASS SELECTION MODAL */}
      <ClassSelectModal
        isOpen={isClassModalOpen}
        onClose={() => setIsClassModalOpen(false)}
        classesList={classesList}
        selectedClassId={selectedClassId}
        onSelectClass={(id) => setSelectedClassId(id)}
      />

      {/* CUSTOM MONTH SELECTION MODAL */}
      <MonthSelectModal
        isOpen={isMonthModalOpen}
        onClose={() => setIsMonthModalOpen(false)}
        availableMonths={availableMonths}
        selectedMonthKey={selectedMonthKey}
        onSelectMonth={(key) => setSelectedMonthKey(key)}
      />

      {/* CUSTOM SHOWPIECE CAPTURE SETTINGS MODAL */}
      <CustomCaptureSettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        criteria={captureCriteria}
        onSaveCriteria={handleSaveCriteriaShowpiece}
      />
    </div>
  );
}
