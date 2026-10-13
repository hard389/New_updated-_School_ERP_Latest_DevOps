import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  Bell,
  Sun,
  Moon,
  ChevronRight,
  ChevronLeft,
  Users,
  Wallet,
  Home,
  GraduationCap,
  Settings,
  Save,
  DollarSign,
  CheckCircle2,
  XCircle,
  RefreshCw,
  X,
  CreditCard,
  ArrowLeft,
  Sparkles,
  Calculator,
  PlusCircle,
  Layers,
  Search,
  Check
} from 'lucide-react';

import { db, auth } from '../lib/firebase';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, collection, getDoc, onSnapshot, runTransaction, FieldPath } from 'firebase/firestore';
import type { DocumentData, DocumentReference, Transaction, DocumentSnapshot } from 'firebase/firestore';

interface StudentFeeRecord {
  status: 'PAID' | 'UNPAID' | 'PARTIAL';
  /** Cash received during the selected fee month. Legacy records may use the older allocation semantics. */
  paidAmount: number;
  /** Total outstanding amount, including unpaid previous-month dues. */
  remainingDues: number;
  /** Previous-month balance still outstanding after allocations. */
  previousMonthDues: number;
  /** Fee assessed for this student and month; stored so later class-fee changes do not rewrite history. */
  monthlyFeeDue?: number;
  /** Portion of payments allocated to this month's fee rather than previous-month arrears. */
  paidTowardsCurrentMonth?: number;
}

type FeeStatusPatch =
  | { type: 'none' }
  | { type: 'array'; students: any[] }
  | { type: 'fields'; entries: { path: string[]; value: string }[] };

const MONEY_EPSILON = 0.005;
const BULK_TRANSACTION_STUDENT_LIMIT = 450;

const roundMoney = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

/** Strictly parses a non-negative monetary value. Null/undefined/blank means absent, not zero. */
const parseOptionalMoney = (value: any): number | null => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return roundMoney(parsed);
};

const isPlainObject = (value: any): boolean => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const normalizeTeacherEmail = (email: string | null | undefined): string | null => {
  if (typeof email !== 'string') return null;
  const normalized = email.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
};

const getStudentKey = (student: any): string | null => {
  const raw = student?.id ?? student?.studentId ?? student?._seqKey;
  if (raw === undefined || raw === null) return null;
  const key = String(raw).trim();
  return key.length > 0 ? key : null;
};

const compareStudentKeys = (a: string, b: string): number => {
  const numA = Number(a);
  const numB = Number(b);
  if (!Number.isNaN(numA) && !Number.isNaN(numB)) return numA - numB;
  return a.localeCompare(b);
};

const RESERVED_CLASS_KEYS = [
  'id', 'name', 'monthlyFee', 'className', 'fee', 'classFee', 'createdAt',
  'createdDate', 'date', 'updatedAt', 'students', 'title', 'code'
];

const isStudentRecord = (value: any): boolean => {
  if (!isPlainObject(value)) return false;
  return typeof value.name === 'string' || value.id !== undefined || value.studentId !== undefined;
};

type StudentLayout =
  | { kind: 'array' }
  | { kind: 'studentsMap'; keys: string[] }
  | { kind: 'topLevelMap'; keys: string[] }
  | { kind: 'none' };

const detectStudentLayout = (classData: any): StudentLayout => {
  if (!isPlainObject(classData)) return { kind: 'none' };
  if (Array.isArray(classData.students)) return { kind: 'array' };

  if (isPlainObject(classData.students)) {
    const keys = Object.keys(classData.students)
      .filter((key) => isStudentRecord(classData.students[key]))
      .sort(compareStudentKeys);
    return { kind: 'studentsMap', keys };
  }

  const keys = Object.keys(classData)
    .filter((key) => !RESERVED_CLASS_KEYS.includes(key) && isStudentRecord(classData[key]))
    .sort(compareStudentKeys);
  return keys.length > 0 ? { kind: 'topLevelMap', keys } : { kind: 'none' };
};

/** Read-only extraction. The stored class/student layout is never converted. */
const extractStudentsFromClass = (classData: any): any[] => {
  if (!isPlainObject(classData)) return [];
  const layout = detectStudentLayout(classData);
  if (layout.kind === 'array') return classData.students;
  if (layout.kind === 'studentsMap') {
    return layout.keys.map((key) => ({ ...classData.students[key], _seqKey: key }));
  }
  if (layout.kind === 'topLevelMap') {
    return layout.keys.map((key) => ({ ...classData[key], _seqKey: key }));
  }
  return [];
};

const parseCalendarDate = (rawDate: any): Date | null => {
  if (rawDate === null || rawDate === undefined || rawDate === '') return null;

  try {
    if (rawDate instanceof Date) {
      return Number.isNaN(rawDate.getTime()) ? null : rawDate;
    }
    if (typeof rawDate?.toDate === 'function') {
      const converted = rawDate.toDate();
      return converted instanceof Date && !Number.isNaN(converted.getTime()) ? converted : null;
    }
    if (typeof rawDate === 'object' && Number.isFinite(rawDate.seconds)) {
      const converted = new Date(rawDate.seconds * 1000);
      return Number.isNaN(converted.getTime()) ? null : converted;
    }
    if (typeof rawDate === 'number') {
      const converted = new Date(rawDate);
      return Number.isNaN(converted.getTime()) ? null : converted;
    }
    if (typeof rawDate !== 'string') return null;

    const value = rawDate.trim();
    // Date-only strings represent a calendar date, not midnight UTC.
    const isoDateOnly = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoDateOnly) {
      const converted = new Date(Number(isoDateOnly[1]), Number(isoDateOnly[2]) - 1, Number(isoDateOnly[3]));
      return Number.isNaN(converted.getTime()) ? null : converted;
    }
    // Existing Departments data also accepts MM/DD/YYYY.
    const slashDate = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (slashDate) {
      const converted = new Date(Number(slashDate[3]), Number(slashDate[1]) - 1, Number(slashDate[2]));
      return Number.isNaN(converted.getTime()) ? null : converted;
    }

    const converted = new Date(value);
    return Number.isNaN(converted.getTime()) ? null : converted;
  } catch {
    return null;
  }
};

