/**
 * Pure data helpers for EduTrack Toba reports.
 * Kept separate from React/Firestore so tenant and calculation behavior can be tested
 * deterministically without connecting to production data.
 */

export type AttendanceStatus = 'present' | 'late' | 'absent';

export interface ReportDocument {
  id: string;
  data: Record<string, any>;
}

export interface NormalizedRosterEntry {
  id: string;
  data: Record<string, any>;
}

export interface StudentReportMetrics {
  presentDays: number;
  totalDays: number;
  attendancePct: string;
  quizObtained: number;
  quizTotal: number;
  quizAveragePercent: number | null;
  quizDisplay: string;
}

export const normalizeTenantEmail = (email: unknown): string | null => {
  if (typeof email !== 'string') return null;
  const normalized = email.trim().toLowerCase();
  if (!normalized || normalized.includes('/') || normalized.includes('\\')) return null;
  return normalized;
};

/**
 * Client-side tenant identity check. Firestore Security Rules must enforce the same ownership.
 * A profile must be tied to the current Firebase UID; missing UID is deliberately denied.
 */
export const isAuthorizedTeacherProfile = (
  profile: unknown,
  identity: { uid: string; email: string }
): boolean => {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return false;
  const data = profile as Record<string, unknown>;
  if (typeof data.uid !== 'string' || !data.uid || data.uid !== identity.uid) return false;

  const expectedEmail = normalizeTenantEmail(identity.email);
  if (!expectedEmail) return false;
  if (typeof data.email === 'string' && data.email.trim()) {
    if (normalizeTenantEmail(data.email) !== expectedEmail) return false;
  }

  if (data.role !== undefined && String(data.role).trim().toLowerCase() !== 'teacher') return false;
  if (data.active === false || data.disabled === true || data.deleted === true) return false;
  return true;
};

const pad2 = (value: number): string => String(value).padStart(2, '0');

const makeDateKey = (year: number, month: number, day: number): string => {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return '';
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return '';
  const probe = new Date(year, month - 1, day);
  if (probe.getFullYear() !== year || probe.getMonth() !== month - 1 || probe.getDate() !== day) return '';
  return `${year}-${pad2(month)}-${pad2(day)}`;
};

