import React, { useState, useMemo, useEffect } from 'react';
import {
  Sparkles,
  Award,
  ThumbsUp,
  TrendingUp,
  AlertCircle,
  X,
  GraduationCap,
  CheckCircle2,
  HelpCircle,
  ChevronDown,
  SlidersHorizontal,
  Layers,
} from 'lucide-react';

// 🔥 FIREBASE REALTIME FIRESTORE IMPORTS
import { initializeApp, getApps, getApp } from 'firebase/app';
import { getFirestore, collectionGroup, onSnapshot } from 'firebase/firestore';

// ⚙️ FIREBASE CONFIGURATION (FROM YOUR SCREENSHOT)
const firebaseConfig = {
  apiKey: "AIzaSyAmHi20OGNteUXjuXO_weF8XKEa3KP7oYE",
  authDomain: "tuition-management-b9e2f.firebaseapp.com",
  projectId: "tuition-management-b9e2f",
  storageBucket: "tuition-management-b9e2f.firebasestorage.app",
  messagingSenderId: "634395063857",
  appId: "1:634395063857:web:24d5e9c303845557f1c710",
  measurementId: "G-5SS0BVJWTK"
};

const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();
const db = getFirestore(app);

export type CaptureCriteria = 'Weighted Score' | 'Attendance Rate' | 'Quiz Marks';

export interface StudentData {
  id: number | string;
  name: string;
  rollNo: string;
  avatar?: string;
  overallScore?: number;
  attendance?: any;
  attendanceRate?: any;
  quizScore?: any;
  quizMarks?: any;
  tag?: 'Excellent' | 'Good' | 'Average' | 'Poor';
  [key: string]: any;
}

export interface ClassAnalyticsData {
  id: string;
  name: string;
  code: string;
  students: StudentData[];
}

interface StudentCaptureSectionProps {
  classes: ClassAnalyticsData[];
  selectedClassId: string;
  onSelectClassId: (id: string) => void;
  captureCriteria?: CaptureCriteria;
  onOpenSettingsModal?: () => void;
  capturedStudents?: {
    excellent?: StudentData;
    good?: StudentData;
    average?: StudentData;
    poor?: StudentData;
  };
}

// 🛠️ FALLBACK PROPS ATTENDANCE PARSER
const parseAttendanceFromProps = (student: any): number => {
  if (!student) return 0;
  const val =
    student.attendance ??
    student.attendanceRate ??
    student.attendance_rate ??
    student.attendancePercentage ??
    student.att;

  if (typeof val === 'number') {
    if (isNaN(val)) return 0;
    return val <= 1 && val > 0 ? Math.round(val * 100) : Math.round(val);
  }

  if (typeof val === 'string') {
    const num = parseFloat(val.replace('%', '').trim());
    if (!isNaN(num)) return num <= 1 && num > 0 ? Math.round(num * 100) : Math.round(num);
  }

  return 0;
};

// 🛠️ QUIZ MARKS PARSER
const parseQuizScore = (student: any): number => {
  if (!student) return 0;

  const val =
    student.quizScore ??
    student.quiz_score ??
    student.quizMarks ??
    student.quiz_marks ??
    student.quiz ??
    student.quizzesScore ??
    student.quizPercentage ??
    student.totalQuizScore ??
    student.marks ??
    student.score ??
    student.overallScore;

  if (typeof val === 'number') {
    if (isNaN(val)) return 0;
    return val <= 1 && val > 0 ? Math.round(val * 100) : Math.round(val);
  }

  if (typeof val === 'string') {
    const num = parseFloat(val.replace('%', '').trim());
    if (!isNaN(num)) return num <= 1 && num > 0 ? Math.round(num * 100) : Math.round(num);
  }

  // Object or Map format
  const mapObj = typeof val === 'object' && val !== null && !Array.isArray(val) ? val : student.quizzes;
  if (mapObj && typeof mapObj === 'object') {
    const entries = Object.values(mapObj);
    if (entries.length > 0) {
      let obtained = 0;
      let total = 0;
      entries.forEach((q: any) => {
        if (typeof q === 'number') {
          obtained += q;
          total += 100;
        } else if (typeof q === 'object' && q !== null) {
          obtained += Number(q.marks ?? q.obtained ?? q.score ?? 0);
          total += Number(q.total ?? q.maxMarks ?? 100);
        }
      });
      if (total > 0) return Math.round((obtained / total) * 100);
    }
  }

  return 0;
};

