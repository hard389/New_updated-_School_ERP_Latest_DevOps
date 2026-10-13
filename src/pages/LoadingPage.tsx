import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '@/lib/firebase';
import { Sun, Moon, Sparkles } from 'lucide-react';
import { startLoadingPageAuthGuard } from './LoadingPage.auth';

export default function LoadingPage() {
  const navigate = useNavigate();
  // State to manage dark/light premium transition
  const [isDark, setIsDark] = useState(true);

  useEffect(() => {
    // Dynamically toggle document class for global system consistency
    if (isDark) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDark]);

  // Wait for Firebase Auth, then verify the tenant-owned teacher profile before routing.
  // The gate's timers/observer are all cleaned up when the page unmounts.
  useEffect(() => {
    return startLoadingPageAuthGuard({
      isAvailable: Boolean(auth && db),
      observeAuth: (onUser, onError) => onAuthStateChanged(auth, onUser, onError),
      getCurrentUser: () => auth.currentUser,
      readTeacherProfile: (normalizedEmail) => getDoc(doc(db, 'users', normalizedEmail)),
      navigate,
    });
  }, [navigate]);

  return (
    <div className={`min-h-screen flex flex-col items-center justify-center relative overflow-hidden transition-colors duration-700 ease-in-out ${
      isDark 
        ? 'bg-gradient-to-b from-[#0B1224] via-[#0F172A] to-[#0B1224]' 
        : 'bg-gradient-to-b from-[#F8FAFC] via-[#F1F5F9] to-[#E2E8F0]'
    }`}>
      
      {/* --- MODERN PREMIUM DAY/NIGHT TOGGLE (Top Right) --- */}
      <div className="absolute top-6 right-6 z-50 flex items-center gap-3">
        <span className={`text-xs font-bold tracking-widest uppercase transition-colors duration-300 ${
          isDark ? 'text-orange-400/70' : 'text-slate-500'
        }`}>
          {isDark ? 'Night' : 'Day'}
        </span>
        <button
          onClick={() => setIsDark(!isDark)}
          type="button"
          className={`relative w-16 h-9 rounded-full p-1 transition-all duration-500 shadow-lg focus:outline-none border ${
            isDark 
              ? 'bg-[#131E35] border-orange-500/30 shadow-[inset_0_2px_4px_rgba(0,0,0,0.4)]' 
              : 'bg-slate-200 border-slate-300 shadow-[inset_0_2px_4px_rgba(0,0,0,0.05)]'
          }`}
        >
          {/* Sliding Knob */}
          <div className={`w-7 h-7 rounded-full flex items-center justify-center transform transition-all duration-500 ease-out shadow-md ${
            isDark 
              ? 'translate-x-7 bg-gradient-to-r from-orange-500 to-amber-500 text-white ring-2 ring-orange-500/30' 
              : 'translate-x-0 bg-white text-slate-600 ring-2 ring-slate-100'
          }`}>
            {isDark ? (
              <Moon className="w-3.5 h-3.5 fill-white stroke-white animate-pulse" />
            ) : (
              <Sun className="w-3.5 h-3.5 text-amber-500" />
            )}
          </div>
        </button>
      </div>

      {/* --- AMBIENT GLOW EFFECTS (Matching Login Screen Deep Vibes) --- */}
      {/* Top Right Luxury Orb */}
      <div className={`absolute top-0 right-0 w-[500px] h-[500px] rounded-full blur-[130px] -translate-y-1/4 translate-x-1/4 transition-all duration-1000 ${
        isDark ? 'bg-orange-500/10' : 'bg-orange-400/10'
      }`} />
      
      {/* Bottom Left Luxury Orb */}
      <div className={`absolute bottom-0 left-0 w-[450px] h-[450px] rounded-full blur-[130px] translate-y-1/4 -translate-x-1/4 transition-all duration-1000 ${
        isDark ? 'bg-[#1E293B]/40' : 'bg-slate-300/30'
      }`} />

      {/* Center Background Radial Dynamic Glow */}
      <div className={`absolute inset-0 pointer-events-none transition-opacity duration-700 ${
        isDark 
          ? 'bg-[radial-gradient(circle_at_center,rgba(249,115,22,0.04),transparent_65%)]' 
          : 'bg-[radial-gradient(circle_at_center,rgba(249,115,22,0.02),transparent_60%)]'
      }`} />

      {/* --- MAIN INTERACTIVE CONTAINER --- */}
      <div className="relative z-10 flex flex-col items-center max-w-sm px-4 text-center">
        
        {/* Modern Logo Container matching Teacher Portal styling */}
        <div className="relative mb-8 group">
          {/* Subtle Outer Neon Aura */}
          <div className={`absolute -inset-3 rounded-2xl opacity-40 blur-xl transition duration-1000 animate-pulse ${
            isDark ? 'bg-orange-500/30' : 'bg-orange-400/20'
          }`} />
          
          {/* Logo Card Panel */}
          <div className={`relative p-5 rounded-2xl border transition-all duration-700 ${
            isDark 
              ? 'bg-[#131E35] border-slate-700/60 shadow-[0_20px_40px_rgba(0,0,0,0.4)]' 
              : 'bg-white border-slate-200 shadow-[0_20px_40px_rgba(15,23,42,0.05)]'
          }`}>
            <div className="w-36 h-36 md:w-40 md:h-40 flex items-center justify-center">
              <img
                src="/ChatGPT Image Jul 20, 2026, 05_05_41 PM.png"
                alt="EduTrack Logo"
                className="w-full h-full object-contain rounded-xl drop-shadow-md transform transition-transform duration-500 group-hover:scale-105"
              />
            </div>
          </div>
        </div>

        {/* Brand Header with Rich Gradient Typography */}
        <div className="flex items-center justify-center gap-2 mb-2">
          <Sparkles className={`w-4 h-4 ${isDark ? 'text-orange-400' : 'text-orange-500'} animate-pulse`} />
          <h1 className={`text-4xl font-extrabold tracking-tight bg-gradient-to-r from-white via-orange-400 to-amber-500 bg-clip-text text-transparent drop-shadow-sm ${
            !isDark && 'from-slate-800 via-orange-600 to-amber-600'
          }`}>
            EduTrack
          </h1>
          <Sparkles className={`w-4 h-4 ${isDark ? 'text-orange-400' : 'text-orange-500'} animate-pulse`} style={{ animationDelay: '0.4s' }} />
        </div>

        {/* Clean Line Divider */}
        <div className="w-24 h-[2px] bg-gradient-to-r from-transparent via-orange-500/40 to-transparent my-3" />

        {/* Dynamic Typography Tagline */}
        <p className={`text-xs font-bold tracking-[0.3em] uppercase transition-colors duration-500 ${
          isDark ? 'text-slate-400' : 'text-slate-500'
        }`}>
          Track <span className="text-orange-500">•</span> Learn <span className="text-orange-500">•</span> Grow
        </p>

        {/* --- PREMIUM MODERN SPINNER & LOADER STATUS --- */}
        <div className="mt-12 flex flex-col items-center gap-4">
          
          {/* Custom Dual Ring Orbital Loader */}
          <div className="relative w-10 h-10">
            {/* Main Active Spin Ring */}
            <div className={`absolute inset-0 rounded-full border-2 border-transparent animate-spin ${
              isDark ? 'border-t-orange-500 border-r-orange-500' : 'border-t-orange-600 border-r-orange-600'
            }`} style={{ animationDuration: '0.75s' }} />
            {/* Secondary Slow Counter-Ring */}
            <div className="absolute inset-1 rounded-full border-2 border-transparent border-b-amber-400/40 border-l-amber-400/40 animate-[spin_1.5s_linear_infinite]" style={{ animationDirection: 'reverse' }} />
          </div>

          {/* Action Context Processing Text */}
          <div className="flex flex-col items-center gap-1">
            <span className={`text-xs font-semibold tracking-wider transition-colors duration-500 ${
              isDark ? 'text-slate-300' : 'text-slate-600'
            }`}>
              Preparing Workspace
            </span>
            {/* Animated Loading Dots */}
            <div className="flex gap-1 items-center justify-center h-2">
              <span className="w-1 h-1 rounded-full bg-orange-500 animate-bounce" style={{ animationDelay: '0s' }} />
              <span className="w-1 h-1 rounded-full bg-orange-500 animate-bounce" style={{ animationDelay: '0.15s' }} />
              <span className="w-1 h-1 rounded-full bg-orange-500 animate-bounce" style={{ animationDelay: '0.3s' }} />
            </div>
          </div>

        </div>

      </div>
    </div>
  );
}