export const getLocalDateKey = (date: Date): string =>
  Number.isNaN(date.getTime())
    ? ''
    : `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

const toValidDate = (value: unknown): Date | null => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === 'object' && value !== null) {
    const timestamp = value as { toDate?: () => unknown };
    if (typeof timestamp.toDate === 'function') {
      try {
        const date = timestamp.toDate();
        return date instanceof Date && !Number.isNaN(date.getTime()) ? date : null;
      } catch {
        return null;
      }
    }
  }
  if (typeof value === 'string' && value.trim()) {
    const date = new Date(value.trim());
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
};

/** Date-only strings retain their stored calendar day; timestamps convert to local teacher time. */
export const normalizeReportDate = (rawDate: unknown): string => {
  if (rawDate === null || rawDate === undefined || rawDate === '') return '';
  if (typeof rawDate === 'string') {
    const raw = rawDate.trim();
    const ymd = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
    if (ymd) return makeDateKey(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]));
    const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
    if (slash) return makeDateKey(Number(slash[3]), Number(slash[1]), Number(slash[2]));
  }
  const date = toValidDate(rawDate);
  return date ? getLocalDateKey(date) : '';
};

export const normalizeReportMonth = (rawMonth: unknown): string => {
  if (rawMonth === null || rawMonth === undefined || rawMonth === '') return '';
  if (typeof rawMonth === 'string') {
    const raw = rawMonth.trim();
    const yearMonth = /^(\d{4})-(\d{1,2})$/.exec(raw);
    if (yearMonth) {
      const year = Number(yearMonth[1]);
      const month = Number(yearMonth[2]);
      return year >= 1000 && year <= 9999 && month >= 1 && month <= 12
        ? `${year}-${pad2(month)}`
        : '';
    }
    const dateKey = normalizeReportDate(raw);
    if (dateKey) return dateKey.slice(0, 7);
  }
  const date = toValidDate(rawMonth);
  if (date) return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
  if (typeof rawMonth === 'string' && rawMonth.trim()) {
    // Legacy quiz records can store a human-readable month label (e.g. "October 2026").
    const date = new Date(`${rawMonth.trim()} 1`);
    if (!Number.isNaN(date.getTime())) return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
  }
  return '';
};

export interface MonthDateRange {
  startDate: string;
  endDate: string;
  nextMonthStartDate: string;
  start: Date;
  nextMonthStart: Date;
}

export const getReportMonthDateRange = (monthKey: string): MonthDateRange | null => {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(monthKey);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const start = new Date(year, month - 1, 1, 0, 0, 0, 0);
  const nextMonthStart = new Date(year, month, 1, 0, 0, 0, 0);
  const lastDay = new Date(year, month, 0).getDate();
  return {
    startDate: `${match[1]}-${match[2]}-01`,
    endDate: `${match[1]}-${match[2]}-${pad2(lastDay)}`,
    nextMonthStartDate: getLocalDateKey(nextMonthStart),
    start,
    nextMonthStart,
  };
};

const isPlainObject = (value: unknown): value is Record<string, any> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const scalarKey = (value: unknown): string | null => {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
};

/** Supports the current students array and the documented legacy students map without counting both. */
const RESERVED_CLASS_KEYS = new Set([
  'id', 'name', 'code', 'monthlyFee', 'className', 'title', 'fee', 'classFee',
  'createdAt', 'createdDate', 'date', 'updatedAt', 'students', 'subject',
]);

/** Supports the canonical students array/map plus the app's documented legacy top-level student map. */
export const normalizeReportRoster = (rawStudents: unknown, classDocument?: unknown): NormalizedRosterEntry[] => {
  const isArray = Array.isArray(rawStudents);
  let entries: Array<{ storageKey: string; value: unknown }> = isArray
    ? (rawStudents as unknown[]).map((value, index) => ({ storageKey: String(index), value }))
    : isPlainObject(rawStudents)
      ? Object.entries(rawStudents).map(([storageKey, value]) => ({ storageKey, value }))
      : [];

  // Legacy class documents can store students as top-level keyed maps. Only use this
  // representation when the canonical `students` field is absent/empty; never merge both.
  if (entries.length === 0 && (rawStudents === undefined || rawStudents === null) && isPlainObject(classDocument)) {
    entries = Object.entries(classDocument)
      .filter(([key, value]) => !RESERVED_CLASS_KEYS.has(key) && isPlainObject(value))
      .filter(([, value]) => typeof value.name === 'string' || value.id !== undefined || value.studentId !== undefined)
      .map(([storageKey, value]) => ({ storageKey, value }));
  }

  const normalized: NormalizedRosterEntry[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!isPlainObject(entry.value)) continue;
    const explicitId = scalarKey(entry.value.id) ?? scalarKey(entry.value.studentId);
    const id = explicitId ?? (!isArray ? entry.storageKey : null);
    // Never fabricate a stable Firestore student ID for an array row that lacks one.
    if (!id || seen.has(id)) continue;
    seen.add(id);
    normalized.push({ id, data: entry.value });
  }
  return normalized;
};

export const normalizeAttendanceStatus = (raw: unknown): AttendanceStatus | null => {
  let value: unknown = raw;
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

const timestampMillis = (value: unknown): number => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 0 : value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  if (value && typeof value === 'object') {
    const timestamp = value as { toMillis?: () => number; toDate?: () => unknown };
    if (typeof timestamp.toMillis === 'function') {
      try {
        const milliseconds = timestamp.toMillis();
        return Number.isFinite(milliseconds) ? milliseconds : 0;
      } catch {
        return 0;
      }
    }
    if (typeof timestamp.toDate === 'function') {
      const date = toValidDate(value);
      return date ? date.getTime() : 0;
    }
  }
  return 0;
};

/** One authoritative attendance record per class/day; newest updatedAt wins, ID breaks ties. */
export const deduplicateMonthlyAttendance = (
  rows: ReportDocument[],
  classId: string,
  monthKey: string
): ReportDocument[] => {
  const range = getReportMonthDateRange(monthKey);
  if (!range || !classId) return [];
  const prefix = `${classId}_`;
  const byDate = new Map<string, ReportDocument>();

  rows.forEach((row) => {
    if (!isPlainObject(row.data)) return;
    const explicitClassId = scalarKey(row.data.classId);
    if (explicitClassId && explicitClassId !== classId) return;
    if (!explicitClassId && !row.id.startsWith(prefix)) return;

    const idDate = row.id.startsWith(prefix) ? normalizeReportDate(row.id.slice(prefix.length)) : '';
    const date = normalizeReportDate(row.data.date) || idDate;
    if (!date || date < range.startDate || date > range.endDate) return;

    const existing = byDate.get(date);
    const updatedAt = timestampMillis(row.data.updatedAt);
    const existingUpdatedAt = existing ? timestampMillis(existing.data.updatedAt) : -1;
    if (
      !existing ||
      updatedAt > existingUpdatedAt ||
      (updatedAt === existingUpdatedAt && row.id > existing.id)
    ) {
      byDate.set(date, row);
    }
  });

  return Array.from(byDate.entries())
    .sort(([dateA], [dateB]) => dateA.localeCompare(dateB))
    .map(([, row]) => row);
};

const parseNonNegativeNumber = (value: unknown): number | null => {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

const quizMonthFor = (data: Record<string, any>): string =>
  normalizeReportMonth(data.monthKey) || normalizeReportMonth(data.date) || normalizeReportMonth(data.createdAt);

const quizUpdatedAt = (data: Record<string, any>): number =>
  timestampMillis(data.updatedAt ?? data.createdAt ?? data.date);

const collectScores = (quiz: Record<string, any>, rosterIds: Set<string>) => {
  const result: Array<{ studentId: string; marks: number; totalMarks: number }> = [];
  const totalMarks = parseNonNegativeNumber(quiz.totalMarks);
  if (totalMarks === null || totalMarks <= 0 || !Array.isArray(quiz.studentScores)) return result;
  const seenStudents = new Set<string>();
  for (const rawScore of quiz.studentScores) {
    if (!isPlainObject(rawScore)) continue;
    const studentId = scalarKey(rawScore.id) ?? scalarKey(rawScore.studentId);
    if (!studentId || !rosterIds.has(studentId) || seenStudents.has(studentId)) continue;
    // Missing marks are not zero; a literal numeric zero is a valid score.
    if (rawScore.marksObtained === '' || rawScore.marksObtained === null || rawScore.marksObtained === undefined) continue;
    const marks = parseNonNegativeNumber(rawScore.marksObtained);
    if (marks === null || marks > totalMarks) continue;
    seenStudents.add(studentId);
    result.push({ studentId, marks, totalMarks });
  }
  return result;
};

/**
 * Calculates monthly, roster-only metrics in the same way as Analytics:
 * deduplicated local calendar days, present+late / recognized attendance entries,
 * and the mean of per-quiz percentages (not missing scores as zero).
 */
export const calculateMonthlyStudentMetrics = (
  rosterIdsInput: Iterable<string | number>,
  attendanceRows: ReportDocument[],
  quizRows: ReportDocument[],
  classId: string,
  monthKey: string
): Record<string, StudentReportMetrics> => {
  const rosterIds = new Set(Array.from(rosterIdsInput, (id) => String(id)));
  const attendanceStats: Record<string, { present: number; total: number }> = {};
  const quizTotals: Record<string, { obtained: number; possible: number; percentages: number[] }> = {};

  rosterIds.forEach((id) => {
    attendanceStats[id] = { present: 0, total: 0 };
    quizTotals[id] = { obtained: 0, possible: 0, percentages: [] };
  });

  const uniqueAttendanceRows = deduplicateMonthlyAttendance(attendanceRows, classId, monthKey);
  uniqueAttendanceRows.forEach((row) => {
    const data = row.data;
    const studentStatuses = new Map<string, AttendanceStatus>();
    const addStatus = (studentIdRaw: unknown, rawStatus: unknown) => {
      const studentId = scalarKey(studentIdRaw);
      if (!studentId || !rosterIds.has(studentId) || studentStatuses.has(studentId)) return;
      const status = normalizeAttendanceStatus(rawStatus);
      if (status) studentStatuses.set(studentId, status);
    };

    if (isPlainObject(data.attendanceMap)) {
      Object.entries(data.attendanceMap).forEach(([studentId, status]) => addStatus(studentId, status));
    } else {
      const legacyRows = Array.isArray(data.records) ? data.records : Array.isArray(data.students) ? data.students : [];
      legacyRows.forEach((record: unknown) => {
        if (!isPlainObject(record)) return;
        addStatus(record.id ?? record.studentId ?? record.student_id, record);
      });
    }

    studentStatuses.forEach((status, studentId) => {
      const stat = attendanceStats[studentId];
      if (!stat) return;
      stat.total += 1;
      if (status === 'present' || status === 'late') stat.present += 1;
    });
  });

  const uniqueQuizzes = new Map<string, ReportDocument>();
  quizRows.forEach((row) => {
    if (!isPlainObject(row.data)) return;
    const quiz = row.data;
    if (quiz.classId !== undefined && String(quiz.classId) !== classId) return;
    const quizMonth = quizMonthFor(quiz);
    if (quizMonth !== monthKey) return;
    const quizId = scalarKey(quiz.quizId) ?? scalarKey(quiz.id) ?? row.id;
    const identity = `${quizMonth}::${quizId}`;
    const existing = uniqueQuizzes.get(identity);
    if (
      !existing ||
      quizUpdatedAt(quiz) > quizUpdatedAt(existing.data) ||
      (quizUpdatedAt(quiz) === quizUpdatedAt(existing.data) && row.id > existing.id)
    ) {
      uniqueQuizzes.set(identity, row);
    }
  });

  uniqueQuizzes.forEach((row) => {
    collectScores(row.data, rosterIds).forEach(({ studentId, marks, totalMarks }) => {
      const stat = quizTotals[studentId];
      if (!stat) return;
      stat.obtained += marks;
      stat.possible += totalMarks;
      stat.percentages.push((marks / totalMarks) * 100);
    });
  });

  const result: Record<string, StudentReportMetrics> = {};
  rosterIds.forEach((studentId) => {
    const attendance = attendanceStats[studentId];
    const quiz = quizTotals[studentId];
    const quizAveragePercent = quiz.percentages.length
      ? quiz.percentages.reduce((sum, percentage) => sum + percentage, 0) / quiz.percentages.length
      : null;
    result[studentId] = {
      presentDays: attendance.present,
      totalDays: attendance.total,
      attendancePct: attendance.total > 0
        ? `${Math.round((attendance.present / attendance.total) * 100)}%`
        : '—',
      quizObtained: quiz.obtained,
      quizTotal: quiz.possible,
      quizAveragePercent,
      quizDisplay: quizAveragePercent === null ? '—' : `${quizAveragePercent.toFixed(1)}%`,
    };
  });
  return result;
};

/** Extracts only month-specific fee records and rejects a path/document relationship mismatch. */
export const getMonthlyFeeRecords = (
  feeDocument: unknown,
  classId: string,
  monthKey: string
): Record<string, any> => {
  if (!isPlainObject(feeDocument)) return {};
  if (feeDocument.classId !== undefined && String(feeDocument.classId) !== classId) return {};
  if (feeDocument.month !== undefined && normalizeReportMonth(feeDocument.month) !== monthKey) return {};

  if (Object.prototype.hasOwnProperty.call(feeDocument, 'feeRecords')) {
    return isPlainObject(feeDocument.feeRecords) ? feeDocument.feeRecords : {};
  }

  // A limited legacy representation stores student records directly on the monthly fee document.
  const metadataKeys = new Set(['classId', 'month', 'updatedAt', 'createdAt']);
  return Object.fromEntries(Object.entries(feeDocument).filter(([key, value]) => !metadataKeys.has(key) && isPlainObject(value)));
};

export const getFeeStatusForStudent = (
  record: unknown,
  currentRosterStatus: unknown,
  isCurrentMonth: boolean
): string => {
  if (isPlainObject(record) && typeof record.status === 'string' && record.status.trim()) {
    const normalizedStatus = record.status.trim().toUpperCase();
    if (normalizedStatus === 'PAID') return 'Paid';
    if (normalizedStatus === 'PARTIAL') return 'Partial';
    if (normalizedStatus === 'UNPAID') return 'Unpaid';
    return record.status.trim();
  }
  // The embedded class status has no month key; trust it only for the current month.
  if (isCurrentMonth && typeof currentRosterStatus === 'string' && currentRosterStatus.trim()) {
    return currentRosterStatus.trim();
  }
  return 'Unrecorded';
};