const getStudentAdmissionMonth = (student: any): string | null => {
  const rawDate = student?.joiningDate || student?.admissionDate || student?.createdAt || student?.date;
  const parsed = parseCalendarDate(rawDate);
  if (!parsed) return null;
  return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}`;
};

const formatDisplayDate = (rawDate: any): string => {
  if (rawDate === null || rawDate === undefined || rawDate === '') return 'N/A';
  const parsed = parseCalendarDate(rawDate);
  if (!parsed) return String(rawDate);
  return parsed.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
};

const getCurrentMonthKey = (): string => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
};

const isValidMonthKey = (value: string): boolean => /^\d{4}-(0[1-9]|1[0-2])$/.test(value);

const getMonthOffset = (monthStr: string, offset: number): string => {
  if (!isValidMonthKey(monthStr)) throw new Error('Invalid fee month key. Expected YYYY-MM.');
  const [year, month] = monthStr.split('-').map(Number);
  const date = new Date(year, month - 1 + offset, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
};

const getBaseMonthlyFee = (classData: any): number => {
  const candidates = [classData?.monthlyFee, classData?.fee, classData?.classFee];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null || candidate === '') continue;
    const parsed = parseOptionalMoney(candidate);
    if (parsed !== null) return parsed;
  }
  return 0;
};

/** Departments stores a per-student override in `studentFee`; use it before the class default. */
const getStudentMonthlyFee = (student: any, classData: any): number => {
  const studentSpecificFee = student?.studentFee ?? student?.classFee ?? student?.monthlyFee;
  if (studentSpecificFee !== undefined && studentSpecificFee !== null && studentSpecificFee !== '') {
    const parsed = parseOptionalMoney(studentSpecificFee);
    if (parsed !== null) return parsed;
  }
  return getBaseMonthlyFee(classData);
};

const assertValidStudentMonthlyFee = (student: any): void => {
  const studentSpecificFee = student?.studentFee ?? student?.classFee ?? student?.monthlyFee;
  if (studentSpecificFee === undefined || studentSpecificFee === null || studentSpecificFee === '') return;
  if (parseOptionalMoney(studentSpecificFee) === null) {
    throw new Error('This student has an invalid monthly fee. Correct the student fee in Departments before recording a payment.');
  }
};

const calculateProratedFee = (student: any, monthlyFee: number) => {
  const rawDate = student?.joiningDate || student?.admissionDate || student?.createdAt || student?.date;
  const date = parseCalendarDate(rawDate);
  if (!date || !Number.isFinite(monthlyFee) || monthlyFee < 0) return null;

  const totalDaysInMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  const joiningDay = date.getDate();
  const daysStudied = Math.max(1, totalDaysInMonth - joiningDay + 1);
  const dailyRate = Math.round(monthlyFee / totalDaysInMonth);
  const proratedFee = roundMoney(daysStudied * (monthlyFee / totalDaysInMonth));

  return {
    joiningDay,
    totalDaysInMonth,
    daysStudied,
    dailyRate,
    proratedFee,
    joiningDateFormatted: formatDisplayDate(rawDate)
  };
};

const formatFeeStatusLabel = (record?: { status?: string }): string => {
  if (record?.status === 'PAID') return 'Paid';
  if (record?.status === 'PARTIAL') return 'Partial';
  return 'Unpaid';
};

const calculateFeeStatus = (
  totalObligation: number,
  remainingDues: number,
  hasRecordedPayment: boolean
): 'PAID' | 'UNPAID' | 'PARTIAL' => {
  // A zero-fee/no-dues student is not treated as paid merely because 0 >= 0.
  if (totalObligation <= MONEY_EPSILON) return 'UNPAID';
  if (remainingDues <= MONEY_EPSILON) return 'PAID';
  return hasRecordedPayment ? 'PARTIAL' : 'UNPAID';
};

const assertOptionalMoneyFields = (record: any, fields: string[], context: string): void => {
  if (!isPlainObject(record)) throw new Error(`${context} is malformed; no changes were saved.`);
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) continue;
    if (parseOptionalMoney(record[field]) === null) {
      throw new Error(`${context} contains an invalid ${field}; reconcile the record before editing it.`);
    }
  }
};

const readFeeRecords = (snap: DocumentSnapshot<DocumentData>, classId: string, month: string): Record<string, any> => {
  if (!snap.exists()) return {};
  const data = snap.data() || {};
  if (data.classId !== undefined && String(data.classId) !== classId) {
    throw new Error('Fee document classId does not match its document path. No changes were made.');
  }
  if (data.month !== undefined && String(data.month) !== month) {
    throw new Error('Fee document month does not match its document path. No changes were made.');
  }
  if (!Object.prototype.hasOwnProperty.call(data, 'feeRecords')) return {};
  if (!isPlainObject(data.feeRecords)) {
    throw new Error('The feeRecords field is malformed. No changes were made.');
  }
  return data.feeRecords;
};

/**
 * A teacher is verified against the existing users/{email} profile document, not the
 * Firebase Auth emailVerified flag. Departments stores and reads classes by this email
 * tenant key, and some legitimate existing teacher accounts may not have emailVerified set.
 * The profile must identify the same UID, email and teacher role. Firestore Rules must
 * independently enforce the same tenant ownership.
 */
const assertTeacherProfile = (profile: any, user: any, expectedEmail: string): void => {
  if (!user || !profile || normalizeTeacherEmail(user.email) !== expectedEmail) {
    throw new Error('Access denied. The signed-in account does not match this teacher profile.');
  }
  const profileUid = typeof profile.uid === 'string' ? profile.uid : '';
  const profileEmail = normalizeTeacherEmail(profile.email ?? expectedEmail);
  const profileRole = String(profile.role ?? '').trim().toLowerCase();
  if (profileUid !== user.uid || profileEmail !== expectedEmail || profileRole !== 'teacher') {
    throw new Error('Access denied. This teacher profile could not be verified.');
  }
};

const hasAuthenticatedTenantSession = (expectedEmail: string | null): boolean => {
  const user = auth.currentUser;
  return Boolean(expectedEmail && user && normalizeTeacherEmail(user.email) === expectedEmail);
};

const assertVerifiedTenant = async (expectedEmail: string): Promise<void> => {
  const user = auth.currentUser;
  if (!user || !normalizeTeacherEmail(user.email) || normalizeTeacherEmail(user.email) !== expectedEmail) {
    throw new Error('Access denied. Sign in with the teacher account that owns this data.');
  }
  // Refresh the Firebase ID token, then verify ownership against the existing teacher profile.
  await user.getIdToken(true);
  const latestUser = auth.currentUser;
  if (!latestUser || latestUser.uid !== user.uid || normalizeTeacherEmail(latestUser.email) !== expectedEmail) {
    throw new Error('The signed-in teacher changed. Please reopen the Fees page and retry.');
  }
  const profileSnap = await getDoc(doc(db, 'users', expectedEmail));
  if (!profileSnap.exists()) throw new Error('The teacher profile does not exist. Access was denied.');
  assertTeacherProfile(profileSnap.data(), latestUser, expectedEmail);
};

const getTransactionFeeState = (
  currentRecord: any,
  previousRecord: any,
  student: any,
  previousMonth: string,
  defaultMonthlyFee: number
) => {
  const studentAdmissionMonth = getStudentAdmissionMonth(student);
  const canCarryPreviousDues = !studentAdmissionMonth || previousMonth >= studentAdmissionMonth;

  if (currentRecord !== undefined && !isPlainObject(currentRecord)) {
    throw new Error('This student fee record is malformed. No changes were saved.');
  }
  if (previousRecord !== undefined && !isPlainObject(previousRecord)) {
    throw new Error('This student previous-month fee record is malformed. No changes were saved.');
  }
  assertOptionalMoneyFields(currentRecord === undefined ? {} : currentRecord, [
    'paidAmount', 'remainingDues', 'previousMonthDues', 'monthlyFeeDue', 'paidTowardsCurrentMonth'
  ], 'Current student fee record');
  if (previousRecord !== undefined) {
    assertOptionalMoneyFields(previousRecord, ['paidAmount', 'remainingDues', 'previousMonthDues', 'monthlyFeeDue'], 'Previous-month student fee record');
  }

  const oldPreviousRemaining = parseOptionalMoney(previousRecord?.remainingDues) ?? 0;
  const legacyPreviousRemaining = parseOptionalMoney(currentRecord?.previousMonthDues) ?? 0;
  const previousMonthDues = canCarryPreviousDues
    ? Math.max(oldPreviousRemaining, legacyPreviousRemaining)
    : 0;

  const monthlyFeeDue = parseOptionalMoney(currentRecord?.monthlyFeeDue) ?? defaultMonthlyFee;
  const storedRemaining = parseOptionalMoney(currentRecord?.remainingDues);
  const storedAllocation = parseOptionalMoney(currentRecord?.paidTowardsCurrentMonth);
  let paidTowardsCurrentMonth: number;

  if (storedAllocation !== null) {
    paidTowardsCurrentMonth = Math.min(monthlyFeeDue, storedAllocation);
  } else if (storedRemaining !== null) {
    // Legacy record compatibility: infer the allocation from its recorded balance, never from `paidAmount > 0` alone.
    paidTowardsCurrentMonth = Math.min(
      monthlyFeeDue,
      Math.max(0, roundMoney(monthlyFeeDue + previousMonthDues - storedRemaining))
    );
  } else {
    // Older records used paidAmount for the current-month allocation; true historic cash collection cannot be reconstructed.
    paidTowardsCurrentMonth = Math.min(monthlyFeeDue, parseOptionalMoney(currentRecord?.paidAmount) ?? 0);
  }

  const paidAmount = parseOptionalMoney(currentRecord?.paidAmount) ?? 0;
  const remainingDues = Math.max(0, roundMoney(previousMonthDues + monthlyFeeDue - paidTowardsCurrentMonth));
  const totalObligation = roundMoney(previousMonthDues + monthlyFeeDue);
  const status = calculateFeeStatus(totalObligation, remainingDues, paidAmount > 0 || paidTowardsCurrentMonth > 0);

  return {
    monthlyFeeDue,
    paidAmount,
    paidTowardsCurrentMonth,
    previousMonthDues,
    remainingDues,
    totalObligation,
    status
  };
};

const findStudentInClass = (classData: any, studentId: string): any | null => {
  return extractStudentsFromClass(classData).find((student) => getStudentKey(student) === studentId) ?? null;
};

const buildFeeStatusPatch = (
  classData: any,
  currentFeeMap: Record<string, { status?: string }>,
  targetStudentIds: string[]
): FeeStatusPatch => {
  const layout = detectStudentLayout(classData);
  const targets = new Set(targetStudentIds.map(String));

  if (layout.kind === 'array') {
    let changed = false;
    const nextStudents = classData.students.map((student: any) => {
      if (!isStudentRecord(student)) return student;
      const studentKey = getStudentKey(student);
      if (!studentKey || !targets.has(studentKey)) return student;
      const record = currentFeeMap[studentKey];
      if (!record) return student;
      const label = formatFeeStatusLabel(record);
      if (student.feeStatus === label) return student;
      changed = true;
      return { ...student, feeStatus: label };
    });
    return changed ? { type: 'array', students: nextStudents } : { type: 'none' };
  }

  if (layout.kind === 'studentsMap' || layout.kind === 'topLevelMap') {
    const entries: { path: string[]; value: string }[] = [];
    layout.keys.forEach((containerKey) => {
      const student = layout.kind === 'studentsMap' ? classData.students[containerKey] : classData[containerKey];
      const rawIdentity = student.id ?? student.studentId;
      const studentKey = getStudentKey(rawIdentity === undefined || rawIdentity === null
        ? { ...student, _seqKey: containerKey }
        : student);
      if (!studentKey || !targets.has(studentKey)) return;
      const record = currentFeeMap[studentKey];
      if (!record) return;
      const label = formatFeeStatusLabel(record);
      if (student.feeStatus === label) return;
      const path = layout.kind === 'studentsMap'
        ? ['students', containerKey, 'feeStatus']
        : [containerKey, 'feeStatus'];
      entries.push({ path, value: label });
    });
    return entries.length > 0 ? { type: 'fields', entries } : { type: 'none' };
  }
  return { type: 'none' };
};

const applyFeeStatusPatch = (
  tx: Transaction,
  classRef: DocumentReference<DocumentData>,
  classData: any,
  currentFeeMap: Record<string, { status?: string }>,
  targetStudentIds: string[]
): void => {
  const patch = buildFeeStatusPatch(classData, currentFeeMap, targetStudentIds);
  if (patch.type === 'array') {
    // Only the existing students array field is replaced, using the latest transaction snapshot.
    tx.update(classRef, new FieldPath('students'), patch.students);
  } else if (patch.type === 'fields') {
    const args: any[] = [];
    patch.entries.forEach((entry) => args.push(new FieldPath(...entry.path), entry.value));
    if (args.length > 0) tx.update(classRef, args[0], args[1], ...args.slice(2));
  }
};

const writeFeeRecordFields = (
  tx: Transaction,
  ref: DocumentReference<DocumentData>,
  records: Record<string, StudentFeeRecord>,
  metadata: { classId: string; month: string; updatedAt: string },
  documentExists: boolean,
  existingRawRecords: Record<string, any>
): void => {
  const ids = Object.keys(records);
  if (ids.length === 0) return;

  if (!documentExists) {
    const feeRecords: Record<string, StudentFeeRecord> = {};
    ids.forEach((id) => { feeRecords[id] = records[id]; });
    tx.set(ref, { ...metadata, feeRecords });
    return;
  }

  const rawMapExists = Object.keys(existingRawRecords).length > 0;
  const currentDocRef = ref;
  if (!rawMapExists) {
    const feeRecords: Record<string, StudentFeeRecord> = {};
    ids.forEach((id) => { feeRecords[id] = records[id]; });
    tx.update(currentDocRef, {
      classId: metadata.classId,
      month: metadata.month,
      feeRecords,
      updatedAt: metadata.updatedAt
    });
    return;
  }

  const args: any[] = [];
  ids.forEach((id) => args.push(new FieldPath('feeRecords', id), records[id]));
  args.push(new FieldPath('classId'), metadata.classId);
  args.push(new FieldPath('month'), metadata.month);
  args.push(new FieldPath('updatedAt'), metadata.updatedAt);
  tx.update(currentDocRef, args[0], args[1], ...args.slice(2));
};

const createOperationId = (): string => {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    // Use the fallback below when crypto is unavailable in the current browser context.
  }
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;
};

/** Stable per-submit key: sessions starting from the same fee state and amount share one receipt. */
const createPaymentIdempotencyKey = async (basis: string): Promise<string> => {
  if (typeof crypto !== 'undefined' && crypto.subtle && typeof TextEncoder !== 'undefined') {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(basis));
    const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `payment_${hex}`;
  }
  // HTTPS/modern browsers normally use SHA-256 above. This URL-safe fallback remains deterministic.
  const encoded = encodeURIComponent(basis);
  if (encoded.length > 1300) throw new Error('The payment identity is too long to create a safe idempotency key.');
  return `payment_${encoded}`;
};

const getFriendlyErrorMessage = (error: any): string => {
  if (error?.code === 'permission-denied') return 'Permission denied. Verify the teacher account and Firestore Security Rules.';
  if (error?.code === 'unauthenticated') return 'Your session has expired. Sign in again and retry.';
  if (error instanceof Error && /malformed|invalid|does not match|missing|access denied|teacher session changed|no longer exists|no longer belongs/i.test(error.message)) return error.message;
  if (error instanceof Error && /overpay|exceeds outstanding|no outstanding dues/i.test(error.message)) return error.message;
  return 'Unable to save the fee record. No partial save was accepted; check your connection and retry.';
};

interface PaymentOperationContext {
  id: string;
  teacherEmail: string;
  classId: string;
  month: string;
  studentId: string;
  paymentAmount?: number;
  idempotencyBasis?: string;
  outcomeUncertain?: boolean;
}

export default function Fees() {
  const location = useLocation();
  const navigate = useNavigate();
  const [isDark, setIsDark] = useState(false);
  const [currentUserEmail, setCurrentUserEmail] = useState<string | null>(null);

  const [classes, setClasses] = useState<any[]>([]);
  const [selectedClassId, setSelectedClassId] = useState('');
  const [feeMap, setFeeMap] = useState<Record<string, StudentFeeRecord>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [hasPrevMonthRecords, setHasPrevMonthRecords] = useState(false);

  const [isClassModalOpen, setIsClassModalOpen] = useState(false);
  const [isMonthModalOpen, setIsMonthModalOpen] = useState(false);
  const [classSearchQuery, setClassSearchQuery] = useState('');

  const [statusFilter, setStatusFilter] = useState<'ALL' | 'PAID' | 'UNPAID' | 'PARTIAL'>('ALL');
  const [genderFilter, setGenderFilter] = useState<'ALL' | 'Male' | 'Female'>('ALL');
  const [currentPage, setCurrentPage] = useState(1);
  const ITEMS_PER_PAGE = 10;

  const [activeModalStudent, setActiveModalStudent] = useState<any | null>(null);
  const [modalPaidInput, setModalPaidInput] = useState<string>('');
  const [modalPrevDuesInput, setModalPrevDuesInput] = useState<string>('0');
  const [modalFeeOverride, setModalFeeOverride] = useState<number | null>(null);
  const paymentOperationRef = useRef<PaymentOperationContext | null>(null);
  const paymentInFlightRef = useRef(false);
  const bulkActionInFlightRef = useRef(false);
  const notifiedReadErrorRef = useRef<string | null>(null);

  const currentClass = useMemo(() => {
    return classes.find((item) => item.id === selectedClassId) || {
      id: '', name: 'Select Class', students: [], monthlyFee: 0
    };
  }, [selectedClassId, classes]);

  const monthOptions = useMemo(() => {
    const currentMonthKey = getCurrentMonthKey();
    const previousMonthKey = getMonthOffset(currentMonthKey, -1);
    const formatMonth = (monthKey: string) => {
      const [year, month] = monthKey.split('-').map(Number);
      const date = new Date(year, month - 1, 1);
      return {
        label: date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
        value: monthKey
      };
    };

    const hasOlderStudent = (currentClass.students || []).some((student: any) => {
      const admissionMonth = getStudentAdmissionMonth(student);
      return admissionMonth !== null && admissionMonth <= previousMonthKey;
    });

    if (!hasPrevMonthRecords && !hasOlderStudent) return [formatMonth(currentMonthKey)];
    return [formatMonth(currentMonthKey), formatMonth(previousMonthKey)];
  }, [currentClass.students, hasPrevMonthRecords]);

  const [selectedMonth, setSelectedMonth] = useState<string>(() => getCurrentMonthKey());

  useEffect(() => {
    if (monthOptions.length > 0 && !monthOptions.some((month) => month.value === selectedMonth)) {
      setSelectedMonth(monthOptions[0].value);
    }
  }, [monthOptions, selectedMonth]);

  // A tenant key comes only from the currently authenticated, verified Firebase user.
  useEffect(() => {
    let active = true;
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (!user || !user.email) {
        if (!active) return;
        setCurrentUserEmail(null);
        setClasses([]);
        setSelectedClassId('');
        setFeeMap({});
        setHasPrevMonthRecords(false);
        setIsLoading(false);
        setActiveModalStudent(null);
        paymentOperationRef.current = null;
        return;
      }

      // Clear the prior tenant immediately, then verify this user's profile before listening to data.
      setCurrentUserEmail(null);
      setClasses([]);
      setSelectedClassId('');
      setFeeMap({});
      setHasPrevMonthRecords(false);
      setActiveModalStudent(null);
      paymentOperationRef.current = null;
      setIsLoading(true);

      try {
        const tenantEmail = normalizeTeacherEmail(user.email);
        if (!tenantEmail) throw new Error('The signed-in account has no valid email address.');
        await assertVerifiedTenant(tenantEmail);
        if (!active || auth.currentUser?.uid !== user.uid || !hasAuthenticatedTenantSession(tenantEmail)) return;
        setCurrentUserEmail(tenantEmail);
      } catch (error) {
        console.error('Unable to verify the current teacher session:', error);
        if (!active) return;
        setCurrentUserEmail(null);
        setClasses([]);
        setSelectedClassId('');
        setFeeMap({});
        setIsLoading(false);
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  // Subscribe only to the teacher's own classes collection. No UID/global fallbacks.
  useEffect(() => {
    if (!currentUserEmail || !hasAuthenticatedTenantSession(currentUserEmail)) {
      setClasses([]);
      setSelectedClassId('');
      setFeeMap({});
      setIsLoading(false);
      return;
    }

    let active = true;
    setIsLoading(true);
    const classesRef = collection(db, 'users', currentUserEmail, 'classes');
    const unsubscribe = onSnapshot(classesRef, (snapshot) => {
      if (!active) return;
      const fetchedClasses = snapshot.docs.map((docSnap) => {
        const data = docSnap.data();
        return {
          ...data,
          id: docSnap.id,
          name: data.name || data.className || data.title || docSnap.id,
          monthlyFee: getBaseMonthlyFee(data),
          students: extractStudentsFromClass(data)
        };
      });

      fetchedClasses.sort((a, b) =>
        (a.name || '').localeCompare(b.name || '', undefined, { numeric: true, sensitivity: 'base' })
      );
      setClasses(fetchedClasses);
      setSelectedClassId((previous) =>
        previous && fetchedClasses.some((item) => item.id === previous)
          ? previous
          : (fetchedClasses[0]?.id || '')
      );
      setIsLoading(false);
    }, (error) => {
      console.error('Error fetching this teacher\'s classes:', error);
      if (!active) return;
      setClasses([]);
      setSelectedClassId('');
      setFeeMap({});
      setIsLoading(false);
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [currentUserEmail]);

  // Keep month-picker availability anchored to the current calendar month, not the selected month.
  // This avoids the previous-month option disappearing while that option is selected.
  useEffect(() => {
    if (!currentUserEmail || !selectedClassId) {
      setHasPrevMonthRecords(false);
      return;
    }

    const previousCalendarMonth = getMonthOffset(getCurrentMonthKey(), -1);
    const previousCalendarMonthRef = doc(
      db, 'users', currentUserEmail, 'fees', `${selectedClassId}_${previousCalendarMonth}`
    );
    let active = true;
    const unsubscribe = onSnapshot(previousCalendarMonthRef, (snapshot) => {
      if (!active) return;
      try {
        const records = readFeeRecords(snapshot, selectedClassId, previousCalendarMonth);
        setHasPrevMonthRecords(Object.keys(records).length > 0);
      } catch (error) {
        console.error('Invalid previous-calendar-month fee data:', error);
        setHasPrevMonthRecords(false);
      }
    }, (error) => {
      console.error('Unable to check the previous-calendar-month fee record:', error);
      if (active) setHasPrevMonthRecords(false);
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [currentUserEmail, selectedClassId]);

  const selectedMonthObj = useMemo(() => {
    return monthOptions.find((month) => month.value === selectedMonth) || monthOptions[0];
  }, [selectedMonth, monthOptions]);

  const eligibleStudentsForMonth = useMemo(() => {
    const rawStudents = currentClass.students || [];
    return rawStudents.filter((student: any) => {
      const studentName = (student?.name || '').trim();
      if (!studentName || studentName.toLowerCase() === 'unnamed student') return false;
      // Do not invent identity keys from a name or a mutable array index.
      if (!getStudentKey(student)) return false;
      const admissionMonth = getStudentAdmissionMonth(student);
      if (admissionMonth && selectedMonth < admissionMonth) return false;
      return true;
    });
  }, [currentClass.students, selectedMonth]);

  const docKey = `${selectedClassId}_${selectedMonth}`;
  const monthlyFee = getBaseMonthlyFee(currentClass);

  // Live read-only merge. Reading a fee page never mutates or clears previous-month balances.
  useEffect(() => {
    if (
      !selectedClassId || !currentUserEmail || !isValidMonthKey(selectedMonth) ||
      !hasAuthenticatedTenantSession(currentUserEmail)
    ) {
      setFeeMap({});
      return;
    }

    let active = true;
    let gotCurrent = false;
    let gotPrevious = false;
    let currentRecords: Record<string, any> = {};
    let previousRecords: Record<string, any> = {};
    setIsLoading(true);

    const previousMonth = getMonthOffset(selectedMonth, -1);
    const currentFeeRef = doc(db, 'users', currentUserEmail, 'fees', docKey);
    const previousFeeRef = doc(db, 'users', currentUserEmail, 'fees', `${selectedClassId}_${previousMonth}`);

    const recalculateFeeMap = () => {
      if (!active || !gotCurrent || !gotPrevious) return;
      try {
        const nextMap: Record<string, StudentFeeRecord> = {};

        eligibleStudentsForMonth.forEach((student: any) => {
          const studentId = getStudentKey(student);
          if (!studentId) return;
          const hasCurrentRecord = Object.prototype.hasOwnProperty.call(currentRecords, studentId);
          const hasPreviousRecord = Object.prototype.hasOwnProperty.call(previousRecords, studentId);
          const rawCurrent = currentRecords[studentId];
          const rawPrevious = previousRecords[studentId];
          const moneyFields = ['paidAmount', 'remainingDues', 'previousMonthDues', 'monthlyFeeDue', 'paidTowardsCurrentMonth'];
          if (hasCurrentRecord) assertOptionalMoneyFields(rawCurrent, moneyFields, `Current fee record for student ${studentId}`);
          if (hasPreviousRecord) assertOptionalMoneyFields(rawPrevious, moneyFields, `Previous fee record for student ${studentId}`);
          assertValidStudentMonthlyFee(student);

          const studentMonthlyFee = getStudentMonthlyFee(student, currentClass);
          const admissionMonth = getStudentAdmissionMonth(student);
        const canCarryPreviousDues = !admissionMonth || previousMonth >= admissionMonth;
        const previousRecordRemaining = parseOptionalMoney(rawPrevious?.remainingDues) ?? 0;
        const previousDueStoredOnCurrent = parseOptionalMoney(rawCurrent?.previousMonthDues) ?? 0;
        const previousMonthDues = canCarryPreviousDues
          ? Math.max(previousRecordRemaining, previousDueStoredOnCurrent)
          : 0;
        const storedFeeDue = parseOptionalMoney(rawCurrent?.monthlyFeeDue);
        const monthlyFeeDue = storedFeeDue ?? studentMonthlyFee;
        const storedRemaining = parseOptionalMoney(rawCurrent?.remainingDues);
        const storedAllocation = parseOptionalMoney(rawCurrent?.paidTowardsCurrentMonth);
        const collected = parseOptionalMoney(rawCurrent?.paidAmount) ?? 0;

        let paidTowardsCurrentMonth = 0;
        if (isPlainObject(rawCurrent) && storedAllocation !== null) {
          paidTowardsCurrentMonth = Math.min(monthlyFeeDue, storedAllocation);
        } else if (isPlainObject(rawCurrent) && storedRemaining !== null) {
          paidTowardsCurrentMonth = Math.min(
            monthlyFeeDue,
            Math.max(0, roundMoney(monthlyFeeDue + previousMonthDues - storedRemaining))
          );
        } else if (isPlainObject(rawCurrent)) {
          // Legacy fallback only; historical collection/allocation semantics cannot be perfectly reconstructed.
          paidTowardsCurrentMonth = Math.min(monthlyFeeDue, collected);
        }

        const remainingDues = Math.max(0, roundMoney(previousMonthDues + monthlyFeeDue - paidTowardsCurrentMonth));
        const totalObligation = roundMoney(previousMonthDues + monthlyFeeDue);
        const status = calculateFeeStatus(
          totalObligation,
          remainingDues,
          collected > 0 || paidTowardsCurrentMonth > 0
        );

          nextMap[studentId] = {
            ...(isPlainObject(rawCurrent) ? rawCurrent : {}),
            status,
            paidAmount: collected,
            remainingDues,
            previousMonthDues,
            monthlyFeeDue,
            paidTowardsCurrentMonth
          };
        });

        if (!active) return;
        setFeeMap(nextMap);
        setIsLoading(false);
        notifiedReadErrorRef.current = null;
      } catch (error) {
        handleSnapshotError('student', error);
      }
    };

    const handleSnapshotError = (label: string, error: any) => {
      console.error(`Unable to read ${label} fee records:`, error);
      if (!active) return;
      setFeeMap({});
      setIsLoading(false);
      const errorKey = `${currentUserEmail}/${selectedClassId}/${selectedMonth}`;
      if (notifiedReadErrorRef.current !== errorKey) {
        notifiedReadErrorRef.current = errorKey;
        window.alert('Fee data could not be verified for this class and month. Displayed fee statuses may be incomplete; do not record a payment until the data loads successfully.');
      }
    };

    const unsubscribePrevious = onSnapshot(previousFeeRef, (snapshot) => {
      try {
        previousRecords = readFeeRecords(snapshot, selectedClassId, previousMonth);
        gotPrevious = true;
        recalculateFeeMap();
      } catch (error) {
        handleSnapshotError('previous-month', error);
      }
    }, (error) => handleSnapshotError('previous-month', error));

    const unsubscribeCurrent = onSnapshot(currentFeeRef, (snapshot) => {
      try {
        currentRecords = readFeeRecords(snapshot, selectedClassId, selectedMonth);
        gotCurrent = true;
        recalculateFeeMap();
      } catch (error) {
        handleSnapshotError('current-month', error);
      }
    }, (error) => handleSnapshotError('current-month', error));

    return () => {
      active = false;
      unsubscribePrevious();
      unsubscribeCurrent();
    };
  }, [selectedClassId, selectedMonth, docKey, eligibleStudentsForMonth, monthlyFee, currentUserEmail]);

  useEffect(() => setCurrentPage(1), [statusFilter, genderFilter, selectedClassId, selectedMonth]);

  const sortedStudentsList = useMemo(() => {
    const list = [...eligibleStudentsForMonth];
    return list.sort((a: any, b: any) => {
      const seqA = a.rollNo ?? a.roll_no ?? a.seq ?? a._seqKey ?? a.id ?? a.studentId;
      const seqB = b.rollNo ?? b.roll_no ?? b.seq ?? b._seqKey ?? b.id ?? b.studentId;
      const numA = parseFloat(String(seqA).replace(/\D/g, ''));
      const numB = parseFloat(String(seqB).replace(/\D/g, ''));
      if (!Number.isNaN(numA) && !Number.isNaN(numB) && numA !== numB) return numA - numB;
      return (a.name || '').localeCompare(b.name || '');
    });
  }, [eligibleStudentsForMonth]);

  const totalStudents = sortedStudentsList.length;
  const paidCount = useMemo(() => sortedStudentsList.filter((student: any) => feeMap[getStudentKey(student) || '']?.status === 'PAID').length, [sortedStudentsList, feeMap]);
  const unpaidCount = useMemo(() => sortedStudentsList.filter((student: any) => !feeMap[getStudentKey(student) || ''] || feeMap[getStudentKey(student) || '']?.status === 'UNPAID').length, [sortedStudentsList, feeMap]);
  const partialCount = useMemo(() => sortedStudentsList.filter((student: any) => feeMap[getStudentKey(student) || '']?.status === 'PARTIAL').length, [sortedStudentsList, feeMap]);

  const totalCollectedPKR = useMemo(() => sortedStudentsList.reduce((sum: number, student: any) => sum + (feeMap[getStudentKey(student) || '']?.paidAmount || 0), 0), [sortedStudentsList, feeMap]);
  const totalPendingDuesPKR = useMemo(() => sortedStudentsList.reduce((sum: number, student: any) => sum + (feeMap[getStudentKey(student) || '']?.remainingDues || 0), 0), [sortedStudentsList, feeMap]);
  const totalPrevMonthDuesPKR = useMemo(() => sortedStudentsList.reduce((sum: number, student: any) => sum + (feeMap[getStudentKey(student) || '']?.previousMonthDues || 0), 0), [sortedStudentsList, feeMap]);

  const filteredStudents = useMemo(() => {
    return sortedStudentsList.filter((student: any) => {
      const key = getStudentKey(student) || '';
      const record = feeMap[key];
      const matchesGender = genderFilter === 'ALL' || student.gender === genderFilter;
      if (!matchesGender) return false;
      if (statusFilter === 'PAID') return record?.status === 'PAID';
      if (statusFilter === 'UNPAID') return !record || record.status === 'UNPAID';
      if (statusFilter === 'PARTIAL') return record?.status === 'PARTIAL';
      return true;
    });
  }, [sortedStudentsList, statusFilter, genderFilter, feeMap]);

  const totalPages = useMemo(() => Math.ceil(filteredStudents.length / ITEMS_PER_PAGE) || 1, [filteredStudents.length]);
  const paginatedStudents = useMemo(() => {
    const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
    return filteredStudents.slice(startIndex, startIndex + ITEMS_PER_PAGE);
  }, [filteredStudents, currentPage]);
  const filteredClassesList = useMemo(() => classes.filter((item) => (item.name || '').toLowerCase().includes(classSearchQuery.toLowerCase())), [classes, classSearchQuery]);

  const openPaymentModal = (student: any) => {
    const studentId = getStudentKey(student);
    if (!studentId || !currentUserEmail || !hasAuthenticatedTenantSession(currentUserEmail)) {
      window.alert('This student or teacher identity could not be verified. No payment was opened.');
      return;
    }

    const existing = feeMap[studentId];
    const defaultFee = getStudentMonthlyFee(student, currentClass);
    const feeDue = parseOptionalMoney(existing?.monthlyFeeDue) ?? defaultFee;
    const previousDues = parseOptionalMoney(existing?.previousMonthDues) ?? 0;
    const paidTowardsCurrent = parseOptionalMoney(existing?.paidTowardsCurrentMonth) ?? 0;
    const remaining = parseOptionalMoney(existing?.remainingDues) ?? Math.max(0, roundMoney(previousDues + feeDue - paidTowardsCurrent));

    paymentOperationRef.current = {
      id: '',
      teacherEmail: currentUserEmail,
      classId: selectedClassId,
      month: selectedMonth,
      studentId,
      outcomeUncertain: false
    };
    setActiveModalStudent(student);
    setModalFeeOverride(parseOptionalMoney(existing?.monthlyFeeDue));
    setModalPrevDuesInput(previousDues.toString());
    setModalPaidInput(remaining.toString());
  };

  const closeModal = () => {
    if (paymentInFlightRef.current) return;
    if (paymentOperationRef.current?.outcomeUncertain) {
      window.alert('The last payment result is not confirmed. Retry the same amount to reconcile it before closing this payment form.');
      return;
    }
    setActiveModalStudent(null);
    setModalFeeOverride(null);
    paymentOperationRef.current = null;
  };

  const handleSaveModalPayment = async () => {
    if (paymentInFlightRef.current) return;
    const operation = paymentOperationRef.current;
    if (!activeModalStudent || !operation) {
      window.alert('The payment session is no longer valid. Reopen the student payment form.');
      return;
    }
    if (
      operation.teacherEmail !== currentUserEmail || operation.classId !== selectedClassId ||
      operation.month !== selectedMonth || operation.studentId !== getStudentKey(activeModalStudent)
    ) {
      window.alert('The selected teacher, class, month, or student changed. Reopen the payment form.');
      return;
    }

    const paymentAmount = parseOptionalMoney(modalPaidInput);
    if (paymentAmount === null || paymentAmount <= MONEY_EPSILON) {
      window.alert('Enter a valid payment amount greater than zero.');
      return;
    }
    if (operation.paymentAmount !== undefined && roundMoney(paymentAmount) !== operation.paymentAmount) {
      window.alert('A previous submission may still be processing. Keep the same amount while retrying this payment; a new amount requires a verified outcome and a new payment session.');
      return;
    }
    if (!isValidMonthKey(operation.month)) {
      window.alert('Invalid month key. No payment was saved.');
      return;
    }

    paymentInFlightRef.current = true;
    try {
      await assertVerifiedTenant(operation.teacherEmail);
      if (!operation.id) {
        const displayedRecord = feeMap[operation.studentId];
        const monthlyFeeAtSubmit = parseOptionalMoney(modalFeeOverride)
          ?? parseOptionalMoney(displayedRecord?.monthlyFeeDue)
          ?? getStudentMonthlyFee(activeModalStudent, currentClass);
        const submissionBasis = JSON.stringify([
          operation.teacherEmail,
          operation.classId,
          operation.month,
          operation.studentId,
          roundMoney(paymentAmount),
          parseOptionalMoney(displayedRecord?.remainingDues),
          parseOptionalMoney(displayedRecord?.paidAmount) ?? 0,
          parseOptionalMoney(displayedRecord?.paidTowardsCurrentMonth) ?? 0,
          parseOptionalMoney(displayedRecord?.previousMonthDues) ?? 0,
          monthlyFeeAtSubmit
        ]);
        operation.id = await createPaymentIdempotencyKey(submissionBasis);
        operation.paymentAmount = roundMoney(paymentAmount);
        operation.idempotencyBasis = submissionBasis;
      }
      const previousMonth = getMonthOffset(operation.month, -1);
      const currentFeeRef = doc(db, 'users', operation.teacherEmail, 'fees', `${operation.classId}_${operation.month}`);
      const previousFeeRef = doc(db, 'users', operation.teacherEmail, 'fees', `${operation.classId}_${previousMonth}`);
      const classRef = doc(db, 'users', operation.teacherEmail, 'classes', operation.classId);
      const paymentRef = doc(db, 'users', operation.teacherEmail, 'fees', `${operation.classId}_${operation.month}`, 'payments', operation.id);
      const teacherProfileRef = doc(db, 'users', operation.teacherEmail);

      const result = await runTransaction(db, async (tx) => {
        const userNow = auth.currentUser;
        if (!userNow || normalizeTeacherEmail(userNow.email) !== operation.teacherEmail) {
          throw new Error('Access denied. The authenticated teacher no longer matches this fee record.');
        }

        // All transaction reads occur before any write.
        const [paymentSnap, classSnap, currentSnap, previousSnap, teacherProfileSnap] = await Promise.all([
          tx.get(paymentRef), tx.get(classRef), tx.get(currentFeeRef), tx.get(previousFeeRef), tx.get(teacherProfileRef)
        ]);
        assertTeacherProfile(teacherProfileSnap.exists() ? teacherProfileSnap.data() : null, userNow, operation.teacherEmail);
        if (paymentSnap.exists()) return 'duplicate' as const;
        if (!classSnap.exists()) throw new Error('The selected class no longer exists. No payment was saved.');
        const classData = classSnap.data();
        const verifiedStudent = findStudentInClass(classData, operation.studentId);
        if (!verifiedStudent) throw new Error('This student is no longer in the selected teacher\'s class. No payment was saved.');
        assertValidStudentMonthlyFee(verifiedStudent);

        const currentData = currentSnap.exists() ? (currentSnap.data() || {}) : {};
        const previousData = previousSnap.exists() ? (previousSnap.data() || {}) : {};
        const currentRawMap = readFeeRecords(currentSnap, operation.classId, operation.month);
        const previousRawMap = readFeeRecords(previousSnap, operation.classId, previousMonth);
        const currentRaw = currentRawMap[operation.studentId];
        const previousRaw = previousRawMap[operation.studentId];
        const state = getTransactionFeeState(currentRaw, previousRaw, verifiedStudent, previousMonth, getStudentMonthlyFee(verifiedStudent, classData));
        const monthlyFeeDue = parseOptionalMoney(modalFeeOverride) ?? state.monthlyFeeDue;
        const outstandingBefore = Math.max(0, roundMoney(state.previousMonthDues + monthlyFeeDue - state.paidTowardsCurrentMonth));

        if (paymentAmount - outstandingBefore > MONEY_EPSILON) {
          throw new Error(`Payment exceeds outstanding dues (PKR ${outstandingBefore.toLocaleString()}). Overpayments need an explicit advance-credit rule.`);
        }
        if (outstandingBefore <= MONEY_EPSILON) throw new Error('There are no outstanding dues for this student. No payment was recorded.');

        const amountToPrevious = Math.min(paymentAmount, state.previousMonthDues);
        const previousRemainingAfter = Math.max(0, roundMoney(state.previousMonthDues - amountToPrevious));
        const amountToCurrent = Math.max(0, roundMoney(paymentAmount - amountToPrevious));
        const paidTowardsCurrentAfter = Math.min(monthlyFeeDue, roundMoney(state.paidTowardsCurrentMonth + amountToCurrent));
        const remainingAfter = Math.max(0, roundMoney(previousRemainingAfter + monthlyFeeDue - paidTowardsCurrentAfter));
        const collectedAfter = roundMoney(state.paidAmount + paymentAmount);
        const statusAfter = calculateFeeStatus(
          state.previousMonthDues + monthlyFeeDue,
          remainingAfter,
          collectedAfter > 0 || paidTowardsCurrentAfter > 0
        );
        const now = new Date().toISOString();
        const updatedCurrentRecord: StudentFeeRecord = {
          ...(isPlainObject(currentRaw) ? currentRaw : {}),
          status: statusAfter,
          paidAmount: collectedAfter,
          remainingDues: remainingAfter,
          previousMonthDues: previousRemainingAfter,
          monthlyFeeDue,
          paidTowardsCurrentMonth: paidTowardsCurrentAfter
        };

        if (amountToPrevious > MONEY_EPSILON) {
          if (!previousSnap.exists() || !isPlainObject(previousRaw)) {
            throw new Error('Previous-month dues exist, but the previous-month student record is missing. Reconcile it before receiving this payment.');
          }
          const updatedPreviousRecord = {
            ...previousRaw,
            remainingDues: previousRemainingAfter,
            status: previousRemainingAfter <= MONEY_EPSILON
              ? 'PAID'
              : 'PARTIAL'
          };
          const previousHasRecords = Object.keys(previousRawMap).length > 0;
          if (!previousHasRecords || !isPlainObject(previousData.feeRecords)) {
            throw new Error('The previous-month fee map is malformed. No payment was saved.');
          }
          const previousArgs: any[] = [
            new FieldPath('feeRecords', operation.studentId), updatedPreviousRecord,
            new FieldPath('classId'), operation.classId,
            new FieldPath('month'), previousMonth,
            new FieldPath('updatedAt'), now
          ];
          tx.update(previousFeeRef, previousArgs[0], previousArgs[1], ...previousArgs.slice(2));
        }

        if (currentSnap.exists() && Object.keys(currentData).length > 0 && currentData.feeRecords !== undefined && currentData.feeRecords !== null) {
          const args: any[] = [
            new FieldPath('feeRecords', operation.studentId), updatedCurrentRecord,
            new FieldPath('classId'), operation.classId,
            new FieldPath('month'), operation.month,
            new FieldPath('updatedAt'), now
          ];
          tx.update(currentFeeRef, args[0], args[1], ...args.slice(2));
        } else if (currentSnap.exists()) {
          tx.update(currentFeeRef, {
            classId: operation.classId,
            month: operation.month,
            feeRecords: { [operation.studentId]: updatedCurrentRecord },
            updatedAt: now
          });
        } else {
          tx.set(currentFeeRef, {
            classId: operation.classId,
            month: operation.month,
            feeRecords: { [operation.studentId]: updatedCurrentRecord },
            updatedAt: now
          });
        }

        // Durable receipt/idempotency key: transaction retries and repeated submits of this modal cannot apply twice.
        tx.set(paymentRef, {
          paymentId: operation.id,
          teacherEmail: operation.teacherEmail,
          classId: operation.classId,
          studentId: operation.studentId,
          month: operation.month,
          amount: paymentAmount,
          appliedToPreviousDues: amountToPrevious,
          appliedToCurrentMonth: amountToCurrent,
          createdAt: now,
          source: 'fees-page'
        });

        applyFeeStatusPatch(tx, classRef, classData, { [operation.studentId]: updatedCurrentRecord }, [operation.studentId]);
        return 'saved' as const;
      });

      if (result === 'duplicate') {
        // The receipt exists, so a prior commit succeeded even if its acknowledgement was lost.
        window.alert('This payment was already recorded. No second payment was applied.');
      }
      operation.outcomeUncertain = false;
      // Clear directly because closeModal intentionally refuses to close while a transaction is in flight.
      setActiveModalStudent(null);
      setModalFeeOverride(null);
      paymentOperationRef.current = null;
    } catch (error) {
      console.error('Error processing fee payment:', error);
      window.alert(getFriendlyErrorMessage(error));
      const message = error instanceof Error ? error.message : '';
      const definitelyRejected = error?.code === 'permission-denied' || error?.code === 'unauthenticated' ||
        /overpay|exceeds outstanding|no outstanding dues|malformed|invalid|does not match|missing|no longer exists|no longer belongs|access denied|teacher session changed|no payment was saved/i.test(message);
      if (definitelyRejected && paymentOperationRef.current) {
        // Firestore transactions are atomic; known validation/permission failures applied no writes.
        paymentOperationRef.current.id = '';
        paymentOperationRef.current.paymentAmount = undefined;
        paymentOperationRef.current.idempotencyBasis = undefined;
        paymentOperationRef.current.outcomeUncertain = false;
      } else if (paymentOperationRef.current?.id) {
        paymentOperationRef.current.outcomeUncertain = true;
      }
      // Keep the key and require reconciliation for ambiguous network failures.
    } finally {
      paymentInFlightRef.current = false;
    }
  };

  const markAllPaid = async () => {
    if (bulkActionInFlightRef.current || !selectedClassId || !currentUserEmail || !isValidMonthKey(selectedMonth)) return;
    if (sortedStudentsList.length > BULK_TRANSACTION_STUDENT_LIMIT) {
      window.alert(`This class has more than ${BULK_TRANSACTION_STUDENT_LIMIT} students. Use individual payments so the transaction stays within Firestore limits.`);
      return;
    }
    const targets = sortedStudentsList.map((student: any) => ({ student, id: getStudentKey(student) })).filter((item): item is { student: any; id: string } => Boolean(item.id));
    if (targets.length === 0) return;

    bulkActionInFlightRef.current = true;
    try {
      await assertVerifiedTenant(currentUserEmail);
      const ownerEmail = currentUserEmail;
      const classId = selectedClassId;
      const month = selectedMonth;
      const previousMonth = getMonthOffset(month, -1);
      const currentRef = doc(db, 'users', ownerEmail, 'fees', `${classId}_${month}`);
      const previousRef = doc(db, 'users', ownerEmail, 'fees', `${classId}_${previousMonth}`);
      const classRef = doc(db, 'users', ownerEmail, 'classes', classId);
      const teacherProfileRef = doc(db, 'users', ownerEmail);
      const paymentIds = new Map(targets.map(({ id }) => [id, createOperationId()]));

      await runTransaction(db, async (tx) => {
        const userNow = auth.currentUser;
        if (!userNow || normalizeTeacherEmail(userNow.email) !== ownerEmail) throw new Error('Access denied. The teacher session changed.');
        const [classSnap, currentSnap, previousSnap, teacherProfileSnap] = await Promise.all([tx.get(classRef), tx.get(currentRef), tx.get(previousRef), tx.get(teacherProfileRef)]);
        assertTeacherProfile(teacherProfileSnap.exists() ? teacherProfileSnap.data() : null, userNow, ownerEmail);
        if (!classSnap.exists()) throw new Error('The selected class no longer exists.');
        const classData = classSnap.data();
        const currentRawMap = readFeeRecords(currentSnap, classId, month);
        const previousRawMap = readFeeRecords(previousSnap, classId, previousMonth);
        const now = new Date().toISOString();
        const currentUpdates: Record<string, StudentFeeRecord> = {};
        const previousUpdates: Record<string, any> = {};
        const classStatusRecords: Record<string, StudentFeeRecord> = {};
        const receipts: { ref: DocumentReference<DocumentData>; data: any }[] = [];

        targets.forEach(({ student, id }) => {
          const verifiedStudent = findStudentInClass(classData, id);
          if (!verifiedStudent) throw new Error(`Student ${id} no longer belongs to this class.`);
          assertValidStudentMonthlyFee(verifiedStudent);
          const currentRaw = currentRawMap[id];
          const previousRaw = previousRawMap[id];
          const state = getTransactionFeeState(currentRaw, previousRaw, verifiedStudent, previousMonth, getStudentMonthlyFee(verifiedStudent, classData));
          const obligation = roundMoney(state.previousMonthDues + state.monthlyFeeDue);
          const outstanding = Math.max(0, roundMoney(state.previousMonthDues + state.monthlyFeeDue - state.paidTowardsCurrentMonth));

          if (outstanding <= MONEY_EPSILON || obligation <= MONEY_EPSILON) {
            const unchanged: StudentFeeRecord = {
              ...(isPlainObject(currentRaw) ? currentRaw : {}),
              status: calculateFeeStatus(obligation, outstanding, state.paidAmount > 0 || state.paidTowardsCurrentMonth > 0),
              paidAmount: state.paidAmount,
              remainingDues: outstanding,
              previousMonthDues: state.previousMonthDues,
              monthlyFeeDue: state.monthlyFeeDue,
              paidTowardsCurrentMonth: state.paidTowardsCurrentMonth
            };
            currentUpdates[id] = unchanged;
            classStatusRecords[id] = unchanged;
            return;
          }

          const amountToPay = outstanding;
          const appliedToPrevious = Math.min(amountToPay, state.previousMonthDues);
          const previousRemainingAfter = Math.max(0, roundMoney(state.previousMonthDues - appliedToPrevious));
          const appliedToCurrent = Math.max(0, roundMoney(amountToPay - appliedToPrevious));
          const paidTowardsCurrentAfter = Math.min(state.monthlyFeeDue, roundMoney(state.paidTowardsCurrentMonth + appliedToCurrent));
          const remainingAfter = Math.max(0, roundMoney(previousRemainingAfter + state.monthlyFeeDue - paidTowardsCurrentAfter));
          const updated: StudentFeeRecord = {
            ...(isPlainObject(currentRaw) ? currentRaw : {}),
            status: calculateFeeStatus(obligation, remainingAfter, true),
            paidAmount: roundMoney(state.paidAmount + amountToPay),
            remainingDues: remainingAfter,
            previousMonthDues: previousRemainingAfter,
            monthlyFeeDue: state.monthlyFeeDue,
            paidTowardsCurrentMonth: paidTowardsCurrentAfter
          };
          currentUpdates[id] = updated;
          classStatusRecords[id] = updated;

          if (appliedToPrevious > MONEY_EPSILON) {
            if (!previousSnap.exists() || !isPlainObject(previousRaw)) {
              throw new Error(`Student ${id} has previous-month dues but no valid previous fee record. No students were changed.`);
            }
            previousUpdates[id] = {
              ...previousRaw,
              remainingDues: previousRemainingAfter,
              status: previousRemainingAfter <= MONEY_EPSILON ? 'PAID' : 'PARTIAL'
            };
          }

          const receiptId = paymentIds.get(id)!;
          receipts.push({
            ref: doc(db, 'users', ownerEmail, 'fees', `${classId}_${month}`, 'payments', receiptId),
            data: {
              paymentId: receiptId,
              teacherEmail: ownerEmail,
              classId,
              studentId: id,
              month,
              amount: amountToPay,
              appliedToPreviousDues: appliedToPrevious,
              appliedToCurrentMonth: appliedToCurrent,
              createdAt: now,
              source: 'mark-all-paid'
            }
          });
        });

        // No writes occurred before every selected student passed validation.
        if (Object.keys(previousUpdates).length > 0) {
          const previousArgs: any[] = [];
          Object.entries(previousUpdates).forEach(([id, record]) => previousArgs.push(new FieldPath('feeRecords', id), record));
          previousArgs.push(new FieldPath('classId'), classId, new FieldPath('month'), previousMonth, new FieldPath('updatedAt'), now);
          tx.update(previousRef, previousArgs[0], previousArgs[1], ...previousArgs.slice(2));
        }
        writeFeeRecordFields(tx, currentRef, currentUpdates, { classId, month, updatedAt: now }, currentSnap.exists(), currentRawMap);
        receipts.forEach((receipt) => tx.set(receipt.ref, receipt.data));
        applyFeeStatusPatch(tx, classRef, classData, classStatusRecords, targets.map((item) => item.id));
      });
    } catch (error) {
      console.error('Error marking all students paid:', error);
      window.alert(getFriendlyErrorMessage(error));
    } finally {
      bulkActionInFlightRef.current = false;
    }
  };

  const markAllUnpaid = async () => {
    if (bulkActionInFlightRef.current || !selectedClassId || !currentUserEmail || !isValidMonthKey(selectedMonth)) return;
    if (sortedStudentsList.length > BULK_TRANSACTION_STUDENT_LIMIT) {
      window.alert(`This class has more than ${BULK_TRANSACTION_STUDENT_LIMIT} students. Use smaller changes so the transaction stays within Firestore limits.`);
      return;
    }
    const targets = sortedStudentsList.map((student: any) => ({ student, id: getStudentKey(student) })).filter((item): item is { student: any; id: string } => Boolean(item.id));
    if (targets.length === 0) return;

    bulkActionInFlightRef.current = true;
    try {
      await assertVerifiedTenant(currentUserEmail);
      const ownerEmail = currentUserEmail;
      const classId = selectedClassId;
      const month = selectedMonth;
      const previousMonth = getMonthOffset(month, -1);
      const currentRef = doc(db, 'users', ownerEmail, 'fees', `${classId}_${month}`);
      const previousRef = doc(db, 'users', ownerEmail, 'fees', `${classId}_${previousMonth}`);
      const classRef = doc(db, 'users', ownerEmail, 'classes', classId);
      const teacherProfileRef = doc(db, 'users', ownerEmail);

      await runTransaction(db, async (tx) => {
        const userNow = auth.currentUser;
        if (!userNow || normalizeTeacherEmail(userNow.email) !== ownerEmail) throw new Error('Access denied. The teacher session changed.');
        const [classSnap, currentSnap, previousSnap, teacherProfileSnap] = await Promise.all([tx.get(classRef), tx.get(currentRef), tx.get(previousRef), tx.get(teacherProfileRef)]);
        assertTeacherProfile(teacherProfileSnap.exists() ? teacherProfileSnap.data() : null, userNow, ownerEmail);
        if (!classSnap.exists()) throw new Error('The selected class no longer exists.');
        const classData = classSnap.data();
        const currentRawMap = readFeeRecords(currentSnap, classId, month);
        const previousRawMap = readFeeRecords(previousSnap, classId, previousMonth);
        const now = new Date().toISOString();
        const currentUpdates: Record<string, StudentFeeRecord> = {};
        const classStatusRecords: Record<string, StudentFeeRecord> = {};

        targets.forEach(({ id }) => {
          const verifiedStudent = findStudentInClass(classData, id);
          if (!verifiedStudent) throw new Error(`Student ${id} no longer belongs to this class.`);
          assertValidStudentMonthlyFee(verifiedStudent);
          const rawCurrent = currentRawMap[id];
          const rawPrevious = previousRawMap[id];
          const state = getTransactionFeeState(rawCurrent, rawPrevious, verifiedStudent, previousMonth, getStudentMonthlyFee(verifiedStudent, classData));
          const storedRemaining = parseOptionalMoney(rawCurrent?.remainingDues);
          const obligationAtCurrentState = roundMoney(state.previousMonthDues + state.monthlyFeeDue);
          const hasAnyPayment = state.paidAmount > MONEY_EPSILON || state.paidTowardsCurrentMonth > MONEY_EPSILON ||
            rawCurrent?.status === 'PAID' || rawCurrent?.status === 'PARTIAL' ||
            (storedRemaining !== null && storedRemaining + MONEY_EPSILON < obligationAtCurrentState);

          if (hasAnyPayment) {
            throw new Error('At least one selected student has payment history. Mark All Unpaid will not erase or reverse collected money; use a controlled reversal instead. No records were changed.');
          }

          const updated: StudentFeeRecord = {
            ...(isPlainObject(rawCurrent) ? rawCurrent : {}),
            status: 'UNPAID',
            paidAmount: 0,
            remainingDues: obligationAtCurrentState,
            previousMonthDues: state.previousMonthDues,
            monthlyFeeDue: state.monthlyFeeDue,
            paidTowardsCurrentMonth: 0
          };
          currentUpdates[id] = updated;
          classStatusRecords[id] = updated;
        });

        writeFeeRecordFields(tx, currentRef, currentUpdates, { classId, month, updatedAt: now }, currentSnap.exists(), currentRawMap);
        applyFeeStatusPatch(tx, classRef, classData, classStatusRecords, targets.map((item) => item.id));
      });
    } catch (error) {
      console.error('Error marking all students unpaid:', error);
      window.alert(getFriendlyErrorMessage(error));
    } finally {
      bulkActionInFlightRef.current = false;
    }
  };

  const applyModalFeePreset = (feeTarget: number) => {
    if (!activeModalStudent || !Number.isFinite(feeTarget) || feeTarget < 0) return;
    const key = getStudentKey(activeModalStudent) || '';
    const record = feeMap[key];
    const previousDues = parseOptionalMoney(record?.previousMonthDues) ?? 0;
    const paidTowardsCurrent = parseOptionalMoney(record?.paidTowardsCurrentMonth) ?? 0;
    const newRemaining = Math.max(0, roundMoney(previousDues + feeTarget - paidTowardsCurrent));
    setModalFeeOverride(roundMoney(feeTarget));
    setModalPrevDuesInput(previousDues.toString());
    setModalPaidInput(newRemaining.toString());
  };

  const navigationTabs = [
    { id: 'home', label: 'Home', icon: Home, href: '/' },
    { id: 'classes', label: 'Classes', icon: GraduationCap, href: '/departments' },
    { id: 'attendance', label: 'Attendance', icon: Users, href: '/attendance' },
    { id: 'fees', label: 'Fees', icon: Wallet, href: '/fees' },
    { id: 'settings', label: 'Settings', icon: Settings, href: '/settings' },
  ];

  const activeRecord = feeMap[getStudentKey(activeModalStudent) || ''];
  const modalClassFee = modalFeeOverride ?? (parseOptionalMoney(activeRecord?.monthlyFeeDue) ?? getStudentMonthlyFee(activeModalStudent, currentClass));
  const modalPrevDues = parseOptionalMoney(modalPrevDuesInput) ?? 0;
  const modalTotalPayable = roundMoney(modalClassFee + modalPrevDues);
  const modalPaidVal = parseOptionalMoney(modalPaidInput) ?? 0;
  const modalRemainingVal = Math.max(0, roundMoney(
    modalTotalPayable - (parseOptionalMoney(activeRecord?.paidTowardsCurrentMonth) ?? 0) - modalPaidVal
  ));
  const activeModalStudentAdmissionMonth = activeModalStudent ? getStudentAdmissionMonth(activeModalStudent) : null;
  const isModalStudentInFirstMonth = activeModalStudentAdmissionMonth === selectedMonth;
  const modalProratedDetails = activeModalStudent ? calculateProratedFee(activeModalStudent, modalClassFee) : null;

  return (
    <div className={`min-h-screen bg-[#f8fafc] dark:bg-[#070c18] text-slate-900 dark:text-slate-100 transition-colors duration-300 pb-36 ${isDark ? 'dark' : ''}`}>

      {/* TOP HEADER */}
      <div className="w-full bg-white/60 dark:bg-[#080e1e]/80 backdrop-blur-md border-b border-slate-200/60 dark:border-slate-800/80 sticky top-0 z-40">
        <div className="mx-auto max-w-7xl flex h-14 items-center justify-between px-4 sm:px-6 lg:px-8">
          
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate('/')}
              className="group flex items-center justify-center h-9 w-9 rounded-xl bg-gradient-to-r from-orange-500 to-amber-500 text-white shadow-[0_0_15px_rgba(249,115,22,0.5)] hover:shadow-[0_0_22px_rgba(249,115,22,0.8)] transition-all hover:scale-105 active:scale-95 shrink-0"
              title="Move Back To Dashboard"
            >
              <ArrowLeft className="h-4 w-4 stroke-[2.5] group-hover:-translate-x-0.5 transition-transform" />
            </button>
          </div>

          <div className="flex items-center gap-3">
            <Link
              to="/extra-fee"
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-gradient-to-r from-orange-500 to-amber-500 text-white font-extrabold text-xs shadow-[0_0_15px_rgba(249,115,22,0.4)] hover:scale-105 transition-all shrink-0"
            >
              <Layers className="h-3.5 w-3.5" />
              <span>Extra Charges</span>
            </Link>

            <button
              onClick={() => setIsDark(!isDark)}
              className="flex h-7 w-12 items-center rounded-full bg-slate-200/80 p-0.5 transition-all dark:bg-slate-800/90 border border-slate-300/40 dark:border-slate-700/50 shrink-0 shadow-inner"
            >
              <div className={`flex h-5 w-5 items-center justify-center rounded-full bg-white text-orange-500 shadow-md transition-all ${isDark ? 'translate-x-5 bg-slate-950 text-amber-400' : ''}`}>
                {isDark ? <Moon className="h-3 w-3 fill-current" /> : <Sun className="h-3 w-3 fill-current" />}
              </div>
            </button>
            <button className="relative rounded-xl p-2 text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-[#0d1527] transition-colors shrink-0">
              <Bell className="h-4 w-4" />
              <span className="absolute right-1 top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-orange-500 text-[9px] font-bold text-white ring-2 ring-white dark:ring-[#070c18] shadow-[0_0_8px_rgba(249,115,22,0.8)]">3</span>
            </button>
          </div>
        </div>
      </div>

      {/* MAIN WORKSPACE */}
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 space-y-6 animate-in fade-in duration-500">

        {/* HEADER GLOW CARD */}
        <div className="relative group w-full overflow-hidden rounded-2xl p-[2px] transition-all duration-300 border-2 border-orange-500 shadow-[0_0_25px_rgba(249,115,22,0.35)]">
          <div className="relative flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 md:p-5 rounded-[14px] bg-white dark:bg-[#0a1020]">
            
            <div className="flex items-center gap-3.5">
              <div className="flex items-center justify-center h-11 w-11 rounded-xl bg-gradient-to-br from-orange-500 to-amber-500 text-white shadow-[0_0_15px_rgba(249,115,22,0.5)] shrink-0">
                <Wallet className="h-5 w-5" />
              </div>

              <div>
                <h2 className="text-xl font-black tracking-tight md:text-2xl flex items-center gap-2 text-slate-900 dark:text-white">
                  Fees Register
                  {isLoading && (
                    <RefreshCw className="h-4 w-4 animate-spin text-orange-500 drop-shadow-[0_0_8px_rgba(249,115,22,0.8)] ml-1" />
                  )}
                </h2>
                <div className="mt-1 inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full border border-orange-500/40 bg-orange-500/10 text-orange-600 dark:text-orange-400">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-orange-500 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-orange-600" />
                  </span>
                  <span className="text-[10px] font-extrabold uppercase tracking-wider">Live Engine Active</span>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 bg-slate-100/90 dark:bg-[#060b16]/80 p-1.5 rounded-xl border border-slate-200/80 dark:border-slate-800/80 self-start sm:self-auto backdrop-blur-md shadow-inner">
              <button
                onClick={markAllPaid}
                disabled={classes.length === 0}
                className="flex items-center gap-1.5 text-[11px] font-bold px-3.5 py-1.5 rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20 border border-emerald-500/30 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <CheckCircle2 className="h-3.5 w-3.5" /> Mark All Paid
              </button>
              <button
                onClick={markAllUnpaid}
                disabled={classes.length === 0}
                className="flex items-center gap-1.5 text-[11px] font-bold px-3.5 py-1.5 rounded-lg bg-rose-500/10 text-rose-600 dark:text-rose-400 hover:bg-rose-500/20 border border-rose-500/30 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <XCircle className="h-3.5 w-3.5" /> Mark All Unpaid
              </button>
            </div>

          </div>
        </div>

        {/* CLASS & MONTH SELECTOR SECTION */}
        <div className="relative overflow-hidden rounded-3xl p-[2px] border-2 border-orange-500 shadow-[0_0_30px_rgba(249,115,22,0.4)]">
          <div className="rounded-[22px] bg-white dark:bg-[#0a1020] p-6 md:p-8">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 relative z-10">
              <div className="max-w-xl space-y-3">
                <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full border border-orange-500/40 bg-orange-500/10 text-orange-600 dark:text-orange-400 shadow-[0_0_12px_rgba(249,115,22,0.2)]">
                  <Sparkles className="h-3.5 w-3.5" />
                  <span className="text-[10px] font-black uppercase tracking-wider">Filtered Dynamic Fee Engine</span>
                </div>
                <h1 className="text-2xl sm:text-3xl font-black tracking-tight text-slate-950 dark:text-white">
                  Select Class & Month
                </h1>
                
                <div className="flex flex-col sm:flex-row gap-3 max-w-lg pt-1">
                  
                  {/* SELECT CLASS TRIGGER CARD */}
                  <div 
                    onClick={() => classes.length > 0 && setIsClassModalOpen(true)}
                    className="relative flex-1 group cursor-pointer"
                  >
                    <div className="flex items-center justify-between w-full rounded-2xl border-2 border-orange-500/80 bg-white dark:bg-[#070d1a] px-4 py-3 shadow-[0_0_15px_rgba(249,115,22,0.25)] hover:border-orange-500 transition-all">
                      <span className="text-xs font-extrabold text-slate-800 dark:text-slate-100 truncate">
                        {currentClass.name ? `${currentClass.name} — PKR ${currentClass.monthlyFee}` : 'Select Class'}
                      </span>
                      <ChevronRight className="h-4 w-4 text-orange-400 group-hover:translate-x-0.5 transition-transform" />
                    </div>
                  </div>
                  
                  {/* SELECT MONTH TRIGGER CARD */}
                  <div 
                    onClick={() => setIsMonthModalOpen(true)}
                    className="relative flex-1 group cursor-pointer"
                  >
                    <div className="flex items-center justify-between w-full rounded-2xl border-2 border-orange-500/80 bg-white dark:bg-[#070d1a] px-4 py-3 shadow-[0_0_15px_rgba(249,115,22,0.25)] hover:border-orange-500 transition-all">
                      <span className="text-xs font-extrabold text-orange-600 dark:text-orange-400 truncate">
                        🗓️ {selectedMonthObj?.label || 'Select Month'}
                      </span>
                      <ChevronRight className="h-4 w-4 text-orange-400 group-hover:translate-x-0.5 transition-transform" />
                    </div>
                  </div>

                </div>
              </div>

              <div className="hidden md:flex items-center justify-center w-60 h-32 bg-white/80 dark:bg-[#070d1a]/80 border-2 border-orange-500/50 rounded-2xl backdrop-blur-md shadow-[0_0_20px_rgba(249,115,22,0.25)] relative overflow-hidden group">
                <div className="text-center p-4 space-y-1 relative z-10">
                  <div className="mx-auto w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500 to-orange-500 text-white flex items-center justify-center shadow-[0_0_15px_rgba(249,115,22,0.5)]">
                    <DollarSign className="h-5 w-5" />
                  </div>
                  <div className="text-base font-black text-slate-800 dark:text-slate-100 mt-2">
                    PKR {totalCollectedPKR.toLocaleString()}
                  </div>
                  <div className="text-[10px] text-emerald-600 dark:text-emerald-400 font-extrabold uppercase tracking-wider">Collected This Month</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* NO CLASS NOTICE */}
        {classes.length === 0 && !isLoading && (
          <div className="relative overflow-hidden rounded-2xl p-[2px] border-2 border-orange-500 shadow-[0_0_25px_rgba(249,115,22,0.35)]">
            <div className="bg-white dark:bg-[#0a1020] p-6 rounded-[14px] text-center space-y-3">
              <div className="mx-auto w-12 h-12 rounded-full bg-orange-500/10 border border-orange-500/40 flex items-center justify-center text-orange-500">
                <GraduationCap className="h-6 w-6" />
              </div>
              <h3 className="text-lg font-black text-slate-900 dark:text-white">
                No Classes Found
              </h3>
              <p className="text-xs text-slate-400 max-w-md mx-auto">
                Fees load karne ke liye sab se pehle classes create karein.
              </p>
              <button
                onClick={() => navigate('/departments')}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-orange-500 to-amber-500 text-white font-black text-xs shadow-[0_0_15px_rgba(249,115,22,0.4)] hover:scale-105 transition-all"
              >
                <PlusCircle className="h-4 w-4" /> Create Class Now
              </button>
            </div>
          </div>
        )}

        {/* METRICS GRID */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 sm:gap-4">
          <div className="bg-white dark:bg-[#0a1020] border-2 border-orange-500/60 rounded-2xl p-3.5 shadow-[0_0_15px_rgba(249,115,22,0.15)]">
            <span className="text-[10px] font-extrabold text-slate-400 block tracking-wide uppercase">Students</span>
            <span className="text-xl sm:text-2xl font-black text-slate-900 dark:text-white mt-1 block">{totalStudents}</span>
          </div>
          <div className="bg-emerald-50/70 dark:bg-emerald-950/20 border-2 border-emerald-500/40 rounded-2xl p-3.5 shadow-[0_0_15px_rgba(16,185,129,0.15)]">
            <span className="text-[10px] font-extrabold text-emerald-600 dark:text-emerald-400 block tracking-wide uppercase">Paid Count</span>
            <span className="text-xl sm:text-2xl font-black text-emerald-600 dark:text-emerald-400 mt-1 block">{paidCount}</span>
          </div>
          <div className="bg-rose-50/70 dark:bg-rose-950/20 border-2 border-rose-500/40 rounded-2xl p-3.5 shadow-[0_0_15px_rgba(244,63,94,0.15)]">
            <span className="text-[10px] font-extrabold text-rose-600 dark:text-rose-400 block tracking-wide uppercase">Unpaid Count</span>
            <span className="text-xl sm:text-2xl font-black text-rose-600 dark:text-rose-400 mt-1 block">{unpaidCount}</span>
          </div>
          <div className="bg-blue-50/70 dark:bg-blue-950/20 border-2 border-blue-500/40 rounded-2xl p-3.5 shadow-[0_0_15px_rgba(59,130,246,0.15)]">
            <span className="text-[10px] font-extrabold text-blue-600 dark:text-blue-400 block tracking-wide uppercase">Collected</span>
            <span className="text-base sm:text-lg font-black text-blue-600 dark:text-blue-400 mt-1 block truncate">PKR {totalCollectedPKR.toLocaleString()}</span>
          </div>
          <div className="bg-amber-50/70 dark:bg-amber-950/20 border-2 border-amber-500/40 rounded-2xl p-3.5 shadow-[0_0_15px_rgba(245,158,11,0.15)]">
            <span className="text-[10px] font-extrabold text-amber-600 dark:text-amber-400 block tracking-wide uppercase">Pending Dues</span>
            <span className="text-base sm:text-lg font-black text-amber-600 dark:text-amber-400 mt-1 block truncate">PKR {totalPendingDuesPKR.toLocaleString()}</span>
          </div>
          <div className="bg-purple-50/70 dark:bg-purple-950/20 border-2 border-purple-500/40 rounded-2xl p-3.5 shadow-[0_0_15px_rgba(168,85,247,0.15)]">
            <span className="text-[10px] font-extrabold text-purple-600 dark:text-purple-400 block tracking-wide uppercase">Prev Month Dues</span>
            <span className="text-base sm:text-lg font-black text-purple-600 dark:text-purple-400 mt-1 block truncate">PKR {totalPrevMonthDuesPKR.toLocaleString()}</span>
          </div>
        </div>

        {/* FILTERS BAR */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 overflow-x-auto pb-1">
          <div className="inline-flex items-center gap-1 bg-slate-200/60 dark:bg-[#0d1527] p-1 rounded-full border border-slate-300/50 dark:border-slate-800/80 shrink-0 shadow-inner">
            {['ALL', 'Male', 'Female'].map(g => (
              <button 
                key={g} 
                onClick={() => setGenderFilter(g as any)}
                className={`px-3.5 py-1.5 rounded-full text-xs font-black transition-all duration-300 whitespace-nowrap ${
                  genderFilter === g 
                    ? 'bg-slate-900 text-white shadow-md dark:bg-slate-700' 
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                {g === 'ALL' ? 'All Genders' : g}
              </button>
            ))}
          </div>

          <div className="inline-flex items-center gap-1 bg-slate-200/60 dark:bg-[#0d1527] p-1 rounded-full border border-slate-300/50 dark:border-slate-800/80 shrink-0 shadow-inner">
            <button
              onClick={() => setStatusFilter('ALL')}
              className={`px-3.5 py-1.5 rounded-full text-xs font-black transition-all duration-300 whitespace-nowrap ${
                statusFilter === 'ALL'
                  ? 'bg-orange-500 text-white shadow-[0_0_12px_rgba(249,115,22,0.4)]'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              All Students
            </button>

            <button
              onClick={() => setStatusFilter('PAID')}
              className={`px-3.5 py-1.5 rounded-full text-xs font-black transition-all duration-300 whitespace-nowrap ${
                statusFilter === 'PAID'
                  ? 'bg-emerald-600 text-white shadow-[0_0_12px_rgba(16,185,129,0.4)]'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              Paid ({paidCount})
            </button>

            <button
              onClick={() => setStatusFilter('UNPAID')}
              className={`px-3.5 py-1.5 rounded-full text-xs font-black transition-all duration-300 whitespace-nowrap ${
                statusFilter === 'UNPAID'
                  ? 'bg-rose-500 text-white shadow-[0_0_12px_rgba(244,63,94,0.4)]'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              Unpaid ({unpaidCount})
            </button>

            <button
              onClick={() => setStatusFilter('PARTIAL')}
              className={`px-3.5 py-1.5 rounded-full text-xs font-black transition-all duration-300 whitespace-nowrap ${
                statusFilter === 'PARTIAL'
                  ? 'bg-amber-500 text-white shadow-[0_0_12px_rgba(245,158,11,0.4)]'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              Partial ({partialCount})
            </button>
          </div>
        </div>

        {/* STUDENT FEE CARDS LIST */}
        <div className="space-y-3.5">
          {paginatedStudents.length === 0 ? (
            <div className="text-center py-12 bg-white dark:bg-[#0a1020] rounded-2xl border-2 border-orange-500/40 shadow-[0_0_15px_rgba(249,115,22,0.15)]">
              <p className="text-xs font-bold text-slate-400">
                {classes.length === 0 ? 'No classes available to load students.' : 'No students found for this month/filters.'}
              </p>
            </div>
          ) : (
            paginatedStudents.map((student: any, index: number) => {
              const studentKey = student.id || student.studentId || student._seqKey;
              const globalIndex = (currentPage - 1) * ITEMS_PER_PAGE + index + 1;
              const record: StudentFeeRecord = feeMap[studentKey] || {
                status: 'UNPAID',
                paidAmount: 0,
                remainingDues: Number(currentClass.monthlyFee),
                previousMonthDues: 0
              };

              const isPaid = record.status === 'PAID';
              const isPartial = record.status === 'PARTIAL';
              const hasRemaining = record.remainingDues > 0;

              const studentAdmissionMonth = getStudentAdmissionMonth(student);
              const isFirstAdmissionMonth = studentAdmissionMonth === selectedMonth;
              const joiningDateDisplay = student.joiningDate || student.admissionDate || student.createdAt;
              const prorated = isFirstAdmissionMonth ? calculateProratedFee(student, monthlyFee) : null;

              return (
                <div
                  key={studentKey || globalIndex}
                  className={`group relative overflow-hidden rounded-2xl p-[2px] transition-all duration-300 ${
                    isPaid
                      ? 'border-2 border-slate-300 dark:border-slate-800 shadow-sm'
                      : isPartial
                      ? 'border-2 border-amber-500 shadow-[0_0_20px_rgba(245,158,11,0.25)]'
                      : 'border-2 border-orange-500 shadow-[0_0_25px_rgba(249,115,22,0.35)]'
                  }`}
                >
                  <div className="relative bg-white dark:bg-[#0a1020] p-4 rounded-[14px] flex flex-col sm:flex-row sm:items-center justify-between gap-3.5 backdrop-blur-md">
                    
                    {/* Left: Student Profile */}
                    <div className="flex items-center gap-3.5 min-w-0">
                      <div className="relative shrink-0">
                        <img
                          src={student.avatar || student.image || 'https://via.placeholder.com/150'}
                          alt={student.name}
                          className="h-12 w-12 rounded-full object-cover ring-2 ring-orange-500/40 shadow-md"
                        />
                        <span className="absolute -bottom-1 -right-1 bg-gradient-to-r from-orange-500 to-amber-500 text-white text-[9px] font-black px-1.5 py-0.2 rounded-full shadow-md">
                          #{globalIndex}
                        </span>
                      </div>

                      <div className="min-w-0 space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h4 className="text-xs sm:text-sm font-extrabold text-slate-800 dark:text-slate-100 truncate">
                            {student.name}
                          </h4>

                          {isFirstAdmissionMonth && joiningDateDisplay && (
                            <span className="inline-flex items-center gap-1 text-[10px] font-black px-2.5 py-0.5 rounded-full bg-orange-500/10 border border-orange-500/40 text-orange-600 dark:text-orange-400 shadow-[0_0_10px_rgba(249,115,22,0.2)] animate-pulse">
                              <Sparkles className="h-3 w-3 text-orange-500" />
                              Joined: {formatDisplayDate(joiningDateDisplay)}
                            </span>
                          )}
                        </div>

                        <div className="text-[10px] font-bold text-slate-400 flex items-center gap-2 flex-wrap">
                          <span>{student.gender === 'Male' ? 'Male' : 'Female'} | Fee: PKR {getStudentMonthlyFee(student, currentClass)}</span>
                          
                          {isFirstAdmissionMonth && prorated && (
                            <span className="text-amber-600 dark:text-amber-400 font-extrabold bg-amber-500/10 px-2 py-0.5 rounded-md border border-amber-500/30 flex items-center gap-1">
                              <Calculator className="h-3 w-3 text-amber-500" />
                              1st Month Dues ({prorated.daysStudied} Days @ {prorated.dailyRate}/day): PKR {prorated.proratedFee}
                            </span>
                          )}

                          {record.previousMonthDues > 0 && (
                            <span className="text-purple-600 dark:text-purple-400 font-extrabold bg-purple-500/10 px-2 py-0.5 rounded-md border border-purple-500/20">
                              Merged Unpaid Dues: PKR {record.previousMonthDues}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Right: Payment Status */}
                    <div className="flex items-center gap-2.5 self-end sm:self-auto shrink-0">
                      {hasRemaining ? (
                        <button
                          onClick={() => openPaymentModal(student)}
                          className="px-3.5 py-1.5 rounded-xl bg-amber-500/10 dark:bg-amber-950/40 border border-amber-400/40 text-amber-800 dark:text-amber-300 hover:scale-105 transition-all text-start flex items-center gap-2 shadow-sm"
                          title="Click to process payment"
                        >
                          <div>
                            <span className="text-[9px] font-black uppercase block tracking-wider text-amber-600 dark:text-amber-400">Total Dues</span>
                            <span className="text-xs font-extrabold block">PKR {record.remainingDues.toLocaleString()}</span>
                          </div>
                        </button>
                      ) : (
                        <div className="px-3 py-1.5 rounded-xl bg-emerald-500/10 dark:bg-emerald-950/40 border border-emerald-500/30 text-emerald-600 dark:text-emerald-400 text-xs font-extrabold flex items-center gap-1 shadow-sm">
                          <span>Paid Fully</span> ✨
                        </div>
                      )}

                      <button
                        type="button"
                        onClick={() => openPaymentModal(student)}
                        className={`text-xs font-black px-4 py-2 rounded-xl transition-all duration-200 flex items-center gap-1.5 shrink-0 hover:scale-105 active:scale-95 ${
                          isPaid
                            ? 'bg-slate-100 text-slate-700 dark:bg-slate-800/80 dark:text-slate-300 border border-slate-300 dark:border-slate-700'
                            : 'bg-gradient-to-r from-orange-500 to-amber-500 text-white shadow-[0_0_15px_rgba(249,115,22,0.35)] hover:shadow-[0_0_22px_rgba(249,115,22,0.6)]'
                        }`}
                      >
                        <CreditCard className="h-4 w-4" />
                        {isPaid ? 'Edit' : 'Pay Dues'}
                      </button>
                    </div>

                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* PAGINATION */}
        {filteredStudents.length > 0 && (
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4 bg-white dark:bg-[#0a1020] border-2 border-orange-500/40 rounded-2xl p-4 shadow-[0_0_15px_rgba(249,115,22,0.15)] mt-4">
            <div className="text-xs font-bold text-slate-500 dark:text-slate-400">
              Showing <span className="text-orange-500 font-extrabold">{Math.min((currentPage - 1) * ITEMS_PER_PAGE + 1, filteredStudents.length)}</span> to <span className="text-orange-500 font-extrabold">{Math.min(currentPage * ITEMS_PER_PAGE, filteredStudents.length)}</span> of <span className="text-slate-800 dark:text-slate-200 font-extrabold">{filteredStudents.length}</span> Students
            </div>

            <div className="flex items-center gap-2">
              <button
                disabled={currentPage === 1}
                onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
                className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-black transition-all duration-300 ${
                  currentPage === 1
                    ? 'opacity-40 cursor-not-allowed bg-slate-100 dark:bg-slate-800 text-slate-400 border border-slate-200 dark:border-slate-800'
                    : 'bg-gradient-to-r from-orange-500 to-amber-500 text-white shadow-[0_0_15px_rgba(249,115,22,0.35)] hover:scale-105 active:scale-95'
                }`}
              >
                <ChevronLeft className="h-4 w-4" /> Previous
              </button>

              <div className="px-3.5 py-2 rounded-xl bg-orange-500/10 dark:bg-orange-500/20 border border-orange-500/30 text-orange-600 dark:text-orange-400 text-xs font-black shadow-inner">
                {currentPage} / {totalPages}
              </div>

              <button
                disabled={currentPage >= totalPages}
                onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))}
                className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-black transition-all duration-300 ${
                  currentPage >= totalPages
                    ? 'opacity-40 cursor-not-allowed bg-slate-100 dark:bg-slate-800 text-slate-400 border border-slate-200 dark:border-slate-800'
                    : 'bg-gradient-to-r from-orange-500 to-amber-500 text-white shadow-[0_0_15px_rgba(249,115,22,0.35)] hover:scale-105 active:scale-95'
                }`}
              >
                Next <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}

      </main>

      {/* SELECT CLASS MODAL */}
      {isClassModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md animate-in fade-in duration-300">
          <div className="relative overflow-hidden bg-white dark:bg-[#0a1020] rounded-3xl p-6 w-full max-w-md border-2 border-orange-500 shadow-[0_0_50px_rgba(249,115,22,0.4)]">
            
            {/* Header */}
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="flex items-center justify-center h-10 w-10 rounded-2xl bg-orange-500 text-white shadow-[0_0_15px_rgba(249,115,22,0.5)]">
                  <GraduationCap className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-lg font-black text-slate-900 dark:text-white tracking-tight">Select Class Product</h3>
                  <p className="text-[11px] font-extrabold text-slate-400">Choose class to load items ({classes.length} Available)</p>
                </div>
              </div>
              <button 
                onClick={() => setIsClassModalOpen(false)}
                className="p-1.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-400 hover:text-slate-600 transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Filter Search Input */}
            <div className="relative mb-4">
              <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-orange-400" />
              <input
                type="text"
                placeholder="Filter products by name or code..."
                value={classSearchQuery}
                onChange={(e) => setClassSearchQuery(e.target.value)}
                className="w-full bg-slate-50 dark:bg-[#070d1a] border-2 border-orange-500/40 rounded-full pl-10 pr-4 py-2.5 text-xs font-bold text-slate-800 dark:text-slate-100 placeholder-slate-400 outline-none focus:border-orange-500 transition-all shadow-inner"
              />
            </div>

            {/* Options List */}
            <div className="space-y-2.5 max-h-64 overflow-y-auto pr-1">
              {filteredClassesList.map((cls) => {
                const isSelected = selectedClassId === cls.id;
                return (
                  <div
                    key={cls.id}
                    onClick={() => setSelectedClassId(cls.id)}
                    className={`flex items-center justify-between p-3.5 rounded-2xl border-2 transition-all cursor-pointer ${
                      isSelected
                        ? 'border-orange-500 bg-orange-50/20 dark:bg-orange-500/10 shadow-sm'
                        : 'border-slate-200 dark:border-slate-800 hover:border-orange-400 bg-white dark:bg-[#070d1a]'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <div className={`h-5 w-5 rounded-full border-2 flex items-center justify-center transition-all ${
                        isSelected ? 'border-orange-500 bg-orange-500 text-white' : 'border-slate-300 dark:border-slate-700'
                      }`}>
                        {isSelected && <Check className="h-3 w-3 stroke-[3]" />}
                      </div>
                      <div>
                        <h4 className="text-xs font-black text-slate-900 dark:text-white">{cls.name}</h4>
                        <span className="text-[10px] font-extrabold text-slate-400 uppercase">STUDENTS: {cls.students?.length || 0} UNITS</span>
                      </div>
                    </div>

                    <span className="px-3 py-1 rounded-full bg-gradient-to-r from-orange-500 to-amber-500 text-white font-extrabold text-xs shadow-md">
                      Rs. {cls.monthlyFee}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Confirm Button */}
            <button
              onClick={() => setIsClassModalOpen(false)}
              className="w-full mt-5 bg-gradient-to-r from-orange-500 to-amber-500 text-white font-black py-3 rounded-full shadow-[0_0_20px_rgba(249,115,22,0.4)] flex items-center justify-center gap-2 text-xs uppercase tracking-wider hover:scale-[1.02] active:scale-95 transition-all"
            >
              <Check className="h-4 w-4 stroke-[3]" /> OK
            </button>

          </div>
        </div>
      )}

      {/* SELECT MONTH MODAL */}
      {isMonthModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md animate-in fade-in duration-300">
          <div className="relative overflow-hidden bg-white dark:bg-[#0a1020] rounded-3xl p-6 w-full max-w-md border-2 border-orange-500 shadow-[0_0_50px_rgba(249,115,22,0.4)]">
            
            {/* Header */}
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="flex items-center justify-center h-10 w-10 rounded-2xl bg-orange-500 text-white shadow-[0_0_15px_rgba(249,115,22,0.5)]">
                  <Wallet className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-lg font-black text-slate-900 dark:text-white tracking-tight">Select Month</h3>
                  <p className="text-[11px] font-extrabold text-slate-400">Choose fee month ({monthOptions.length} Active Months)</p>
                </div>
              </div>
              <button 
                onClick={() => setIsMonthModalOpen(false)}
                className="p-1.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-400 hover:text-slate-600 transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Month Cards Options List */}
            <div className="space-y-2.5 max-h-64 overflow-y-auto pr-1">
              {monthOptions.map((m) => {
                const isSelected = selectedMonth === m.value;
                return (
                  <div
                    key={m.value}
                    onClick={() => setSelectedMonth(m.value)}
                    className={`flex items-center justify-between p-3.5 rounded-2xl border-2 transition-all cursor-pointer ${
                      isSelected
                        ? 'border-orange-500 bg-orange-50/20 dark:bg-orange-500/10 shadow-sm'
                        : 'border-slate-200 dark:border-slate-800 hover:border-orange-400 bg-white dark:bg-[#070d1a]'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <div className={`h-5 w-5 rounded-full border-2 flex items-center justify-center transition-all ${
                        isSelected ? 'border-orange-500 bg-orange-500 text-white' : 'border-slate-300 dark:border-slate-700'
                      }`}>
                        {isSelected && <Check className="h-3 w-3 stroke-[3]" />}
                      </div>
                      <div>
                        <h4 className="text-xs font-black text-slate-900 dark:text-white">🗓️ {m.label}</h4>
                        <span className="text-[10px] font-extrabold text-slate-400 uppercase">DYNAMIC 2-MONTH SYSTEM RECORD</span>
                      </div>
                    </div>

                    <span className="px-3 py-1 rounded-full bg-gradient-to-r from-orange-500 to-amber-500 text-white font-extrabold text-xs shadow-md">
                      ACTIVE
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Confirm Button */}
            <button
              onClick={() => setIsMonthModalOpen(false)}
              className="w-full mt-5 bg-gradient-to-r from-orange-500 to-amber-500 text-white font-black py-3 rounded-full shadow-[0_0_20px_rgba(249,115,22,0.4)] flex items-center justify-center gap-2 text-xs uppercase tracking-wider hover:scale-[1.02] active:scale-95 transition-all"
            >
              <Check className="h-4 w-4 stroke-[3]" /> OK
            </button>

          </div>
        </div>
      )}

      {/* GLOWING PAYMENT MODAL */}
      {activeModalStudent && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md animate-in fade-in duration-300">
          <div className="relative overflow-hidden bg-white dark:bg-[#0a1020] rounded-3xl p-6 w-full max-w-md border-2 border-orange-500 shadow-[0_0_50px_rgba(249,115,22,0.4)]">
            
            <div className="flex justify-between items-center mb-5 relative z-10">
              <div>
                <h3 className="text-xl font-black text-slate-800 dark:text-white tracking-wide flex items-center gap-2">
                  Process Payment
                </h3>
                {activeModalStudent?.name && (
                  <p className="text-xs font-semibold text-slate-400 mt-0.5">
                    Student: <span className="text-orange-500 font-extrabold">{activeModalStudent.name}</span>
                  </p>
                )}
              </div>
              <button 
                onClick={closeModal} 
                className="p-2 rounded-full bg-slate-100 dark:bg-slate-800/80 hover:bg-slate-200 text-slate-500 dark:text-slate-400 transition-all hover:scale-105"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-4 relative z-10">
              
              {isModalStudentInFirstMonth && modalProratedDetails && (
                <div className="bg-gradient-to-br from-amber-500/10 via-orange-500/10 to-transparent border border-amber-500/40 rounded-2xl p-3.5 space-y-2 shadow-[0_0_15px_rgba(245,158,11,0.15)]">
                  <div className="flex items-center justify-between text-xs font-black text-amber-600 dark:text-amber-400">
                    <span className="flex items-center gap-1">
                      <Sparkles className="h-4 w-4" /> 1st Month Joining Fee Assistant
                    </span>
                    <span className="text-[10px] bg-amber-500/20 px-2 py-0.5 rounded-full border border-amber-500/30">
                      Joined: {modalProratedDetails.joiningDateFormatted}
                    </span>
                  </div>

                  <div className="text-[11px] text-slate-600 dark:text-slate-300 font-semibold space-y-1">
                    <p>Daily Rate: <strong>PKR {modalProratedDetails.dailyRate}/day</strong></p>
                    <p>Classes Taken: <strong>{modalProratedDetails.daysStudied} Days</strong></p>
                  </div>

                  <div className="flex items-center gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => applyModalFeePreset(modalProratedDetails.proratedFee)}
                      className="flex-1 py-1.5 px-2 rounded-xl bg-orange-500 text-white font-black text-[11px] shadow-md hover:bg-orange-600 transition-all text-center"
                    >
                      Apply Prorated Fee (PKR {modalProratedDetails.proratedFee})
                    </button>
                    <button
                      type="button"
                      onClick={() => applyModalFeePreset(getStudentMonthlyFee(activeModalStudent, currentClass))}
                      className="flex-1 py-1.5 px-2 rounded-xl bg-slate-200 dark:bg-slate-800 text-slate-800 dark:text-slate-200 font-extrabold text-[11px] hover:bg-slate-300 transition-all text-center"
                    >
                      Apply Full Fee (PKR {modalClassFee})
                    </button>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-2 bg-slate-100/70 dark:bg-[#070d1a] p-3.5 rounded-2xl border border-slate-200 dark:border-slate-800">
                <div>
                  <span className="text-[10px] font-bold text-slate-400 uppercase block">Merged Prev Dues</span>
                  <span className="text-sm font-black text-purple-600 dark:text-purple-400">PKR {modalPrevDues}</span>
                </div>
                <div>
                  <span className="text-[10px] font-bold text-slate-400 uppercase block">Current Month Fee</span>
                  <span className="text-sm font-black text-slate-800 dark:text-slate-200">PKR {modalClassFee}</span>
                </div>
                <div className="col-span-2 pt-2 mt-1 border-t border-slate-200 dark:border-slate-800 flex justify-between items-center">
                  <span className="text-xs font-black text-slate-600 dark:text-slate-300">Total Payable Dues:</span>
                  <span className="text-sm font-black text-orange-500 drop-shadow-[0_0_8px_rgba(249,115,22,0.4)]">PKR {modalTotalPayable}</span>
                </div>
              </div>

              <div>
                <label className="text-xs font-bold text-slate-500 dark:text-slate-400 mb-1 block">
                  Paid Amount (PKR)
                </label>
                <input 
                  type="number"
                  value={modalPaidInput}
                  onChange={(e) => setModalPaidInput(e.target.value)}
                  placeholder="0"
                  className="w-full bg-slate-50 dark:bg-[#070d1a] border-2 border-orange-500/60 rounded-2xl px-4 py-3 text-base font-black focus:outline-none focus:border-orange-500 transition-all text-slate-800 dark:text-white shadow-inner"
                />
              </div>

              <div className="bg-emerald-500/10 dark:bg-emerald-950/40 border border-emerald-500/30 rounded-2xl p-4 flex items-center justify-between shadow-[0_0_20px_rgba(16,185,129,0.12)]">
                <div>
                  <span className="text-xs font-black text-emerald-600 dark:text-emerald-400 uppercase tracking-wider block">
                    Total Received
                  </span>
                  <span className="text-[10px] text-slate-400 font-medium">
                    Remaining After Payment: <strong className="text-rose-500">PKR {modalRemainingVal}</strong>
                  </span>
                </div>
                <div className="text-right">
                  <span className="text-xl font-black text-emerald-500 dark:text-emerald-400 drop-shadow-[0_0_10px_rgba(16,185,129,0.4)]">
                    PKR {modalPaidVal.toLocaleString()}
                  </span>
                </div>
              </div>

              <button 
                onClick={handleSaveModalPayment}
                className="w-full mt-2 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 text-white font-black py-3.5 rounded-2xl transition-all duration-200 shadow-[0_4px_25px_rgba(249,115,22,0.4)] flex justify-center items-center gap-2 text-sm tracking-wide"
              >
                <Save className="h-5 w-5" /> Save Record
              </button>

            </div>
          </div>
        </div>
      )}

      {/* FLOATING CIRCULAR BOTTOM NAVBAR */}
      <div className="fixed bottom-4 left-0 right-0 z-50 flex justify-center px-4 pointer-events-none">
        <nav className="pointer-events-auto bg-white/95 dark:bg-[#0a1020]/95 backdrop-blur-xl border-2 border-orange-500/40 shadow-[0_10px_40px_rgba(0,0,0,0.4)] rounded-full px-5 py-2 flex items-center justify-between gap-4 sm:gap-8 max-w-md w-full">
          {navigationTabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = location.pathname === tab.href || (tab.id === 'fees' && location.pathname.includes('/fees'));
            return (
              <Link
                key={tab.id}
                to={tab.href}
                className="flex flex-col items-center justify-center relative transition-transform duration-200 active:scale-95 group"
              >
                {isActive && (
                  <span className="absolute -top-1 w-1.5 h-1.5 bg-orange-500 rounded-full animate-pulse shadow-[0_0_8px_rgba(249,115,22,0.8)]" />
                )}

                <div
                  className={`flex items-center justify-center transition-all duration-300 ${
                    isActive
                      ? 'w-10 h-10 rounded-full bg-gradient-to-br from-orange-500 to-amber-500 text-white shadow-[0_0_15px_rgba(249,115,22,0.5)] scale-105'
                      : 'w-10 h-10 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200'
                  }`}
                >
                  <Icon className="h-5 w-5 stroke-[2.2]" />
                </div>

                <span
                  className={`text-[10px] font-black mt-0.5 transition-colors ${
                    isActive ? 'text-orange-500' : 'text-slate-400 dark:text-slate-500'
                  }`}
                >
                  {tab.label}
                </span>
              </Link>
            );
          })}
        </nav>
      </div>

    </div>
  );
}
