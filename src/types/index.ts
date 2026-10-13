// Institution Types
export type InstitutionType = 'school' | 'college' | 'university';

// Student
export interface Student {
  id: string;
  studentId: string; // PRN / University ID
  name: string;
  class?: string; // For schools
  year?: number; // For colleges/universities
  section?: string;
  department?: string; // For colleges/universities
  createdAt: Date;
  updatedAt: Date;
}

// Faculty
export interface Faculty {
  id: string;
  facultyId: string;
  name: string;
  email: string;
  phone?: string;
  department: string;
  subjects: string[]; // Subject IDs
  maxHoursPerWeek: number;
  availability?: DayAvailability[];
  createdAt: Date;
  updatedAt: Date;
}

export interface DayAvailability {
  day: string;
  slots: string[]; // Time slot IDs that are available
}

// Subject
export interface Subject {
  id: string;
  code: string;
  name: string;
  type: 'theory' | 'lab' | 'practical';
  weeklyHours: number;
  department: string;
  labRequired: boolean;
  continuousSlots?: number; // For labs - number of continuous slots needed
  createdAt: Date;
  updatedAt: Date;
}

// Classroom
export interface Room {
  id: string;
  roomNumber: string;
  name: string;
  type: 'classroom' | 'lab' | 'auditorium' | 'seminar';
  capacity: number;
  building?: string;
  floor?: number;
  facilities?: string[];
  createdAt: Date;
  updatedAt: Date;
}

// Department
export interface Department {
  id: string;
  name: string;
  code: string;
  headOfDepartment?: string;
  createdAt: Date;
  updatedAt: Date;
}

// Class (for schools)
export interface ClassGroup {
  id: string;
  name: string; // e.g., "10th A", "12th B"
  grade: number;
  section: string;
  classTeacherId?: string;
  studentCount: number;
  createdAt: Date;
  updatedAt: Date;
}

// Subject Allocation
export interface SubjectAllocation {
  id: string;
  subjectId: string;
  facultyId: string;
  classId?: string; // For schools
  departmentId?: string; // For colleges
  year?: number;
  semester?: number;
  createdAt: Date;
  updatedAt: Date;
}

// Time Configuration
export interface TimeConfig {
  id: string;
  institutionType: InstitutionType;
  lectureDuration: number; // in minutes
  labDuration: number; // in minutes
  workingDays: string[];
  startTime: string; // HH:MM format
  endTime: string; // HH:MM format
  shortBreak: {
    startTime: string;
    duration: number; // in minutes
  };
  lunchBreak: {
    startTime: string;
    duration: number; // in minutes
  };
  createdAt: Date;
  updatedAt: Date;
}

// Time Slot
export interface TimeSlot {
  id: string;
  startTime: string;
  endTime: string;
  type: 'lecture' | 'lab' | 'break' | 'lunch';
  slotNumber: number;
}

// Timetable Entry
export interface TimetableEntry {
  id: string;
  day: string;
  timeSlotId: string;
  timeSlot: TimeSlot;
  subjectId: string;
  subject?: Subject;
  facultyId: string;
  faculty?: Faculty;
  roomId: string;
  room?: Room;
  classId?: string;
  departmentId?: string;
  year?: number;
  semester?: number;
  isLocked: boolean;
}

// Generated Timetable
export interface Timetable {
  id: string;
  name: string;
  institutionType?: InstitutionType;
  classId?: string;
  departmentId?: string;
  year?: number;
  semester?: number;
  entries: TimetableEntry[];
  status: 'draft' | 'published' | 'archived';
  generatedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

// Conflict
export interface Conflict {
  type: 'faculty' | 'room' | 'time' | 'subject';
  message: string;
  entry1: TimetableEntry;
  entry2?: TimetableEntry;
}
