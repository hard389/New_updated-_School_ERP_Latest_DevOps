import {
  collection,
  doc,
  getDocs,
  getDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  Timestamp,
  QueryConstraint,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import type {
  Faculty,
  Student,
  Subject,
  Room,
  Department,
  ClassGroup,
  SubjectAllocation,
  TimeConfig,
  Timetable,
} from '@/types';

// Collection names
const COLLECTIONS = {
  FACULTY: 'faculty',
  STUDENTS: 'students',
  SUBJECTS: 'subjects',
  ROOMS: 'rooms',
  DEPARTMENTS: 'departments',
  CLASSES: 'classes',
  SUBJECT_ALLOCATIONS: 'subjectAllocations',
  TIME_CONFIG: 'timeConfig',
  TIMETABLES: 'timetables',
};

// Helper to convert Firestore timestamp
const convertTimestamp = (data: any) => {
  const result = { ...data };
  if (result.createdAt instanceof Timestamp) {
    result.createdAt = result.createdAt.toDate();
  }
  if (result.updatedAt instanceof Timestamp) {
    result.updatedAt = result.updatedAt.toDate();
  }
  if (result.generatedAt instanceof Timestamp) {
    result.generatedAt = result.generatedAt.toDate();
  }
  return result;
};

// Check if Firebase is initialized
const isFirebaseReady = () => {
  if (!db) {
    console.warn('Firebase is not configured. Please add your Firebase credentials.');
    return false;
  }
  return true;
};

// Helper to add timeout to promises
const withTimeout = <T,>(promise: Promise<T>, timeoutMs: number = 10000): Promise<T> => {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('Operation timed out. Please ensure Firestore is enabled in your Firebase project console.')), timeoutMs)
    ),
  ]);
};

// Generic CRUD operations
async function getAll<T>(collectionName: string, constraints: QueryConstraint[] = []): Promise<T[]> {
  if (!isFirebaseReady()) return [];
  try {
    const q = query(collection(db!, collectionName), ...constraints);
    const snapshot = await withTimeout(getDocs(q), 10000);
    return snapshot.docs.map((doc) => ({
      id: doc.id,
      ...convertTimestamp(doc.data()),
    })) as T[];
  } catch (error) {
    console.error(`Error fetching ${collectionName}:`, error);
    return [];
  }
}

async function getById<T>(collectionName: string, id: string): Promise<T | null> {
  if (!isFirebaseReady()) return null;
  try {
    const docRef = doc(db!, collectionName, id);
    const docSnap = await withTimeout(getDoc(docRef), 10000);
    if (docSnap.exists()) {
      return { id: docSnap.id, ...convertTimestamp(docSnap.data()) } as T;
    }
    return null;
  } catch (error) {
    console.error(`Error fetching ${collectionName}/${id}:`, error);
    return null;
  }
}

async function create<T>(collectionName: string, data: Omit<T, 'id' | 'createdAt' | 'updatedAt'>): Promise<string> {
  if (!isFirebaseReady()) throw new Error('Firebase is not configured');
  try {
    const docRef = await withTimeout(
      addDoc(collection(db!, collectionName), {
        ...data,
        createdAt: Timestamp.now(),
        updatedAt: Timestamp.now(),
      }),
      10000
    );
    return docRef.id;
  } catch (error) {
    console.error(`Error creating ${collectionName}:`, error);
    throw error;
  }
}

async function update<T>(collectionName: string, id: string, data: Partial<T>): Promise<void> {
  if (!isFirebaseReady()) throw new Error('Firebase is not configured');
  try {
    const docRef = doc(db!, collectionName, id);
    await withTimeout(
      updateDoc(docRef, {
        ...data,
        updatedAt: Timestamp.now(),
      }),
      10000
    );
  } catch (error) {
    console.error(`Error updating ${collectionName}/${id}:`, error);
    throw error;
  }
}

