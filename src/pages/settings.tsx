import { useState, useEffect, useRef } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  Search,
  Settings,
  User,
  Sliders,
  Bell,
  Sun,
  Moon,
  Home,
  GraduationCap,
  Users,
  Wallet,
  Check,
  FileText,
  Award,
  Camera,
  Pencil,
  Trash2,
  Save,
  ShieldCheck,
  Phone,
  Mail,
  Building,
  UserCheck,
  AlertTriangle,
  X,
  AlertCircle,
  ArrowLeft
} from 'lucide-react';
import { doc, setDoc, onSnapshot, deleteDoc, getDoc } from 'firebase/firestore';
import { onAuthStateChanged } from 'firebase/auth';

// ✅ FIREBASE IMPORTS
import { db, auth } from '../lib/firebase';

import GradingTab, { RatingPriority } from '../components/settings/GradingTab';
import ReportConfigTab, { ReportMetrics } from '../components/settings/ReportConfigTab';
import TriggerAlertsTab, { Thresholds } from '../components/settings/TriggerAlertsTab';

type SettingsTab = 'profile' | 'grading' | 'report_config' | 'notifications';

export interface ProfileData {
  name: string;
  role: string;
  schoolName: string;
  email: string;
  phone: string;
  avatarUrl: string;
}

// 🌐 BOTTOM NAVIGATION TABS CONFIGURATION
const navigationTabs = [
  { id: 'home', label: 'Home', icon: Home, href: '/' },
  { id: 'classes', label: 'Classes', icon: GraduationCap, href: '/departments' },
  { id: 'attendance', label: 'Attendance', icon: Users, href: '/attendance' },
  { id: 'fees', label: 'Fees', icon: Wallet, href: '/fees' },
  { id: 'settings', label: 'Settings', icon: Settings, href: '/settings' },
];

