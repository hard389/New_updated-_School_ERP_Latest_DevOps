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
import { collection, getDocs, onSnapshot, doc, getDoc, query, where } from 'firebase/firestore';
import { onAuthStateChanged } from 'firebase/auth';
import { auth, db } from '../lib/firebase';

// Components & Types
import { StudentCaptureSection } from '../components/analytics/StudentCaptureSection';

export type CaptureCriteria = 'Weighted Score' | 'Attendance Rate' | 'Quiz Marks' | 'overallScore' | 'manualTag';

// Pure analytics/data-contract helpers. These functions never write to Firestore.
const EMPTY_METRICS = {
  attendanceRate: 0,
  absentPercentage: 0,
  presentCount: 0,
  lateCount: 0,
  absentCount: 0,
  absentToday: 0,
  feeRecoveryRate: 0,
  paidCount: 0,
  pendingCount: 0,
  totalRevenue: 0,
  dailyCollectedRevenue: 0,
  dailyPaidCount: 0,
  totalStudentsCount: 0,
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
  const [isDark, setIsDark] = useState(true);
  const [loading, setLoading] = useState(true);
  const [fetchingMetrics, setFetchingMetrics] = useState(false);

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
      setFetchingMetrics(false);
      setNoDataNotification(null);
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
  }, []);

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

  // 1. Listen only to this verified teacher's class subcollection. Never fall back to root classes.
  useEffect(() => {
    let cancelled = false;

    if (!userEmail) {
      setClassesList([]);
      setSelectedClassId('');
      // Auth/tenant resolution owns the loading state until the identity check completes.
      return;
    }

    setLoading(true);
    setClassesList([]);
    setSelectedClassId('');
    setCaptureMetricSnapshot(null);

    const classesRef = collection(db, 'users', userEmail, 'classes');
    const unsubscribe = onSnapshot(
      classesRef,
      (snapshot) => {
        if (cancelled) return;
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
        setClassesList(loadedClasses);
        setNoDataNotification(null);
        setSelectedClassId((previous) =>
          previous && loadedClasses.some((item) => item.id === previous)
            ? previous
            : loadedClasses[0]?.id || ''
        );
        setLoading(false);
      },
      (error: any) => {
        if (cancelled) return;
        console.error(`[Analytics] Class listener failed for users/${userEmail}/classes:`, error);
        setClassesList([]);
        setSelectedClassId('');
        setFeeDetailedStudents([]);
        setCaptureMetricSnapshot(null);
        setMetrics({ ...EMPTY_METRICS });
        setTrendDataPoints([0, 0, 0, 0, 0, 0, 0]);
        setNoDataNotification(error?.code === 'permission-denied'
          ? 'Access denied while loading classes. Check Firestore Security Rules.'
          : error?.code === 'unavailable' || error?.code === 'deadline-exceeded'
          ? 'Network problem while loading classes. Please check your connection.'
          : 'Could not load classes. Please try again.');
        setLoading(false);
      }
    );

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [userEmail]);

  // Ensure selectedClassId stays valid
  useEffect(() => {
    if (classesList.length > 0) {
      const exists = classesList.some((c) => c.id === selectedClassId);
      if (!exists) {
        setSelectedClassId(classesList[0].id);
      }
    }
  }, [classesList, selectedClassId]);

  // 2. Tenant- and class-scoped analytics. This effect is read-only and cancels stale async results.
  useEffect(() => {
    let cancelled = false;
    const selectedClassForContext = classesList.find((item) => item.id === selectedClassId);
    const captureContextKey = buildCaptureContextKey(userEmail, selectedClassId, selectedMonthKey, selectedClassForContext);

    // Remove stale values immediately whenever the tenant, class, month or report mode changes.
    setFetchingMetrics(Boolean(userEmail && selectedClassId && selectedMonthKey));
    setFeeDetailedStudents([]);
    setCaptureMetricSnapshot(null);
    setMetrics({ ...EMPTY_METRICS });
    setTrendDataPoints([0, 0, 0, 0, 0, 0, 0]);

    if (!userEmail || !selectedClassId || !selectedMonthKey) {
      setFetchingMetrics(false);
      return () => { cancelled = true; };
    }
    setNoDataNotification(null);

    const calculateAnalytics = async () => {
      const warnings: string[] = [];
      try {
        const activeClass = classesList.find((item) => item.id === selectedClassId);
        if (!activeClass) {
          if (!cancelled) {
            setFeeDetailedStudents([]);
            setMetrics({ ...EMPTY_METRICS });
            setNoDataNotification('The selected class is no longer available in this teacher workspace.');
          }
          return;
        }

        const classStudents: any[] = Array.isArray(activeClass.students) ? activeClass.students : [];
        const studentsById = new Map<string, any>();
        classStudents.forEach((student) => {
          const rawId = student?.id ?? student?.studentId;
          if (rawId === undefined || rawId === null || String(rawId).trim() === '') return;
          const id = String(rawId);
          if (!studentsById.has(id)) studentsById.set(id, student);
        });
        const uniqueStudents = Array.from(studentsById.entries()).map(([id, student]) => ({ ...student, id }));
        const rosterIds = new Set(uniqueStudents.map((student) => String(student.id)));
        const totalStudents = uniqueStudents.length;
        const normalizedSelectedDate = normalizeDate(selectedDate);

        // A. Attendance. Current Attendance writes include classId and date. If this class has no
        // classId-tagged documents, use a legacy compatibility read inside this tenant only, then
        // require an exact classId or `${classId}_` document-ID prefix.
        const attendanceCollection = collection(db, 'users', userEmail, 'attendance');
        const [monthYear, monthNumber] = selectedMonthKey.split('-').map(Number);
        const monthStart = `${selectedMonthKey}-01`;
        const monthEnd = `${monthYear}-${String(monthNumber).padStart(2, '0')}-${String(new Date(monthYear, monthNumber, 0).getDate()).padStart(2, '0')}`;
        const monthAttendanceQuery = query(
          attendanceCollection,
          where('classId', '==', selectedClassId),
          where('date', '>=', monthStart),
          where('date', '<=', monthEnd)
        );
        const monthAttendanceSnapshot = await getDocs(monthAttendanceQuery);
        const attendanceDocsById = new Map<string, any>();
        monthAttendanceSnapshot.docs.forEach((docSnap) => attendanceDocsById.set(docSnap.id, docSnap));

        // Daily mode may point to a date outside the selected month. Fetch only that class/date.
        if (analyticsType === 'daily' && normalizedSelectedDate &&
            normalizedSelectedDate.slice(0, 7) !== selectedMonthKey) {
          const dailyQuery = query(
            attendanceCollection,
            where('classId', '==', selectedClassId),
            where('date', '==', normalizedSelectedDate)
          );
          const dailySnapshot = await getDocs(dailyQuery);
          dailySnapshot.docs.forEach((docSnap) => attendanceDocsById.set(docSnap.id, docSnap));
        }

        // Compatibility path for older documents without classId/date fields. It is only used
        // when no standard record was found for the current month, and remains tenant-scoped.
        if (monthAttendanceSnapshot.empty) {
          // Prefer a class-only history query before the tenant-wide legacy compatibility scan.
          // This avoids scanning every class on the teacher account when the current month is empty.
          const classHistorySnapshot = await getDocs(query(attendanceCollection, where('classId', '==', selectedClassId)));
          classHistorySnapshot.docs.forEach((docSnap) => attendanceDocsById.set(docSnap.id, docSnap));

          if (classHistorySnapshot.empty) {
            const legacySnapshot = await getDocs(attendanceCollection);
            legacySnapshot.docs.forEach((docSnap) => {
              const data = docSnap.data() || {};
              if (data.classId !== undefined && data.classId !== null && String(data.classId) !== '') {
                if (String(data.classId) !== selectedClassId) return;
              } else if (!docSnap.id.startsWith(`${selectedClassId}_`)) {
                return;
              }
              const date = attendanceDateFromDocument(data, docSnap.id, selectedClassId);
              const monthKey = date ? date.slice(0, 7) : normalizeMonthKey(data.month);
              if (monthKey === selectedMonthKey || (analyticsType === 'daily' && date === normalizedSelectedDate)) {
                attendanceDocsById.set(docSnap.id, docSnap);
              }
            });
          }
        }
        const attendanceDocs = Array.from(attendanceDocsById.values());

        const rowsByDate = new Map<string, { id: string; date: string; monthKey: string; data: any }>();
        attendanceDocs.forEach((docSnap) => {
          const data = docSnap.data() || {};
          if (data.classId !== undefined && data.classId !== null && String(data.classId) !== '' && String(data.classId) !== selectedClassId) return;
          if ((data.classId === undefined || data.classId === null || String(data.classId) === '') &&
              !docSnap.id.startsWith(`${selectedClassId}_`)) return;

          const date = attendanceDateFromDocument(data, docSnap.id, selectedClassId);
          const monthKey = date ? date.slice(0, 7) : normalizeMonthKey(data.month);
          if (!monthKey) {
            console.warn(`[Analytics] Skipped attendance record with no valid date/month: ${docSnap.id}`);
            return;
          }
          const dedupeKey = date || `${monthKey}:${docSnap.id}`;
          const existing = rowsByDate.get(dedupeKey);
          if (!existing || timestampRank(data.updatedAt) >= timestampRank(existing.data.updatedAt)) {
            rowsByDate.set(dedupeKey, { id: docSnap.id, date, monthKey, data });
          }
        });
        const allAttendanceRows = Array.from(rowsByDate.values());
        const monthlyAttendanceRows = allAttendanceRows.filter((row) => row.monthKey === selectedMonthKey);
        const dailyAttendanceRows = normalizedSelectedDate
          ? allAttendanceRows.filter((row) => row.date === normalizedSelectedDate)
          : [];
        const monthlyAttendance = buildAttendanceSummary(monthlyAttendanceRows, rosterIds);
        const dailyAttendance = buildAttendanceSummary(dailyAttendanceRows, rosterIds);
        const activeAttendance = analyticsType === 'daily' ? dailyAttendance : monthlyAttendance;

        // A day contributes to the trend only when it has observed attendance. Missing weekdays
        // stay at zero rather than receiving synthetic/default percentages.
        const weekdayScoreSums = [0, 0, 0, 0, 0, 0, 0];
        const weekdaySamples = [0, 0, 0, 0, 0, 0, 0];
        monthlyAttendanceRows.forEach((row) => {
          if (!row.date) return;
          const day = new Date(`${row.date}T12:00:00`).getDay();
          const weekdayIndex = (day + 6) % 7;
          const rowSummary = summarizeAttendanceDocument(row.data, rosterIds).counts;
          if (rowSummary.total <= 0) return;
          weekdayScoreSums[weekdayIndex] += ((rowSummary.present + rowSummary.late) / rowSummary.total) * 100;
          weekdaySamples[weekdayIndex] += 1;
        });
        const calculatedTrend = weekdayScoreSums.map((sum, index) =>
          weekdaySamples[index] > 0 ? Math.round(sum / weekdaySamples[index]) : 0
        );

        // B. Quiz marks. Quiz Management stores records in this class's subcollection, with
        // monthKey values such as "October 2026" and marks in studentScores[].marksObtained.
        const quizCollection = collection(db, 'users', userEmail, 'classes', selectedClassId, 'quizzes');
        let quizSnapshotDocs: any[] = [];
        try {
          const quizSnapshot = await getDocs(quizCollection);
          quizSnapshotDocs = quizSnapshot.docs;
        } catch (error: any) {
          warnings.push(error?.code === 'permission-denied'
            ? 'Quiz data is unavailable because Firestore denied access.'
            : 'Quiz data could not be loaded; quiz-based captures are unavailable.');
          console.error(`[Analytics] Quiz read failed for ${selectedClassId}:`, error);
        }

        const quizSamplesByStudent: Record<string, Array<{ marksObtained: number; totalMarks: number }>> = {};
        quizSnapshotDocs.forEach((quizSnap) => {
          const quiz = quizSnap.data() || {};
          const quizMonth = normalizeMonthKey(quiz.monthKey) || normalizeMonthKey(quiz.date) || normalizeMonthKey(quiz.createdAt);
          if (quizMonth !== selectedMonthKey) return;
          const totalMarks = parseNonNegativeNumber(quiz.totalMarks);
          if (totalMarks === null || totalMarks <= 0 || !Array.isArray(quiz.studentScores)) {
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
            // Empty/absent marks are missing, not zero. A literal 0 is a valid score.
            if (score.marksObtained === '' || score.marksObtained === null || score.marksObtained === undefined) return;
            const marks = parseNonNegativeNumber(score.marksObtained);
            if (marks === null || marks > totalMarks) {
              console.warn(`[Analytics] Ignored invalid quiz mark for student ${studentId} in ${quizSnap.id}.`);
              return;
            }
            scoredInThisQuiz.add(studentId);
            const samples = quizSamplesByStudent[studentId] ?? [];
            samples.push({ marksObtained: marks, totalMarks });
            quizSamplesByStudent[studentId] = samples;
          });
        });
        const quizTotals: Record<string, { averagePercent: number }> = {};
        Object.entries(quizSamplesByStudent).forEach(([studentId, samples]) => {
          const averagePercent = calculateAverageQuizPercent(samples);
          if (averagePercent !== null) quizTotals[studentId] = { averagePercent };
        });

        // C. Fees. The document ID is `${classId}_${YYYY-MM}`. Never read root/global fees.
        const targetFeeDocId = `${selectedClassId}_${selectedMonthKey}`;
        const feeDocRef = doc(db, 'users', userEmail, 'fees', targetFeeDocId);
        const feeDocSnap = await getDoc(feeDocRef);
        const feeData = feeDocSnap.exists() ? (feeDocSnap.data() || {}) : {};
        if (feeDocSnap.exists()) {
          if (feeData.classId !== undefined && String(feeData.classId) !== selectedClassId) {
            throw new Error('Fee document classId does not match its path. Analytics was stopped to avoid mixing classes.');
          }
          if (feeData.month !== undefined && normalizeMonthKey(feeData.month) !== selectedMonthKey) {
            throw new Error('Fee document month does not match its path. Analytics was stopped to avoid mixing months.');
          }
        }
        let rawFeeRecords: Record<string, any> = {};
        if (feeDocSnap.exists()) {
          const raw = Object.prototype.hasOwnProperty.call(feeData, 'feeRecords') ? feeData.feeRecords : feeData;
          if (!isPlainObject(raw)) {
            warnings.push('Fee record map is malformed; fees were excluded rather than guessed.');
            console.error(`[Analytics] Malformed feeRecords map in ${targetFeeDocId}.`);
          } else {
            rawFeeRecords = raw;
          }
        }

        // Payment receipts are the only reliable source for daily cash collection. The fee
        // record's updatedAt is a document edit time, not necessarily a payment date.
        const receiptTotalsByStudent: Record<string, number> = {};
        const dailyReceiptsByStudent: Record<string, number> = {};
        const lastReceiptDateByStudent: Record<string, string> = {};
        let dailyRevenue = 0;
        const studentsPaidOnSelectedDate = new Set<string>();
        const seenReceiptIds = new Set<string>();
        try {
          const paymentCollection = collection(db, 'users', userEmail, 'fees', targetFeeDocId, 'payments');
          const receiptSnapshot = await getDocs(paymentCollection);
          receiptSnapshot.docs.forEach((receiptSnap) => {
            const receipt = receiptSnap.data() || {};
            const receiptId = String(receipt.paymentId ?? receiptSnap.id);
            if (seenReceiptIds.has(receiptId)) return;
            seenReceiptIds.add(receiptId);
            if (receipt.classId !== undefined && String(receipt.classId) !== selectedClassId) return;
            if (receipt.month !== undefined && normalizeMonthKey(receipt.month) !== selectedMonthKey) return;
            const studentIdRaw = receipt.studentId;
            if (studentIdRaw === undefined || studentIdRaw === null) return;
            const studentId = String(studentIdRaw);
            if (!rosterIds.has(studentId)) return;
            const amount = parseNonNegativeNumber(receipt.amount);
            const paymentDate = normalizeDate(receipt.createdAt ?? receipt.paidAt ?? receipt.date);
            if (amount === null || amount <= 0) {
              if (amount === null) console.warn(`[Analytics] Ignored malformed payment receipt ${receiptSnap.id}.`);
              return;
            }
            receiptTotalsByStudent[studentId] = (receiptTotalsByStudent[studentId] ?? 0) + amount;
            if (paymentDate && (!lastReceiptDateByStudent[studentId] || paymentDate > lastReceiptDateByStudent[studentId])) {
              lastReceiptDateByStudent[studentId] = paymentDate;
            }
            if (paymentDate === normalizedSelectedDate) {
              dailyRevenue += amount;
              dailyReceiptsByStudent[studentId] = (dailyReceiptsByStudent[studentId] ?? 0) + amount;
              studentsPaidOnSelectedDate.add(studentId);
            }
          });
        } catch (error: any) {
          warnings.push(error?.code === 'permission-denied'
            ? 'Daily payment receipts are unavailable because Firestore denied access.'
            : 'Daily payment receipts could not be loaded. Daily revenue is shown only when receipts are readable.');
          console.error(`[Analytics] Payment receipt read failed for ${targetFeeDocId}:`, error);
        }

        let paidStudentsCount = 0;
        let monthTotalRevenue = 0;
        const feeDetailList: FeeDetailStudent[] = [];
        uniqueStudents.forEach((student) => {
          const studentId = String(student.id);
          const recordRaw = rawFeeRecords[studentId];
          const record = isPlainObject(recordRaw) ? recordRaw : null;
          if (recordRaw !== undefined && record === null) {
            console.warn(`[Analytics] Ignored malformed fee record for student ${studentId}.`);
          }
          const recordPaidAmount = parseNonNegativeNumber(record?.paidAmount);
          const receiptPaidAmount = receiptTotalsByStudent[studentId] ?? 0;
          // Avoid double-counting records and receipts which represent the same cash receipts.
          const amountPaid = Math.max(recordPaidAmount ?? 0, receiptPaidAmount);
          monthTotalRevenue += amountPaid;

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

          const paidDate = normalizeDate(record?.paidDate ?? record?.paidAt ?? record?.date)
            || lastReceiptDateByStudent[studentId];
          feeDetailList.push({
            id: studentId,
            name: String(student.name || `Student (${studentId.slice(-4)})`),
            rollNo: String(student.rollNo || student.roll_no || studentId),
            status: isFullyPaid ? 'PAID' : 'UNPAID',
            amountPaid,
            ...(isFullyPaid && paidDate ? { date: paidDate } : {}),
          });
        });

        const activeCounts = activeAttendance.counts;
        const calcAttendanceRate = percent(activeCounts.present + activeCounts.late, activeCounts.total);
        const calculatedAbsentPercentage = percent(activeCounts.absent, activeCounts.total);
        const recoveryRate = totalStudents > 0 ? Math.round((paidStudentsCount / totalStudents) * 100) : 0;
        const pendingStudentsCount = Math.max(0, totalStudents - paidStudentsCount);
        const dailyHasAttendance = dailyAttendance.counts.total > 0;
        const dailyHasPayments = dailyRevenue > 0;

        // The student capture metrics deliberately use the selected MONTH even when the report
        // cards are toggled to Daily Analytics, so changing the date does not reshuffle captures.
        const captureValues: Record<string, { attendanceRate: number | null; quizMarks: number | null; weightedScore: number | null; overallScore: number | null }> = {};
        uniqueStudents.forEach((student) => {
          const id = String(student.id);
          const attendance = monthlyAttendance.byStudent[id];
          const attendanceRate = attendance && attendance.total > 0
            ? ((attendance.present + attendance.late) / attendance.total) * 100
            : null;
          const quizzes = quizTotals[id];
          const quizMarks = quizzes?.averagePercent ?? null;
          const roundedAttendanceRate = attendanceRate === null ? null : Math.round(attendanceRate * 100) / 100;
          const roundedQuizMarks = quizMarks === null ? null : Math.round(quizMarks * 100) / 100;
          const calculatedWeightedScore = calculateWeightedScore(roundedAttendanceRate, roundedQuizMarks);
          const storedOverallScore = parseScoreOutOf100(student.overallScore);
          captureValues[id] = {
            attendanceRate: roundedAttendanceRate,
            quizMarks: roundedQuizMarks,
            // Weighted Score requires both source components; no missing component becomes zero.
            // overallScore keeps the legacy saved value when available, then falls back to the same formula.
            weightedScore: calculatedWeightedScore,
            overallScore: storedOverallScore ?? calculatedWeightedScore,
          };
        });

        const notice = analyticsType === 'daily' && !dailyHasAttendance && !dailyHasPayments
          ? `No attendance or payment receipts found for ${normalizedSelectedDate || selectedDate}. Daily revenue is not inferred from document update timestamps.`
          : warnings[0] ?? null;

        if (cancelled) return;
        setTrendDataPoints(calculatedTrend);
        setNoDataNotification(notice);
        setFeeDetailedStudents(feeDetailList);
        setMetrics({
          attendanceRate: calcAttendanceRate,
          absentPercentage: calculatedAbsentPercentage,
          presentCount: activeCounts.present,
          lateCount: activeCounts.late,
          absentCount: activeCounts.absent,
          absentToday: dailyAttendance.counts.absent,
          feeRecoveryRate: recoveryRate,
          paidCount: paidStudentsCount,
          pendingCount: pendingStudentsCount,
          totalRevenue: Math.round(monthTotalRevenue * 100) / 100,
          dailyCollectedRevenue: Math.round(dailyRevenue * 100) / 100,
          dailyPaidCount: studentsPaidOnSelectedDate.size,
          totalStudentsCount: totalStudents,
        });
        setCaptureMetricSnapshot({ contextKey: captureContextKey, values: captureValues });
      } catch (error: any) {
        if (cancelled) return;
        console.error('[Analytics] Failed to calculate analytics:', error);
        setFeeDetailedStudents([]);
        setCaptureMetricSnapshot(null);
        setMetrics({ ...EMPTY_METRICS });
        setTrendDataPoints([0, 0, 0, 0, 0, 0, 0]);
        const message = error?.code === 'permission-denied'
          ? 'Access denied while loading analytics. Check Firestore Security Rules for this teacher workspace.'
          : error?.code === 'unauthenticated'
          ? 'Your session expired. Please sign in again.'
          : error?.code === 'unavailable' || error?.code === 'deadline-exceeded'
          ? 'Network problem while loading analytics. Please check your connection.'
          : String(error?.message || 'Could not calculate analytics.');
        setNoDataNotification(message);
      } finally {
        if (!cancelled) setFetchingMetrics(false);
      }
    };

    calculateAnalytics();
    return () => { cancelled = true; };
  }, [selectedClassId, selectedMonthKey, selectedDate, analyticsType, classesList, userEmail]);

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
      <div className="min-h-screen bg-[#070b13] flex items-center justify-center text-slate-300">
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
            {fetchingMetrics ? (
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

                  {noDataNotification && (
                    <div className="p-3 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex items-center gap-2.5 text-amber-500 animate-in fade-in duration-300">
                      <AlertCircle className="h-4 w-4 shrink-0 animate-pulse" />
                      <p className="text-[11px] font-bold leading-tight">
                        {noDataNotification}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
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
                {metrics.attendanceRate}%
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
                    {metrics.feeRecoveryRate}%
                  </h2>
                  <span className="text-[10px] font-extrabold text-slate-400">
                    ({metrics.paidCount}/{metrics.totalStudentsCount})
                  </span>
                </div>
              ) : (
                <div className="space-y-0.5">
                  <h2 className="text-lg font-black text-orange-500">
                    PKR {metrics.dailyCollectedRevenue.toLocaleString()}
                  </h2>
                  <p className="text-[10px] font-extrabold text-emerald-500">
                    {metrics.dailyPaidCount} Paid Today
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
                {metrics.totalStudentsCount}
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
                  {analyticsType === 'daily' ? metrics.absentToday : metrics.absentCount}
                </h2>
                <span className="text-xs font-extrabold px-2 py-0.5 rounded-full bg-rose-500/10 text-rose-500 border border-rose-500/20">
                  ({metrics.absentPercentage}%)
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
                    strokeDasharray={`${metrics.attendanceRate}, 100`}
                    strokeWidth="3.8"
                    strokeLinecap="round"
                    stroke="currentColor"
                    fill="none"
                    d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                  />
                </svg>
                <div className="absolute text-center">
                  <p className="text-base font-black text-slate-900 dark:text-slate-100">
                    {metrics.attendanceRate}%
                  </p>
                  <p className="text-[9px] font-bold text-slate-400">Present</p>
                </div>
              </div>

              <div className="space-y-1.5 text-xs font-black">
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
                  <span className="text-slate-500 dark:text-slate-400 font-extrabold">Present</span>
                  <span className="ml-auto font-black">{metrics.presentCount}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full bg-orange-400" />
                  <span className="text-slate-500 dark:text-slate-400 font-extrabold">Late</span>
                  <span className="ml-auto font-black">{metrics.lateCount}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full bg-rose-500" />
                  <span className="text-slate-500 dark:text-slate-400 font-extrabold">Absent</span>
                  <span className="ml-auto font-black">{metrics.absentCount}</span>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white dark:bg-[#0c1222] border border-slate-200/80 dark:border-slate-800 rounded-3xl p-5 shadow-sm space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-black">Fee Collection Summary</h3>
              <span className="text-xs font-black text-orange-500">
                {metrics.feeRecoveryRate}%
              </span>
            </div>

            <div className="w-full bg-slate-100 dark:bg-slate-900 h-3.5 rounded-full overflow-hidden p-0.5">
              <div
                className="bg-gradient-to-r from-orange-500 to-amber-500 h-full rounded-full transition-all duration-500 shadow-sm"
                style={{ width: `${metrics.feeRecoveryRate}%` }}
              />
            </div>

            <div className="grid grid-cols-3 gap-2 text-center pt-1">
              <div className="bg-slate-50 dark:bg-[#070b13] p-2 rounded-2xl border border-slate-100 dark:border-slate-800">
                <p className="text-[9px] font-bold text-slate-400">Paid Students</p>
                <p className="text-xs font-black text-emerald-500">{metrics.paidCount}</p>
              </div>
              <div className="bg-slate-50 dark:bg-[#070b13] p-2 rounded-2xl border border-slate-100 dark:border-slate-800">
                <p className="text-[9px] font-bold text-slate-400">Pending</p>
                <p className="text-xs font-black text-orange-500">{metrics.pendingCount}</p>
              </div>
              <div className="bg-slate-50 dark:bg-[#070b13] p-2 rounded-2xl border border-slate-100 dark:border-slate-800">
                <p className="text-[9px] font-bold text-slate-400">Month Revenue</p>
                <p className="text-[11px] font-black text-slate-800 dark:text-slate-200">
                  PKR {metrics.totalRevenue.toLocaleString()}
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