async function remove(collectionName: string, id: string): Promise<void> {
  if (!isFirebaseReady()) throw new Error('Firebase is not configured');
  try {
    const docRef = doc(db!, collectionName, id);
    await withTimeout(deleteDoc(docRef), 10000);
  } catch (error) {
    console.error(`Error deleting ${collectionName}/${id}:`, error);
    throw error;
  }
}

// Faculty Service
export const facultyService = {
  getAll: () => getAll<Faculty>(COLLECTIONS.FACULTY, [orderBy('name')]),
  getById: (id: string) => getById<Faculty>(COLLECTIONS.FACULTY, id),
  getByDepartment: (departmentId: string) =>
    getAll<Faculty>(COLLECTIONS.FACULTY, [where('department', '==', departmentId)]),
  create: (data: Omit<Faculty, 'id' | 'createdAt' | 'updatedAt'>) =>
    create<Faculty>(COLLECTIONS.FACULTY, data),
  update: (id: string, data: Partial<Faculty>) => update<Faculty>(COLLECTIONS.FACULTY, id, data),
  delete: (id: string) => remove(COLLECTIONS.FACULTY, id),
};

// Student Service
export const studentService = {
  getAll: () => getAll<Student>(COLLECTIONS.STUDENTS, [orderBy('name')]),
  getById: (id: string) => getById<Student>(COLLECTIONS.STUDENTS, id),
  getByClass: (classId: string) =>
    getAll<Student>(COLLECTIONS.STUDENTS, [where('class', '==', classId)]),
  getByDepartment: (departmentId: string) =>
    getAll<Student>(COLLECTIONS.STUDENTS, [where('department', '==', departmentId)]),
  create: (data: Omit<Student, 'id' | 'createdAt' | 'updatedAt'>) =>
    create<Student>(COLLECTIONS.STUDENTS, data),
  update: (id: string, data: Partial<Student>) => update<Student>(COLLECTIONS.STUDENTS, id, data),
  delete: (id: string) => remove(COLLECTIONS.STUDENTS, id),
};

// Subject Service
export const subjectService = {
  getAll: () => getAll<Subject>(COLLECTIONS.SUBJECTS, [orderBy('name')]),
  getById: (id: string) => getById<Subject>(COLLECTIONS.SUBJECTS, id),
  getByDepartment: (departmentId: string) =>
    getAll<Subject>(COLLECTIONS.SUBJECTS, [where('department', '==', departmentId)]),
  create: (data: Omit<Subject, 'id' | 'createdAt' | 'updatedAt'>) =>
    create<Subject>(COLLECTIONS.SUBJECTS, data),
  update: (id: string, data: Partial<Subject>) => update<Subject>(COLLECTIONS.SUBJECTS, id, data),
  delete: (id: string) => remove(COLLECTIONS.SUBJECTS, id),
};

// Room Service
export const roomService = {
  getAll: () => getAll<Room>(COLLECTIONS.ROOMS, [orderBy('roomNumber')]),
  getById: (id: string) => getById<Room>(COLLECTIONS.ROOMS, id),
  getByType: (type: string) => getAll<Room>(COLLECTIONS.ROOMS, [where('type', '==', type)]),
  create: (data: Omit<Room, 'id' | 'createdAt' | 'updatedAt'>) =>
    create<Room>(COLLECTIONS.ROOMS, data),
  update: (id: string, data: Partial<Room>) => update<Room>(COLLECTIONS.ROOMS, id, data),
  delete: (id: string) => remove(COLLECTIONS.ROOMS, id),
};

// Department Service
export const departmentService = {
  getAll: () => getAll<Department>(COLLECTIONS.DEPARTMENTS, [orderBy('name')]),
  getById: (id: string) => getById<Department>(COLLECTIONS.DEPARTMENTS, id),
  create: (data: Omit<Department, 'id' | 'createdAt' | 'updatedAt'>) =>
    create<Department>(COLLECTIONS.DEPARTMENTS, data),
  update: (id: string, data: Partial<Department>) =>
    update<Department>(COLLECTIONS.DEPARTMENTS, id, data),
  delete: (id: string) => remove(COLLECTIONS.DEPARTMENTS, id),
};

