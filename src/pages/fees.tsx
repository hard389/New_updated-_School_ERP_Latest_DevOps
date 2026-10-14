import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
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
  Check,
  FileText,
  Download,
  Printer
} from 'lucide-react';

import { db, auth } from '../lib/firebase';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, collection, getDoc, getDocFromServer, getDocsFromServer, onSnapshot, runTransaction, FieldPath, query, orderBy, startAt, endAt, documentId, limit, where } from 'firebase/firestore';
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
  const rounded = roundMoney(parsed);
  if (!Number.isFinite(rounded) || !Number.isSafeInteger(Math.round(rounded * 100))) return null;
  return rounded;
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

  const makeValidatedLocalDate = (year: number, monthIndex: number, day: number): Date | null => {
    if (!Number.isInteger(year) || !Number.isInteger(monthIndex) || !Number.isInteger(day) ||
        monthIndex < 0 || monthIndex > 11 || day < 1 || day > 31) return null;
    const result = new Date(year, monthIndex, day);
    return result.getFullYear() === year && result.getMonth() === monthIndex && result.getDate() === day
      ? result
      : null;
  };

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
      return makeValidatedLocalDate(Number(isoDateOnly[1]), Number(isoDateOnly[2]) - 1, Number(isoDateOnly[3]));
    }
    // Existing Departments data also accepts MM/DD/YYYY.
    const slashDate = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (slashDate) {
      return makeValidatedLocalDate(Number(slashDate[3]), Number(slashDate[1]) - 1, Number(slashDate[2]));
    }

    const datePrefix = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|[Tt ]|Z$)/);
    if (datePrefix && !makeValidatedLocalDate(Number(datePrefix[1]), Number(datePrefix[2]) - 1, Number(datePrefix[3]))) return null;
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

const normalizeFirebaseErrorCode = (rawCode: unknown): string =>
  String(rawCode ?? '').trim().toLowerCase().replace(/^(?:firestore|firebase|auth)\//, '');

const getFriendlyErrorMessage = (error: any): string => {
  const code = normalizeFirebaseErrorCode(error?.code);
  const message = error instanceof Error ? error.message : String(error?.message ?? '');
  if (!code && /malformed|invalid|does not match|missing|access denied|teacher session changed|no longer exists|no longer belongs|no payment was saved|reconcile|overpay|exceeds outstanding|no outstanding dues|payment history|changed after confirmation|differs from the confirmed estimate/i.test(message)) return message;
  if (code === 'permission-denied') return 'Permission denied. Verify the signed-in teacher profile and Firestore Security Rules. No unconfirmed payment should be retried with a new amount.';
  if (code === 'unauthenticated' || code === 'user-token-expired' || code === 'invalid-user-token') return 'Your session has expired. Sign in again, then reopen the payment form.';
  if (['unavailable', 'deadline-exceeded', 'network-request-failed', 'cancelled', 'internal'].includes(code)) return 'Firebase could not confirm the operation because the service or connection is unavailable. Keep the same payment amount and retry to reconcile the result.';
  if (code === 'aborted') return 'The record changed concurrently and Firestore could not complete the transaction. Refresh the fee data and retry after reviewing the balance.';
  if (code === 'resource-exhausted') return 'Firestore rejected the operation because a service quota or request limit was reached. No new attempt should be made until the cause is resolved.';
  if (code === 'failed-precondition') return 'Firestore rejected the operation because a required precondition or configuration is not satisfied. Inspect the full console error; if it requests an index, deploy that index and retry.';
  if (code === 'invalid-argument') return 'Firestore rejected the request as invalid. Check the fee data and submitted values before retrying.';
  if (code === 'not-found') return 'A required fee, class, or teacher record could not be found. Refresh the selected class/month and verify the data.';
  return 'Unable to confirm the fee operation. Review the diagnostic details in the console; if the outcome is uncertain, retry only the same payment amount.';
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


type FeeReportScope = 'selected' | 'history' | 'range';
type FeeReportAction = 'download' | 'print';

interface FeeReportStudentRow {
  serial: number;
  rollNo: string;
  studentName: string;
  studentId: string;
  gender: string;
  month: string;
  assessedFee: number | null;
  previousDues: number | null;
  totalPayable: number | null;
  amountPaid: number | null;
  remainingBalance: number | null;
  status: string;
  latestPaymentDate: string;
  legacyAggregate: boolean;
}

interface FeeReportTransaction {
  paymentDate: string;
  createdAtDate: Date | null;
  paymentId: string;
  studentName: string;
  studentId: string;
  feeMonth: string;
  amount: number | null;
  appliedToPreviousDues: number | null;
  appliedToCurrentMonth: number | null;
  source: string;
}

interface FeeReportMonth {
  month: string;
  hasDocument: boolean;
  rows: FeeReportStudentRow[];
  assessedTotal: number | null;
  paidCount: number;
  partialCount: number;
  unpaidCount: number;
  unrecordedCount: number;
  previousDuesTotal: number | null;
  collectedByFeeMonth: number | null;
  outstandingTotal: number | null;
}

interface FeeReportModel {
  title: string;
  className: string;
  classId: string;
  teacherEmail: string;
  scope: FeeReportScope;
  periodLabel: string;
  generatedAt: string;
  months: FeeReportMonth[];
  transactions: FeeReportTransaction[];
  warnings: string[];
  isComplete: boolean;
  totals: {
    eligibleStudents: number;
    paidCount: number;
    partialCount: number;
    unpaidCount: number;
    unrecordedCount: number;
    assessedFees: number | null;
    collectionsReceivedDuringPeriod: number | null;
    legacyAggregateForPeriod: number | null;
    cumulativeRecordedPayments: number | null;
    previousDuesAtEnd: number | null;
    outstandingAtEnd: number | null;
  };
}

const MAX_FEE_REPORT_MONTHS = 600;
const MAX_FEE_REPORT_RECEIPTS_PER_MONTH = 10000;
const MAX_FEE_REPORT_RECEIPTS_TOTAL = 100000;
const MAX_FEE_REPORT_WARNINGS = 80;

const formatPKR = (value: number | null | undefined): string =>
  value === null || value === undefined || !Number.isFinite(value)
    ? 'N/A'
    : `PKR ${roundMoney(value).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const formatMonthLabel = (monthKey: string): string => {
  if (!isValidMonthKey(monthKey)) return monthKey;
  const [year, month] = monthKey.split('-').map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
};

const getMonthsBetween = (startMonth: string, endMonth: string): string[] => {
  if (!isValidMonthKey(startMonth) || !isValidMonthKey(endMonth) || startMonth > endMonth) {
    throw new Error('Choose a valid starting month that is not later than the ending month.');
  }
  const [startYear, startNumber] = startMonth.split('-').map(Number);
  const [endYear, endNumber] = endMonth.split('-').map(Number);
  const count = (endYear - startYear) * 12 + endNumber - startNumber + 1;
  if (count < 1 || count > MAX_FEE_REPORT_MONTHS) {
    throw new Error(`A report can cover up to ${MAX_FEE_REPORT_MONTHS} months at a time. Choose a narrower range.`);
  }
  return Array.from({ length: count }, (_, index) => getMonthOffset(startMonth, index));
};

const sanitizeReportFilePart = (value: string): string => {
  const sanitized = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9._-]/g, '')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 60);
  return sanitized || 'Class';
};

const reportFilename = (model: FeeReportModel): string => {
  const classPart = sanitizeReportFilePart(model.className);
  const classWithPrefix = /^class/i.test(classPart) ? classPart : `Class${classPart}`;
  const first = model.months[0]?.month || getCurrentMonthKey();
  const last = model.months[model.months.length - 1]?.month || first;
  const period = first === last ? first : `${first}_to_${last}`;
  return `EduTrack_Fee_Report_${classWithPrefix}_${period}.pdf`;
};

const escapeHtml = (value: unknown): string => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const reportHtml = (model: FeeReportModel): string => {
  const fmt = (value: number | null | undefined) => escapeHtml(formatPKR(value));
  const ledgerRows = model.months.flatMap((month) => month.rows).map((row) => `
    <tr>
      <td>${row.serial}</td><td>${escapeHtml(row.rollNo)}</td><td>${escapeHtml(row.studentName)}</td>
      <td>${escapeHtml(row.studentId)}</td><td>${escapeHtml(row.gender)}</td><td>${escapeHtml(formatMonthLabel(row.month))}</td>
      <td class="money">${fmt(row.assessedFee)}</td><td class="money">${fmt(row.previousDues)}</td>
      <td class="money">${fmt(row.totalPayable)}</td><td class="money">${fmt(row.amountPaid)}</td>
      <td class="money">${fmt(row.remainingBalance)}</td><td class="status ${row.status.toLowerCase().replace(/[^a-z]/g, '')}">${escapeHtml(row.status)}</td>
      <td>${escapeHtml(row.latestPaymentDate)}</td>
    </tr>`).join('');
  const monthRows = model.months.map((month) => `
    <tr><td>${escapeHtml(formatMonthLabel(month.month))}</td><td>${month.hasDocument ? 'Available' : 'Missing record'}</td>
    <td>${month.rows.length}</td><td>${month.paidCount}</td><td>${month.partialCount}</td><td>${month.unpaidCount}</td>
    <td>${month.unrecordedCount}</td><td class="money">${fmt(month.assessedTotal)}</td>
    <td class="money">${fmt(month.collectedByFeeMonth)}</td><td class="money">${fmt(month.previousDuesTotal)}</td>
    <td class="money">${fmt(month.outstandingTotal)}</td></tr>`).join('');
  const transactionRows = model.transactions.map((item) => `
    <tr><td>${escapeHtml(item.paymentDate)}</td><td>${escapeHtml(item.paymentId)}</td><td>${escapeHtml(item.studentName)}</td>
    <td>${escapeHtml(item.studentId)}</td><td>${escapeHtml(formatMonthLabel(item.feeMonth))}</td><td class="money">${fmt(item.amount)}</td>
    <td class="money">${fmt(item.appliedToPreviousDues)}</td><td class="money">${fmt(item.appliedToCurrentMonth)}</td><td>${escapeHtml(item.source)}</td></tr>`).join('');
  const warnings = model.warnings.length
    ? `<section class="warnings"><h2>Data quality notes</h2><ul>${model.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')}</ul></section>`
    : '<p class="verified">No data-quality gaps were detected in the queried records.</p>';
  const summary = [
    ['Students at period end', String(model.totals.eligibleStudents)],
    ['Paid at period end', String(model.totals.paidCount)],
    ['Partial at period end', String(model.totals.partialCount)],
    ['Unpaid at period end', String(model.totals.unpaidCount)],
    ['Assessed fees in period', fmt(model.totals.assessedFees)],
    ['Dated receipts received in period', fmt(model.totals.collectionsReceivedDuringPeriod)],
    ['Legacy aggregates attributed by fee month', fmt(model.totals.legacyAggregateForPeriod)],
    ['Cumulative recorded payments', fmt(model.totals.cumulativeRecordedPayments)],
    ['Previous dues at period end', fmt(model.totals.previousDuesAtEnd)],
    ['Outstanding balance at period end', fmt(model.totals.outstandingAtEnd)]
  ].map(([label, value]) => `<div class="metric"><span>${escapeHtml(label)}</span><strong>${value}</strong></div>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(model.title)}</title><style>
    @page{size:A4 landscape;margin:12mm}*{box-sizing:border-box}body{font:10px Arial,Helvetica,sans-serif;color:#172033;margin:0}
    header{background:#111827;color:white;padding:18px 22px;border-bottom:5px solid #f59e0b;margin-bottom:14px}
    .brand{font-size:19px;font-weight:800;letter-spacing:.2px}.brand span{color:#fbbf24}h1{font-size:17px;margin:8px 0 4px}header p{margin:3px 0;color:#e5e7eb}
    h2{font-size:13px;color:#c65d0b;margin:18px 0 7px;border-bottom:1px solid #f3b56a;padding-bottom:5px}
    .metrics{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:7px;margin:8px 0 14px}.metric{border:1px solid #e5e7eb;border-radius:7px;padding:8px;background:#fafafa;break-inside:avoid}
    .metric span{display:block;color:#64748b;font-size:8px;margin-bottom:5px}.metric strong{font-size:11px}.tag{display:inline-block;border:1px solid #d97706;color:#9a3412;background:#fff7ed;border-radius:100px;padding:3px 8px;font-weight:700}
    table{border-collapse:collapse;width:100%;font-size:7px;table-layout:auto;margin:6px 0 14px}thead{display:table-header-group}tr{break-inside:avoid}th{background:#fff0d6;color:#7c2d12;text-align:left;font-weight:700}th,td{border:1px solid #e5e7eb;padding:5px 4px;vertical-align:top}td.money{text-align:right;white-space:nowrap}td.status{font-weight:700}.paid{color:#047857}.partial{color:#b45309}.unpaid{color:#be123c}.notrecorded{color:#64748b}
    .warnings{border-left:4px solid #d97706;background:#fff7ed;padding:8px 12px;margin-top:16px}.warnings li{margin:4px 0}.verified{color:#047857}.note{margin-top:18px;padding-top:7px;border-top:1px solid #cbd5e1;color:#64748b;font-size:8px}
    footer{margin-top:12px;color:#64748b;font-size:8px;border-top:1px solid #cbd5e1;padding-top:6px}@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
  </style></head><body><header><div class="brand">Edu<span>Track</span></div><h1>${escapeHtml(model.title)}</h1>
    <p>Class: ${escapeHtml(model.className)} &nbsp; | &nbsp; Class ID: ${escapeHtml(model.classId)}</p>
    <p>Teacher: ${escapeHtml(model.teacherEmail)} &nbsp; | &nbsp; Period: ${escapeHtml(model.periodLabel)} &nbsp; | &nbsp; Currency: PKR</p>
    <p>Generated: ${escapeHtml(model.generatedAt)} &nbsp; | &nbsp; Report scope: ${escapeHtml(model.scope === 'selected' ? 'Selected month' : model.scope === 'history' ? 'Available class history' : 'Custom month range')}</p>
    ${model.isComplete ? '<span class="tag">Queried records reconciled</span>' : '<span class="tag">Data gaps or legacy details present</span>'}</header>
    <h2>Financial summary</h2><div class="metrics">${summary}</div>
    <h2>Month-by-month assessment and balance</h2><table><thead><tr><th>Fee month</th><th>Record</th><th>Students</th><th>Paid</th><th>Partial</th><th>Unpaid</th><th>Unrecorded</th><th>Assessed fees</th><th>Recorded collection</th><th>Previous dues</th><th>Outstanding</th></tr></thead><tbody>${monthRows || '<tr><td colspan="11">No monthly ledger records are available.</td></tr>'}</tbody></table>
    <h2>Student ledger</h2><p>Amounts marked N/A were not verifiable from the stored historical records. Each row represents one student and fee month.</p>
    <table><thead><tr><th>#</th><th>Roll no.</th><th>Student name</th><th>Student ID</th><th>Gender</th><th>Fee month</th><th>Assessed fee</th><th>Previous dues</th><th>Total payable</th><th>Amount paid</th><th>Remaining balance</th><th>Status</th><th>Latest payment date</th></tr></thead><tbody>${ledgerRows || '<tr><td colspan="13">No student ledger rows are available.</td></tr>'}</tbody></table>
    <h2>Detailed transaction ledger</h2><table><thead><tr><th>Payment date/time</th><th>Receipt / payment ID</th><th>Student name</th><th>Student ID</th><th>Fee month</th><th>Amount received</th><th>Applied to previous dues</th><th>Applied to current month</th><th>Source</th></tr></thead><tbody>${transactionRows || '<tr><td colspan="9">No verifiable detailed receipts were found in the queried report scope.</td></tr>'}</tbody></table>
    ${warnings}<p class="note">Confidential student financial information. Share only with authorized recipients. Figures are limited to records available and readable in the authenticated teacher account; N/A indicates an unavailable or unverifiable value.</p>
    <footer>EduTrack · ${escapeHtml(model.className)} · ${escapeHtml(model.periodLabel)} · ${model.isComplete ? 'Queried records reconciled' : 'Data quality limitations identified'}</footer></body></html>`;
};

const pdfWinAnsiByte = (char: string): number | null => {
  const code = char.codePointAt(0) ?? 63;
  if (code >= 32 && code <= 126) return code;
  if (code >= 160 && code <= 255) return code;
  const special: Record<number, number> = {
    0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86,
    0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c,
    0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95,
    0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
    0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f
  };
  return special[code] ?? null;
};

const pdfLiteral = (value: unknown): string => {
  const input = String(value ?? '');
  let result = '';
  for (const char of input) {
    const byte = pdfWinAnsiByte(char);
    if (byte === null) { result += '?'; continue; }
    if (byte === 40 || byte === 41 || byte === 92) result += `\\${String.fromCharCode(byte)}`;
    else if (byte < 32 || byte > 126) result += `\\${byte.toString(8).padStart(3, '0')}`;
    else result += String.fromCharCode(byte);
  }
  return result;
};

const buildFeeReportPdf = (model: FeeReportModel): Uint8Array => {
  const pageWidth = 842;
  const pageHeight = 595;
  const margin = 28;
  const pages: string[][] = [];
  let commands: string[] = [];
  let y = 0;
  const color = (r: number, g: number, b: number) => `${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)}`;
  const drawRect = (x: number, top: number, width: number, height: number, fill: string, stroke?: string) => {
    const base = pageHeight - top - height;
    commands.push(`${fill} rg ${x} ${base} ${width} ${height} re f`);
    if (stroke) commands.push(`${stroke} RG 0.6 w ${x} ${base} ${width} ${height} re S`);
  };
  const drawText = (x: number, top: number, value: unknown, size = 8, bold = false, fill = color(0.12, 0.16, 0.22)) => {
    commands.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${fill} rg 1 0 0 1 ${x.toFixed(2)} ${(pageHeight - top - size).toFixed(2)} Tm (${pdfLiteral(value)}) Tj ET`);
  };
  const newPage = (sectionTitle: string) => {
    commands = [];
    pages.push(commands);
    drawRect(0, 0, pageWidth, 76, color(0.07, 0.10, 0.16));
    drawRect(0, 73, pageWidth, 3, color(0.96, 0.56, 0.10));
    drawText(margin, 17, 'EduTrack', 16, true, color(1, 1, 1));
    drawText(margin, 39, model.title, 12, true, color(1, 1, 1));
    drawText(450, 19, `Class: ${model.className}  |  ID: ${model.classId}`, 8, true, color(1, 0.78, 0.43));
    drawText(450, 34, `Period: ${model.periodLabel}`, 8, false, color(0.90, 0.92, 0.95));
    drawText(450, 49, `Teacher: ${model.teacherEmail}  |  Currency: PKR`, 7, false, color(0.90, 0.92, 0.95));
    drawText(450, 61, `Generated: ${model.generatedAt}`, 6.5, false, color(0.90, 0.92, 0.95));
    drawText(margin, 88, sectionTitle, 10, true, color(0.75, 0.29, 0.04));
    y = 105;
  };
  const ensureSpace = (height: number, sectionTitle: string, repeat?: () => void) => {
    if (y + height <= pageHeight - 39) return;
    newPage(sectionTitle);
    if (repeat) repeat();
  };
  const drawSectionHeading = (label: string) => {
    ensureSpace(24, label);
    drawText(margin, y, label, 9, true, color(0.75, 0.29, 0.04));
    drawRect(margin, y + 14, pageWidth - margin * 2, 1, color(0.95, 0.70, 0.39));
    y += 22;
  };
  interface PdfColumn { key: string; label: string; width: number; align?: 'left' | 'right' }
  const drawTable = (title: string, columns: PdfColumn[], rows: Array<Record<string, unknown>>) => {
    const tableWidth = columns.reduce((sum, column) => sum + column.width, 0);
    if (tableWidth > pageWidth - margin * 2 + 0.1) throw new Error(`Internal PDF layout error: ${title} table exceeds page width.`);
    const header = () => {
      drawRect(margin, y, tableWidth, 21, color(1, 0.94, 0.84));
      let x = margin;
      columns.forEach((column) => {
        drawText(x + 3, y + 6, column.label, 6.2, true, color(0.43, 0.16, 0.06));
        x += column.width;
      });
      y += 21;
    };
    ensureSpace(25, title);
    drawSectionHeading(title);
    header();
    const wrapCell = (value: unknown, width: number): string[] => {
      const raw = String(value ?? 'N/A');
      const maxChars = Math.max(4, Math.floor((width - 6) / 2.9));
      if (!raw.length) return [''];
      const words = raw.split(/\s+/);
      const lines: string[] = [];
      let line = '';
      words.forEach((word) => {
        if (word.length > maxChars) {
          if (line) { lines.push(line); line = ''; }
          for (let offset = 0; offset < word.length; offset += maxChars) lines.push(word.slice(offset, offset + maxChars));
          return;
        }
        if (!line) line = word;
        else if (`${line} ${word}`.length <= maxChars) line += ` ${word}`;
        else { lines.push(line); line = word; }
      });
      if (line) lines.push(line);
      return lines.length ? lines : [''];
    };
    rows.forEach((row, rowIndex) => {
      const cellLines = columns.map((column) => wrapCell(row[column.key], column.width));
      const rowHeight = Math.max(18, Math.max(...cellLines.map((lines) => lines.length)) * 8 + 6);
      if (y + rowHeight > pageHeight - 39) {
        newPage(title);
        drawText(margin, y, `${title} (continued)`, 8, true, color(0.75, 0.29, 0.04));
        y += 13;
        header();
      }
      if (rowIndex % 2 === 1) drawRect(margin, y, tableWidth, rowHeight, color(0.975, 0.978, 0.982));
      let x = margin;
      columns.forEach((column, columnIndex) => {
        const raw = String(row[column.key] ?? 'N/A');
        const fill = column.key === 'status'
          ? (/partial/i.test(raw) ? color(0.70, 0.39, 0.03)
            : /unpaid/i.test(raw) ? color(0.72, 0.12, 0.17)
              : /paid/i.test(raw) ? color(0.02, 0.45, 0.31) : color(0.16, 0.20, 0.26))
          : color(0.16, 0.20, 0.26);
        cellLines[columnIndex].forEach((line, lineIndex) => {
          drawText(x + 3, y + 3 + lineIndex * 8, line, 5.6, column.key === 'status', fill);
        });
        x += column.width;
      });
      y += rowHeight;
      commands.push(`${color(0.87, 0.89, 0.92)} RG 0.25 w ${margin} ${pageHeight - y} m ${margin + tableWidth} ${pageHeight - y} l S`);
    });
    y += 10;
  };

  newPage('Financial summary');
  const metricItems: Array<[string, string]> = [
    ['Students at period end', String(model.totals.eligibleStudents)],
    ['Paid', String(model.totals.paidCount)],
    ['Partial', String(model.totals.partialCount)],
    ['Unpaid', String(model.totals.unpaidCount)],
    ['Unrecorded status', String(model.totals.unrecordedCount)],
    ['Assessed fees in period', formatPKR(model.totals.assessedFees)],
    ['Dated receipts received in period', formatPKR(model.totals.collectionsReceivedDuringPeriod)],
    ['Legacy aggregates by fee month', formatPKR(model.totals.legacyAggregateForPeriod)],
    ['Cumulative recorded payments', formatPKR(model.totals.cumulativeRecordedPayments)],
    ['Previous dues at end', formatPKR(model.totals.previousDuesAtEnd)],
    ['Outstanding balance at end', formatPKR(model.totals.outstandingAtEnd)]
  ];
  const metricGap = 8;
  const metricWidth = (pageWidth - margin * 2 - metricGap * 3) / 4;
  metricItems.forEach(([label, value], index) => {
    const row = Math.floor(index / 4);
    const col = index % 4;
    const boxX = margin + col * (metricWidth + metricGap);
    const boxTop = y + row * 46;
    drawRect(boxX, boxTop, metricWidth, 39, color(0.975, 0.978, 0.982), color(0.88, 0.90, 0.93));
    drawText(boxX + 7, boxTop + 7, label, 6.2, false, color(0.39, 0.43, 0.49));
    drawText(boxX + 7, boxTop + 21, value, 8.1, true, color(0.08, 0.12, 0.19));
  });
  y += Math.ceil(metricItems.length / 4) * 46 + 8;
  drawText(margin, y, model.isComplete ? 'Queried records reconciled; see ledger for monthly detail.' : 'DATA LIMITATIONS DETECTED — this report does not claim a complete historical ledger.', 7, true, model.isComplete ? color(0.02, 0.45, 0.31) : color(0.72, 0.24, 0.02));
  y += 20;

  drawTable('Month-by-month assessments and balances', [
    { key: 'month', label: 'Fee month', width: 78 }, { key: 'record', label: 'Record', width: 62 },
    { key: 'students', label: 'Students', width: 43 }, { key: 'paid', label: 'Paid', width: 35 },
    { key: 'partial', label: 'Partial', width: 39 }, { key: 'unpaid', label: 'Unpaid', width: 39 },
    { key: 'unknown', label: 'Unrecorded', width: 55 }, { key: 'assessed', label: 'Assessed fees', width: 74 },
    { key: 'collected', label: 'Recorded collection', width: 87 }, { key: 'previous', label: 'Previous dues', width: 72 },
    { key: 'outstanding', label: 'Outstanding', width: 75 }
  ], model.months.map((month) => ({
    month: formatMonthLabel(month.month), record: month.hasDocument ? 'Available' : 'Missing', students: month.rows.length,
    paid: month.paidCount, partial: month.partialCount, unpaid: month.unpaidCount, unknown: month.unrecordedCount,
    assessed: formatPKR(month.assessedTotal), collected: formatPKR(month.collectedByFeeMonth),
    previous: formatPKR(month.previousDuesTotal), outstanding: formatPKR(month.outstandingTotal)
  })));

  drawTable('Student ledger', [
    { key: 'serial', label: '#', width: 22 }, { key: 'rollNo', label: 'Roll no.', width: 46 },
    { key: 'studentName', label: 'Student name', width: 102 }, { key: 'studentId', label: 'Student ID', width: 66 },
    { key: 'gender', label: 'Gender', width: 38 }, { key: 'month', label: 'Fee month', width: 56 },
    { key: 'assessed', label: 'Assessed', width: 60 }, { key: 'previous', label: 'Prev. dues', width: 58 },
    { key: 'payable', label: 'Payable', width: 58 }, { key: 'paid', label: 'Paid', width: 58 },
    { key: 'balance', label: 'Balance', width: 59 }, { key: 'status', label: 'Status', width: 48 },
    { key: 'latest', label: 'Latest pay date', width: 81 }
  ], model.months.flatMap((month) => month.rows.map((row) => ({
    serial: row.serial, rollNo: row.rollNo, studentName: row.studentName, studentId: row.studentId,
    gender: row.gender, month: formatMonthLabel(row.month), assessed: formatPKR(row.assessedFee),
    previous: formatPKR(row.previousDues), payable: formatPKR(row.totalPayable), paid: formatPKR(row.amountPaid),
    balance: formatPKR(row.remainingBalance), status: row.status, latest: row.latestPaymentDate
  }))));

  drawTable('Detailed transaction ledger', [
    { key: 'date', label: 'Payment date/time', width: 92 }, { key: 'id', label: 'Receipt / payment ID', width: 104 },
    { key: 'name', label: 'Student name', width: 106 }, { key: 'studentId', label: 'Student ID', width: 68 },
    { key: 'month', label: 'Fee month', width: 72 }, { key: 'amount', label: 'Received', width: 65 },
    { key: 'previous', label: 'To previous dues', width: 78 }, { key: 'current', label: 'To current fee', width: 74 },
    { key: 'source', label: 'Source', width: 74 }
  ], model.transactions.map((item) => ({
    date: item.paymentDate, id: item.paymentId, name: item.studentName, studentId: item.studentId,
    month: formatMonthLabel(item.feeMonth), amount: formatPKR(item.amount),
    previous: formatPKR(item.appliedToPreviousDues), current: formatPKR(item.appliedToCurrentMonth), source: item.source
  })));

  if (model.warnings.length) {
    drawSectionHeading('Data quality notes');
    model.warnings.forEach((warning, index) => {
      ensureSpace(22, 'Data quality notes');
      drawText(margin + 3, y, `${index + 1}. ${warning}`, 6.7, false, color(0.42, 0.24, 0.12));
      y += 13;
    });
  } else {
    drawText(margin, y, 'No data-quality gaps were detected in the queried records.', 7, true, color(0.02, 0.45, 0.31));
    y += 12;
  }

  pages.forEach((pageCommands, index) => {
    pageCommands.push(`${color(0.75, 0.78, 0.82)} RG 0.5 w ${margin} 27 m ${pageWidth - margin} 27 l S`);
    const footerLeft = `Confidential student financial data  |  ${model.className}  |  ${model.periodLabel}`;
    pageCommands.push(`BT /F1 6 Tf ${color(0.38, 0.42, 0.48)} rg 1 0 0 1 ${margin} 15 Tm (${pdfLiteral(footerLeft)}) Tj ET`);
    pageCommands.push(`BT /F2 6 Tf ${color(0.38, 0.42, 0.48)} rg 1 0 0 1 ${pageWidth - margin - 64} 15 Tm (Page ${index + 1} of ${pages.length}) Tj ET`);
  });

  const objects: string[] = [];
  const addObject = (value: string) => { objects.push(value); return objects.length; };
  addObject(''); // 1: catalog placeholder
  addObject(''); // 2: pages placeholder
  addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'); // 3
  addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'); // 4
  const pageIds: number[] = [];
  pages.forEach((pageCommands) => {
    const content = pageCommands.join('\n');
    const contentId = addObject(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    const pageId = addObject(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`);
    pageIds.push(pageId);
  });
  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  let pdf = '%PDF-1.4\n% EduTrack report\n';
  const offsets: number[] = [0];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index += 1) pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return new TextEncoder().encode(pdf);
};

