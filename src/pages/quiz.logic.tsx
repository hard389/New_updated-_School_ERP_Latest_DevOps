import type { Timestamp } from 'firebase/firestore';

export type StudentScore = {
  id: string;
  name: string;
  rollNo: string;
  gender: string;
  marksObtained: number | string;
  [key: string]: unknown;
};
export type ClassItem = { id: string; className: string; classCode: string; students: StudentScore[] };
export type QuizRecord = {
  id: string; topic: string; totalMarks: number; date: string; monthKey: string;
  createdAt: number; studentScores: StudentScore[]; averageScore: number;
  unidentifiableScoreCount?: number; updatedAt?: number; updatedByUid?: string;
  revisionSignature: string;
};

/** Must match the exact normalized-email key used by RegisterPage and Firestore Rules. */
export function normalizeEmailId(email: string | null | undefined): string {
  // Firestore document IDs may contain dots; do not mutate the email beyond canonical case/space.
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}
export function verifyTeacherTenantProfile(data: Record<string, unknown>, identity: {uid:string; email:string|null}) {
  const uid = typeof data.uid === 'string' ? data.uid : typeof data.authUid === 'string' ? data.authUid : '';
  const email = typeof data.email === 'string' ? data.email.trim().toLowerCase() : '';
  const expectedEmail = identity.email?.trim().toLowerCase() ?? '';
  if (!uid || uid !== identity.uid) return { ok:false as const, reason:'PROFILE_UID_MISMATCH' };
  if (!email || !expectedEmail || email !== expectedEmail) return { ok:false as const, reason:'PROFILE_EMAIL_MISMATCH' };
  return { ok:true as const };
}
// Tenant path contract assumed by this page: users/{normalizedEmail}/classes/{classId}/quizzes/{quizId}.
// Confirm this against RegisterPage, class management, and Firestore Rules before deployment.
export const getClassCollectionPath = (tenantId:string) => ['users', tenantId, 'classes'];
export const getQuizCollectionPath = (tenantId:string, classId:string) => ['users', tenantId, 'classes', classId, 'quizzes'];

export function extractStudents(raw: unknown): {format:'array'|'map'|'unsupported'; students:StudentScore[]; skipped:number} {
  if (Array.isArray(raw)) {
    const students:StudentScore[]=[]; const seen=new Set<string>(); let skipped=0;
    for (const item of raw) {
      if (!item || typeof item !== 'object') { skipped++; continue; }
      const r=item as Record<string,unknown>; const id=String(r.id ?? r.studentId ?? '').trim();
      if (!id || seen.has(id)) { skipped++; continue; } seen.add(id);
      students.push({ ...r, id, name:typeof r.name==='string'?r.name:'Unknown student', rollNo:String(r.rollNo ?? r.rollNumber ?? ''), gender:typeof r.gender==='string'?r.gender:'', marksObtained:'' } as StudentScore);
    }
    return {format:'array',students,skipped};
  }
  if (raw && typeof raw==='object') {
    const students:StudentScore[]=[]; const seen=new Set<string>(); let skipped=0;
    for (const [key,value] of Object.entries(raw as Record<string,unknown>)) {
      if (!value || typeof value!=='object') { skipped++; continue; }
      const r=value as Record<string,unknown>; const id=String(r.id ?? r.studentId ?? key).trim();
      if (!id || seen.has(id)) { skipped++; continue; } seen.add(id);
      students.push({ ...r, id, name:typeof r.name==='string'?r.name:'Unknown student', rollNo:String(r.rollNo ?? r.rollNumber ?? ''), gender:typeof r.gender==='string'?r.gender:'', marksObtained:'' } as StudentScore);
    }
    return {format:'map',students,skipped};
  }
  return {format:'unsupported',students:[],skipped:0};
}
export function compareStudentOrder(a:StudentScore,b:StudentScore) {
  const an=Number(a.rollNo), bn=Number(b.rollNo);
  if (a.rollNo!=='' && b.rollNo!=='' && Number.isFinite(an) && Number.isFinite(bn) && an!==bn) return an-bn;
  return String(a.rollNo).localeCompare(String(b.rollNo),undefined,{numeric:true}) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}