// Class Service
export const classService = {
  getAll: () => getAll<ClassGroup>(COLLECTIONS.CLASSES, [orderBy('grade'), orderBy('section')]),
  getById: (id: string) => getById<ClassGroup>(COLLECTIONS.CLASSES, id),
  create: (data: Omit<ClassGroup, 'id' | 'createdAt' | 'updatedAt'>) =>
    create<ClassGroup>(COLLECTIONS.CLASSES, data),
  update: (id: string, data: Partial<ClassGroup>) =>
    update<ClassGroup>(COLLECTIONS.CLASSES, id, data),
  delete: (id: string) => remove(COLLECTIONS.CLASSES, id),
};

// Subject Allocation Service
export const subjectAllocationService = {
  getAll: () => getAll<SubjectAllocation>(COLLECTIONS.SUBJECT_ALLOCATIONS),
  getById: (id: string) => getById<SubjectAllocation>(COLLECTIONS.SUBJECT_ALLOCATIONS, id),
  getByClass: (classId: string) =>
    getAll<SubjectAllocation>(COLLECTIONS.SUBJECT_ALLOCATIONS, [where('classId', '==', classId)]),
  getByDepartment: (departmentId: string, year?: number) => {
    const constraints: QueryConstraint[] = [where('departmentId', '==', departmentId)];
    if (year) constraints.push(where('year', '==', year));
    return getAll<SubjectAllocation>(COLLECTIONS.SUBJECT_ALLOCATIONS, constraints);
  },
  create: (data: Omit<SubjectAllocation, 'id' | 'createdAt' | 'updatedAt'>) =>
    create<SubjectAllocation>(COLLECTIONS.SUBJECT_ALLOCATIONS, data),
  update: (id: string, data: Partial<SubjectAllocation>) =>
    update<SubjectAllocation>(COLLECTIONS.SUBJECT_ALLOCATIONS, id, data),
  delete: (id: string) => remove(COLLECTIONS.SUBJECT_ALLOCATIONS, id),
};

// Time Config Service
export const timeConfigService = {
  getAll: () => getAll<TimeConfig>(COLLECTIONS.TIME_CONFIG),
  getById: (id: string) => getById<TimeConfig>(COLLECTIONS.TIME_CONFIG, id),
  getByInstitutionType: (type: string) =>
    getAll<TimeConfig>(COLLECTIONS.TIME_CONFIG, [where('institutionType', '==', type)]),
  create: (data: Omit<TimeConfig, 'id' | 'createdAt' | 'updatedAt'>) =>
    create<TimeConfig>(COLLECTIONS.TIME_CONFIG, data),
  update: (id: string, data: Partial<TimeConfig>) =>
    update<TimeConfig>(COLLECTIONS.TIME_CONFIG, id, data),
  delete: (id: string) => remove(COLLECTIONS.TIME_CONFIG, id),
};

// Timetable Service
export const timetableService = {
  getAll: () => getAll<Timetable>(COLLECTIONS.TIMETABLES, [orderBy('createdAt', 'desc')]),
  getById: (id: string) => getById<Timetable>(COLLECTIONS.TIMETABLES, id),
  getByDepartment: (departmentId: string) =>
    getAll<Timetable>(COLLECTIONS.TIMETABLES, [
      where('departmentId', '==', departmentId),
      orderBy('createdAt', 'desc'),
    ]),
  getByClass: (classId: string) =>
    getAll<Timetable>(COLLECTIONS.TIMETABLES, [
      where('classId', '==', classId),
      orderBy('createdAt', 'desc'),
    ]),
  create: (data: Omit<Timetable, 'id' | 'createdAt' | 'updatedAt'>) =>
    create<Timetable>(COLLECTIONS.TIMETABLES, data),
  update: (id: string, data: Partial<Timetable>) =>
    update<Timetable>(COLLECTIONS.TIMETABLES, id, data),
  delete: (id: string) => remove(COLLECTIONS.TIMETABLES, id),
};