export default function Fees() {
  const location = useLocation();
  const navigate = useNavigate();
  const [isDark, setIsDark] = useState(false);
  const [currentUserEmail, setCurrentUserEmail] = useState<string | null>(null);

  const [classes, setClasses] = useState<any[]>([]);
  const [selectedClassId, setSelectedClassId] = useState('');
  const [feeMap, setFeeMap] = useState<Record<string, StudentFeeRecord>>({});
  const [isLoadingClasses, setIsLoadingClasses] = useState(false);
  const [classDataStatus, setClassDataStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [classRetryCount, setClassRetryCount] = useState(0);
  const [authRetryCount, setAuthRetryCount] = useState(0);
  const [feeDataStatus, setFeeDataStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [feeDataError, setFeeDataError] = useState<string | null>(null);
  const [feeRetryCount, setFeeRetryCount] = useState(0);
  const [hasPrevMonthRecords, setHasPrevMonthRecords] = useState(false);
  const [notification, setNotification] = useState<{ kind: 'success' | 'error' | 'warning' | 'info'; message: string } | null>(null);
  const notificationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [bulkConfirmation, setBulkConfirmation] = useState<{ action: 'paid' | 'unpaid'; classId: string; className: string; month: string; studentIds: string[]; estimatedTotal: number; studentCount: number } | null>(null);
  const [isBulkProcessing, setIsBulkProcessing] = useState(false);
  const [isPaymentSaving, setIsPaymentSaving] = useState(false);

  const [isClassModalOpen, setIsClassModalOpen] = useState(false);
  const [isMonthModalOpen, setIsMonthModalOpen] = useState(false);
  const [classSearchQuery, setClassSearchQuery] = useState('');

  const [statusFilter, setStatusFilter] = useState<'ALL' | 'PAID' | 'UNPAID' | 'PARTIAL'>('ALL');
  const [genderFilter, setGenderFilter] = useState<'ALL' | 'Male' | 'Female'>('ALL');
  const [currentPage, setCurrentPage] = useState(1);
  const ITEMS_PER_PAGE = 10;

  const showNotification = useCallback((kind: 'success' | 'error' | 'warning' | 'info', message: string) => {
    setNotification((current) => current?.kind === kind && current.message === message ? current : { kind, message });
    if (notificationTimerRef.current) clearTimeout(notificationTimerRef.current);
    notificationTimerRef.current = setTimeout(() => { setNotification(null); notificationTimerRef.current = null; }, kind === 'error' ? 6500 : 4000);
  }, []);

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
  const [isReportModalOpen, setIsReportModalOpen] = useState(false);
  const [reportScope, setReportScope] = useState<FeeReportScope>('selected');
  const [reportStartMonth, setReportStartMonth] = useState<string>(() => getCurrentMonthKey());
  const [reportEndMonth, setReportEndMonth] = useState<string>(() => getCurrentMonthKey());
  const [isReportGenerating, setIsReportGenerating] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [generatedReport, setGeneratedReport] = useState<{ model: FeeReportModel; blob: Blob; filename: string; signature: string } | null>(null);
  const reportInFlightRef = useRef(false);

  useEffect(() => {
    setGeneratedReport(null);
  }, [currentUserEmail, selectedClassId, selectedMonth, reportScope, reportStartMonth, reportEndMonth]);

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
        setClassDataStatus('loading');
        setClasses([]);
        setSelectedClassId('');
        setFeeMap({});
        setFeeDataStatus('loading');
        setFeeDataError(null);
        setBulkConfirmation(null);
        setHasPrevMonthRecords(false);
        setIsReportModalOpen(false);
        setGeneratedReport(null);
        setReportError(null);
        setIsLoadingClasses(false);
        setActiveModalStudent(null);
        paymentOperationRef.current = null;
        return;
      }

      // Clear the prior tenant immediately, then verify this user's profile before listening to data.
      setCurrentUserEmail(null);
      setClassDataStatus('loading');
      setClasses([]);
      setSelectedClassId('');
      setFeeMap({});
      setFeeDataStatus('loading');
      setFeeDataError(null);
      setBulkConfirmation(null);
      setHasPrevMonthRecords(false);
      setIsReportModalOpen(false);
      setGeneratedReport(null);
      setReportError(null);
      setActiveModalStudent(null);
      paymentOperationRef.current = null;
      setIsLoadingClasses(true);

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
        setClassDataStatus('loading');
        setClasses([]);
        setSelectedClassId('');
        setFeeMap({});
        setClassDataStatus('error');
        setFeeDataStatus('error');
        setFeeDataError(getFriendlyErrorMessage(error));
        setIsLoadingClasses(false);
        showNotification('error', `Teacher verification failed. ${getFriendlyErrorMessage(error)}`);
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [showNotification, authRetryCount]);

  // Subscribe only to the teacher's own classes collection. No UID/global fallbacks.
  useEffect(() => {
    if (!currentUserEmail || !hasAuthenticatedTenantSession(currentUserEmail)) {
      setClassDataStatus('loading');
      setClasses([]);
      setSelectedClassId('');
      setFeeMap({});
      setIsLoadingClasses(false);
      return;
    }

    let active = true;
    setIsLoadingClasses(true);
    setClassDataStatus('loading');
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
      setClassDataStatus('ready');
      setSelectedClassId((previous) =>
        previous && fetchedClasses.some((item) => item.id === previous)
          ? previous
          : (fetchedClasses[0]?.id || '')
      );
      setIsLoadingClasses(false);
    }, (error) => {
      console.error('Error fetching this teacher\'s classes:', error);
      if (!active) return;
      setClasses([]);
      setSelectedClassId('');
      setFeeMap({});
      setClassDataStatus('error');
      setFeeDataStatus('error');
      setFeeDataError(getFriendlyErrorMessage(error));
      setIsLoadingClasses(false);
      showNotification('error', `Class data could not be loaded. ${getFriendlyErrorMessage(error)}`);
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [currentUserEmail, classRetryCount, showNotification]);

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
      setFeeDataStatus('loading');
      setFeeDataError(null);
      return;
    }

    let active = true;
    let gotCurrent = false;
    let gotPrevious = false;
    let readFailed = false;
    let currentRecords: Record<string, any> = {};
    let previousRecords: Record<string, any> = {};
    setFeeDataStatus('loading');
    setFeeDataError(null);

    const previousMonth = getMonthOffset(selectedMonth, -1);
    const currentFeeRef = doc(db, 'users', currentUserEmail, 'fees', docKey);
    const previousFeeRef = doc(db, 'users', currentUserEmail, 'fees', `${selectedClassId}_${previousMonth}`);

    const recalculateFeeMap = () => {
      if (!active || readFailed || !gotCurrent || !gotPrevious) return;
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
        setFeeDataStatus('ready');
        setFeeDataError(null);
        setNotification((current) => current && /fee data could not be verified|class data could not be loaded|teacher verification failed/i.test(current.message) ? null : current);
        notifiedReadErrorRef.current = null;
      } catch (error) {
        handleSnapshotError('student', error);
      }
    };

    const handleSnapshotError = (label: string, error: any) => {
      console.error(`Unable to read ${label} fee records:`, error);
      if (!active) return;
      readFailed = true;
      setFeeMap({});
      setFeeDataStatus('error');
      setFeeDataError(getFriendlyErrorMessage(error));
      const errorKey = `${currentUserEmail}/${selectedClassId}/${selectedMonth}/${normalizeFirebaseErrorCode(error?.code)}/${error?.message ?? ''}`;
      console.error('[Fees] Fee data verification failed:', { stage: label, code: error?.code, normalizedCode: normalizeFirebaseErrorCode(error?.code), message: error?.message, customData: error?.customData, error });
      if (notifiedReadErrorRef.current !== errorKey) {
        notifiedReadErrorRef.current = errorKey;
        showNotification('error', `Fee data could not be verified. ${getFriendlyErrorMessage(error)} Use Retry to reload authoritative records.`);
      }
    };

    const unsubscribePrevious = onSnapshot(previousFeeRef, { includeMetadataChanges: true }, (snapshot) => {
      if (snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites) return;
      try {
        previousRecords = readFeeRecords(snapshot, selectedClassId, previousMonth);
        gotPrevious = true;
        recalculateFeeMap();
      } catch (error) {
        handleSnapshotError('previous-month', error);
      }
    }, (error) => handleSnapshotError('previous-month', error));

    const unsubscribeCurrent = onSnapshot(currentFeeRef, { includeMetadataChanges: true }, (snapshot) => {
      if (snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites) return;
      try {
        currentRecords = readFeeRecords(snapshot, selectedClassId, selectedMonth);
        gotCurrent = true;
        recalculateFeeMap();
      } catch (error) {
        handleSnapshotError('current-month', error);
      }
    }, (error) => handleSnapshotError('current-month', error));

    // Server-only reads make offline/unavailable failures explicit instead of treating cache as verified.
    void Promise.all([getDocFromServer(currentFeeRef), getDocFromServer(previousFeeRef)]).catch((error: any) => {
      // If both listeners have already delivered authoritative server snapshots, their result is sufficient.
      if (active && !(gotCurrent && gotPrevious)) handleSnapshotError('server-confirmation', error);
    });

    return () => {
      active = false;
      unsubscribePrevious();
      unsubscribeCurrent();
    };
  }, [selectedClassId, selectedMonth, docKey, eligibleStudentsForMonth, monthlyFee, currentUserEmail, feeRetryCount, showNotification]);

  useEffect(() => setCurrentPage(1), [statusFilter, genderFilter, selectedClassId, selectedMonth]);

  useEffect(() => () => {
    if (notificationTimerRef.current) clearTimeout(notificationTimerRef.current);
  }, []);

  useEffect(() => {
    setBulkConfirmation(null);
  }, [currentUserEmail, selectedClassId, selectedMonth]);

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
      showNotification('error', 'This student or teacher identity could not be verified. No payment was opened.');
      return;
    }
    if (feeDataStatus !== 'ready') {
      showNotification('warning', feeDataStatus === 'error' ? 'Fee records could not be verified. Retry the read before recording a payment.' : 'Fee records are still being verified. Please wait before recording a payment.');
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
      showNotification('error', 'The last payment result is not confirmed. Retry the same amount to reconcile it before closing this payment form.');
      return;
    }
    setActiveModalStudent(null);
    setModalFeeOverride(null);
    paymentOperationRef.current = null;
  };

  const handleSaveModalPayment = async () => {
    const devTimingEnabled = (import.meta as any).env?.DEV === true;
    const paymentPerfStart = devTimingEnabled && typeof performance !== 'undefined' ? performance.now() : 0;
    const paymentPerfMarks: Record<string, number> = {};
    const markPaymentPerf = (label: string) => {
      if (devTimingEnabled && typeof performance !== 'undefined') paymentPerfMarks[label] = performance.now();
    };
    if (paymentInFlightRef.current) return;
    if (feeDataStatus !== 'ready') {
      showNotification('warning', 'Wait until current and previous fee records are verified by the server before saving a payment.');
      return;
    }
    const operation = paymentOperationRef.current;
    if (!activeModalStudent || !operation) {
      showNotification('error', 'The payment session is no longer valid. Reopen the student payment form.');
      return;
    }
    if (
      operation.teacherEmail !== currentUserEmail || operation.classId !== selectedClassId ||
      operation.month !== selectedMonth || operation.studentId !== getStudentKey(activeModalStudent)
    ) {
      showNotification('error', 'The selected teacher, class, month, or student changed. Reopen the payment form.');
      return;
    }

    const paymentAmount = parseOptionalMoney(modalPaidInput);
    if (paymentAmount === null || paymentAmount <= MONEY_EPSILON) {
      showNotification('error', 'Enter a valid payment amount greater than zero.');
      return;
    }
    if (operation.paymentAmount !== undefined && roundMoney(paymentAmount) !== operation.paymentAmount) {
      showNotification('error', 'A previous submission may still be processing. Keep the same amount while retrying this payment; a new amount requires a verified outcome and a new payment session.');
      return;
    }
    if (!isValidMonthKey(operation.month)) {
      showNotification('error', 'Invalid month key. No payment was saved.');
      return;
    }

    markPaymentPerf('inputValidationCompletedAt');
    paymentInFlightRef.current = true;
    setIsPaymentSaving(true);
    let operationStage = 'input-validation';
    try {
      // Fast local session check only. Authoritative teacher UID/email/role verification remains
      // inside the Firestore transaction below, along with Firebase Security Rules.
      operationStage = 'session-check';
      const preflightUser = auth.currentUser;
      if (!preflightUser || normalizeTeacherEmail(preflightUser.email) !== operation.teacherEmail) {
        throw new Error('Access denied. Sign in with the teacher account that owns this fee record.');
      }
      markPaymentPerf('sessionCheckCompletedAt');
      if (!operation.id) {
        operationStage = 'create-idempotency-key';
        const idempotencyStartedAt = devTimingEnabled && typeof performance !== 'undefined' ? performance.now() : 0;
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
        if (devTimingEnabled && typeof performance !== 'undefined') paymentPerfMarks.idempotencyKeyMs = performance.now() - idempotencyStartedAt;
        operation.paymentAmount = roundMoney(paymentAmount);
        operation.idempotencyBasis = submissionBasis;
      } else if (devTimingEnabled) {
        paymentPerfMarks.idempotencyKeyMs = 0;
      }
      const previousMonth = getMonthOffset(operation.month, -1);
      const currentFeeRef = doc(db, 'users', operation.teacherEmail, 'fees', `${operation.classId}_${operation.month}`);
      const previousFeeRef = doc(db, 'users', operation.teacherEmail, 'fees', `${operation.classId}_${previousMonth}`);
      const classRef = doc(db, 'users', operation.teacherEmail, 'classes', operation.classId);
      const paymentRef = doc(db, 'users', operation.teacherEmail, 'fees', `${operation.classId}_${operation.month}`, 'payments', operation.id);
      const teacherProfileRef = doc(db, 'users', operation.teacherEmail);

      operationStage = 'transaction-start';
      const transactionInvokedAt = devTimingEnabled && typeof performance !== 'undefined' ? performance.now() : 0;
      if (devTimingEnabled && typeof performance !== 'undefined') paymentPerfMarks.transactionInvokedAt = transactionInvokedAt;
      const result = await runTransaction(db, async (tx) => {
        if (devTimingEnabled && typeof performance !== 'undefined' && paymentPerfMarks.transactionCallbackStartedAt === undefined) {
          paymentPerfMarks.transactionCallbackStartedAt = performance.now();
        }
        operationStage = 'transaction-authentication';
        const userNow = auth.currentUser;
        if (!userNow || normalizeTeacherEmail(userNow.email) !== operation.teacherEmail) {
          throw new Error('Access denied. The authenticated teacher no longer matches this fee record.');
        }

        // All transaction reads occur before any write.
        operationStage = 'transaction-reads';
        const [paymentSnap, classSnap, currentSnap, previousSnap, teacherProfileSnap] = await Promise.all([
          tx.get(paymentRef), tx.get(classRef), tx.get(currentFeeRef), tx.get(previousFeeRef), tx.get(teacherProfileRef)
        ]);
        operationStage = 'transaction-validation';
        assertTeacherProfile(teacherProfileSnap.exists() ? teacherProfileSnap.data() : null, userNow, operation.teacherEmail);
        if (paymentSnap.exists()) { operationStage = 'transaction-commit'; return 'duplicate' as const; }
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

        operationStage = 'transaction-writes';
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
        operationStage = 'transaction-commit';
        return 'saved' as const;
      });

      if (devTimingEnabled && typeof performance !== 'undefined') {
        paymentPerfMarks.transactionConfirmedAt = performance.now();
        paymentPerfMarks.transactionOutcome = result === 'duplicate' ? 0 : 1;
        paymentPerfMarks.transactionInvokedAt = transactionInvokedAt;
      }
      if (result === 'duplicate') {
        // The receipt exists, so a prior commit succeeded even if its acknowledgement was lost.
        showNotification('info', 'This payment was already recorded. No second payment was applied.');
      } else {
        showNotification('success', `Payment of PKR ${paymentAmount.toLocaleString()} was saved for ${String(activeModalStudent?.name ?? 'the selected student')} in ${currentClass.name} (${operation.month}).`);
      }
      operation.outcomeUncertain = false;
      // Clear directly because closeModal intentionally refuses to close while a transaction is in flight.
      setActiveModalStudent(null);
      setModalFeeOverride(null);
      paymentOperationRef.current = null;
    } catch (error: any) {
      console.error('[Fees] Payment operation failed:', { stage: operationStage, code: error?.code, normalizedCode: normalizeFirebaseErrorCode(error?.code), name: error?.name, message: error?.message, customData: error?.customData, error });
      showNotification('error', getFriendlyErrorMessage(error));
      const message = error instanceof Error ? error.message : '';
      const normalizedErrorCode = normalizeFirebaseErrorCode(error?.code);
      const definitelyRejected = ['permission-denied', 'unauthenticated', 'user-token-expired', 'invalid-user-token', 'invalid-argument'].includes(normalizedErrorCode) ||
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
      setIsPaymentSaving(false);
      if (devTimingEnabled && typeof performance !== 'undefined') {
        const uiUpdateScheduledAt = performance.now();
          const transactionInvoked = paymentPerfMarks.transactionInvokedAt;
        const transactionCallbackStarted = paymentPerfMarks.transactionCallbackStartedAt;
        const transactionConfirmed = paymentPerfMarks.transactionConfirmedAt;
        const measurement = {
          inputValidationMs: paymentPerfMarks.inputValidationCompletedAt === undefined ? null : Math.round((paymentPerfMarks.inputValidationCompletedAt - paymentPerfStart) * 100) / 100,
          authPreflightMs: paymentPerfMarks.sessionCheckCompletedAt === undefined || paymentPerfMarks.inputValidationCompletedAt === undefined
            ? null : Math.round((paymentPerfMarks.sessionCheckCompletedAt - paymentPerfMarks.inputValidationCompletedAt) * 100) / 100,
          forcedTokenRefreshAndPreflightProfileRead: 'skipped; authoritative profile read remains inside transaction',
          idempotencyKeyMs: paymentPerfMarks.idempotencyKeyMs ?? null,
          transactionStartupMs: transactionInvoked !== undefined && transactionCallbackStarted !== undefined
            ? Math.round((transactionCallbackStarted - transactionInvoked) * 100) / 100 : null,
          transactionCommitConfirmationMs: transactionInvoked !== undefined && transactionConfirmed !== undefined
            ? Math.round((transactionConfirmed - transactionInvoked) * 100) / 100 : null,
          totalUntilUiUpdateScheduledMs: Math.round((uiUpdateScheduledAt - paymentPerfStart) * 100) / 100,
          outcomeConfirmed: transactionConfirmed !== undefined
        };
        window.requestAnimationFrame(() => {
          console.info('[Fees][dev payment timing]', {
            ...measurement,
            uiNextPaintMs: Math.round((performance.now() - uiUpdateScheduledAt) * 100) / 100
          });
        });
      }
    }
  };

  const requestBulkAction = (action: 'paid' | 'unpaid') => {
    if (!currentUserEmail || !selectedClassId || !isValidMonthKey(selectedMonth)) {
      showNotification('warning', 'Select a verified class and fee month first.');
      return;
    }
    if (feeDataStatus !== 'ready') {
      showNotification('warning', feeDataStatus === 'error' ? 'Fee records failed verification. Retry the read before a bulk action.' : 'Fee records are still loading; bulk actions are disabled until server verification completes.');
      return;
    }
    const studentIds = sortedStudentsList.map((student: any) => getStudentKey(student)).filter((id): id is string => Boolean(id));
    if (studentIds.length === 0 || new Set(studentIds).size !== studentIds.length) {
      showNotification('error', 'The selected class has no eligible students or contains duplicate student IDs. Resolve the roster before continuing.');
      return;
    }
    setBulkConfirmation({ action, classId: selectedClassId, className: currentClass.name, month: selectedMonth, studentIds: [...studentIds].sort(), estimatedTotal: roundMoney(totalPendingDuesPKR), studentCount: studentIds.length });
  };

  const markAllPaid = async (confirmation: NonNullable<typeof bulkConfirmation>) => {
    if (bulkActionInFlightRef.current || !selectedClassId || !currentUserEmail || !isValidMonthKey(selectedMonth)) return;
    if (confirmation.action !== 'paid' || confirmation.classId !== selectedClassId || confirmation.month !== selectedMonth || confirmation.className !== currentClass.name || feeDataStatus !== 'ready') {
      showNotification('warning', 'The class, month, or verified fee state changed. Review the fee data and confirm the action again.');
      setBulkConfirmation(null);
      return;
    }
    if (sortedStudentsList.length > BULK_TRANSACTION_STUDENT_LIMIT) {
      setBulkConfirmation(null);
      showNotification('error', `This class has more than ${BULK_TRANSACTION_STUDENT_LIMIT} students. Use individual payments so the transaction stays within Firestore limits.`);
      return;
    }
    const targets = sortedStudentsList.map((student: any) => ({ student, id: getStudentKey(student) })).filter((item): item is { student: any; id: string } => Boolean(item.id));
    if (targets.length === 0) { setBulkConfirmation(null); return; }

    bulkActionInFlightRef.current = true;
    setIsBulkProcessing(true);
    setBulkConfirmation(null);
    let operationStage = 'tenant-verification';
    try {
      await assertVerifiedTenant(currentUserEmail);
      operationStage = 'transaction-preparation';
      const ownerEmail = currentUserEmail;
      const classId = selectedClassId;
      const month = selectedMonth;
      const previousMonth = getMonthOffset(month, -1);
      const currentRef = doc(db, 'users', ownerEmail, 'fees', `${classId}_${month}`);
      const previousRef = doc(db, 'users', ownerEmail, 'fees', `${classId}_${previousMonth}`);
      const classRef = doc(db, 'users', ownerEmail, 'classes', classId);
      const teacherProfileRef = doc(db, 'users', ownerEmail);
      const paymentIds = new Map(targets.map(({ id }) => [id, createOperationId()]));

      operationStage = 'transaction-start';
      await runTransaction(db, async (tx) => {
        operationStage = 'transaction-authentication';
        const userNow = auth.currentUser;
        if (!userNow || normalizeTeacherEmail(userNow.email) !== ownerEmail) throw new Error('Access denied. The teacher session changed.');
        operationStage = 'transaction-reads';
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
        let authoritativeOutstandingTotal = 0;

        const liveClassName = String(classData.name || classData.className || classData.title || classId);
        const liveEligibleIds = extractStudentsFromClass(classData).filter((student: any) => {
          const name = String(student?.name ?? '').trim();
          if (!name || name.toLowerCase() === 'unnamed student' || !getStudentKey(student)) return false;
          const admissionMonth = getStudentAdmissionMonth(student);
          return !admissionMonth || month >= admissionMonth;
        }).map((student: any) => getStudentKey(student)!).sort();
        const confirmedIds = [...confirmation.studentIds].sort();
        if (liveClassName !== confirmation.className || JSON.stringify(liveEligibleIds) !== JSON.stringify(confirmedIds)) {
          throw new Error('The class roster or eligible student population changed after confirmation. Refresh the register and confirm the bulk action again.');
        }

        targets.forEach(({ student, id }) => {
          const verifiedStudent = findStudentInClass(classData, id);
          if (!verifiedStudent) throw new Error(`Student ${id} no longer belongs to this class.`);
          assertValidStudentMonthlyFee(verifiedStudent);
          const currentRaw = currentRawMap[id];
          const previousRaw = previousRawMap[id];
          const state = getTransactionFeeState(currentRaw, previousRaw, verifiedStudent, previousMonth, getStudentMonthlyFee(verifiedStudent, classData));
          const obligation = roundMoney(state.previousMonthDues + state.monthlyFeeDue);
          const outstanding = Math.max(0, roundMoney(state.previousMonthDues + state.monthlyFeeDue - state.paidTowardsCurrentMonth));
          authoritativeOutstandingTotal = roundMoney(authoritativeOutstandingTotal + outstanding);

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

        if (Math.abs(roundMoney(authoritativeOutstandingTotal) - roundMoney(confirmation.estimatedTotal)) > MONEY_EPSILON) {
          throw new Error(`The authoritative outstanding total is now PKR ${roundMoney(authoritativeOutstandingTotal).toLocaleString()}, which differs from the confirmed estimate. No records were changed; review and confirm again.`);
        }
        operationStage = 'transaction-writes';
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
        operationStage = 'transaction-commit';
      });
      showNotification('success', `Mark All Paid completed for ${targets.length} students in ${month}. Receipts were created for outstanding balances and balances were updated transactionally.`);
    } catch (error: any) {
      console.error('[Fees] Mark All Paid failed:', { stage: operationStage, code: error?.code, normalizedCode: normalizeFirebaseErrorCode(error?.code), name: error?.name, message: error?.message, customData: error?.customData, error });
      showNotification('error', getFriendlyErrorMessage(error));
    } finally {
      bulkActionInFlightRef.current = false;
      setIsBulkProcessing(false);
    }
  };

  const markAllUnpaid = async (confirmation: NonNullable<typeof bulkConfirmation>) => {
    if (bulkActionInFlightRef.current || !selectedClassId || !currentUserEmail || !isValidMonthKey(selectedMonth)) return;
    if (confirmation.action !== 'unpaid' || confirmation.classId !== selectedClassId || confirmation.month !== selectedMonth || feeDataStatus !== 'ready') {
      showNotification('warning', 'The class, month, or verified fee state changed. Review the fee data and confirm the action again.');
      setBulkConfirmation(null);
      return;
    }
    if (sortedStudentsList.length > BULK_TRANSACTION_STUDENT_LIMIT) {
      setBulkConfirmation(null);
      showNotification('error', `This class has more than ${BULK_TRANSACTION_STUDENT_LIMIT} students. Use smaller changes so the transaction stays within Firestore limits.`);
      return;
    }
    const targets = sortedStudentsList.map((student: any) => ({ student, id: getStudentKey(student) })).filter((item): item is { student: any; id: string } => Boolean(item.id));
    if (targets.length === 0) { setBulkConfirmation(null); return; }

    bulkActionInFlightRef.current = true;
    setIsBulkProcessing(true);
    setBulkConfirmation(null);
    let operationStage = 'tenant-verification';
    try {
      await assertVerifiedTenant(currentUserEmail);
      operationStage = 'transaction-preparation';
      const ownerEmail = currentUserEmail;
      const classId = selectedClassId;
      const month = selectedMonth;
      const previousMonth = getMonthOffset(month, -1);
      const currentRef = doc(db, 'users', ownerEmail, 'fees', `${classId}_${month}`);
      const previousRef = doc(db, 'users', ownerEmail, 'fees', `${classId}_${previousMonth}`);
      const classRef = doc(db, 'users', ownerEmail, 'classes', classId);
      const teacherProfileRef = doc(db, 'users', ownerEmail);

      operationStage = 'transaction-start';
      await runTransaction(db, async (tx) => {
        operationStage = 'transaction-authentication';
        const userNow = auth.currentUser;
        if (!userNow || normalizeTeacherEmail(userNow.email) !== ownerEmail) throw new Error('Access denied. The teacher session changed.');
        operationStage = 'transaction-reads';
        const [classSnap, currentSnap, previousSnap, teacherProfileSnap] = await Promise.all([tx.get(classRef), tx.get(currentRef), tx.get(previousRef), tx.get(teacherProfileRef)]);
        assertTeacherProfile(teacherProfileSnap.exists() ? teacherProfileSnap.data() : null, userNow, ownerEmail);
        if (!classSnap.exists()) throw new Error('The selected class no longer exists.');
        const classData = classSnap.data();
        const liveClassName = String(classData.name || classData.className || classData.title || classId);
        const liveEligibleIds = extractStudentsFromClass(classData).filter((student: any) => {
          const name = String(student?.name ?? '').trim();
          if (!name || name.toLowerCase() === 'unnamed student' || !getStudentKey(student)) return false;
          const admissionMonth = getStudentAdmissionMonth(student);
          return !admissionMonth || month >= admissionMonth;
        }).map((student: any) => getStudentKey(student)!).sort();
        if (liveClassName !== confirmation.className || JSON.stringify(liveEligibleIds) !== JSON.stringify([...confirmation.studentIds].sort())) {
          throw new Error('The class roster or eligible student population changed after confirmation. Refresh the register and confirm the bulk action again.');
        }
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

        operationStage = 'transaction-writes';
        writeFeeRecordFields(tx, currentRef, currentUpdates, { classId, month, updatedAt: now }, currentSnap.exists(), currentRawMap);
        applyFeeStatusPatch(tx, classRef, classData, classStatusRecords, targets.map((item) => item.id));
        operationStage = 'transaction-commit';
      });
      showNotification('success', `Mark All Unpaid completed for ${targets.length} students in ${month}. No payment history was reset or erased.`);
    } catch (error: any) {
      console.error('[Fees] Mark All Unpaid failed:', { stage: operationStage, code: error?.code, normalizedCode: normalizeFirebaseErrorCode(error?.code), name: error?.name, message: error?.message, customData: error?.customData, error });
      showNotification('error', getFriendlyErrorMessage(error));
    } finally {
      bulkActionInFlightRef.current = false;
      setIsBulkProcessing(false);
    }
  };

  const openReportConfiguration = () => {
    if (!currentUserEmail || !selectedClassId || classDataStatus !== 'ready') {
      showNotification('warning', 'Select a class under a verified teacher session before creating a report.');
      return;
    }
    setReportStartMonth(selectedMonth);
    setReportEndMonth(selectedMonth);
    setReportScope('selected');
    setReportError(null);
    setGeneratedReport(null);
    setIsReportModalOpen(true);
  };

  const currentReportSignature = () => [
    currentUserEmail || '', selectedClassId, currentClass.name, reportScope,
    reportScope === 'selected' ? selectedMonth : reportScope === 'range' ? `${reportStartMonth}:${reportEndMonth}` : 'all-history'
  ].join('|');

  const handleReportAction = async (action: FeeReportAction) => {
    if (reportInFlightRef.current) return;
    let operationStage = 'initial report validation';
    let operationDomain = 'report validation';
    let activeQueryDiagnostics: Record<string, unknown> = { operation: 'report action entry', action };
    const reportFailureContexts = new WeakMap<object, { stage: string; domain: string; diagnostics?: Record<string, unknown> }>();
    const rememberReportFailure = (error: unknown, stage: string, domain: string, diagnostics?: Record<string, unknown>) => {
      if (typeof error === 'object' && error !== null) {
        reportFailureContexts.set(error, { stage, domain, diagnostics });
      }
    };
    const runReportStage = async <T,>(
      stage: string,
      domain: string,
      operation: () => Promise<T>,
      diagnostics?: Record<string, unknown>
    ): Promise<T> => {
      operationStage = stage;
      operationDomain = domain;
      if (diagnostics) activeQueryDiagnostics = diagnostics;
      try {
        return await operation();
      } catch (error) {
        rememberReportFailure(error, stage, domain, diagnostics);
        throw error;
      }
    };
    const runReportSyncStage = <T,>(
      stage: string,
      domain: string,
      operation: () => T,
      diagnostics?: Record<string, unknown>
    ): T => {
      operationStage = stage;
      operationDomain = domain;
      if (diagnostics) activeQueryDiagnostics = diagnostics;
      try {
        return operation();
      } catch (error) {
        rememberReportFailure(error, stage, domain, diagnostics);
        throw error;
      }
    };
    let legacyCompatibilityLookupUsed = false;
    let legacyCompatibilityCutoffMonth: string | null = null;
    let printWindow: Window | null = null;
    if (action === 'print') {
      operationStage = 'print window initialization';
      operationDomain = 'PDF delivery';
      printWindow = window.open('', '_blank');
      if (!printWindow) {
        setReportError('The print window was blocked by the browser. Allow pop-ups for EduTrack, then click Print again.');
        return;
      }
      printWindow.document.open();
      printWindow.document.write('<!doctype html><title>EduTrack report</title><body style="font:14px Arial;padding:28px;color:#334155">Preparing your verified fee report…</body>');
      printWindow.document.close();
    }

    reportInFlightRef.current = true;
    setIsReportGenerating(true);
    setReportError(null);
    try {
      operationStage = 'initial report validation';
      operationDomain = 'report validation';
      if (!selectedClassId || !currentUserEmail || classDataStatus !== 'ready') {
        throw new Error('A verified class and teacher session are required before generating a report.');
      }
      let reportPackage = generatedReport && generatedReport.signature === currentReportSignature()
        ? generatedReport
        : null;

      if (!reportPackage) {
        const signedInUser = auth.currentUser;
        const tenantEmail = normalizeTeacherEmail(signedInUser?.email);
        if (!signedInUser || !tenantEmail || tenantEmail !== currentUserEmail) {
          throw new Error('Access denied. Sign in with the teacher account that owns this class.');
        }
        const uidAtStart = signedInUser.uid;
        // Use normal Firebase token-refresh behavior; the authoritative profile and class are read from the server below.
        await runReportStage(
          'teacher identity/token verification',
          'Firebase authentication',
          () => signedInUser.getIdToken(),
          { operation: 'getIdToken', forcedRefresh: false, verifiedTenantSessionRequired: true }
        );
        const teacherProfileRef = doc(db, 'users', tenantEmail);
        const classRef = doc(db, 'users', tenantEmail, 'classes', selectedClassId);
        // Keep the reads concurrent while tagging failures individually so Promise.all cannot hide the failing read stage.
        const teacherProfilePromise = runReportStage(
          'server-side teacher-profile read',
          'Firestore read',
          () => getDocFromServer(teacherProfileRef),
          { operation: 'getDocFromServer', pathTemplate: 'users/{verifiedTeacherEmail}', readSource: 'server' }
        );
        const classPromise = runReportStage(
          'selected class document read',
          'Firestore read',
          () => getDocFromServer(classRef),
          { operation: 'getDocFromServer', pathTemplate: 'users/{verifiedTeacherEmail}/classes/{selectedClassId}', readSource: 'server', classIdLength: selectedClassId.length }
        );
        const [teacherProfileSnap, classSnap] = await Promise.all([teacherProfilePromise, classPromise]);
        operationStage = 'teacher profile validation';
        operationDomain = 'tenant security validation';
        assertTeacherProfile(teacherProfileSnap.exists() ? teacherProfileSnap.data() : null, signedInUser, tenantEmail);
        if (!classSnap.exists()) throw new Error('The selected class no longer exists under this teacher account.');
        if (auth.currentUser?.uid !== uidAtStart || normalizeTeacherEmail(auth.currentUser?.email) !== tenantEmail) {
          throw new Error('The authenticated teacher changed during report generation. Reopen the report and try again.');
        }
        const classData = classSnap.data();
        const className = String(classData.name || classData.className || classData.title || selectedClassId);

        let periodMonths: string[];
        operationStage = 'report scope and month validation';
        operationDomain = 'report validation';
        if (reportScope === 'selected') {
          if (!isValidMonthKey(selectedMonth)) throw new Error('The selected fee month is invalid.');
          periodMonths = [selectedMonth];
        } else if (reportScope === 'range') {
          periodMonths = getMonthsBetween(reportStartMonth, reportEndMonth);
        } else {
          periodMonths = [];
        }

        // The standard documentId() + orderBy() + startAt()/endAt() cursor query is a documented
        // Firestore pattern. Keep it as the primary path and only use the compatibility path if
        // this exact query construction/read is rejected with invalid-argument at runtime.
        const feeCollection = collection(db, 'users', tenantEmail, 'fees');
        const feeDocumentSnapshots: DocumentSnapshot<DocumentData>[] = [];
        const feeDocumentsById = new Map<string, DocumentSnapshot<DocumentData>>();
        const classDocPrefix = `${selectedClassId}_`;
        const feeQueryDiagnostics = {
          collectionPathTemplate: 'users/{verifiedTeacherEmail}/fees',
          queryKind: 'orderBy(documentId()) + startAt/endAt cursor range',
          classIdLength: selectedClassId.length,
          lowerBoundSuffix: '_0000-00',
          upperBoundSuffix: '_9999-99',
          maxDocuments: MAX_FEE_REPORT_MONTHS + 1,
          scope: reportScope
        };
        let cursorQueryFailed = false;
        try {
          const feeQuery = runReportSyncStage(
            'monthly fee query construction',
            'Firestore query construction',
            () => query(
              feeCollection,
              orderBy(documentId()),
              startAt(`${selectedClassId}_0000-00`),
              endAt(`${selectedClassId}_9999-99`),
              limit(MAX_FEE_REPORT_MONTHS + 1)
            ),
            feeQueryDiagnostics
          );
          const feeDocsSnapshot = await runReportStage(
            'historical fee documents server read',
            'Firestore read',
            () => getDocsFromServer(feeQuery),
            feeQueryDiagnostics
          );
          feeDocumentSnapshots.push(...feeDocsSnapshot.docs);
        } catch (feeQueryError: any) {
          const savedContext = typeof feeQueryError === 'object' && feeQueryError !== null
            ? reportFailureContexts.get(feeQueryError)
            : undefined;
          const failedStage = savedContext?.stage || operationStage;
          if (normalizeFirebaseErrorCode(feeQueryError?.code) !== 'invalid-argument' ||
              !['monthly fee query construction', 'historical fee documents server read'].includes(failedStage)) {
            throw feeQueryError;
          }

          cursorQueryFailed = true;
          legacyCompatibilityLookupUsed = true;
          console.warn('[Fees] Document-ID monthly query was rejected; attempting bounded tenant-scoped compatibility retrieval.', {
            operationStage: failedStage,
            errorCode: feeQueryError?.code ?? null,
            normalizedErrorCode: normalizeFirebaseErrorCode(feeQueryError?.code),
            errorMessage: feeQueryError?.message ?? String(feeQueryError),
            queryDiagnostics: savedContext?.diagnostics || feeQueryDiagnostics,
            fallback: 'where(classId == selectedClassId) plus bounded direct monthly-document lookups',
            note: 'No tenant-wide collection scan is performed.'
          });

          const classFieldQuery = runReportSyncStage(
            'compatibility classId equality-query construction',
            'Firestore query construction',
            () => query(feeCollection, where('classId', '==', selectedClassId), limit(MAX_FEE_REPORT_MONTHS + 1)),
            {
              collectionPathTemplate: 'users/{verifiedTeacherEmail}/fees',
              queryKind: "where('classId', '==', selectedClassId)",
              maxDocuments: MAX_FEE_REPORT_MONTHS + 1,
              legacyDocsWithoutClassIdRequireDirectLookup: true
            }
          );
          const classFieldSnapshot = await runReportStage(
            'compatibility classId equality-query server read',
            'Firestore read',
            () => getDocsFromServer(classFieldQuery),
            {
              collectionPathTemplate: 'users/{verifiedTeacherEmail}/fees',
              queryKind: "where('classId', '==', selectedClassId)",
              maxDocuments: MAX_FEE_REPORT_MONTHS + 1
            }
          );
          if (classFieldSnapshot.size > MAX_FEE_REPORT_MONTHS) {
            throw new Error(`This class has more than ${MAX_FEE_REPORT_MONTHS} monthly fee documents. Report generation stopped rather than omitting historical records.`);
          }
          classFieldSnapshot.docs.forEach((snapshot) => feeDocumentsById.set(snapshot.id, snapshot));

          let compatibilityMonths: string[];
          if (reportScope === 'history') {
            const classQueryMonths = classFieldSnapshot.docs
              .map((snapshot) => {
                if (!snapshot.id.startsWith(classDocPrefix)) return null;
                const suffix = snapshot.id.slice(classDocPrefix.length);
                return isValidMonthKey(suffix) ? suffix : null;
              })
              .filter((month): month is string => month !== null)
              .sort();
            const latestFieldMonth = classQueryMonths.length ? classQueryMonths[classQueryMonths.length - 1] : getCurrentMonthKey();
            const latestProbeMonth = latestFieldMonth > getCurrentMonthKey() ? latestFieldMonth : getCurrentMonthKey();
            const cutoffMonth = getMonthOffset(latestProbeMonth, -(MAX_FEE_REPORT_MONTHS - 1));
            legacyCompatibilityCutoffMonth = cutoffMonth;
            compatibilityMonths = getMonthsBetween(cutoffMonth, latestProbeMonth);
          } else {
            compatibilityMonths = periodMonths;
          }

          // Point-read only predictable monthly paths; this is bounded by the report month limit
          // and discovers legacy documents whose classId field is absent, without scanning all tenants.
          for (let start = 0; start < compatibilityMonths.length; start += 20) {
            const batchMonths = compatibilityMonths.slice(start, start + 20);
            const monthlySnapshots = await Promise.all(batchMonths.map((month) => runReportStage(
              `legacy monthly document server read (${month})`,
              'Firestore read',
              () => getDocFromServer(doc(feeCollection, `${selectedClassId}_${month}`)),
              {
                collectionPathTemplate: 'users/{verifiedTeacherEmail}/fees/{classId}_{YYYY-MM}',
                readKind: 'direct document lookup',
                month,
                classIdLength: selectedClassId.length,
                reportScope
              }
            )));
            monthlySnapshots.forEach((snapshot) => {
              if (snapshot.exists()) feeDocumentsById.set(snapshot.id, snapshot);
            });
          }
          feeDocumentSnapshots.push(...feeDocumentsById.values());
        }

        if (!cursorQueryFailed) {
          feeDocumentSnapshots.forEach((snapshot) => feeDocumentsById.set(snapshot.id, snapshot));
        }
        if (feeDocumentSnapshots.length > MAX_FEE_REPORT_MONTHS || feeDocumentsById.size > MAX_FEE_REPORT_MONTHS) {
          throw new Error(`This class has more than ${MAX_FEE_REPORT_MONTHS} monthly fee documents in the report's bounded retrieval. Report generation stopped rather than omitting historical records.`);
        }
        const verifiedFeeDocumentSnapshots = [...feeDocumentsById.values()];

        interface ReportFeeDoc {
          month: string;
          docId: string;
          data: Record<string, any>;
          records: Record<string, any>;
        }
        interface StoredReportReceipt {
          paymentId: string;
          studentId: string;
          feeMonth: string;
          amount: number | null;
          appliedToPreviousDues: number | null;
          appliedToCurrentMonth: number | null;
          createdAtDate: Date | null;
          paymentDate: string;
          source: string;
          storedStudentName: string;
          storedRollNo: string;
          storedGender: string;
        }

        const warnings = new Set<string>();
        let hasDataGaps = false;
        let warningsTruncated = false;
        const addReportWarning = (message: string, affectsCompleteness = true) => {
          if (affectsCompleteness) hasDataGaps = true;
          if (warnings.has(message)) return;
          if (warnings.size < MAX_FEE_REPORT_WARNINGS) warnings.add(message);
          else warningsTruncated = true;
        };
        if (legacyCompatibilityLookupUsed) {
          addReportWarning(reportScope === 'history'
            ? `The primary document-ID query was rejected. Compatibility retrieval checked at most ${MAX_FEE_REPORT_MONTHS} known monthly document IDs starting at ${legacyCompatibilityCutoffMonth || 'an unavailable cutoff'}; records older than that bounded window cannot be independently ruled out, so this report does not claim complete history.`
            : 'The primary document-ID query was rejected. Compatibility retrieval recovered monthly records using the classId field and targeted document reads for the selected period; cross-period legacy history may be incomplete, so cumulative historical totals are not treated as verified.');
        }
        const feeDocsByMonth = new Map<string, ReportFeeDoc>();
        operationStage = 'fee-document schema validation and feeRecords parsing';
        operationDomain = 'Firestore data validation';
        verifiedFeeDocumentSnapshots.forEach((snapshot) => {
          if (!snapshot.id.startsWith(classDocPrefix)) {
            addReportWarning('A fee document returned by the compatibility query did not match the selected class document-ID prefix and was excluded.');
            return;
          }
          const month = snapshot.id.slice(classDocPrefix.length);
          if (!isValidMonthKey(month)) {
            addReportWarning('A monthly fee document did not follow the expected classId_YYYY-MM naming format and was not included.');
            return;
          }
          const data = snapshot.data() as Record<string, any>;
          if (data.classId !== undefined && String(data.classId) !== selectedClassId) {
            throw new Error(`Fee document ${snapshot.id} has a classId that does not match its path. The report was not generated.`);
          }
          if (data.month !== undefined && String(data.month) !== month) {
            throw new Error(`Fee document ${snapshot.id} has a month that does not match its path. The report was not generated.`);
          }
          const records = readFeeRecords(snapshot, selectedClassId, month);
          Object.entries(records).forEach(([studentId, record]) => {
            if (!isPlainObject(record)) {
              addReportWarning(`Fee record for student ID ${studentId} in ${month} is malformed; its balance is not inferred.`);
              return;
            }
            ['paidAmount', 'remainingDues', 'previousMonthDues', 'monthlyFeeDue', 'paidTowardsCurrentMonth'].forEach((field) => {
              if (Object.prototype.hasOwnProperty.call(record, field) && parseOptionalMoney(record[field]) === null) {
                addReportWarning(`Fee record for student ID ${studentId} in ${month} has an invalid ${field} value.`);
              }
            });
          });
          feeDocsByMonth.set(month, { month, docId: snapshot.id, data, records });
        });

        operationStage = 'historical ledger period calculation';
        operationDomain = 'report processing';
        if (reportScope === 'history') {
          const availableMonths = [...feeDocsByMonth.keys()].sort();
          if (availableMonths.length === 0) {
            throw new Error('No monthly fee documents were found for this class. A complete-history report cannot be established from available records.');
          }
          const knownAdmissionMonths = extractStudentsFromClass(classData)
            .map((student: any) => getStudentAdmissionMonth(student))
            .filter((month): month is string => Boolean(month))
            .sort();
          const earliestKnownAdmission = knownAdmissionMonths[0];
          const historyStart = earliestKnownAdmission && earliestKnownAdmission < availableMonths[0]
            ? earliestKnownAdmission
            : availableMonths[0];
          const latestAvailable = availableMonths[availableMonths.length - 1];
          const reportCurrentMonth = getCurrentMonthKey();
          const historyEnd = latestAvailable > reportCurrentMonth ? latestAvailable : reportCurrentMonth;
          // Extend through the current month (and any earlier verified admission date) so active
          // students are not silently omitted just because a monthly document was never created.
          periodMonths = getMonthsBetween(historyStart, historyEnd);
        }
        if (periodMonths.length === 0 || periodMonths.length > MAX_FEE_REPORT_MONTHS) {
          throw new Error(`The selected report period must contain between 1 and ${MAX_FEE_REPORT_MONTHS} months.`);
        }

        operationStage = 'historical ledger coverage analysis';
        operationDomain = 'report processing';
        const allMonthDocs = [...feeDocsByMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
        const allAvailableMonthKeys = allMonthDocs.map((feeDoc) => feeDoc.month);
        const coverageStart = reportScope === 'history' && periodMonths.length
          ? periodMonths[0]
          : allAvailableMonthKeys[0];
        const coverageEnd = reportScope === 'history' && periodMonths.length
          ? periodMonths[periodMonths.length - 1]
          : allAvailableMonthKeys[allAvailableMonthKeys.length - 1];
        const allHistoryMonthKeys = allAvailableMonthKeys.length > 0 && coverageStart && coverageEnd
          ? getMonthsBetween(coverageStart, coverageEnd)
          : [];
        const hasHistoricalCoverageGap = legacyCompatibilityLookupUsed || allHistoryMonthKeys.some((month) => !feeDocsByMonth.has(month));
        if (allHistoryMonthKeys.some((month) => !feeDocsByMonth.has(month))) {
          addReportWarning('One or more months within the identified historical coverage have no monthly fee document; historical and period-based totals may not include all fees or receipts.');
        }
        const storedReceipts: StoredReportReceipt[] = [];
        const receiptsByFeeMonth = new Map<string, StoredReportReceipt[]>();
        const seenReportReceiptKeys = new Map<string, string>();
        // Read the receipt subcollection below each validated monthly document in small concurrent batches.
        operationStage = 'payment receipt subcollection retrieval';
        operationDomain = 'Firestore read';
        for (let start = 0; start < allMonthDocs.length; start += 6) {
          const batch = allMonthDocs.slice(start, start + 6);
          const batchSnapshots = await Promise.all(batch.map(async (feeDoc) => {
            operationStage = 'payment receipt subcollection query construction';
            const receiptCollection = collection(db, 'users', tenantEmail, 'fees', feeDoc.docId, 'payments');
            const receiptQuery = runReportSyncStage(
              'payment receipt subcollection query construction',
              'Firestore query construction',
              () => query(receiptCollection, limit(MAX_FEE_REPORT_RECEIPTS_PER_MONTH + 1)),
              {
                pathTemplate: 'users/{verifiedTeacherEmail}/fees/{validatedClassId}_{YYYY-MM}/payments',
                queryKind: 'collection query with limit',
                feeMonth: feeDoc.month,
                monthlyDocumentIdLength: feeDoc.docId.length,
                maxReceipts: MAX_FEE_REPORT_RECEIPTS_PER_MONTH + 1
              }
            );
            const receiptsSnapshot = await runReportStage(
              `payment receipt server read for fee month ${feeDoc.month}`,
              'Firestore read',
              () => getDocsFromServer(receiptQuery),
              {
                pathTemplate: 'users/{verifiedTeacherEmail}/fees/{validatedClassId}_{YYYY-MM}/payments',
                queryKind: 'collection query with limit',
                feeMonth: feeDoc.month,
                monthlyDocumentIdLength: feeDoc.docId.length,
                maxReceipts: MAX_FEE_REPORT_RECEIPTS_PER_MONTH + 1,
                readSource: 'server'
              }
            );
            return { feeDoc, receiptsSnapshot };
          }));
          const receiptsReadThisBatch = batchSnapshots.reduce((sum, item) => sum + item.receiptsSnapshot.size, 0);
          if (storedReceipts.length + receiptsReadThisBatch > MAX_FEE_REPORT_RECEIPTS_TOTAL) {
            throw new Error(`This class has more than ${MAX_FEE_REPORT_RECEIPTS_TOTAL} historical receipts in the queried data. The report was stopped rather than omitting records.`);
          }
          operationStage = 'receipt validation and reconciliation';
          operationDomain = 'Firestore data validation';
          batchSnapshots.forEach(({ feeDoc, receiptsSnapshot }) => {
            if (receiptsSnapshot.size > MAX_FEE_REPORT_RECEIPTS_PER_MONTH) {
              throw new Error(`Fee month ${feeDoc.month} has more than ${MAX_FEE_REPORT_RECEIPTS_PER_MONTH} receipts. The report was stopped rather than silently omitting payment history.`);
            }
            const monthReceipts: StoredReportReceipt[] = [];
            receiptsSnapshot.docs.forEach((receiptSnapshot) => {
              const receiptData = receiptSnapshot.data() as Record<string, any>;
              if (receiptData.teacherEmail !== undefined && normalizeTeacherEmail(String(receiptData.teacherEmail)) !== tenantEmail) {
                throw new Error(`Receipt ${receiptSnapshot.id} is marked for another teacher. The report was not generated.`);
              }
              if (receiptData.classId !== undefined && String(receiptData.classId) !== selectedClassId) {
                throw new Error(`Receipt ${receiptSnapshot.id} is marked for another class. The report was not generated.`);
              }
              if (receiptData.month !== undefined && String(receiptData.month) !== feeDoc.month) {
                addReportWarning(`Receipt ${receiptSnapshot.id} records a fee month that differs from its monthly document path.`);
              }
              const studentId = receiptData.studentId === undefined || receiptData.studentId === null ? '' : String(receiptData.studentId).trim();
              const createdAtDate = parseCalendarDate(receiptData.createdAt);
              const amount = parseOptionalMoney(receiptData.amount);
              const appliedToPreviousDues = parseOptionalMoney(receiptData.appliedToPreviousDues);
              const appliedToCurrentMonth = parseOptionalMoney(receiptData.appliedToCurrentMonth);
              if (!studentId) addReportWarning(`Receipt ${receiptSnapshot.id} has no student ID and could not be reconciled to a student ledger row.`);
              if (amount === null) addReportWarning(`Receipt ${receiptSnapshot.id} has an invalid or unavailable amount; report totals may be incomplete.`);
              if (appliedToPreviousDues === null || appliedToCurrentMonth === null) {
                addReportWarning(`Receipt ${receiptSnapshot.id} is missing or has invalid allocation fields; allocation history is incomplete.`);
              } else if (amount !== null && Math.abs(roundMoney(appliedToPreviousDues + appliedToCurrentMonth) - amount) > MONEY_EPSILON) {
                addReportWarning(`Receipt ${receiptSnapshot.id} allocation amounts do not add up to its stored payment amount; related balances may be incomplete.`);
              }
              if (!receiptData.source || typeof receiptData.source !== 'string') addReportWarning(`Receipt ${receiptSnapshot.id} has no recorded transaction source.`);
              if (!createdAtDate) addReportWarning(`Receipt ${receiptSnapshot.id} has no verifiable payment timestamp; its receipt date cannot be assigned to a reporting period.`);
              if (receiptData.paymentId !== undefined && String(receiptData.paymentId) !== receiptSnapshot.id) {
                addReportWarning(`Receipt ${receiptSnapshot.id} has a stored paymentId that differs from its document ID.`);
              }
              const receipt: StoredReportReceipt = {
                paymentId: typeof receiptData.paymentId === 'string' && receiptData.paymentId.trim() ? receiptData.paymentId.trim() : receiptSnapshot.id,
                studentId,
                feeMonth: feeDoc.month,
                amount,
                appliedToPreviousDues,
                appliedToCurrentMonth,
                createdAtDate,
                paymentDate: createdAtDate ? createdAtDate.toLocaleString() : 'Date unavailable',
                source: typeof receiptData.source === 'string' && receiptData.source.trim() ? receiptData.source : 'Source unavailable',
                storedStudentName: String(receiptData.studentName ?? receiptData.name ?? '').trim(),
                storedRollNo: String(receiptData.rollNo ?? receiptData.roll_no ?? '').trim(),
                storedGender: String(receiptData.gender ?? '').trim()
              };
              const receiptPath = `${feeDoc.docId}/payments/${receiptSnapshot.id}`;
              for (const identityKey of new Set([receiptSnapshot.id, receipt.paymentId])) {
                const existingPath = seenReportReceiptKeys.get(identityKey);
                if (existingPath && existingPath !== receiptPath) {
                  throw new Error(`Payment identity ${identityKey} appears in more than one monthly payment subcollection. The report was stopped to avoid double-counting receipts.`);
                }
                seenReportReceiptKeys.set(identityKey, receiptPath);
              }
              monthReceipts.push(receipt);
              storedReceipts.push(receipt);
            });
            receiptsByFeeMonth.set(feeDoc.month, monthReceipts);
          });
        }

        if (auth.currentUser?.uid !== uidAtStart || normalizeTeacherEmail(auth.currentUser?.email) !== tenantEmail) {
          throw new Error('The authenticated teacher changed while report data was being retrieved. No report was produced.');
        }

        operationStage = 'historical ledger calculations';
        operationDomain = 'report processing';
        const currentRoster = extractStudentsFromClass(classData);
        const rosterById = new Map<string, any>();
        currentRoster.forEach((student: any) => {
          const id = getStudentKey(student);
          if (!id) return;
          if (rosterById.has(id)) addReportWarning(`The current class roster contains duplicate student ID ${id}.`);
          else rosterById.set(id, student);
        });
        const periodSet = new Set(periodMonths);
        periodMonths.forEach((month) => {
          if (!feeDocsByMonth.has(month)) addReportWarning(`No monthly fee document exists for ${month}; fee assessment, balances and payment history for that month cannot be inferred.`);
        });

        const currentCalendarMonth = getCurrentMonthKey();
        const reportMonths: FeeReportMonth[] = [];
        const studentNameFor = (studentId: string, feeMonth: string, raw: any): string => {
          const rosterStudent = rosterById.get(studentId);
          const receiptName = (receiptsByFeeMonth.get(feeMonth) || []).find((receipt) => receipt.studentId === studentId && receipt.storedStudentName)?.storedStudentName;
          const name = String(rosterStudent?.name ?? raw?.studentName ?? raw?.name ?? receiptName ?? '').trim();
          return name && name.toLowerCase() !== 'unnamed student' ? name : 'Name unavailable';
        };
        const reportRosterStudentIsEligible = (student: any, month: string): boolean => {
          const studentName = String(student?.name ?? '').trim();
          if (!studentName || studentName.toLowerCase() === 'unnamed student' || !getStudentKey(student)) return false;
          const admissionMonth = getStudentAdmissionMonth(student);
          return !admissionMonth || month >= admissionMonth;
        };
        const getReportMonthlyFee = (student: any, rawClassData: any): number | null => {
          const studentSpecificFee = student?.studentFee ?? student?.classFee ?? student?.monthlyFee;
          if (studentSpecificFee !== undefined && studentSpecificFee !== null && studentSpecificFee !== '') {
            return parseOptionalMoney(studentSpecificFee);
          }
          const classCandidates = [rawClassData?.monthlyFee, rawClassData?.fee, rawClassData?.classFee];
          for (const candidate of classCandidates) {
            if (candidate === undefined || candidate === null || candidate === '') continue;
            const parsed = parseOptionalMoney(candidate);
            if (parsed !== null) return parsed;
          }
          return null;
        };
        const sumKnown = (rows: FeeReportStudentRow[], getter: (row: FeeReportStudentRow) => number | null): number | null => {
          if (rows.length === 0 || rows.some((row) => getter(row) === null)) return null;
          return roundMoney(rows.reduce((sum, row) => sum + (getter(row) ?? 0), 0));
        };

        for (const month of periodMonths) {
          const monthDoc = feeDocsByMonth.get(month);
          const monthReceipts = receiptsByFeeMonth.get(month) || [];
          const previousMonth = getMonthOffset(month, -1);
          const previousDoc = feeDocsByMonth.get(previousMonth);
          const studentIds = new Set<string>();
          currentRoster.forEach((student: any) => {
            const studentId = getStudentKey(student);
            if (studentId && reportRosterStudentIsEligible(student, month)) studentIds.add(studentId);
          });
          if (monthDoc) Object.keys(monthDoc.records).forEach((studentId) => studentIds.add(studentId));
          monthReceipts.forEach((receipt) => { if (receipt.studentId) studentIds.add(receipt.studentId); });
          const rows: FeeReportStudentRow[] = [];
          const orderedIds = [...studentIds].sort(compareStudentKeys);

          orderedIds.forEach((studentId, index) => {
            const rosterStudent = rosterById.get(studentId);
            const raw = monthDoc?.records[studentId];
            const hasMalformedRecord = raw !== undefined && !isPlainObject(raw);
            const hasRawRecord = Boolean(raw && isPlainObject(raw));
            if (hasMalformedRecord) addReportWarning(`Fee record for student ID ${studentId} in ${month} is malformed; no totals are inferred from it.`);
            const studentHasHistory = hasRawRecord || monthReceipts.some((receipt) => receipt.studentId === studentId);
            if (rosterStudent && !reportRosterStudentIsEligible(rosterStudent, month) && !studentHasHistory) return;
            const studentReceipts = monthReceipts.filter((receipt) => receipt.studentId === studentId);
            const validReceiptAmounts = studentReceipts.filter((receipt) => receipt.amount !== null);
            const hasInvalidReceiptAmount = studentReceipts.some((receipt) => receipt.amount === null);
            const rawPaidAggregate = hasRawRecord ? parseOptionalMoney(raw.paidAmount) : null;
            let amountPaid: number | null = null;
            let legacyAggregate = false;
            if (!monthDoc || hasMalformedRecord) {
              amountPaid = null;
            } else if (studentReceipts.length > 0) {
              amountPaid = hasInvalidReceiptAmount ? null : roundMoney(validReceiptAmounts.reduce((sum, receipt) => sum + (receipt.amount ?? 0), 0));
              if (rawPaidAggregate !== null && amountPaid !== null && Math.abs(roundMoney(rawPaidAggregate) - amountPaid) > MONEY_EPSILON) {
                addReportWarning(`Receipt total and paidAmount aggregate differ for student ${studentId} in ${month}; receipt values are shown separately from the stored aggregate.`);
              }
            } else if (rawPaidAggregate !== null) {
              amountPaid = rawPaidAggregate;
              if (rawPaidAggregate > MONEY_EPSILON) {
                legacyAggregate = true;
                addReportWarning(`Student ${studentId} in ${month} has aggregate paidAmount ${formatPKR(rawPaidAggregate)} but no detailed receipts; transaction-level history is unavailable.`);
              }
            } else if (!hasRawRecord) {
              // The monthly document and its payment subcollection were successfully queried, and no receipt was found for this student.
              amountPaid = 0;
            } else {
              addReportWarning(`Student ${studentId} in ${month} has no usable paidAmount aggregate or detailed receipt amount.`);
            }

            let assessedFee: number | null = null;
            if (monthDoc && hasRawRecord && !hasMalformedRecord) {
              assessedFee = parseOptionalMoney(raw.monthlyFeeDue);
              if (assessedFee === null && month === currentCalendarMonth && rosterStudent && getStudentAdmissionMonth(rosterStudent) !== month) {
                assessedFee = getReportMonthlyFee(rosterStudent, classData);
              }
            } else if (!hasMalformedRecord && month === currentCalendarMonth && rosterStudent && getStudentAdmissionMonth(rosterStudent) !== month) {
              assessedFee = getReportMonthlyFee(rosterStudent, classData);
            }
            if (monthDoc && assessedFee === null) {
              addReportWarning(`The assessed fee for student ${studentId} in ${month} is not stored and cannot be verified from current historical records.`);
            }

            const explicitPreviousDues = hasRawRecord && !hasMalformedRecord && Object.prototype.hasOwnProperty.call(raw, 'previousMonthDues')
              ? parseOptionalMoney(raw.previousMonthDues)
              : null;
            const previousRaw = previousDoc?.records[studentId];
            const admissionMonth = getStudentAdmissionMonth(rosterStudent || raw || {});
            let previousDues: number | null = explicitPreviousDues;
            if (previousDues === null && previousRaw && isPlainObject(previousRaw)) {
              previousDues = parseOptionalMoney(previousRaw.remainingDues);
            }
            if (previousDues === null && admissionMonth && previousMonth < admissionMonth) previousDues = 0;
            if (previousDues === null && monthDoc && (hasRawRecord || assessedFee !== null)) {
              addReportWarning(`Previous-month dues for student ${studentId} in ${month} are not recorded on this month or a verifiable previous-month record.`);
            }

            const totalPayable = !hasMalformedRecord && assessedFee !== null && previousDues !== null
              ? roundMoney(assessedFee + previousDues)
              : null;
            const storedRemaining = hasRawRecord && !hasMalformedRecord ? parseOptionalMoney(raw.remainingDues) : null;
            let paidTowardsCurrent: number | null = hasRawRecord && !hasMalformedRecord ? parseOptionalMoney(raw.paidTowardsCurrentMonth) : null;
            if (paidTowardsCurrent === null && storedRemaining !== null && assessedFee !== null && previousDues !== null) {
              paidTowardsCurrent = Math.min(assessedFee, Math.max(0, roundMoney(totalPayable! - storedRemaining)));
            } else if (paidTowardsCurrent === null && hasRawRecord && assessedFee !== null && amountPaid !== null) {
              // Match the existing Fees module's documented legacy allocation fallback.
              paidTowardsCurrent = Math.min(assessedFee, amountPaid);
            } else if (paidTowardsCurrent === null && !hasRawRecord && studentReceipts.length > 0) {
              const currentAllocations = studentReceipts.map((receipt) => receipt.appliedToCurrentMonth);
              if (currentAllocations.every((amount) => amount !== null)) {
                paidTowardsCurrent = roundMoney(currentAllocations.reduce((sum, amount) => sum + (amount ?? 0), 0));
              }
            }

            let remainingBalance: number | null = storedRemaining;
            if (remainingBalance === null && totalPayable !== null && studentReceipts.length > 0) {
              // Receipts are the only safe reconstruction source when a stored balance is absent,
              // whether or not an incomplete legacy aggregate exists on the monthly record.
              const previousAllocations = studentReceipts.map((receipt) => receipt.appliedToPreviousDues);
              const currentAllocations = studentReceipts.map((receipt) => receipt.appliedToCurrentMonth);
              if (previousAllocations.every((amount) => amount !== null) && currentAllocations.every((amount) => amount !== null)) {
                const toPrevious = previousAllocations.reduce((sum, amount) => sum + (amount ?? 0), 0);
                const toCurrent = currentAllocations.reduce((sum, amount) => sum + (amount ?? 0), 0);
                remainingBalance = Math.max(0, roundMoney(Math.max(0, previousDues! - toPrevious) + Math.max(0, assessedFee! - toCurrent)));
              }
            }
            if (remainingBalance === null && totalPayable !== null && paidTowardsCurrent !== null) {
              remainingBalance = Math.max(0, roundMoney(totalPayable - paidTowardsCurrent));
            }

            let status = 'Not recorded';
            const storedStatus = String(raw?.status ?? '').trim().toUpperCase();
            const hasValidStoredStatus = storedStatus === 'PAID' || storedStatus === 'PARTIAL' || storedStatus === 'UNPAID';
            if (totalPayable !== null && remainingBalance !== null) {
              const inferred = calculateFeeStatus(
                totalPayable,
                remainingBalance,
                (amountPaid ?? 0) > MONEY_EPSILON || (paidTowardsCurrent ?? 0) > MONEY_EPSILON || storedStatus === 'PAID' || storedStatus === 'PARTIAL'
              );
              status = inferred === 'PAID' ? 'Paid' : inferred === 'PARTIAL' ? 'Partial' : 'Unpaid';
              const storedLabel = storedStatus === 'PAID' ? 'Paid' : storedStatus === 'PARTIAL' ? 'Partial' : 'Unpaid';
              if (hasValidStoredStatus && storedLabel !== status) {
                addReportWarning(`Stored status ${storedLabel} differs from the balance-derived status ${status} for student ${studentId} in ${month}; the report uses the status derived from the recorded balance.`);
              }
            } else if (hasValidStoredStatus) {
              status = storedStatus === 'PAID' ? 'Paid' : storedStatus === 'PARTIAL' ? 'Partial' : 'Unpaid';
            }
            if (!monthDoc || hasMalformedRecord) status = 'Not recorded';
            if (hasMalformedRecord) {
              assessedFee = null;
              previousDues = null;
              amountPaid = null;
              remainingBalance = null;
              legacyAggregate = false;
            }
            if (!hasRawRecord && monthDoc && (assessedFee === null || previousDues === null || remainingBalance === null)) {
              if (status !== 'Unpaid') status = 'Not recorded';
            }
            if (!hasRawRecord && monthDoc && assessedFee !== null && previousDues !== null && remainingBalance !== null && amountPaid === 0) status = 'Unpaid';
            if (status === 'Not recorded') addReportWarning(`Student ${studentId} has no complete fee ledger row for ${month}; the report does not infer a zero balance.`);

            const datedStudentReceipts = studentReceipts.filter((receipt) => receipt.createdAtDate !== null)
              .sort((a, b) => (b.createdAtDate?.getTime() || 0) - (a.createdAtDate?.getTime() || 0));
            const latestPaymentDate = datedStudentReceipts[0]?.paymentDate || 'N/A';
            const receiptForIdentity = studentReceipts.find((receipt) => receipt.storedStudentName || receipt.storedRollNo || receipt.storedGender);
            const name = studentNameFor(studentId, month, raw);
            if (name === 'Name unavailable') {
              addReportWarning(`A historical student name is unavailable for student ID ${studentId} in ${month}; the ID is retained without inventing a name.`);
            }
            const row: FeeReportStudentRow = {
              serial: rows.length + 1,
              rollNo: String(rosterStudent?.rollNo ?? rosterStudent?.roll_no ?? rosterStudent?.roll ?? raw?.rollNo ?? raw?.roll_no ?? receiptForIdentity?.storedRollNo ?? 'N/A'),
              studentName: name,
              studentId,
              gender: String(rosterStudent?.gender ?? raw?.gender ?? receiptForIdentity?.storedGender ?? 'N/A'),
              month,
              assessedFee,
              previousDues,
              totalPayable,
              amountPaid,
              remainingBalance,
              status,
              latestPaymentDate,
              legacyAggregate
            };
            rows.push(row);
          });

          const monthReceiptAmountsInvalid = monthReceipts.some((receipt) => receipt.amount === null || !receipt.studentId);
          const monthRecordAggregatesUnusable = monthDoc ? Object.entries(monthDoc.records).some(([studentId, raw]) => {
            const hasReceiptsForStudent = monthReceipts.some((receipt) => receipt.studentId === studentId);
            return !hasReceiptsForStudent && parseOptionalMoney(raw?.paidAmount) === null;
          }) : false;
          let collectedByFeeMonth: number | null = null;
          if (monthDoc && !monthReceiptAmountsInvalid && !monthRecordAggregatesUnusable) {
            let collected = monthReceipts.reduce((sum, receipt) => sum + (receipt.amount ?? 0), 0);
            Object.entries(monthDoc.records).forEach(([studentId, raw]) => {
              const hasReceiptsForStudent = monthReceipts.some((receipt) => receipt.studentId === studentId);
              if (hasReceiptsForStudent) return;
              const aggregate = parseOptionalMoney(raw?.paidAmount);
              if (aggregate !== null) collected += aggregate;
            });
            collectedByFeeMonth = roundMoney(collected);
          }
          const assessedTotal = sumKnown(rows, (row) => row.assessedFee);
          const previousDuesTotal = sumKnown(rows, (row) => row.previousDues);
          const outstandingTotal = sumKnown(rows, (row) => row.remainingBalance);
          const monthModel: FeeReportMonth = {
            month,
            hasDocument: Boolean(monthDoc),
            rows,
            assessedTotal,
            paidCount: rows.filter((row) => row.status === 'Paid').length,
            partialCount: rows.filter((row) => row.status === 'Partial').length,
            unpaidCount: rows.filter((row) => row.status === 'Unpaid').length,
            unrecordedCount: rows.filter((row) => row.status === 'Not recorded').length,
            previousDuesTotal,
            collectedByFeeMonth,
            outstandingTotal
          };
          if (!monthDoc) {
            monthModel.previousDuesTotal = null;
            monthModel.outstandingTotal = null;
          }
          reportMonths.push(monthModel);
        }

        const reportStart = periodMonths[0];
        const reportEnd = periodMonths[periodMonths.length - 1];
        const transactionRows = storedReceipts.filter((receipt) => {
          if (reportScope === 'history') return true;
          if (periodSet.has(receipt.feeMonth)) return true;
          if (receipt.createdAtDate) {
            const createdMonth = `${receipt.createdAtDate.getFullYear()}-${String(receipt.createdAtDate.getMonth() + 1).padStart(2, '0')}`;
            return createdMonth >= reportStart && createdMonth <= reportEnd;
          }
          return false;
        }).map((receipt): FeeReportTransaction => {
          const raw = feeDocsByMonth.get(receipt.feeMonth)?.records[receipt.studentId];
          const studentName = studentNameFor(receipt.studentId, receipt.feeMonth, raw);
          if (receipt.studentId && studentName === 'Name unavailable') {
            addReportWarning(`The historical name for student ${receipt.studentId} in a payment receipt is unavailable; the student ID is retained.`);
          }
          return {
            paymentDate: receipt.paymentDate,
            createdAtDate: receipt.createdAtDate,
            paymentId: receipt.paymentId,
            studentName,
            studentId: receipt.studentId || 'Student ID unavailable',
            feeMonth: receipt.feeMonth,
            amount: receipt.amount,
            appliedToPreviousDues: receipt.appliedToPreviousDues,
            appliedToCurrentMonth: receipt.appliedToCurrentMonth,
            source: receipt.source
          };
        }).sort((a, b) => (a.createdAtDate?.getTime() || 0) - (b.createdAtDate?.getTime() || 0));

        let collectionsReceivedDuringPeriod: number | null = null;
        const anyUnassignableReceipt = storedReceipts.some((receipt) => !receipt.createdAtDate || receipt.amount === null || !receipt.studentId);
        const missingPeriodFeeDocument = periodMonths.some((month) => !feeDocsByMonth.has(month));
        if (!anyUnassignableReceipt && !missingPeriodFeeDocument && !hasHistoricalCoverageGap) {
          collectionsReceivedDuringPeriod = roundMoney(storedReceipts.reduce((sum, receipt) => {
            if (!receipt.createdAtDate || receipt.amount === null) return sum;
            const createdMonth = `${receipt.createdAtDate.getFullYear()}-${String(receipt.createdAtDate.getMonth() + 1).padStart(2, '0')}`;
            return createdMonth >= reportStart && createdMonth <= reportEnd ? sum + receipt.amount : sum;
          }, 0));
        }

        const sumLegacyForMonths = (monthsToSum: Set<string>): number | null => {
          // A sum across an incomplete period is not a verified period total.
          if ([...monthsToSum].some((month) => !feeDocsByMonth.has(month))) return null;
          let total = 0;
          for (const [month, monthDoc] of feeDocsByMonth.entries()) {
            if (!monthsToSum.has(month)) continue;
            const monthReceipts = receiptsByFeeMonth.get(month) || [];
            for (const [studentId, raw] of Object.entries(monthDoc.records)) {
              if (monthReceipts.some((receipt) => receipt.studentId === studentId)) continue;
              const aggregate = parseOptionalMoney((raw as any)?.paidAmount);
              if (aggregate === null) return null;
              total += aggregate;
            }
          }
          return roundMoney(total);
        };
        const legacyAggregateForPeriod = sumLegacyForMonths(periodSet);

        let cumulativeRecordedPayments: number | null = (storedReceipts.some((receipt) => !receipt.studentId) || hasHistoricalCoverageGap) ? null : 0;
        for (const [month, monthDoc] of feeDocsByMonth.entries()) {
          if (cumulativeRecordedPayments === null) break;
          const monthReceipts = receiptsByFeeMonth.get(month) || [];
          const ids = new Set([...Object.keys(monthDoc.records), ...monthReceipts.map((receipt) => receipt.studentId).filter(Boolean)]);
          for (const studentId of ids) {
            const receiptList = monthReceipts.filter((receipt) => receipt.studentId === studentId);
            if (receiptList.length) {
              if (receiptList.some((receipt) => receipt.amount === null)) { cumulativeRecordedPayments = null; break; }
              cumulativeRecordedPayments = (cumulativeRecordedPayments ?? 0) + receiptList.reduce((sum, receipt) => sum + (receipt.amount ?? 0), 0);
            } else {
              const aggregate = parseOptionalMoney(monthDoc.records[studentId]?.paidAmount);
              if (aggregate === null) { cumulativeRecordedPayments = null; break; }
              cumulativeRecordedPayments = (cumulativeRecordedPayments ?? 0) + aggregate;
            }
          }
          if (cumulativeRecordedPayments === null) break;
        }
        if (cumulativeRecordedPayments !== null) cumulativeRecordedPayments = roundMoney(cumulativeRecordedPayments);

        const endingMonth = reportMonths[reportMonths.length - 1];
        const assessedFees = reportMonths.every((month) => month.assessedTotal !== null)
          ? roundMoney(reportMonths.reduce((sum, month) => sum + (month.assessedTotal ?? 0), 0))
          : null;
        const unsupportedPdfCharacters = [className, tenantEmail, ...reportMonths.flatMap((month) => month.rows.map((row) => row.studentName)), ...transactionRows.map((row) => row.studentName)]
          .some((value) => [...value].some((character) => pdfWinAnsiByte(character) === null));
        if (unsupportedPdfCharacters) {
          addReportWarning('The downloaded PDF uses built-in Latin/WinAnsi fonts; characters outside that encoding may appear as question marks. The Print action uses browser-rendered report HTML and may preserve the original script.');
        }
        if (warningsTruncated) warnings.add('Additional data-quality notes were omitted after the report note limit was reached.');
        const isComplete = !hasDataGaps && warnings.size === 0 && !warningsTruncated;
        const model: FeeReportModel = {
          title: reportScope === 'history' && isComplete ? 'Complete Fee History' : reportScope === 'history' ? 'Fee History Report — Data Limitations' : 'Student Fee Report',
          className,
          classId: selectedClassId,
          teacherEmail: tenantEmail,
          scope: reportScope,
          periodLabel: periodMonths.length === 1
            ? formatMonthLabel(periodMonths[0])
            : `${formatMonthLabel(reportStart)} – ${formatMonthLabel(reportEnd)}`,
          generatedAt: new Date().toLocaleString(),
          months: reportMonths,
          transactions: transactionRows,
          warnings: [...warnings],
          isComplete,
          totals: {
            eligibleStudents: endingMonth?.rows.length ?? 0,
            paidCount: endingMonth?.paidCount ?? 0,
            partialCount: endingMonth?.partialCount ?? 0,
            unpaidCount: endingMonth?.unpaidCount ?? 0,
            unrecordedCount: endingMonth?.unrecordedCount ?? 0,
            assessedFees,
            collectionsReceivedDuringPeriod,
            legacyAggregateForPeriod,
            cumulativeRecordedPayments,
            previousDuesAtEnd: endingMonth?.previousDuesTotal ?? null,
            outstandingAtEnd: endingMonth?.outstandingTotal ?? null
          }
        };
        const pdfBytes = runReportSyncStage(
          'PDF byte generation',
          'PDF generation',
          () => buildFeeReportPdf(model),
          { generator: 'buildFeeReportPdf', format: 'application/pdf', monthCount: model.months.length, studentLedgerRowCount: model.months.reduce((sum, month) => sum + month.rows.length, 0), receiptRowCount: model.transactions.length }
        );
        const blob = runReportSyncStage(
          'PDF Blob creation',
          'PDF generation',
          () => new Blob([pdfBytes], { type: 'application/pdf' }),
          { type: 'application/pdf', byteLength: pdfBytes.byteLength }
        );
        reportPackage = { model, blob, filename: reportFilename(model), signature: currentReportSignature() };
        setGeneratedReport(reportPackage);
      }

      operationStage = 'authenticated report delivery validation';
      operationDomain = 'tenant security validation';
      if (!auth.currentUser || normalizeTeacherEmail(auth.currentUser.email) !== reportPackage.model.teacherEmail || currentUserEmail !== reportPackage.model.teacherEmail) {
        throw new Error('The signed-in teacher changed before the report could be delivered. Generate the report again under the verified account.');
      }
      if (action === 'download') {
        operationStage = 'PDF download delivery';
        operationDomain = 'PDF delivery';
        const objectUrl = URL.createObjectURL(reportPackage.blob);
        const link = document.createElement('a');
        link.href = objectUrl;
        link.download = reportPackage.filename;
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
        showNotification('success', `Fee report PDF generated: ${reportPackage.filename}`);
      } else if (printWindow) {
        operationStage = 'PDF print-report HTML delivery';
        operationDomain = 'PDF delivery';
        printWindow.onload = () => {
          printWindow?.focus();
          printWindow?.print();
        };
        printWindow.document.open();
        printWindow.document.write(reportHtml(reportPackage.model));
        printWindow.document.close();
      }
    } catch (error: any) {
      const message = getFriendlyErrorMessage(error);
      const savedContext = typeof error === 'object' && error !== null
        ? reportFailureContexts.get(error)
        : undefined;
      const failedStage = savedContext?.stage || operationStage;
      const failedDomain = savedContext?.domain || operationDomain;
      const rawCode = error?.code ?? null;
      const normalizedCode = normalizeFirebaseErrorCode(rawCode);
      const rawMessage = error instanceof Error ? error.message : String(error?.message ?? error ?? 'Unknown report-generation error');
      const errorName = error?.name ?? (error === null ? 'null' : typeof error);
      const errorStack = typeof error?.stack === 'string' ? error.stack : null;
      const failureCategory = /Firestore/.test(failedDomain) || /Firestore|fee documents|receipt server read|subcollection query/i.test(failedStage)
        ? 'Firestore record retrieval/query'
        : /PDF/.test(failedDomain) || /PDF|download|print/i.test(failedStage)
          ? 'PDF generation/delivery'
          : /authentication|tenant/i.test(failedDomain)
            ? 'authentication/tenant verification'
            : 'report validation/ledger processing';
      console.error('[Fees] Report generation failed — diagnostic details:', {
        operationStage: failedStage,
        failureDomain: failedDomain,
        failureCategory,
        errorCode: rawCode,
        normalizedErrorCode: normalizedCode,
        errorMessage: rawMessage,
        userFacingMessage: message,
        errorName,
        errorStack,
        queryDiagnostics: savedContext?.diagnostics || activeQueryDiagnostics,
        reportScope: reportScope,
        classIdLength: selectedClassId.length,
        selectedMonthFormatValid: isValidMonthKey(selectedMonth),
        rangeStartFormatValid: isValidMonthKey(reportStartMonth),
        rangeEndFormatValid: isValidMonthKey(reportEndMonth),
        action,
        cursorQueryCompatibilityFallbackUsed: legacyCompatibilityLookupUsed
      });
      setReportError(message);
      showNotification('error', `Fee report could not be generated. ${message}`);
      // Never leave an error document in a tab that the user may mistake for a report
      // or accidentally print. Only a successfully generated report is sent to print.
      if (printWindow && !printWindow.closed) printWindow.close();
    } finally {
      reportInFlightRef.current = false;
      setIsReportGenerating(false);
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

      {notification && (
        <div role={notification.kind === 'error' ? 'alert' : 'status'} aria-live={notification.kind === 'error' ? 'assertive' : 'polite'} className={`fixed top-4 left-1/2 -translate-x-1/2 z-[120] w-[calc(100%-2rem)] max-w-lg rounded-2xl border px-4 py-3 shadow-[0_0_30px_rgba(249,115,22,0.22)] backdrop-blur-xl flex items-start gap-3 ${notification.kind === 'success' ? 'bg-emerald-600 text-white border-emerald-300' : notification.kind === 'error' ? 'bg-rose-600 text-white border-rose-300' : notification.kind === 'warning' ? 'bg-amber-500 text-white border-amber-300' : 'bg-slate-900 text-white border-slate-600'}`}>
          {notification.kind === 'success' ? <CheckCircle2 className="h-5 w-5 shrink-0 mt-0.5" /> : notification.kind === 'error' ? <XCircle className="h-5 w-5 shrink-0 mt-0.5" /> : <RefreshCw className="h-5 w-5 shrink-0 mt-0.5" />}
          <div className="min-w-0 flex-1 text-xs sm:text-sm font-bold leading-relaxed">{notification.message}</div>
          {(feeDataStatus === 'error' || classDataStatus === 'error') && (
            <button type="button" onClick={() => { setNotification(null); if (classDataStatus === 'error') setClassRetryCount((value) => value + 1); else setFeeRetryCount((value) => value + 1); }} title={feeDataError || 'Retry server verification'} className="shrink-0 rounded-lg border border-white/40 px-2.5 py-1 text-xs font-black hover:bg-white/10">Retry</button>
          )}
          <button type="button" aria-label="Dismiss notification" onClick={() => setNotification(null)} className="shrink-0 rounded-lg p-1 hover:bg-white/10"><X className="h-4 w-4" /></button>
        </div>
      )}

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
              type="button"
              onClick={openReportConfiguration}
              disabled={!currentUserEmail || !selectedClassId || classDataStatus !== 'ready' || isReportGenerating}
              aria-label="Print Report"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-gradient-to-r from-orange-500 to-amber-500 text-white font-extrabold text-xs shadow-[0_0_18px_rgba(249,115,22,0.35)] hover:scale-105 transition-all shrink-0 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <FileText className="h-3.5 w-3.5" />
              <span>Print Report</span>
            </button>

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
                  {(isLoadingClasses || feeDataStatus === 'loading') && (
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
                onClick={() => requestBulkAction('paid')}
                disabled={classes.length === 0 || feeDataStatus !== 'ready' || isBulkProcessing}
                className="flex items-center gap-1.5 text-[11px] font-bold px-3.5 py-1.5 rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20 border border-emerald-500/30 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <CheckCircle2 className="h-3.5 w-3.5" /> Mark All Paid
              </button>
              <button
                onClick={() => requestBulkAction('unpaid')}
                disabled={classes.length === 0 || feeDataStatus !== 'ready' || isBulkProcessing}
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
                    PKR {feeDataStatus === 'ready' ? totalCollectedPKR.toLocaleString() : '—'}
                  </div>
                  <div className="text-[10px] text-emerald-600 dark:text-emerald-400 font-extrabold uppercase tracking-wider">Collected This Month</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* NO CLASS NOTICE */}
        {classes.length === 0 && !isLoadingClasses && (
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
            <span className="text-xl sm:text-2xl font-black text-emerald-600 dark:text-emerald-400 mt-1 block">{feeDataStatus === 'ready' ? paidCount : '—'}</span>
          </div>
          <div className="bg-rose-50/70 dark:bg-rose-950/20 border-2 border-rose-500/40 rounded-2xl p-3.5 shadow-[0_0_15px_rgba(244,63,94,0.15)]">
            <span className="text-[10px] font-extrabold text-rose-600 dark:text-rose-400 block tracking-wide uppercase">Unpaid Count</span>
            <span className="text-xl sm:text-2xl font-black text-rose-600 dark:text-rose-400 mt-1 block">{feeDataStatus === 'ready' ? unpaidCount : '—'}</span>
          </div>
          <div className="bg-blue-50/70 dark:bg-blue-950/20 border-2 border-blue-500/40 rounded-2xl p-3.5 shadow-[0_0_15px_rgba(59,130,246,0.15)]">
            <span className="text-[10px] font-extrabold text-blue-600 dark:text-blue-400 block tracking-wide uppercase">Collected</span>
            <span className="text-base sm:text-lg font-black text-blue-600 dark:text-blue-400 mt-1 block truncate">PKR {feeDataStatus === 'ready' ? totalCollectedPKR.toLocaleString() : '—'}</span>
          </div>
          <div className="bg-amber-50/70 dark:bg-amber-950/20 border-2 border-amber-500/40 rounded-2xl p-3.5 shadow-[0_0_15px_rgba(245,158,11,0.15)]">
            <span className="text-[10px] font-extrabold text-amber-600 dark:text-amber-400 block tracking-wide uppercase">Pending Dues</span>
            <span className="text-base sm:text-lg font-black text-amber-600 dark:text-amber-400 mt-1 block truncate">PKR {feeDataStatus === 'ready' ? totalPendingDuesPKR.toLocaleString() : '—'}</span>
          </div>
          <div className="bg-purple-50/70 dark:bg-purple-950/20 border-2 border-purple-500/40 rounded-2xl p-3.5 shadow-[0_0_15px_rgba(168,85,247,0.15)]">
            <span className="text-[10px] font-extrabold text-purple-600 dark:text-purple-400 block tracking-wide uppercase">Prev Month Dues</span>
            <span className="text-base sm:text-lg font-black text-purple-600 dark:text-purple-400 mt-1 block truncate">PKR {feeDataStatus === 'ready' ? totalPrevMonthDuesPKR.toLocaleString() : '—'}</span>
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
              Paid ({feeDataStatus === 'ready' ? paidCount : '—'})
            </button>

            <button
              onClick={() => setStatusFilter('UNPAID')}
              className={`px-3.5 py-1.5 rounded-full text-xs font-black transition-all duration-300 whitespace-nowrap ${
                statusFilter === 'UNPAID'
                  ? 'bg-rose-500 text-white shadow-[0_0_12px_rgba(244,63,94,0.4)]'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              Unpaid ({feeDataStatus === 'ready' ? unpaidCount : '—'})
            </button>

            <button
              onClick={() => setStatusFilter('PARTIAL')}
              className={`px-3.5 py-1.5 rounded-full text-xs font-black transition-all duration-300 whitespace-nowrap ${
                statusFilter === 'PARTIAL'
                  ? 'bg-amber-500 text-white shadow-[0_0_12px_rgba(245,158,11,0.4)]'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              Partial ({feeDataStatus === 'ready' ? partialCount : '—'})
            </button>
          </div>
        </div>

        {/* STUDENT FEE CARDS LIST */}
        <div className="space-y-3.5">
          {feeDataStatus !== 'ready' ? (
            <div className="rounded-2xl border-2 border-orange-500/40 bg-white p-6 text-center shadow-[0_0_18px_rgba(249,115,22,0.12)] dark:bg-[#0a1020]">
              <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-orange-500/10 text-orange-500">
                {feeDataStatus === 'loading' ? <RefreshCw className="h-5 w-5 animate-spin" /> : <XCircle className="h-5 w-5" />}
              </div>
              <h3 className="text-sm font-black text-slate-900 dark:text-white">{classDataStatus === 'error' ? 'Class data could not be verified' : feeDataStatus === 'loading' ? 'Verifying fee records...' : 'Fee records could not be verified'}</h3>
              <p className="mx-auto mt-1 max-w-lg text-xs leading-relaxed text-slate-500 dark:text-slate-400">{classDataStatus === 'error' ? (feeDataError || 'Class data could not be verified. Retry the class read.') : feeDataStatus === 'loading' ? 'Waiting for server-confirmed current- and previous-month records. Payment and bulk actions remain unavailable until verification completes.' : (feeDataError || 'The current and previous fee registers could not be verified. Retry the server read before recording a payment.')}</p>
              {(feeDataStatus === 'error' || classDataStatus === 'error') && <button type="button" onClick={() => { notifiedReadErrorRef.current = null; setNotification(null); if (classDataStatus === 'error' && !currentUserEmail) setAuthRetryCount((value) => value + 1); else if (classDataStatus === 'error') setClassRetryCount((value) => value + 1); else setFeeRetryCount((value) => value + 1); }} className="mt-4 inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-orange-500 to-amber-500 px-4 py-2 text-xs font-black text-white shadow-md"><RefreshCw className="h-3.5 w-3.5" /> Retry Verification</button>}
            </div>
          ) : paginatedStudents.length === 0 ? (
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
                disabled={isPaymentSaving || feeDataStatus !== 'ready'}
                aria-busy={isPaymentSaving}
                className="w-full mt-2 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 text-white font-black py-3.5 rounded-2xl transition-all duration-200 shadow-[0_4px_25px_rgba(249,115,22,0.4)] flex justify-center items-center gap-2 text-sm tracking-wide disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {isPaymentSaving ? <RefreshCw className="h-5 w-5 animate-spin" /> : <Save className="h-5 w-5" />} {isPaymentSaving ? 'Saving Payment...' : 'Save Record'}
              </button>

            </div>
          </div>
        </div>
      )}

      {/* BULK FINANCIAL ACTION CONFIRMATION */}
      {bulkConfirmation && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md" role="dialog" aria-modal="true" aria-labelledby="bulk-confirm-title">
          <div className="w-full max-w-lg rounded-3xl border-2 border-orange-500 bg-white p-6 shadow-[0_0_50px_rgba(249,115,22,0.35)] dark:bg-[#0a1020]">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h3 id="bulk-confirm-title" className="text-lg font-black text-slate-900 dark:text-white">{bulkConfirmation.action === 'paid' ? 'Confirm Mark All Paid' : 'Confirm Mark All Unpaid'}</h3>
                <p className="mt-1 text-xs font-semibold text-slate-500 dark:text-slate-400">Review the complete eligible class population before committing.</p>
              </div>
              <button type="button" disabled={isBulkProcessing} onClick={() => setBulkConfirmation(null)} aria-label="Cancel bulk action" className="rounded-full bg-slate-100 p-2 text-slate-500 disabled:opacity-50 dark:bg-slate-800"><X className="h-4 w-4" /></button>
            </div>
            <div className="space-y-3 rounded-2xl border border-orange-500/30 bg-orange-500/5 p-4 text-sm dark:bg-orange-500/10">
              <div className="flex justify-between gap-4"><span className="text-slate-500 dark:text-slate-400">Class</span><strong className="text-right text-slate-900 dark:text-white">{bulkConfirmation.className}</strong></div>
              <div className="flex justify-between gap-4"><span className="text-slate-500 dark:text-slate-400">Fee month</span><strong className="text-slate-900 dark:text-white">{bulkConfirmation.month}</strong></div>
              <div className="flex justify-between gap-4"><span className="text-slate-500 dark:text-slate-400">Eligible students</span><strong className="text-slate-900 dark:text-white">{bulkConfirmation.studentCount}</strong></div>
              {bulkConfirmation.action === 'paid' && <div className="flex justify-between gap-4 border-t border-orange-500/20 pt-3"><span className="text-slate-500 dark:text-slate-400">Estimated collected (PKR)</span><strong className="text-right text-emerald-600 dark:text-emerald-400">{bulkConfirmation.estimatedTotal.toLocaleString()}</strong></div>}
            </div>
            <p className="mt-4 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
              {bulkConfirmation.action === 'paid'
                ? 'This operation records the full authoritative outstanding balance for every eligible student, creates one payment receipt for each positive balance, allocates payments to previous-month dues first, updates fee balances and student fee statuses, and commits the writes atomically. If the server-side total or student population differs from this confirmation, the entire operation is cancelled.'
                : 'This operation sets eligible students to Unpaid only when none of them has payment history. It will not erase collected money or partially update the class; if any affected record has payment history, the entire transaction is rejected.'}
            </p>
            <div className="mt-5 flex gap-3">
              <button type="button" disabled={isBulkProcessing} onClick={() => setBulkConfirmation(null)} className="flex-1 rounded-xl border border-slate-300 px-4 py-3 text-xs font-black text-slate-600 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300">Cancel</button>
              <button type="button" disabled={isBulkProcessing || feeDataStatus !== 'ready'} onClick={() => { const confirmation = bulkConfirmation; if (!confirmation) return; if (confirmation.action === 'paid') void markAllPaid(confirmation); else void markAllUnpaid(confirmation); }} className="flex-1 rounded-xl bg-gradient-to-r from-orange-500 to-amber-500 px-4 py-3 text-xs font-black text-white shadow-[0_0_18px_rgba(249,115,22,0.3)] disabled:cursor-not-allowed disabled:opacity-60">{isBulkProcessing ? 'Processing...' : 'Confirm & Commit'}</button>
            </div>
          </div>
        </div>
      )}


      {/* REPORT CONFIGURATION AND PDF ACTIONS */}
      {isReportModalOpen && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md" role="dialog" aria-modal="true" aria-labelledby="fee-report-title">
          <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-3xl border-2 border-orange-500/70 bg-white p-5 sm:p-6 shadow-[0_0_55px_rgba(249,115,22,0.3)] dark:bg-[#0a1020]">
            <div className="mb-5 flex items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-orange-500 to-amber-500 text-white shadow-[0_0_18px_rgba(249,115,22,0.3)]"><FileText className="h-5 w-5" /></div>
                <div>
                  <h3 id="fee-report-title" className="text-lg font-black text-slate-900 dark:text-white">Premium Fee Report</h3>
                  <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">Generate a searchable PDF from server-confirmed records belonging to the signed-in teacher.</p>
                </div>
              </div>
              <button type="button" disabled={isReportGenerating} onClick={() => setIsReportModalOpen(false)} aria-label="Close report configuration" className="rounded-full bg-slate-100 p-2 text-slate-500 disabled:opacity-50 dark:bg-slate-800"><X className="h-4 w-4" /></button>
            </div>

            <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
              <button type="button" disabled={isReportGenerating} onClick={() => { setReportScope('selected'); setGeneratedReport(null); setReportError(null); }} className={`rounded-2xl border p-3 text-left transition-all ${reportScope === 'selected' ? 'border-orange-500 bg-orange-500/10 shadow-[0_0_14px_rgba(249,115,22,0.12)]' : 'border-slate-200 hover:border-orange-400 dark:border-slate-700'}`}>
                <strong className="block text-xs font-black text-slate-900 dark:text-white">Selected Month</strong><span className="mt-1 block text-[10px] leading-relaxed text-slate-500 dark:text-slate-400">Current selected class and fee month.</span>
              </button>
              <button type="button" disabled={isReportGenerating} onClick={() => { setReportScope('history'); setGeneratedReport(null); setReportError(null); }} className={`rounded-2xl border p-3 text-left transition-all ${reportScope === 'history' ? 'border-orange-500 bg-orange-500/10 shadow-[0_0_14px_rgba(249,115,22,0.12)]' : 'border-slate-200 hover:border-orange-400 dark:border-slate-700'}`}>
                <strong className="block text-xs font-black text-slate-900 dark:text-white">Complete Fee History</strong><span className="mt-1 block text-[10px] leading-relaxed text-slate-500 dark:text-slate-400">All available monthly fee documents for this class.</span>
              </button>
              <button type="button" disabled={isReportGenerating} onClick={() => { setReportScope('range'); setGeneratedReport(null); setReportError(null); }} className={`rounded-2xl border p-3 text-left transition-all ${reportScope === 'range' ? 'border-orange-500 bg-orange-500/10 shadow-[0_0_14px_rgba(249,115,22,0.12)]' : 'border-slate-200 hover:border-orange-400 dark:border-slate-700'}`}>
                <strong className="block text-xs font-black text-slate-900 dark:text-white">Custom Month Range</strong><span className="mt-1 block text-[10px] leading-relaxed text-slate-500 dark:text-slate-400">Choose starting and ending months.</span>
              </button>
            </div>

            {reportScope === 'range' && (
              <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="text-xs font-bold text-slate-600 dark:text-slate-300">Starting month
                  <input type="month" value={reportStartMonth} max={reportEndMonth || undefined} disabled={isReportGenerating} onChange={(event) => { setReportStartMonth(event.target.value); setGeneratedReport(null); setReportError(null); }} className="mt-1 block w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm font-bold text-slate-800 outline-none focus:border-orange-500 dark:border-slate-700 dark:bg-[#070d1a] dark:text-white" />
                </label>
                <label className="text-xs font-bold text-slate-600 dark:text-slate-300">Ending month
                  <input type="month" value={reportEndMonth} min={reportStartMonth || undefined} disabled={isReportGenerating} onChange={(event) => { setReportEndMonth(event.target.value); setGeneratedReport(null); setReportError(null); }} className="mt-1 block w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm font-bold text-slate-800 outline-none focus:border-orange-500 dark:border-slate-700 dark:bg-[#070d1a] dark:text-white" />
                </label>
              </div>
            )}

            <div className="space-y-2 rounded-2xl border border-orange-500/25 bg-orange-500/5 p-4 text-xs dark:bg-orange-500/10">
              <div className="flex items-start justify-between gap-4"><span className="text-slate-500 dark:text-slate-400">Selected class</span><strong className="max-w-[65%] break-words text-right text-slate-900 dark:text-white">{currentClass.name} <span className="block text-[10px] font-semibold text-slate-500">ID: {selectedClassId || 'N/A'}</span></strong></div>
              <div className="flex items-start justify-between gap-4"><span className="text-slate-500 dark:text-slate-400">Report scope</span><strong className="text-right text-slate-900 dark:text-white">{reportScope === 'selected' ? 'Selected month' : reportScope === 'history' ? 'All available monthly records' : 'Custom month range'}</strong></div>
              <div className="flex items-start justify-between gap-4"><span className="text-slate-500 dark:text-slate-400">Report period</span><strong className="text-right text-slate-900 dark:text-white">{reportScope === 'selected' ? formatMonthLabel(selectedMonth) : reportScope === 'history' ? 'Determined from available class records' : `${formatMonthLabel(reportStartMonth)} – ${formatMonthLabel(reportEndMonth)}`}</strong></div>
              <p className="border-t border-orange-500/15 pt-2 text-[10px] leading-relaxed text-slate-500 dark:text-slate-400">Includes eligible students and historical student IDs. Missing records remain marked as unavailable. Legacy paidAmount aggregates are not represented as detailed receipts. Receipt collections are assigned to a period only when their stored payment date is verifiable.</p>
            </div>

            {reportError && <div role="alert" className="mt-4 rounded-xl border border-rose-300 bg-rose-50 px-3.5 py-3 text-xs font-semibold text-rose-700 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-300">{reportError}</div>}
            {generatedReport && generatedReport.signature === currentReportSignature() && !isReportGenerating && (
              <div className={`mt-4 rounded-xl border px-3.5 py-3 text-xs ${generatedReport.model.isComplete ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300' : 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200'}`}>
                <strong className="block">{generatedReport.model.isComplete ? 'Report generated' : 'Report generated with data limitations'}</strong>
                <span className="mt-1 block break-words">{generatedReport.filename}</span>
                <span className="mt-1 block">{generatedReport.model.months.length} month(s), {generatedReport.model.months.reduce((sum, month) => sum + month.rows.length, 0)} student ledger row(s), {generatedReport.model.transactions.length} receipt record(s).</span>
                {generatedReport.model.warnings.length > 0 && <span className="mt-1 block">{generatedReport.model.warnings.slice(0, 2).join(' ')}{generatedReport.model.warnings.length > 2 ? ' Additional data-quality notes are included in the report.' : ''}</span>}
              </div>
            )}

            <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button type="button" disabled={isReportGenerating} onClick={() => setIsReportModalOpen(false)} className="rounded-xl border border-slate-300 px-4 py-3 text-xs font-black text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">Cancel</button>
              <button type="button" disabled={isReportGenerating || !currentUserEmail || !selectedClassId} onClick={() => void handleReportAction('print')} className="inline-flex items-center justify-center gap-2 rounded-xl border border-orange-500/50 bg-white px-4 py-3 text-xs font-black text-orange-700 transition-all hover:bg-orange-50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-[#070d1a] dark:text-orange-300 dark:hover:bg-orange-500/10">
                {isReportGenerating ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Printer className="h-4 w-4" />}{isReportGenerating ? 'Generating…' : 'Print'}
              </button>
              <button type="button" disabled={isReportGenerating || !currentUserEmail || !selectedClassId} onClick={() => void handleReportAction('download')} className="inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-orange-500 to-amber-500 px-4 py-3 text-xs font-black text-white shadow-[0_0_18px_rgba(249,115,22,0.3)] transition-all hover:from-orange-600 hover:to-amber-600 disabled:cursor-not-allowed disabled:opacity-50">
                {isReportGenerating ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}{isReportGenerating ? 'Generating…' : 'Download PDF'}
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