export default function SettingsPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Layout & Navigation States
  const [isDark, setIsDark] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('profile');
  const [loading, setLoading] = useState(true);

  // Profile Saved State & Edit Mode State
  const [isEditing, setIsEditing] = useState(false);
  const [hasProfile, setHasProfile] = useState(false);

  // Custom Delete Modal State
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  // 🌟 ANIMATED POPUP MODAL STATE
  const [popup, setPopup] = useState<{
    show: boolean;
    title: string;
    message: string;
    type: 'success' | 'delete' | 'warning' | 'info';
  }>({ show: false, title: '', message: '', type: 'success' });

  // Profile Form State
  const [profile, setProfile] = useState<ProfileData>({
    name: '',
    role: '',
    schoolName: '',
    email: '',
    phone: '+92 ',
    avatarUrl: ''
  });

  // Rating Priorities State
  const [ratingPriorities, setRatingPriorities] = useState<RatingPriority[]>([
    { level: 'Excellent', score: 100, color: 'text-emerald-500', bgColor: 'bg-emerald-500/10 border-emerald-500/30', badgeText: '🌟 Top Performer' },
    { level: 'Good', score: 75, color: 'text-blue-500', bgColor: 'bg-blue-500/10 border-blue-500/30', badgeText: '👍 Satisfactory' },
    { level: 'Average', score: 50, color: 'text-amber-500', bgColor: 'bg-amber-500/10 border-amber-500/30', badgeText: '⚠️ Needs Focus' },
    { level: 'Poor', score: 25, color: 'text-rose-500', bgColor: 'bg-rose-500/10 border-rose-500/30', badgeText: '🚨 Action Required' }
  ]);

  // Thresholds State
  const [thresholds, setThresholds] = useState<Thresholds>({
    lowAttendanceLimit: 75,
    feeDueReminderDays: 5,
    autoSendSms: true,
    autoWhatsAppNotif: true
  });

  // Report Metrics State
  const [reportMetrics, setReportMetrics] = useState<ReportMetrics>({
    homeworkEnabled: true,
    behaviorEnabled: true,
    participationEnabled: true,
    performanceEnabled: true,
    teacherRemarksRequired: true
  });

  // 1. Current logged-in user email/ID
  const currentUserEmail = auth?.currentUser?.email || profile.email || 'admin@gmail.com';

  // 🎨 POPUP TRIGGER HELPER
  const triggerPopup = (title: string, message: string, type: 'success' | 'delete' | 'warning' | 'info' = 'success') => {
    setPopup({ show: true, title, message, type });
    setTimeout(() => {
      setPopup((prev) => ({ ...prev, show: false }));
    }, 3200);
  };

  // 🔄 REALTIME FIRESTORE LISTENER (WITH AUTO-FILL FROM USERS DOCUMENT)
  useEffect(() => {
    let unsubscribeSnapshot: () => void = () => {};

    const unsubscribeAuth = onAuthStateChanged(auth, async (user) => {
      setLoading(true);

      // Current User Identification
      const userEmail = user?.email || profile.email || 'admin@gmail.com';
      const userId = user ? user.uid : 'vyYKFEuB2lMSAuMOAJIPrCXK2ca2';

      // 1. First fetch Main User Document Data from `users/{userEmail}` or `users/{userId}` for Dynamic Auto-fill
      let mainUserData: any = null;
      try {
        const userByEmailDoc = await getDoc(doc(db, 'users', userEmail));
        if (userByEmailDoc.exists()) {
          mainUserData = userByEmailDoc.data();
        } else {
          const userByIdDoc = await getDoc(doc(db, 'users', userId));
          if (userByIdDoc.exists()) {
            mainUserData = userByIdDoc.data();
          }
        }
      } catch (err) {
        console.error('Error loading main user profile:', err);
      }

      // Default values fetched directly from Firestore Database
      const defaultProfile: ProfileData = {
        name: mainUserData?.teacherName || mainUserData?.name || '',
        role: mainUserData?.role || '',
        schoolName: mainUserData?.schoolName || mainUserData?.academyName || '',
        email: mainUserData?.email || userEmail,
        phone: mainUserData?.whatsappNumber || mainUserData?.phone || '+92 ',
        avatarUrl: mainUserData?.profileImage || mainUserData?.avatarUrl || ''
      };

      // 2. Realtime listener for saved settings in subcollection: users/{userEmail}/settings/profile_data
      const settingsRef = doc(db, 'users', userEmail, 'settings', 'profile_data');

      if (unsubscribeSnapshot) unsubscribeSnapshot();

      unsubscribeSnapshot = onSnapshot(
        settingsRef,
        (docSnap) => {
          if (docSnap.exists()) {
            const data = docSnap.data();
            if (data.profile && data.profile.name) {
              setProfile(data.profile);
              setHasProfile(true);
              setIsEditing(false);
            } else {
              // Auto fill dynamic record if no explicit profile saved yet
              setProfile(defaultProfile);
              setHasProfile(false);
              setIsEditing(true);
            }

            if (data.ratingPriorities) setRatingPriorities(data.ratingPriorities);
            if (data.thresholds) setThresholds(data.thresholds);
            if (data.reportMetrics) setReportMetrics(data.reportMetrics);
          } else {
            // Document doesn't exist yet: Auto fill dynamic fields from database!
            setProfile(defaultProfile);
            setHasProfile(false);
            setIsEditing(true);
          }
          setLoading(false);
        },
        (error) => {
          console.error('Firestore Sub-collection Error:', error);
          setProfile(defaultProfile);
          setHasProfile(false);
          setIsEditing(true);
          setLoading(false);
        }
      );
    });

    return () => {
      unsubscribeAuth();
      if (unsubscribeSnapshot) unsubscribeSnapshot();
    };
  }, []);

  // 📞 PHONE NUMBER FORMATTING
  const getRawPhoneDigits = (phoneStr: string) => phoneStr.replace(/^\+92/, '').replace(/\D/g, '');

  const handlePhoneChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let digits = e.target.value.replace(/^\+92/, '').replace(/\D/g, '');
    if (digits.length > 10) digits = digits.slice(0, 10);

    let formattedPhone = '+92 ';
    if (digits.length > 0) {
      if (digits.length <= 3) {
        formattedPhone += digits;
      } else {
        formattedPhone += `${digits.slice(0, 3)} ${digits.slice(3)}`;
      }
    }
    setProfile((prev) => ({ ...prev, phone: formattedPhone }));
  };

  const rawPhoneDigits = getRawPhoneDigits(profile.phone);
  const isPhoneValid = rawPhoneDigits.length === 10;
  const isPhoneIncomplete = rawPhoneDigits.length > 0 && rawPhoneDigits.length < 10;
  const isGmailValid = profile.email.trim().toLowerCase().endsWith('@gmail.com') && profile.email.trim().length > 10;

  // 💾 SAVE PROFILE
  const handleSaveProfile = async () => {
    if (!profile.name.trim()) return triggerPopup('Name Required', 'Please enter Full Name.', 'warning');
    if (!profile.role.trim()) return triggerPopup('Designation Required', 'Please fill Role field.', 'warning');
    if (!profile.schoolName.trim()) return triggerPopup('School Required', 'Please enter Academy or School Name.', 'warning');
    if (!isGmailValid) return triggerPopup('Invalid Email', 'Must end with @gmail.com', 'warning');
    if (!isPhoneValid) return triggerPopup('Phone Incomplete', 'Enter complete 10-digit number.', 'warning');

    try {
      const userDocId = currentUserEmail;
      const settingsRef = doc(db, 'users', userDocId, 'settings', 'profile_data');
      await setDoc(settingsRef, { profile, updatedAt: new Date().toISOString() }, { merge: true });
      setIsEditing(false);
      setHasProfile(true);
      triggerPopup('Profile Saved!', 'Profile updated in database successfully.', 'success');
    } catch (error) {
      console.error('Error saving profile:', error);
      triggerPopup('Save Failed', 'Could not update profile.', 'delete');
    }
  };

  // 🗑️ DELETE PROFILE
  const handleConfirmDelete = async () => {
    setShowDeleteModal(false);
    try {
      const userDocId = currentUserEmail;
      await deleteDoc(doc(db, 'users', userDocId, 'settings', 'profile_data'));
      setHasProfile(false);
      setIsEditing(true);
      triggerPopup('Profile Deleted!', 'Profile removed from database.', 'delete');
    } catch (error) {
      console.error('Error deleting profile:', error);
      triggerPopup('Delete Failed', 'Could not delete profile.', 'delete');
    }
  };

  // 📷 IMAGE UPLOAD
  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.size > 2 * 1024 * 1024) return triggerPopup('File Too Large', 'Image must be under 2MB.', 'warning');
      const reader = new FileReader();
      reader.onloadend = () => setProfile((prev) => ({ ...prev, avatarUrl: reader.result as string }));
      reader.readAsDataURL(file);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50 dark:bg-[#070b13] transition-colors">
        <div className="relative flex items-center justify-center">
          <div className="w-16 h-16 rounded-full border-4 border-orange-500/20 border-t-orange-500 animate-spin" />
          <Settings className="h-6 w-6 text-orange-500 absolute animate-pulse" />
        </div>
        <p className="mt-4 font-bold text-xs text-slate-500 dark:text-slate-400 tracking-wider uppercase">
          Loading Settings...
        </p>
      </div>
    );
  }

  return (
    <div className={`min-h-screen bg-slate-50 dark:bg-[#070b13] text-slate-900 dark:text-slate-100 transition-colors duration-300 pb-32 ${isDark ? 'dark' : ''}`}>

      {/* 🌟 1. MINIMAL PREMIUM UTILITY HEADER */}
      <div className="w-full bg-white/40 dark:bg-[#070b13]/40 backdrop-blur-sm border-b border-slate-200/40 dark:border-slate-900/40 sticky top-0 z-40 transition-colors">
        <div className="mx-auto max-w-7xl flex h-14 items-center justify-between px-3 sm:px-6 lg:px-8 gap-2">

          {/* 🔙 BACK BUTTON & SEARCH */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => navigate(-1)}
              className="flex h-8 w-8 sm:h-9 sm:w-9 shrink-0 items-center justify-center rounded-full bg-orange-500 text-white shadow-lg shadow-orange-500/30 hover:bg-orange-600 active:scale-90 transition-all cursor-pointer"
              title="Go Back"
            >
              <ArrowLeft className="h-4 w-4 sm:h-5 sm:w-5 stroke-[2.5]" />
            </button>

            {/* Quick Search */}
            <div className="relative w-28 sm:w-64">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Quick search..."
                className="w-full rounded-xl border border-slate-200/60 bg-white/60 py-1.5 pl-8 pr-2 sm:pl-9 sm:pr-4 text-xs outline-none transition-all focus:border-orange-500 focus:bg-white dark:border-slate-800 dark:bg-[#0c1222] dark:focus:bg-[#0c1222] dark:text-white"
              />
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            {/* Dark Mode Toggle */}
            <button
              onClick={() => setIsDark(!isDark)}
              className="flex h-6 w-10 sm:h-7 sm:w-12 items-center rounded-full bg-slate-200/60 p-0.5 transition-all dark:bg-slate-800 border border-slate-300/30"
              title="Toggle Theme"
            >
              <div className={`flex h-4 w-4 sm:h-5 sm:w-5 items-center justify-center rounded-full bg-white text-orange-500 shadow-sm transition-all ${isDark ? 'translate-x-4 sm:translate-x-5 bg-slate-950 text-yellow-400' : ''}`}>
                {isDark ? <Moon className="h-2.5 w-2.5 sm:h-3 sm:w-3 fill-current" /> : <Sun className="h-2.5 w-2.5 sm:h-3 sm:w-3 fill-current" />}
              </div>
            </button>

            {/* Notification Bell */}
            <Link
              to="/alerts"
              className="relative rounded-xl p-1.5 sm:p-2 text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-[#0c1222] transition-all hover:scale-105 active:scale-95"
            >
              <Bell className="h-4 w-4" />
              <span className="absolute right-1 top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-orange-500 text-[9px] font-bold text-white ring-2 ring-white dark:ring-[#070b13] animate-pulse">
                3
              </span>
            </Link>

            {/* Profile Link */}
            <Link
              to="/settings"
              title="View Profile / Settings"
              className="h-7 w-7 sm:h-8 sm:w-8 shrink-0 overflow-hidden rounded-full ring-2 ring-orange-500/70 shadow-[0_0_12px_rgba(249,115,22,0.4)] transition-all hover:scale-110 active:scale-95 cursor-pointer block"
            >
              <img
                src={
                  profile.avatarUrl ||
                  'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&q=80&w=250'
                }
                alt={profile.name || 'User Avatar'}
                className="h-full w-full object-cover"
              />
            </Link>
          </div>
        </div>
      </div>

      {/* 🗑️ DELETE CONFIRMATION MODAL */}
      {showDeleteModal && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-slate-950/60 backdrop-blur-md transition-all px-4 animate-fadeIn">
          <div className="bg-white dark:bg-[#0c1222] border border-rose-500/30 rounded-3xl p-6 max-w-sm w-full shadow-[0_0_50px_rgba(244,63,94,0.25)] flex flex-col items-center text-center relative overflow-hidden">
            <button
              onClick={() => setShowDeleteModal(false)}
              className="absolute top-4 right-4 text-slate-400 hover:text-slate-600 dark:hover:text-white p-1 rounded-full transition-colors"
            >
              <X className="h-4 w-4" />
            </button>

            <div className="w-16 h-16 rounded-full bg-rose-500/10 text-rose-500 flex items-center justify-center mb-4 shadow-lg shadow-rose-500/10 border border-rose-500/20">
              <AlertTriangle className="h-8 w-8 animate-bounce" />
            </div>

            <h3 className="text-lg font-black text-slate-900 dark:text-white">Delete Teacher Profile?</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 font-medium mt-1.5 leading-relaxed">
              Are you sure you want to remove this profile? This action will delete the profile data permanently.
            </p>

            <div className="grid grid-cols-2 gap-3 w-full mt-6">
              <button
                onClick={() => setShowDeleteModal(false)}
                className="py-3 px-4 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 font-bold text-xs transition-all active:scale-95"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmDelete}
                className="py-3 px-4 rounded-xl bg-rose-500 hover:bg-rose-600 text-white font-bold text-xs shadow-lg shadow-rose-500/30 transition-all active:scale-95 flex items-center justify-center gap-1.5"
              >
                <Trash2 className="h-3.5 w-3.5" /> Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 🌟 ANIMATED POPUP NOTIFICATION */}
      {popup.show && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-950/50 backdrop-blur-md transition-all px-4 animate-fadeIn">
          <div className="bg-white dark:bg-[#0c1222] border border-orange-500/30 rounded-3xl p-6 max-w-xs w-full shadow-[0_0_50px_rgba(249,115,22,0.3)] flex flex-col items-center text-center">
            <div className={`w-14 h-14 rounded-full flex items-center justify-center mb-3 shadow-lg ${
              popup.type === 'delete' 
                ? 'bg-rose-500/10 text-rose-500 shadow-rose-500/20' 
                : popup.type === 'warning'
                ? 'bg-amber-500/10 text-amber-500 shadow-amber-500/20'
                : 'bg-emerald-500/10 text-emerald-500 shadow-emerald-500/20'
            }`}>
              {popup.type === 'delete' ? (
                <Trash2 className="h-7 w-7 animate-bounce" />
              ) : popup.type === 'warning' ? (
                <AlertCircle className="h-7 w-7 animate-bounce" />
              ) : (
                <Check className="h-7 w-7 stroke-[3] animate-bounce" />
              )}
            </div>
            <h3 className="text-base font-black text-slate-900 dark:text-white">{popup.title}</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 font-medium mt-1 leading-relaxed">{popup.message}</p>
          </div>
        </div>
      )}

      {/* MAIN CONTENT AREA */}
      <main className="mx-auto max-w-2xl px-3 sm:px-4 py-6 space-y-6">

        {/* HERO BANNER */}
        <div className="bg-gradient-to-r from-orange-500 via-amber-500 to-orange-600 rounded-3xl p-5 sm:p-6 text-white shadow-xl shadow-orange-500/10 relative overflow-hidden flex items-center justify-between border border-orange-400/30">
          <div className="space-y-1 z-10 max-w-[85%] sm:max-w-[80%]">
            <span className="inline-flex items-center gap-1 bg-white/20 backdrop-blur-md px-2.5 py-0.5 sm:px-3 sm:py-1 rounded-full text-[9px] sm:text-[10px] font-black uppercase tracking-wider">
              <ShieldCheck className="h-3 w-3" /> Dedicated Sub-Collection Active
            </span>
            <h2 className="text-lg sm:text-xl font-black tracking-tight">Settings & Teacher Profile</h2>
            <p className="text-[11px] sm:text-xs text-orange-50 font-medium leading-relaxed opacity-90">
              `settings` sub-collection is separated from classes & attendance collections.
            </p>
          </div>
          <Sliders className="h-24 w-24 sm:h-28 sm:w-28 text-white/10 absolute -right-3 -bottom-3 pointer-events-none" />
        </div>

        {/* SUB-TAB NAVIGATION */}
        <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-none">
          <button
            onClick={() => setSettingsTab('profile')}
            className={`px-3.5 sm:px-4 py-2 sm:py-2.5 rounded-2xl text-xs font-bold flex items-center gap-2 transition-all whitespace-nowrap active:scale-95 ${
              settingsTab === 'profile'
                ? 'bg-orange-500 text-white shadow-lg shadow-orange-500/25'
                : 'bg-white dark:bg-[#0c1222] text-slate-600 dark:text-slate-400 border border-slate-200/80 dark:border-slate-800'
            }`}
          >
            <User className="h-4 w-4" /> Admin Profile
          </button>

          <button
            onClick={() => setSettingsTab('grading')}
            className={`px-3.5 sm:px-4 py-2 sm:py-2.5 rounded-2xl text-xs font-bold flex items-center gap-2 transition-all whitespace-nowrap active:scale-95 ${
              settingsTab === 'grading'
                ? 'bg-orange-500 text-white shadow-lg shadow-orange-500/25'
                : 'bg-white dark:bg-[#0c1222] text-slate-600 dark:text-slate-400 border border-slate-200/80 dark:border-slate-800'
            }`}
          >
            <Award className="h-4 w-4" /> Grading Rules
          </button>

          <button
            onClick={() => setSettingsTab('report_config')}
            className={`px-3.5 sm:px-4 py-2 sm:py-2.5 rounded-2xl text-xs font-bold flex items-center gap-2 transition-all whitespace-nowrap active:scale-95 ${
              settingsTab === 'report_config'
                ? 'bg-orange-500 text-white shadow-lg shadow-orange-500/25'
                : 'bg-white dark:bg-[#0c1222] text-slate-600 dark:text-slate-400 border border-slate-200/80 dark:border-slate-800'
            }`}
          >
            <FileText className="h-4 w-4" /> Report Fields
          </button>

          <button
            onClick={() => setSettingsTab('notifications')}
            className={`px-3.5 sm:px-4 py-2 sm:py-2.5 rounded-2xl text-xs font-bold flex items-center gap-2 transition-all whitespace-nowrap active:scale-95 ${
              settingsTab === 'notifications'
                ? 'bg-orange-500 text-white shadow-lg shadow-orange-500/25'
                : 'bg-white dark:bg-[#0c1222] text-slate-600 dark:text-slate-400 border border-slate-200/80 dark:border-slate-800'
            }`}
          >
            <Bell className="h-4 w-4" /> Trigger Alerts
          </button>
        </div>

        {/* PROFILE TAB */}
        {settingsTab === 'profile' && (
          <div className="relative group rounded-[28px] sm:rounded-[32px] p-[2px] transition-all overflow-hidden shadow-xl">
            <div className="absolute inset-[-1000%] bg-[conic-gradient(from_90deg_at_50%_50%,#f97316_0%,#fbbf24_25%,#f97316_50%,#fbbf24_75%,#f97316_100%)] animate-[spin_4s_linear_infinite]" />

            <div className="relative rounded-[26px] sm:rounded-[30px] bg-white dark:bg-[#0c1222] p-4 sm:p-6 space-y-6 overflow-hidden">

              {/* SAVED PROFILE CARD */}
              {hasProfile && !isEditing ? (
                <div className="space-y-6 animate-fadeIn">
                  <div className="flex items-center justify-between pb-3 sm:pb-4 border-b border-slate-100 dark:border-slate-800 gap-2">
                    <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
                      <UserCheck className="h-4 w-4 sm:h-5 sm:w-5 text-emerald-500" />
                      <h3 className="font-black text-slate-900 dark:text-white text-xs sm:text-base uppercase tracking-wider">
                        PROFILE
                      </h3>
                    </div>
                    
                    {/* BUTTON SIZE & COMPACT RESPONSIVE LAYOUT */}
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        onClick={() => setIsEditing(true)}
                        className="px-2.5 sm:px-3.5 py-1.5 sm:py-2 rounded-xl bg-orange-500 text-white font-bold text-[11px] sm:text-xs flex items-center gap-1 shadow-md hover:bg-orange-600 active:scale-95 transition-all whitespace-nowrap"
                      >
                        <Pencil className="h-3 w-3 sm:h-3.5 sm:w-3.5" /> Edit Profile
                      </button>

                      <button
                        onClick={() => setShowDeleteModal(true)}
                        className="p-1.5 sm:p-2 rounded-xl bg-rose-500/10 text-rose-500 hover:bg-rose-500/20 active:scale-95 transition-all shrink-0"
                        title="Delete Profile"
                      >
                        <Trash2 className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                      </button>
                    </div>
                  </div>

                  <div className="flex flex-col items-center justify-center gap-4 bg-slate-50 dark:bg-slate-900/60 p-4 sm:p-5 rounded-2xl border border-slate-100 dark:border-slate-800">
                    <img
                      src={
                        profile.avatarUrl ||
                        'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&q=80&w=250'
                      }
                      alt="Avatar"
                      className="w-20 h-20 sm:w-24 sm:h-24 rounded-2xl object-cover ring-2 ring-orange-500/30 shadow-md shrink-0"
                    />

                    <div className="space-y-3 text-center w-full">
                      <div>
                        <h2 className="text-base sm:text-lg font-black text-slate-900 dark:text-white break-words">{profile.name}</h2>
                        <p className="text-xs font-bold text-orange-500 break-words">{profile.role}</p>
                      </div>

                      <div className="flex flex-col items-center justify-center gap-2 pt-2 text-xs font-medium text-slate-500 dark:text-slate-400 w-full">
                        <div className="flex items-center gap-1.5 justify-center max-w-full">
                          <Building className="h-3.5 w-3.5 text-orange-500 shrink-0" />
                          <span className="truncate">{profile.schoolName || 'Not Set'}</span>
                        </div>
                        <div className="flex items-center gap-1.5 justify-center max-w-full">
                          <Mail className="h-3.5 w-3.5 text-orange-500 shrink-0" />
                          <span className="truncate">{profile.email || 'Not Set'}</span>
                        </div>
                        <div className="flex items-center gap-1.5 justify-center max-w-full">
                          <Phone className="h-3.5 w-3.5 text-orange-500 shrink-0" />
                          <span className="truncate">{profile.phone || 'Not Set'}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                
                /* EDIT / CREATE FORM */
                <div className="space-y-4 animate-fadeIn">
                  <div className="flex items-center justify-between pb-4 border-b border-slate-100 dark:border-slate-800">
                    <div className="flex items-center gap-3">
                      <div className="relative shrink-0">
                        <img
                          src={
                            profile.avatarUrl ||
                            'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&q=80&w=250'
                          }
                          alt="Avatar"
                          className="w-12 h-12 sm:w-14 sm:h-14 rounded-2xl object-cover ring-2 ring-orange-500/30 shadow-md"
                        />
                        <button
                          onClick={() => fileInputRef.current?.click()}
                          className="absolute -bottom-1 -right-1 p-1 sm:p-1.5 rounded-xl bg-orange-500 text-white shadow-md hover:bg-orange-600 active:scale-95 transition-all"
                        >
                          <Camera className="h-3 w-3 sm:h-3.5 sm:w-3.5" />
                        </button>
                        <input
                          ref={fileInputRef}
                          type="file"
                          accept="image/*"
                          onChange={handleImageUpload}
                          className="hidden"
                        />
                      </div>

                      <div>
                        <h3 className="font-black text-slate-900 dark:text-white text-sm sm:text-base">
                          {hasProfile ? 'Edit Profile Details' : 'Create Teacher Profile'}
                        </h3>
                        <p className="text-[11px] sm:text-xs font-medium text-slate-400">
                          {hasProfile ? 'Update existing teacher information' : 'Fill all fields to save in settings collection'}
                        </p>
                      </div>
                    </div>

                    {hasProfile && (
                      <button
                        onClick={() => setIsEditing(false)}
                        className="text-xs font-bold text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 shrink-0 ml-2"
                      >
                        Cancel
                      </button>
                    )}
                  </div>

                  {/* FULL NAME INPUT */}
                  <div>
                    <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-1 flex items-center gap-1.5">
                      <User className="h-3.5 w-3.5 text-orange-500" /> Full Name
                    </label>
                    <input
                      type="text"
                      value={profile.name}
                      onChange={(e) => setProfile({ ...profile, name: e.target.value })}
                      placeholder="Enter administrator / teacher full name"
                      className={`w-full px-4 py-3 rounded-2xl bg-slate-50 dark:bg-slate-900 border text-xs font-bold text-slate-800 dark:text-slate-100 focus:outline-none transition-all ${
                        profile.name.trim()
                          ? 'border-emerald-500/80 focus:ring-2 focus:ring-emerald-500'
                          : 'border-slate-200 dark:border-slate-800 focus:ring-2 focus:ring-orange-500'
                      }`}
                    />
                  </div>

                  {/* ROLE / DESIGNATION INPUT */}
                  <div>
                    <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-1 flex items-center gap-1.5">
                      <Award className="h-3.5 w-3.5 text-orange-500" /> Role / Designation
                    </label>
                    <input
                      type="text"
                      value={profile.role}
                      onChange={(e) => setProfile({ ...profile, role: e.target.value })}
                      placeholder="e.g. Head Teacher / Senior Instructor"
                      className={`w-full px-4 py-3 rounded-2xl bg-slate-50 dark:bg-slate-900 border text-xs font-bold text-slate-800 dark:text-slate-100 focus:outline-none transition-all ${
                        profile.role.trim()
                          ? 'border-emerald-500/80 focus:ring-2 focus:ring-emerald-500'
                          : 'border-slate-200 dark:border-slate-800 focus:ring-2 focus:ring-orange-500'
                      }`}
                    />
                  </div>

                  {/* ACADEMY / SCHOOL NAME INPUT */}
                  <div>
                    <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-1 flex items-center gap-1.5">
                      <Building className="h-3.5 w-3.5 text-orange-500" /> Academy / School Name
                    </label>
                    <input
                      type="text"
                      value={profile.schoolName}
                      onChange={(e) => setProfile({ ...profile, schoolName: e.target.value })}
                      placeholder="Enter school or academy name"
                      className={`w-full px-4 py-3 rounded-2xl bg-slate-50 dark:bg-slate-900 border text-xs font-bold text-slate-800 dark:text-slate-100 focus:outline-none transition-all ${
                        profile.schoolName.trim()
                          ? 'border-emerald-500/80 focus:ring-2 focus:ring-emerald-500'
                          : 'border-slate-200 dark:border-slate-800 focus:ring-2 focus:ring-orange-500'
                      }`}
                    />
                  </div>

                  {/* GMAIL ADDRESS INPUT */}
                  <div>
                    <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-1 flex items-center gap-1.5">
                      <Mail className="h-3.5 w-3.5 text-orange-500" /> Gmail Address (@gmail.com)
                    </label>
                    <div className="relative flex items-center">
                      <input
                        type="email"
                        value={profile.email}
                        onChange={(e) => setProfile({ ...profile, email: e.target.value })}
                        placeholder="admin@gmail.com"
                        className={`w-full pl-4 pr-11 py-3 rounded-2xl bg-slate-50 dark:bg-slate-900 border text-xs font-bold text-slate-800 dark:text-slate-100 focus:outline-none transition-all ${
                          isGmailValid
                            ? 'border-emerald-500/80 focus:ring-2 focus:ring-emerald-500'
                            : profile.email.length > 0
                            ? 'border-rose-500/80 focus:ring-2 focus:ring-rose-500'
                            : 'border-slate-200 dark:border-slate-800 focus:ring-2 focus:ring-orange-500'
                        }`}
                      />

                      <div className="absolute right-3.5 flex items-center justify-center">
                        {isGmailValid && (
                          <div className="p-1 rounded-full bg-emerald-500/15 text-emerald-500 animate-fadeIn">
                            <Check className="h-4 w-4 stroke-[3]" />
                          </div>
                        )}

                        {!isGmailValid && profile.email.length > 0 && (
                          <div className="p-1 rounded-full bg-rose-500/15 text-rose-500 animate-pulse">
                            <AlertCircle className="h-4 w-4" />
                          </div>
                        )}
                      </div>
                    </div>
                    {!isGmailValid && profile.email.length > 0 && (
                      <p className="text-[10px] font-semibold text-rose-500 mt-1 pl-1">
                        Email must end strictly with @gmail.com
                      </p>
                    )}
                  </div>

                  {/* WHATSAPP PHONE INPUT */}
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
                        <Phone className="h-3.5 w-3.5 text-orange-500" /> Contact WhatsApp
                      </label>

                      <span className="text-[10px] font-bold text-slate-400">
                        {rawPhoneDigits.length} / 10 Digits
                      </span>
                    </div>

                    <div className="relative flex items-center">
                      <input
                        type="text"
                        value={profile.phone}
                        onChange={handlePhoneChange}
                        placeholder="+92 300 0000000"
                        className={`w-full pl-4 pr-11 py-3 rounded-2xl bg-slate-50 dark:bg-slate-900 border text-xs font-bold text-slate-800 dark:text-slate-100 focus:outline-none transition-all ${
                          isPhoneValid
                            ? 'border-emerald-500/80 focus:ring-2 focus:ring-emerald-500'
                            : isPhoneIncomplete
                            ? 'border-rose-500/80 focus:ring-2 focus:ring-rose-500'
                            : 'border-slate-200 dark:border-slate-800 focus:ring-2 focus:ring-orange-500'
                        }`}
                      />

                      <div className="absolute right-3.5 flex items-center justify-center">
                        {isPhoneValid && (
                          <div className="p-1 rounded-full bg-emerald-500/15 text-emerald-500 animate-fadeIn">
                            <Check className="h-4 w-4 stroke-[3]" />
                          </div>
                        )}

                        {isPhoneIncomplete && (
                          <div className="p-1 rounded-full bg-rose-500/15 text-rose-500 animate-pulse">
                            <AlertCircle className="h-4 w-4" />
                          </div>
                        )}
                      </div>
                    </div>

                    {isPhoneIncomplete && (
                      <p className="text-[10px] font-semibold text-rose-500 mt-1 pl-1">
                        Please enter remaining {10 - rawPhoneDigits.length} digits after +92.
                      </p>
                    )}
                  </div>

                  <button
                    onClick={handleSaveProfile}
                    className="w-full py-3.5 rounded-2xl bg-orange-500 hover:bg-orange-600 text-white font-black text-xs flex items-center justify-center gap-2 shadow-lg shadow-orange-500/20 active:scale-95 transition-all mt-3"
                  >
                    <Save className="h-4 w-4" /> Save Profile Details
                  </button>
                </div>
              )}

            </div>
          </div>
        )}

        {/* OTHER SETTINGS TABS WITH USERID PASSING */}
        {settingsTab === 'grading' && (
          <GradingTab
            userId={currentUserEmail}
            ratingPriorities={ratingPriorities}
            setRatingPriorities={setRatingPriorities}
          />
        )}

        {settingsTab === 'report_config' && (
          <ReportConfigTab
            userId={currentUserEmail}
            reportMetrics={reportMetrics}
            setReportMetrics={setReportMetrics}
          />
        )}

        {settingsTab === 'notifications' && (
          <TriggerAlertsTab
            userId={currentUserEmail}
            thresholds={thresholds}
            setThresholds={setThresholds}
          />
        )}

      </main>

      {/* 🌟 2. FLOATING BOTTOM NAVIGATION BAR */}
      <div className="fixed bottom-0 left-0 right-0 z-50 px-4 pb-4 pt-2 bg-gradient-to-t from-[#f8fafc] via-[#f8fafc]/90 to-transparent dark:from-[#070b13] dark:via-[#070b13]/90 pointer-events-none">
        <nav className="mx-auto max-w-md bg-white/80 dark:bg-[#0c1222]/90 backdrop-blur-xl border border-slate-200/50 dark:border-slate-800/40 rounded-3xl shadow-[0_15px_35px_-5px_rgba(0,0,0,0.08)] dark:shadow-[0_20px_40px_rgba(0,0,0,0.4)] px-3 py-2 flex items-center justify-between pointer-events-auto">
          {navigationTabs.map((tab) => {
            const IconComponent = tab.icon;
            const isActive = location.pathname === tab.href || (tab.href === '/settings' && location.pathname.includes('/settings'));

            return (
              <Link
                key={tab.id}
                to={tab.href}
                className="flex flex-col items-center justify-center flex-1 py-1 relative group"
              >
                <div
                  className={`p-2 rounded-2xl transition-all duration-300 relative ${
                    isActive
                      ? 'bg-orange-500 text-white shadow-md shadow-orange-500/30 scale-105'
                      : 'text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300'
                  }`}
                >
                  <IconComponent className="h-4 w-4" />
                </div>

                <span
                  className={`text-[9px] font-bold tracking-tight mt-1 transition-colors ${
                    isActive
                      ? 'text-orange-600 dark:text-orange-400 font-extrabold'
                      : 'text-slate-400 dark:text-slate-500'
                  }`}
                >
                  {tab.label}
                </span>

                {isActive && (
                  <div className="absolute top-0 h-1 w-1 bg-orange-500 rounded-full shadow-[0_0_8px_#f97316]" />
                )}
              </Link>
            );
          })}
        </nav>
      </div>

    </div>
  );
}