export const StudentCaptureSection: React.FC<StudentCaptureSectionProps> = ({
  classes,
  selectedClassId,
  onSelectClassId,
  captureCriteria = 'Weighted Score',
  onOpenSettingsModal,
  capturedStudents: initialCapturedStudents,
}) => {
  const [activeFilter, setActiveFilter] = useState<CaptureCriteria>(captureCriteria);
  const [firestoreAttendanceDocs, setFirestoreAttendanceDocs] = useState<any[]>([]);

  useEffect(() => {
    setActiveFilter(captureCriteria);
  }, [captureCriteria]);

  // 🔥 FIRESTORE REALTIME SYNC FOR ATTENDANCE
  useEffect(() => {
    try {
      const unsub = onSnapshot(
        collectionGroup(db, 'attendance'),
        (snapshot) => {
          const docs: any[] = [];
          snapshot.forEach((doc) => {
            docs.push({ id: doc.id, ...doc.data() });
          });
          setFirestoreAttendanceDocs(docs);
        },
        (error) => {
          console.warn("Firestore listener warning:", error);
        }
      );
      return () => unsub();
    } catch (e) {
      console.error("Firestore initialization error:", e);
    }
  }, []);

  const [selectedStudent, setSelectedStudent] = useState<{
    student: StudentData;
    category: 'Excellent' | 'Good' | 'Average' | 'Poor';
    calculatedScore: number;
    attendance: number;
    quizScore: number;
  } | null>(null);

  // 🛠️ DYNAMIC ATTENDANCE CALCULATOR (FIRESTORE LIVE + PROPS FALLBACK)
  const getCalculatedAttendance = (student: StudentData, classId: string): number => {
    if (!student) return 0;

    const stId = String(student.id || '').trim();
    const stRoll = String(student.rollNo || '').trim();

    // 1. Filter live attendance documents for current class
    const matchingClassDocs = firestoreAttendanceDocs.filter((doc) => {
      if (!doc) return false;
      const cId = String(doc.classId || '').trim();
      return cId === String(classId).trim();
    });

    if (matchingClassDocs.length > 0) {
      let totalLectures = matchingClassDocs.length;
      let presentCount = 0;

      matchingClassDocs.forEach((doc) => {
        const map = doc.attendanceMap || doc.attendance_map || doc.attendance;
        if (map && typeof map === 'object') {
          // Check if student ID exists in attendanceMap
          if (stId && map[stId] !== undefined) {
            if (map[stId] === true || map[stId] === 'present' || map[stId] === 1) presentCount++;
          }
          // Check by roll number key
          else if (stRoll && map[stRoll] !== undefined) {
            if (map[stRoll] === true || map[stRoll] === 'present' || map[stRoll] === 1) presentCount++;
          }
          // Search keys dynamically
          else {
            const foundKey = Object.keys(map).find((k) => k === stId || k === stRoll);
            if (foundKey && (map[foundKey] === true || map[foundKey] === 'present' || map[foundKey] === 1)) {
              presentCount++;
            }
          }
        }
      });

      if (totalLectures > 0) {
        return Math.round((presentCount / totalLectures) * 100);
      }
    }

    // 2. Fallback to Student Object Props
    return parseAttendanceFromProps(student);
  };

  // Alphabetical Class Sorting
  const sortedClasses = useMemo(() => {
    return [...classes].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    );
  }, [classes]);

  const visibleClasses = sortedClasses.slice(0, 3);
  const remainingClasses = sortedClasses.slice(3);
  const isSelectedInRemaining = remainingClasses.some((c) => c.id === selectedClassId);

  // Dynamic Realtime Student Processor
  const dynamicCapturedStudents = useMemo(() => {
    const activeClass = classes.find((c) => c.id === selectedClassId);

    if (!activeClass || !activeClass.students || activeClass.students.length === 0) {
      return {
        excellent: initialCapturedStudents?.excellent,
        good: initialCapturedStudents?.good,
        average: initialCapturedStudents?.average,
        poor: initialCapturedStudents?.poor,
      };
    }

    const processed = activeClass.students.map((st) => {
      const attendance = getCalculatedAttendance(st, selectedClassId);
      const quizScore = parseQuizScore(st);

      let calculatedScore = 0;
      if (activeFilter === 'Attendance Rate') {
        calculatedScore = attendance;
      } else if (activeFilter === 'Quiz Marks') {
        calculatedScore = quizScore;
      } else {
        // Weighted Score Formula: 40% Attendance + 60% Quiz Marks
        calculatedScore = Math.round(attendance * 0.4 + quizScore * 0.6);
      }

      return {
        ...st,
        extractedAttendance: attendance,
        extractedQuizScore: quizScore,
        calculatedScore,
      };
    }).sort((a, b) => b.calculatedScore - a.calculatedScore);

    const total = processed.length;

    return {
      excellent: processed[0],
      good: processed[Math.min(1, Math.floor(total * 0.25))],
      average: processed[Math.min(2, Math.floor(total * 0.55))],
      poor: processed[Math.max(0, total - 1)],
    };
  }, [classes, selectedClassId, activeFilter, initialCapturedStudents, firestoreAttendanceDocs]);

  const getCategoryColor = (category: string) => {
    switch (category) {
      case 'Excellent':
        return 'emerald';
      case 'Good':
        return 'blue';
      case 'Average':
        return 'amber';
      case 'Poor':
        return 'rose';
      default:
        return 'orange';
    }
  };

  return (
    <div className="relative group w-full">
      {/* 🌟 OUTER GLOW EFFECT */}
      <div className="absolute -inset-1 rounded-[32px] bg-gradient-to-r from-orange-500 via-amber-400 to-orange-600 blur-md opacity-85 group-hover:opacity-100 animate-pulse transition duration-1000" />

      {/* 🛡️ MAIN CONTAINER */}
      <div className="relative bg-white dark:bg-[#0b0f19] border-2 border-orange-500 rounded-3xl p-5 shadow-[0_0_25px_rgba(249,115,22,0.35)] space-y-4">
        
        {/* HEADER & CLASS TOGGLE SWITCHER */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 border-b border-slate-100 dark:border-slate-800 pb-3">
          <div>
            <div 
              onClick={onOpenSettingsModal}
              className="inline-flex items-center gap-1 text-[10px] font-black uppercase text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-orange-950/40 px-2.5 py-0.5 rounded-full mb-1 border border-orange-200 dark:border-orange-900/50 cursor-pointer hover:bg-orange-100 dark:hover:bg-orange-900/60 transition-colors"
            >
              <Sparkles className="h-3 w-3 text-orange-500" /> Class Student Capture
            </div>
            <h3 className="text-sm font-black text-slate-900 dark:text-white">
              Class Category Representatives (4 Students)
            </h3>
            <p className="text-[10px] text-slate-400 font-bold flex items-center gap-1 mt-0.5">
              Captured based on:{' '}
              <span className="text-orange-500 font-black uppercase bg-orange-500/10 px-1.5 py-0.5 rounded border border-orange-500/20">
                {activeFilter}
              </span>
            </p>
          </div>

          {/* CLASS SWITCHER */}
          <div className="bg-slate-50 dark:bg-slate-900 p-2 rounded-2xl border border-slate-200 dark:border-slate-800 flex flex-col gap-2 w-full sm:w-80">
            <div className="grid grid-cols-3 gap-1.5 w-full">
              {visibleClasses.map((cls) => {
                const isActive = cls.id === selectedClassId;
                return (
                  <button
                    key={cls.id}
                    type="button"
                    onClick={() => onSelectClassId(cls.id)}
                    className={`w-full py-2 px-2 rounded-xl text-xs font-black transition-all text-center truncate ${
                      isActive
                        ? 'bg-orange-500 text-white shadow-md'
                        : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 hover:bg-slate-200/50 dark:hover:bg-slate-800/50'
                    }`}
                  >
                    {cls.name}
                  </button>
                );
              })}
            </div>

            {remainingClasses.length > 0 && (
              <div className="relative w-full">
                <select
                  value={isSelectedInRemaining ? selectedClassId : ''}
                  onChange={(e) => {
                    if (e.target.value) onSelectClassId(e.target.value);
                  }}
                  className={`w-full appearance-none px-3 py-2 pr-8 rounded-xl text-xs font-black transition-all cursor-pointer focus:outline-none border text-left ${
                    isSelectedInRemaining
                      ? 'bg-orange-500 text-white border-orange-500 shadow-md'
                      : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:border-orange-500/50'
                  }`}
                >
                  <option value="" disabled className="bg-white dark:bg-slate-900 text-slate-400 font-bold">
                    {isSelectedInRemaining
                      ? `Selected: ${sortedClasses.find((c) => c.id === selectedClassId)?.name}`
                      : `+ More (${remainingClasses.length})`}
                  </option>
                  {remainingClasses.map((cls) => (
                    <option
                      key={cls.id}
                      value={cls.id}
                      className="bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 font-bold py-1"
                    >
                      🎓 {cls.name}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  className={`absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 pointer-events-none transition-colors ${
                    isSelectedInRemaining ? 'text-white' : 'text-orange-500'
                  }`}
                />
              </div>
            )}
          </div>
        </div>

        {/* 🎛️ FILTER SELECTOR TABS */}
        <div className="bg-slate-100 dark:bg-[#070b13] p-1.5 rounded-2xl border border-slate-200 dark:border-slate-800 flex items-center justify-between gap-1 overflow-x-auto">
          <div className="flex items-center gap-1 text-[10px] font-black uppercase text-slate-400 px-2 py-1 shrink-0">
            <SlidersHorizontal className="h-3.5 w-3.5 text-orange-500" /> Filter:
          </div>

          <div className="flex items-center gap-1.5 w-full justify-end">
            <button
              type="button"
              onClick={() => setActiveFilter('Weighted Score')}
              className={`px-3 py-1.5 rounded-xl text-[10px] font-black transition-all flex items-center gap-1.5 whitespace-nowrap ${
                activeFilter === 'Weighted Score'
                  ? 'bg-gradient-to-r from-orange-500 to-amber-500 text-white shadow-md shadow-orange-500/20'
                  : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 hover:bg-slate-200/60 dark:hover:bg-slate-800/60'
              }`}
            >
              <Layers className="h-3 w-3" />
              <span>Weighted Score</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveFilter('Attendance Rate')}
              className={`px-3 py-1.5 rounded-xl text-[10px] font-black transition-all flex items-center gap-1.5 whitespace-nowrap ${
                activeFilter === 'Attendance Rate'
                  ? 'bg-emerald-500 text-white shadow-md shadow-emerald-500/20'
                  : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 hover:bg-slate-200/60 dark:hover:bg-slate-800/60'
              }`}
            >
              <CheckCircle2 className="h-3 w-3" />
              <span>Attendance Rate</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveFilter('Quiz Marks')}
              className={`px-3 py-1.5 rounded-xl text-[10px] font-black transition-all flex items-center gap-1.5 whitespace-nowrap ${
                activeFilter === 'Quiz Marks'
                  ? 'bg-blue-500 text-white shadow-md shadow-blue-500/20'
                  : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 hover:bg-slate-200/60 dark:hover:bg-slate-800/60'
              }`}
            >
              <GraduationCap className="h-3 w-3" />
              <span>Quiz Marks</span>
            </button>
          </div>
        </div>

        {/* 4 CARDS GRID */}
        <div className="grid grid-cols-2 gap-3">
          {(['excellent', 'good', 'average', 'poor'] as const).map((catKey) => {
            const st = dynamicCapturedStudents[catKey];
            const categoryTitle = catKey.charAt(0).toUpperCase() + catKey.slice(1);
            const att = st ? getCalculatedAttendance(st, selectedClassId) : 0;
            const quiz = st ? parseQuizScore(st) : 0;
            const displayScore = st?.calculatedScore ?? (st ? Math.round(att * 0.4 + quiz * 0.6) : 0);

            const categoryIcons = {
              excellent: <Award className="h-3 w-3" />,
              good: <ThumbsUp className="h-3 w-3" />,
              average: <TrendingUp className="h-3 w-3" />,
              poor: <AlertCircle className="h-3 w-3" />,
            };

            const borderColors = {
              excellent: 'border-emerald-200 dark:border-emerald-900/40 hover:border-emerald-500',
              good: 'border-blue-200 dark:border-blue-900/40 hover:border-blue-500',
              average: 'border-amber-200 dark:border-amber-900/40 hover:border-amber-500',
              poor: 'border-rose-200 dark:border-rose-900/40 hover:border-rose-500',
            };

            const bgBadges = {
              excellent: 'bg-emerald-500 text-emerald-600 dark:text-emerald-400',
              good: 'bg-blue-500 text-blue-600 dark:text-blue-400',
              average: 'bg-amber-500 text-amber-600 dark:text-amber-400',
              poor: 'bg-rose-500 text-rose-600 dark:text-rose-400',
            };

            return (
              <div
                key={catKey}
                onClick={() =>
                  st &&
                  setSelectedStudent({
                    student: st,
                    category: categoryTitle as any,
                    calculatedScore: displayScore,
                    attendance: att,
                    quizScore: quiz,
                  })
                }
                className={`bg-white dark:bg-[#070b13] border ${borderColors[catKey]} rounded-2xl p-3.5 shadow-sm space-y-2 relative overflow-hidden cursor-pointer hover:scale-[1.02] active:scale-95 transition-all group/card`}
              >
                <div className="flex items-center justify-between">
                  <span className={`text-[10px] font-black uppercase ${bgBadges[catKey].split(' ')[0]} text-white px-2 py-0.5 rounded-md flex items-center gap-1 shadow-sm`}>
                    {categoryIcons[catKey]} {categoryTitle}
                  </span>
                  <span className={`text-[10px] font-black ${bgBadges[catKey].split(' ').slice(1).join(' ')}`}>
                    {displayScore}%
                  </span>
                </div>
                <div className="flex items-center gap-2.5 pt-1">
                  <img
                    src={
                      st?.avatar ||
                      'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&q=80&w=200'
                    }
                    alt=""
                    className="h-9 w-9 rounded-full object-cover border-2 border-orange-500/40"
                  />
                  <div className="truncate">
                    <p className="text-xs font-black truncate group-hover/card:text-orange-500 transition-colors text-slate-900 dark:text-slate-100">
                      {st?.name || 'No Student'}
                    </p>
                    <p className="text-[10px] text-slate-400 font-bold">
                      Roll: {st?.rollNo || 'N/A'}
                    </p>
                  </div>
                </div>
                <div className="flex justify-between text-[9px] font-black text-slate-400 pt-1 border-t border-slate-100 dark:border-slate-800">
                  <span>Quiz: {quiz}%</span>
                  <span>Att: {att}%</span>
                </div>
              </div>
            );
          })}
        </div>

        {/* CLICK POPUP MODAL CARD */}
        {selectedStudent && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md p-4 animate-in fade-in duration-200">
            <div className="w-full max-w-sm bg-white dark:bg-[#0c1222] border border-slate-200 dark:border-slate-800 rounded-3xl p-6 shadow-2xl space-y-5 text-slate-900 dark:text-slate-100 relative overflow-hidden">
              <div
                className={`absolute top-0 left-0 right-0 h-2 bg-${getCategoryColor(
                  selectedStudent.category
                )}-500`}
              />

              <button
                onClick={() => setSelectedStudent(null)}
                className="absolute top-4 right-4 p-1.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors"
              >
                <X className="h-4 w-4" />
              </button>

              <div className="flex items-center gap-3 pt-2">
                <img
                  src={
                    selectedStudent.student.avatar ||
                    'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&q=80&w=200'
                  }
                  alt=""
                  className="h-14 w-14 rounded-full object-cover border-2 border-orange-500/40 shadow-md"
                />
                <div>
                  <span
                    className={`text-[9px] font-black uppercase px-2 py-0.5 rounded-md text-white bg-${getCategoryColor(
                      selectedStudent.category
                    )}-500`}
                  >
                    {selectedStudent.category} Category
                  </span>
                  <h3 className="text-base font-black mt-1">
                    {selectedStudent.student.name}
                  </h3>
                  <p className="text-xs text-slate-400 font-bold">
                    Roll No: {selectedStudent.student.rollNo}
                  </p>
                </div>
              </div>

              <div className="space-y-3 pt-1">
                {/* Attendance Bar */}
                <div className="bg-slate-50 dark:bg-[#070b13] p-3.5 rounded-2xl border border-slate-100 dark:border-slate-800 space-y-1.5">
                  <div className="flex justify-between items-center text-xs font-black">
                    <span className="text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                      <CheckCircle2 className="h-4 w-4 text-emerald-500" /> Attendance Rate
                    </span>
                    <span className="text-emerald-500 text-sm">
                      {selectedStudent.attendance}%
                    </span>
                  </div>
                  <div className="w-full bg-slate-200 dark:bg-slate-800 h-2 rounded-full overflow-hidden">
                    <div
                      className="bg-emerald-500 h-full rounded-full transition-all duration-500"
                      style={{
                        width: `${selectedStudent.attendance}%`,
                      }}
                    />
                  </div>
                </div>

                {/* Quiz Marks Bar */}
                <div className="bg-slate-50 dark:bg-[#070b13] p-3.5 rounded-2xl border border-slate-100 dark:border-slate-800 space-y-1.5">
                  <div className="flex justify-between items-center text-xs font-black">
                    <span className="text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                      <GraduationCap className="h-4 w-4 text-orange-500" /> Quiz Marks
                    </span>
                    <span className="text-orange-500 text-sm">
                      {selectedStudent.quizScore}%
                    </span>
                  </div>
                  <div className="w-full bg-slate-200 dark:bg-slate-800 h-2 rounded-full overflow-hidden">
                    <div
                      className="bg-orange-500 h-full rounded-full transition-all duration-500"
                      style={{
                        width: `${selectedStudent.quizScore}%`,
                      }}
                    />
                  </div>
                </div>

                {/* Active Filter Score Banner */}
                <div className="bg-orange-500/10 border border-orange-500/20 p-3 rounded-2xl flex items-center justify-between text-xs font-black text-orange-600 dark:text-orange-400">
                  <span className="flex items-center gap-1.5">
                    <HelpCircle className="h-4 w-4" /> Active Filter Score
                  </span>
                  <span className="text-sm font-black">
                    {selectedStudent.calculatedScore}%
                  </span>
                </div>
              </div>

              <button
                onClick={() => setSelectedStudent(null)}
                className="w-full py-2.5 rounded-2xl bg-orange-500 hover:bg-orange-600 active:scale-95 text-white font-black text-xs shadow-lg shadow-orange-500/30 transition-all"
              >
                Done / Close
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