export function buildRosterScores(roster:StudentScore[], saved:StudentScore[] = []) {
  const byId=new Map(saved.map(s=>[s.id,s]));
  return roster.map(s=>({ ...s, ...(byId.get(s.id) ?? {}), id:s.id, name:s.name, rollNo:s.rollNo, gender:s.gender, marksObtained:byId.has(s.id) ? byId.get(s.id)!.marksObtained : '' }));
}
export function parseMark(value:unknown):{kind:'empty'|'invalid'|'valid';value?:number} {
  if (value === '' || value === null || value === undefined) return {kind:'empty'};
  if (typeof value==='string' && !value.trim()) return {kind:'empty'};
  if (!(typeof value==='number' || typeof value==='string')) return {kind:'invalid'};
  const n=typeof value==='number'?value:Number(value);
  return Number.isFinite(n) && n>=0 ? {kind:'valid',value:n} : {kind:'invalid'};
}
export function validateQuizInput(topic:string,totalMarks:unknown,rows:StudentScore[],roster:StudentScore[]) {
  const total=typeof totalMarks==='number'?totalMarks:Number(totalMarks);
  if (!topic.trim()) return {valid:false,error:'Enter a quiz topic.'};
  if (!Number.isFinite(total)||total<=0) return {valid:false,error:'Total marks must be a valid number greater than zero.'};
  const rosterIds=roster.map(s=>s.id); const uniqueRoster=new Set(rosterIds);
  if (uniqueRoster.size!==rosterIds.length || rosterIds.some(id=>!id)) return {valid:false,error:'The class roster contains missing or duplicate student IDs.'};
  const ids=rows.map(s=>s.id);
  if (ids.length!==rosterIds.length || new Set(ids).size!==ids.length || ids.some(id=>!uniqueRoster.has(id))) return {valid:false,error:'Student rows do not match the current class roster.'};
  const rosterById=new Map(roster.map(s=>[s.id,s])); const scores:StudentScore[]=[];
  for (const row of rows) {
    const mark=parseMark(row.marksObtained);
    if (mark.kind==='invalid') return {valid:false,error:`Invalid marks for ${row.name}. Use a number between 0 and ${total}.`};
    if (mark.kind==='valid' && mark.value!>total) return {valid:false,error:`Marks for ${row.name} cannot exceed total marks (${total}).`};
    const actual=rosterById.get(row.id)!;
    scores.push({...row, id:actual.id, name:actual.name, rollNo:actual.rollNo, gender:actual.gender, marksObtained:mark.kind==='empty'?'':mark.value!});
  }
  return {valid:true,totalMarks:total,scores};
}
export function calculateAverageScore(rows:StudentScore[],totalMarks:number) {
  if (!Number.isFinite(totalMarks)||totalMarks<=0) return 0;
  const values=rows.map(s=>parseMark(s.marksObtained)).filter(x=>x.kind==='valid').map(x=>x.value!).filter(x=>x<=totalMarks);
  return values.length ? Math.round((values.reduce((a,b)=>a+b,0)/values.length)*100)/100 : 0;
}
export function getCategoryPerformers(rows:StudentScore[],totalMarks:number) {
  if (!Number.isFinite(totalMarks)||totalMarks<=0) return [];
  return rows.map(s=>{ const p=parseMark(s.marksObtained); const ratio=p.kind==='valid'?p.value!/totalMarks:null;
    const category=ratio===null?'No Score':ratio>=0.8?'Excellent':ratio>=0.6?'Good':ratio>=0.4?'Average':'Poor';
    return {...s, category, numericMarks:ratio===null?-1:p.value!};
  }).filter(s=>s.numericMarks>=0).sort((a,b)=>b.numericMarks-a.numericMarks || compareStudentOrder(a,b)).slice(0,4);
}
export function findOrphanedStudentIds(roster:StudentScore[],rows:StudentScore[]) { const ids=new Set(roster.map(s=>s.id)); return rows.filter(s=>!ids.has(s.id)).map(s=>s.id); }
export function normalizeStoredScores(raw:unknown):StudentScore[] {
  if (!Array.isArray(raw)) return [];
  const seen=new Set<string>(); const out:StudentScore[]=[];
  for(const item of raw){ if(!item||typeof item!=='object') continue; const r=item as Record<string,unknown>; const id=typeof r.id==='string'?r.id.trim():''; if(!id||seen.has(id)) continue; seen.add(id);
    const mark=parseMark(r.marksObtained);
    out.push({...r,id,name:typeof r.name==='string'?r.name:'Unknown student',rollNo:String(r.rollNo??''),gender:typeof r.gender==='string'?r.gender:'',marksObtained:mark.kind==='valid'?mark.value!:''} as StudentScore);
  } return out;
}
export function getCurrentAndPrevMonthKeys(now=new Date()) { const key=(d:Date)=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; const prev=new Date(now.getFullYear(),now.getMonth()-1,1); return {currentMonthKey:key(now),prevMonthKey:key(prev)}; }
export function formatDateLabel(date:Date) { return `${String(date.getDate()).padStart(2,'0')}/${String(date.getMonth()+1).padStart(2,'0')}/${date.getFullYear()}`; }
export function timestampToMillis(value:unknown):number|null { if(typeof value==='number'&&Number.isFinite(value)) return value; if(value instanceof Date) return value.getTime(); if(value&&typeof value==='object'&&'toMillis' in value&&typeof (value as {toMillis?:unknown}).toMillis==='function') return (value as Timestamp).toMillis(); if(typeof value==='string'){const n=Date.parse(value);return Number.isFinite(n)?n:null;} return null; }
export function resolveQuizMonthKey(date:string,createdAt:unknown,monthKey:unknown):string|null {
  if(typeof monthKey==='string'&&/^\d{4}-\d{2}$/.test(monthKey)) return monthKey;
  const m=date.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); if(m){const month=Number(m[2]);if(month>=1&&month<=12)return `${m[3]}-${String(month).padStart(2,'0')}`;}
  const ms=timestampToMillis(createdAt); if(ms!==null){const d=new Date(ms);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;} return null;
}
export function quizRevisionSignature(data:Record<string,unknown>) {
  const canonical=(v:unknown):unknown=>{if(v===null||typeof v!=='object')return v;if(Array.isArray(v))return v.map(canonical);const o=v as Record<string,unknown>;return Object.fromEntries(Object.keys(o).sort().map(k=>[k,canonical(o[k])]));};
  return JSON.stringify(canonical(data));
}
export function acquireSubmissionLock(ref:{current:boolean}) { if(ref.current)return false;ref.current=true;return true; }
export function releaseSubmissionLock(ref:{current:boolean}) { ref.current=false; }
export function getFirestoreErrorMessage(error:unknown,action:string) { const code=(error as {code?:string})?.code; if(code==='permission-denied')return `You do not have permission to ${action}.`;if(code==='unavailable'||code==='deadline-exceeded')return `Could not ${action} because Firestore is unavailable. Check your connection and try again.`;if(code==='failed-precondition')return `Could not ${action} because Firestore requires an index or the operation is not currently available.`;return `Unable to ${action}. Please try again.`; }
