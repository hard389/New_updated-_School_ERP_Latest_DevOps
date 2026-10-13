import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  collection,
  doc,
  onSnapshot,
  updateDoc,
  deleteDoc,
  writeBatch,
  serverTimestamp,
  getDoc,
  runTransaction,
} from 'firebase/firestore';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { auth, db } from '@/lib/firebase';
import { Link, useLocation } from 'react-router-dom';
import {
  Bell,
  CheckCheck,
  Trash2,
  AlertTriangle,
  Megaphone,
  Wallet,
  Users,
  Plus,
  Search,
  Sun,
  Moon,
  Home,
  GraduationCap,
  Settings,
  X,
  Clock,
  Send,
  Calendar,
  Sparkles,
  MessageSquare,
  Loader2,
  ArrowLeft
} from 'lucide-react';
import {
  buildAlertPayloadKey,
  deduplicateAndSortNotifications,
  isOwnedActiveTeacherProfile,
  normalizeTenantEmail,
  userSettingsProfilePath,
  tenantAlertsPath,
  tenantClassesPath,
  type NotificationItem,
} from './alerts.logic';

// ==========================================
// TYPES & INTERFACES
// ==========================================
type AlertCategory = 'All' | 'Unread' | 'Fees' | 'Attendance' | 'Announcements';
type PriorityLevel = 'high' | 'medium' | 'normal';

interface TriggerAlertSettings {
  autoSendSms: boolean;
  autoWhatsAppNotif: boolean;
  feeDueReminderDays: number;
  lowAttendanceLimit: number;
  updatedAt?: string;
}

interface DynamicClass {
  id: string;
  name: string;
  subject?: string;
}

interface TenantContext {
  tenantId: string;
  uid: string;
  generation: number;
}

const readErrorCode = (error: unknown): string => {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return 'unknown';
};

const logFirestoreFailure = (action: string, error: unknown) => {
  const code = readErrorCode(error);
  if (code === 'permission-denied' || code === 'unauthenticated') {
    console.error(`[Alerts] Firestore permission/authentication denied while attempting to ${action}. Check the authenticated teacher's tenant rules.`, error);
  } else if (code === 'unavailable' || code === 'deadline-exceeded' || code === 'network-request-failed') {
    console.warn(`[Alerts] Firestore network/offline failure while attempting to ${action}. Cached listener data may remain available.`, error);
  } else {
    console.error(`[Alerts] Firestore error while attempting to ${action} (code: ${code}).`, error);
  }
};

const triggerWhatsAppCloudAPI = async (recipientPhone: string, title: string, message: string, className: string) => {
  // This file does not contain a real server-side WhatsApp integration. Keep this as an explicit
  // simulation; callers must not persist whatsappSent=true unless a trusted API confirms delivery.
  console.info(`[WhatsApp simulated only] Alert not sent by Meta API for ${className} (${recipientPhone}): ${title}`);
  void message;
  return { success: false, status: 'Simulated' as const };
};

// ==========================================
// MAIN NOTIFICATIONS PAGE COMPONENT
// ==========================================
export default function NotificationsPage() {
  const location = useLocation();

  // Tenant context is created only after the authenticated UID/email matches the teacher profile.
  const [tenantContext, setTenantContext] = useState<TenantContext | null>(null);
  const [tenantResolutionPending, setTenantResolutionPending] = useState(true);
  const authGenerationRef = useRef(0);
  const activeTenantRef = useRef<TenantContext | null>(null);
  const submitInProgressRef = useRef(false);
  const pendingAlertIdRef = useRef<string | null>(null);
  const pendingAlertPayloadKeyRef = useRef<string | null>(null);

  // Theme & State
  const [isDark, setIsDark] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [classesList, setClassesList] = useState<DynamicClass[]>([]);
  const [triggerAlertsSettings, setTriggerAlertsSettings] = useState<TriggerAlertSettings | null>(null);

  // Filters & Search
  const [selectedFilter, setSelectedFilter] = useState<AlertCategory>('All');
  const [searchQuery, setSearchQuery] = useState('');

  // Modal State
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newMessage, setNewMessage] = useState('');
  const [newCategory, setNewCategory] = useState<'Fees' | 'Attendance' | 'Announcements' | 'Exams'>('Announcements');
  const [newPriority, setNewPriority] = useState<PriorityLevel>('normal');
  const [newClass, setNewClass] = useState('All Classes');
  const [recipientPhone, setRecipientPhone] = useState('');

  const isTenantSessionActive = (context: TenantContext): boolean => {
    const authUser: User | null = auth.currentUser;
    const activeContext = activeTenantRef.current;
    return Boolean(
      authUser
      && activeContext
      && activeContext.generation === context.generation
      && activeContext.tenantId === context.tenantId
      && activeContext.uid === context.uid
      && authGenerationRef.current === context.generation
      && authUser.uid === context.uid
      && normalizeTenantEmail(authUser.email) === context.tenantId
    );
  };

  const getActiveTenant = (): TenantContext | null => {
    const context = activeTenantRef.current;
    return context && isTenantSessionActive(context) ? context : null;
  };

  // ------------------------------------------
  // AUTHENTICATION & TENANT PROFILE VERIFICATION
  // ------------------------------------------
  useEffect(() => {
    let disposed = false;
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      const generation = ++authGenerationRef.current;
      activeTenantRef.current = null;
      setTenantContext(null);
      setTenantResolutionPending(Boolean(user));
      setNotifications([]);
      setClassesList([]);
      setTriggerAlertsSettings(null);
      setIsCreateModalOpen(false);
      setNewTitle('');
      setNewMessage('');
      setRecipientPhone('');
      setNewClass('All Classes');
      pendingAlertIdRef.current = null;
      pendingAlertPayloadKeyRef.current = null;
      setLoading(Boolean(user));

      if (!user) {
        setTenantResolutionPending(false);
        setLoading(false);
        return;
      }

      const tenantId = normalizeTenantEmail(user.email);
      if (!tenantId || tenantId.includes('/')) {
        console.error('[Alerts] Tenant access denied: the signed-in account has no valid email-keyed workspace.');
        setTenantResolutionPending(false);
        setLoading(false);
        return;
      }

      try {
        // EduTrack RegisterPage and Quiz use users/{normalizedEmail}; never fall back to UID or root data.
        const profileSnapshot = await getDoc(doc(db, 'users', tenantId));
        if (disposed || generation !== authGenerationRef.current || auth.currentUser?.uid !== user.uid) return;

        if (!profileSnapshot.exists() || !isOwnedActiveTeacherProfile(profileSnapshot.data(), user.uid, user.email)) {
          console.error('[Alerts] Tenant access denied: no active teacher profile matches this signed-in UID and normalized email.');
          setTenantResolutionPending(false);
          setLoading(false);
          return;
        }

        const context: TenantContext = { tenantId, uid: user.uid, generation };
        activeTenantRef.current = context;
        setTenantContext(context);
        setTenantResolutionPending(false);
      } catch (error) {
        if (disposed || generation !== authGenerationRef.current) return;
        setNotifications([]);
        setClassesList([]);
        setTriggerAlertsSettings(null);
        setTenantResolutionPending(false);
        setLoading(false);
        logFirestoreFailure('verify the signed-in teacher profile', error);
      }
    });

    return () => {
      disposed = true;
      authGenerationRef.current += 1;
      activeTenantRef.current = null;
      unsubscribe();
    };
  }, []);

  // A. Listen only to this verified tenant's trigger-alert settings; never read global settings.
  useEffect(() => {
    const context = tenantContext;
    if (!context || !isTenantSessionActive(context)) {
      setTriggerAlertsSettings(null);
      return;
    }

    let active = true;
    const path = userSettingsProfilePath(context.uid);
    if (!path) {
      setTriggerAlertsSettings(null);
      return;
    }

    const unsubscribe = onSnapshot(doc(db, path), (snapshot) => {
      if (!active || !isTenantSessionActive(context)) return;
      const rootSettings = snapshot.exists() ? snapshot.data() : null;
      const thresholds = rootSettings?.thresholds;
      setTriggerAlertsSettings(
        thresholds && typeof thresholds === 'object'
          ? thresholds as TriggerAlertSettings
          : null,
      );
    }, (error) => {
      if (!active || !isTenantSessionActive(context)) return;
      setTriggerAlertsSettings(null);
      logFirestoreFailure("listen to this teacher's trigger-alert settings", error);
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [tenantContext]);

  // B. Listen only to this verified tenant's classes. Empty data remains empty; no sample classes.
  useEffect(() => {
    const context = tenantContext;
    if (!context || !isTenantSessionActive(context)) {
      setClassesList([]);
      return;
    }

    let active = true;
    const path = tenantClassesPath(context.tenantId);
    if (!path) {
      setClassesList([]);
      return;
    }

    const unsubscribe = onSnapshot(collection(db, path), (snapshot) => {
      if (!active || !isTenantSessionActive(context)) return;
      const classes: DynamicClass[] = snapshot.docs.map((classDoc) => {
        const data = classDoc.data();
        return {
          id: classDoc.id,
          name: typeof data.name === 'string' && data.name.trim()
            ? data.name
            : typeof data.className === 'string' && data.className.trim()
              ? data.className
              : classDoc.id,
          subject: typeof data.subject === 'string' ? data.subject : '',
        };
      });
      setClassesList(classes);
      if (snapshot.metadata.fromCache) {
        console.info('[Alerts] Class list currently served from Firestore cache/offline persistence.');
      }
    }, (error) => {
      if (!active || !isTenantSessionActive(context)) return;
      setClassesList([]);
      logFirestoreFailure("listen to this teacher's classes", error);
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [tenantContext]);

  // C. Real-time alerts listener. No orderBy query means legacy documents without createdAt are not hidden.
  useEffect(() => {
    const context = tenantContext;
    if (!context || !isTenantSessionActive(context)) {
      setNotifications([]);
      setLoading(tenantResolutionPending);
      return;
    }

    let active = true;
    setLoading(true);
    const path = tenantAlertsPath(context.tenantId);
    if (!path) {
      setNotifications([]);
      setLoading(false);
      return;
    }

    const unsubscribe = onSnapshot(collection(db, path), (snapshot) => {
      if (!active || !isTenantSessionActive(context)) return;
      const rows = snapshot.docs.map((alertDoc) => ({ id: alertDoc.id, data: alertDoc.data() }));
      setNotifications(deduplicateAndSortNotifications(rows));
      setLoading(false);
      if (snapshot.metadata.fromCache) {
        console.info('[Alerts] Alerts currently served from Firestore cache/offline persistence.');
      }
    }, (error) => {
      if (!active || !isTenantSessionActive(context)) return;
      setNotifications([]);
      setLoading(false);
      logFirestoreFailure("listen to this teacher's alerts", error);
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [tenantContext, tenantResolutionPending]);

  // ------------------------------------------
  // COMPUTED VALUES
  // ------------------------------------------
  const unreadCount = useMemo(() => {
    return notifications.filter((n) => !n.isRead).length;
  }, [notifications]);

  const filteredNotifications = useMemo(() => {
    const normalizedSearch = searchQuery.toLowerCase();
    return notifications.filter((item) => {
      const matchesSearch =
        item.title.toLowerCase().includes(normalizedSearch) ||
        item.message.toLowerCase().includes(normalizedSearch) ||
        item.targetClass.toLowerCase().includes(normalizedSearch);

      if (!matchesSearch) return false;
      if (selectedFilter === 'Unread') return !item.isRead;
      if (selectedFilter === 'Fees') return item.category === 'Fees';
      if (selectedFilter === 'Attendance') return item.category === 'Attendance';
      if (selectedFilter === 'Announcements') return item.category === 'Announcements';
      return true;
    });
  }, [notifications, selectedFilter, searchQuery]);

  // ------------------------------------------
  // FIRESTORE ACTIONS — every action re-checks the active authenticated tenant.
  // ------------------------------------------
  const handleMarkAsRead = async (id: string) => {
    const context = getActiveTenant();
    if (!context || !notifications.some((item) => item.id === id)) return;

    const path = tenantAlertsPath(context.tenantId);
    if (!path) return;
    try {
      if (!isTenantSessionActive(context)) return;
      await updateDoc(doc(db, `${path}/${id}`), { isRead: true });
    } catch (error) {
      logFirestoreFailure('mark this teacher-owned alert as read', error);
    }
  };

  const handleMarkAllRead = async () => {
    const context = getActiveTenant();
    if (!context) return;

    const path = tenantAlertsPath(context.tenantId);
    if (!path) return;
    const unreadItems = notifications.filter((item) => !item.isRead);
    if (unreadItems.length === 0) return;

    try {
      // Firestore batch limit is 500 writes; keep batches comfortably below that ceiling.
      for (let offset = 0; offset < unreadItems.length; offset += 450) {
        if (!isTenantSessionActive(context)) return;
        const batch = writeBatch(db);
        unreadItems.slice(offset, offset + 450).forEach((item) => {
          batch.update(doc(db, `${path}/${item.id}`), { isRead: true });
        });
        await batch.commit();
      }
    } catch (error) {
      logFirestoreFailure("mark this teacher's alerts as read", error);
    }
  };

  const handleDeleteNotification = async (id: string) => {
    const context = getActiveTenant();
    if (!context || !notifications.some((item) => item.id === id)) return;

    const path = tenantAlertsPath(context.tenantId);
    if (!path) return;
    try {
      if (!isTenantSessionActive(context)) return;
      await deleteDoc(doc(db, `${path}/${id}`));
    } catch (error) {
      logFirestoreFailure('delete this teacher-owned alert', error);
    }
  };

  const handleSendAlertSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitInProgressRef.current) return;
    const context = getActiveTenant();
    const title = newTitle.trim();
    const message = newMessage.trim();
    if (!context || !title || !message) return;
    if (newClass !== 'All Classes' && !classesList.some((classItem) => classItem.name === newClass)) {
      console.error('[Alerts] Alert submission blocked because the selected class does not belong to the active teacher.');
      return;
    }

    const path = tenantAlertsPath(context.tenantId);
    if (!path) return;
    submitInProgressRef.current = true;
    setIsSubmitting(true);

    const payloadKey = buildAlertPayloadKey({
      title,
      message,
      category: newCategory,
      priority: newPriority,
      targetClass: newClass,
      recipientPhone,
    });

    try {
      let isWhatsAppSent = false;
      if (triggerAlertsSettings?.autoWhatsAppNotif && recipientPhone.trim()) {
        // Current in-file implementation is simulation only; do not store a false delivery claim.
        const result = await triggerWhatsAppCloudAPI(recipientPhone.trim(), title, message, newClass);
        isWhatsAppSent = result.status === 'sent';
      }

      if (!isTenantSessionActive(context)) {
        throw new Error('Authenticated tenant changed before the alert could be saved.');
      }

      if (pendingAlertPayloadKeyRef.current !== payloadKey || !pendingAlertIdRef.current) {
        // Retain this generated ID after ambiguous network failures; a retry of the same payload
        // uses setDoc with the same ID instead of creating a duplicate alert document.
        pendingAlertIdRef.current = doc(collection(db, path)).id;
        pendingAlertPayloadKeyRef.current = payloadKey;
      }
      const alertRef = doc(db, `${path}/${pendingAlertIdRef.current}`);
      await runTransaction(db, async (transaction) => {
        const existingSnapshot = await transaction.get(alertRef);
        if (existingSnapshot.exists()) {
          const existing = existingSnapshot.data();
          const isSamePendingAlert = existing.title === title
            && existing.message === message
            && existing.category === newCategory
            && existing.priority === newPriority
            && existing.targetClass === newClass
            && existing.sender === 'Tigerr_Alert System';
          if (!isSamePendingAlert) {
            throw new Error('Pending alert ID collision; refusing to overwrite an existing record.');
          }
          // The same pending ID means a prior response may have been lost after commit.
          // Leave that existing record untouched (including its current read/unread state).
          return;
        }
        transaction.set(alertRef, {
          title,
          message,
          category: newCategory,
          priority: newPriority,
          targetClass: newClass,
          isRead: false,
          sender: 'Tigerr_Alert System',
          createdAt: serverTimestamp(),
          timestamp: 'Just now',
          whatsappSent: isWhatsAppSent,
        });
      });

      if (!isTenantSessionActive(context)) return;
      pendingAlertIdRef.current = null;
      pendingAlertPayloadKeyRef.current = null;
      setNewTitle('');
      setNewMessage('');
      setRecipientPhone('');
      setIsCreateModalOpen(false);
    } catch (error) {
      logFirestoreFailure('create an alert for this teacher', error);
    } finally {
      submitInProgressRef.current = false;
      setIsSubmitting(false);
    }
  };

  // Category Icon Helper
  const getCategoryIcon = (category: string) => {
    switch (category) {
      case 'Fees':
        return <Wallet className="h-4 w-4 text-orange-500" />;
      case 'Attendance':
        return <Users className="h-4 w-4 text-rose-500" />;
      case 'Exams':
        return <Calendar className="h-4 w-4 text-purple-500" />;
      default:
        return <Megaphone className="h-4 w-4 text-blue-500" />;
    }
  };

  // Bottom Navbar Options
  const navigationTabs = [
    { id: "home", label: "Home", icon: Home, href: "/" },
    { id: "classes", label: "Classes", icon: GraduationCap, href: "/departments" },
    { id: "attendance", label: "Attendance", icon: Users, href: "/attendance" },
    { id: "fees", label: "Fees", icon: Wallet, href: "/fees" },
    { id: "settings", label: "Settings", icon: Settings, href: "/settings" },
  ];

  return (
    <div className={`min-h-screen bg-[#f8fafc] dark:bg-[#070b13] text-slate-900 dark:text-slate-100 transition-colors duration-300 pb-28 ${isDark ? 'dark' : ''}`}>

      {/* TOP HEADER */}
      <div className="w-full bg-white/60 dark:bg-[#070b13]/60 backdrop-blur-md sticky top-0 z-40 border-b border-slate-200/50 dark:border-slate-800/50">
        <div className="mx-auto max-w-2xl px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {/* BACK TO DASHBOARD BUTTON */}
            <Link
              to="/dashboard"
              className="w-9 h-9 rounded-full bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white flex items-center justify-center shadow-md shadow-orange-500/30 transition-all active:scale-95 flex-shrink-0"
              title="Back to Dashboard"
            >
              <ArrowLeft className="h-5 w-5 stroke-[2.5]" />
            </Link>

            <div className="relative flex items-center gap-2">
              <h1 className="text-xl font-black tracking-tight">Alerts & Notices</h1>
              {unreadCount > 0 && (
                <span className="bg-orange-500 text-white text-[9px] font-black px-1.5 py-0.2 rounded-full animate-pulse">
                  {unreadCount} New
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setIsCreateModalOpen(true)}
              className="bg-orange-500 text-white hover:bg-orange-600 px-3.5 py-1.5 rounded-2xl text-xs font-black flex items-center gap-1.5 shadow-md transition-all active:scale-95"
            >
              <Plus className="h-4 w-4 stroke-[2.5]" /> Send Alert
            </button>

            <button
              onClick={() => setIsDark(!isDark)}
              className="flex h-7 w-12 items-center rounded-full bg-slate-200/60 p-0.5 transition-all dark:bg-slate-800 border border-slate-300/30"
            >
              <div className={`flex h-5 w-5 items-center justify-center rounded-full bg-white text-orange-500 shadow-sm transition-all ${isDark ? 'translate-x-5 bg-slate-950 text-yellow-400' : ''}`}>
                {isDark ? <Moon className="h-3 w-3 fill-current" /> : <Sun className="h-3 w-3 fill-current" />}
              </div>
            </button>
          </div>
        </div>
      </div>

      {/* MAIN CONTAINER */}
      <main className="mx-auto max-w-2xl px-4 py-5 space-y-5">

        {/* HERO HEADER SUMMARY BANNER */}
        <div className="bg-gradient-to-br from-amber-500 via-orange-500 to-orange-600 rounded-3xl p-5 text-white shadow-xl relative overflow-hidden flex items-center justify-between">
          <div className="space-y-1 z-10">
            <div className="inline-flex items-center gap-1.5 bg-white/20 px-2.5 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider backdrop-blur-sm">
              <Sparkles className="h-3 w-3" /> Live Notification Center
            </div>
            <h2 className="text-lg font-black">
              {unreadCount > 0 ? `You have ${unreadCount} unread alert${unreadCount > 1 ? 's' : ''}` : 'All caught up! No unread alerts'}
            </h2>
            <p className="text-xs text-orange-100 font-medium max-w-xs">
              Directly synced with Firestore database & live WhatsApp automation alerts.
            </p>

            {triggerAlertsSettings && (
              <div className="flex items-center gap-2 pt-1">
                <span className={`text-[9px] font-bold px-2 py-0.5 rounded-md backdrop-blur-md ${triggerAlertsSettings.autoWhatsAppNotif ? 'bg-emerald-500/30 text-emerald-100' : 'bg-white/20'}`}>
                  WhatsApp: {triggerAlertsSettings.autoWhatsAppNotif ? 'ON' : 'OFF'}
                </span>
                <span className="text-[9px] font-bold bg-white/20 px-2 py-0.5 rounded-md backdrop-blur-md">
                  Min Attendance: {triggerAlertsSettings.lowAttendanceLimit}%
                </span>
              </div>
            )}
          </div>

          <div className="h-16 w-16 bg-white/10 rounded-2xl flex items-center justify-center backdrop-blur-md z-10 flex-shrink-0 shadow-inner">
            <Bell className="h-8 w-8 text-white" />
          </div>

          <Megaphone className="absolute -left-6 -bottom-6 h-32 w-32 text-white/10" />
        </div>

        {/* SEARCH & FILTERS BAR */}
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3.5 top-3 h-4 w-4 text-slate-400" />
              <input
                type="text"
                placeholder="Search alerts, classes or messages..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-white dark:bg-[#0c1222] border border-slate-200/80 dark:border-slate-800 rounded-2xl pl-10 pr-4 py-2.5 text-xs font-bold outline-none focus:border-orange-500 transition-all shadow-sm"
              />
            </div>

            {unreadCount > 0 && (
              <button
                onClick={handleMarkAllRead}
                className="bg-white dark:bg-[#0c1222] border border-slate-200/80 dark:border-slate-800 text-slate-700 dark:text-slate-300 hover:text-orange-500 px-3 py-2.5 rounded-2xl text-xs font-black flex items-center gap-1.5 shadow-sm transition-colors whitespace-nowrap"
                title="Mark all as read"
              >
                <CheckCheck className="h-4 w-4 text-emerald-500" />
                <span className="hidden sm:inline">Mark All Read</span>
              </button>
            )}
          </div>

          {/* Category Filter Pills */}
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none">
            {(['All', 'Unread', 'Fees', 'Attendance', 'Announcements'] as AlertCategory[]).map((cat) => {
              const isActive = selectedFilter === cat;
              return (
                <button
                  key={cat}
                  onClick={() => setSelectedFilter(cat)}
                  className={`px-3.5 py-1.5 rounded-2xl text-xs font-black whitespace-nowrap transition-all ${
                    isActive
                      ? 'bg-orange-500 text-white shadow-md shadow-orange-500/20'
                      : 'bg-white dark:bg-[#0c1222] text-slate-500 dark:text-slate-400 border border-slate-200/80 dark:border-slate-800 hover:text-slate-900 dark:hover:text-slate-100'
                  }`}
                >
                  {cat} {cat === 'Unread' && unreadCount > 0 ? `(${unreadCount})` : ''}
                </button>
              );
            })}
          </div>
        </div>

        {/* NOTIFICATIONS LIST */}
        {loading ? (
          <div className="bg-white dark:bg-[#0c1222] border border-slate-200/80 dark:border-slate-800 rounded-3xl p-12 text-center space-y-3">
            <Loader2 className="h-8 w-8 text-orange-500 animate-spin mx-auto" />
            <p className="text-xs font-bold text-slate-400">Loading live alerts from Firestore Database...</p>
          </div>
        ) : filteredNotifications.length === 0 ? (
          <div className="bg-white dark:bg-[#0c1222] border border-slate-200/80 dark:border-slate-800 rounded-3xl p-8 text-center space-y-3 shadow-sm">
            <div className="h-12 w-12 rounded-full bg-orange-500/10 text-orange-500 mx-auto flex items-center justify-center">
              <Bell className="h-6 w-6" />
            </div>
            <div>
              <h4 className="text-sm font-black">No Notifications Found</h4>
              <p className="text-xs text-slate-400 font-medium">
                There are no alerts matching your selected category filter in the database.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {filteredNotifications.map((notif) => (
              <div
                key={notif.id}
                onClick={() => handleMarkAsRead(notif.id)}
                className={`bg-white dark:bg-[#0c1222] border rounded-3xl p-4 shadow-sm transition-all cursor-pointer relative overflow-hidden ${
                  !notif.isRead
                    ? 'border-orange-300 dark:border-orange-950 bg-orange-50/20 dark:bg-orange-950/10'
                    : 'border-slate-200/80 dark:border-slate-800'
                }`}
              >
                {!notif.isRead && (
                  <div className="absolute top-0 left-0 bottom-0 w-1.5 bg-orange-500" />
                )}

                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3">
                    <div className="h-10 w-10 rounded-2xl bg-slate-100 dark:bg-slate-800/80 flex items-center justify-center flex-shrink-0 mt-0.5">
                      {getCategoryIcon(notif.category)}
                    </div>

                    <div className="space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        {notif.priority === 'high' && (
                          <span className="bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-200 dark:border-rose-900/40 text-[9px] font-black uppercase px-2 py-0.5 rounded-md flex items-center gap-1">
                            <AlertTriangle className="h-2.5 w-2.5" /> High Priority
                          </span>
                        )}

                        <span className="text-[9px] font-black uppercase bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 px-2 py-0.5 rounded-md">
                          {notif.category}
                        </span>

                        <span className="text-[10px] font-bold text-slate-400">
                          {notif.targetClass}
                        </span>

                        {notif.whatsappSent && (
                          <span className="text-[9px] font-bold bg-emerald-500/10 text-emerald-600 border border-emerald-200/50 px-1.5 py-0.2 rounded-md flex items-center gap-0.5">
                            <MessageSquare className="h-2.5 w-2.5" /> WhatsApp Sent
                          </span>
                        )}
                      </div>

                      <h4 className={`text-xs font-black ${!notif.isRead ? 'text-orange-600 dark:text-orange-400' : 'text-slate-900 dark:text-slate-100'}`}>
                        {notif.title}
                      </h4>

                      <p className="text-xs font-medium text-slate-600 dark:text-slate-300 leading-relaxed">
                        {notif.message}
                      </p>

                      <div className="flex items-center gap-3 pt-1 text-[10px] font-bold text-slate-400">
                        <span className="flex items-center gap-1">
                          <Clock className="h-3 w-3" /> {notif.timestamp}
                        </span>
                        <span>•</span>
                        <span>From: {notif.sender}</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-1 flex-shrink-0">
                    {!notif.isRead && (
                      <span className="h-2.5 w-2.5 rounded-full bg-orange-500" title="Unread" />
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteNotification(notif.id);
                      }}
                      className="text-slate-300 hover:text-rose-500 p-1 rounded-lg transition-colors"
                      title="Delete Alert"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

      </main>

      {/* CREATE / BROADCAST ALERT MODAL */}
      {isCreateModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-[#0c1222] border border-slate-200 dark:border-slate-800 rounded-3xl max-w-md w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
              <h3 className="text-sm font-black flex items-center gap-2">
                <Send className="h-4 w-4 text-orange-500" /> Broadcast New Alert
              </h3>
              <button
                onClick={() => setIsCreateModalOpen(false)}
                className="p-1 text-slate-400 hover:text-slate-600"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleSendAlertSubmit} className="space-y-3">
              <div>
                <label className="text-[11px] font-black text-slate-400 block mb-1">
                  Alert Title *
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Test Tomorrow or Fee Reminder"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  className="w-full bg-slate-50 dark:bg-[#070b13] border border-slate-200 dark:border-slate-800 rounded-2xl px-3.5 py-2 text-xs font-bold outline-none focus:border-orange-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[11px] font-black text-slate-400 block mb-1">
                    Category
                  </label>
                  <select
                    value={newCategory}
                    onChange={(e) => setNewCategory(e.target.value as any)}
                    className="w-full bg-slate-50 dark:bg-[#070b13] border border-slate-200 dark:border-slate-800 rounded-2xl px-3 py-2 text-xs font-bold outline-none focus:border-orange-500"
                  >
                    <option value="Announcements">Announcement</option>
                    <option value="Fees">Fee Notice</option>
                    <option value="Attendance">Attendance Warning</option>
                    <option value="Exams">Exam Update</option>
                  </select>
                </div>

                <div>
                  <label className="text-[11px] font-black text-slate-400 block mb-1">
                    Priority
                  </label>
                  <select
                    value={newPriority}
                    onChange={(e) => setNewPriority(e.target.value as PriorityLevel)}
                    className="w-full bg-slate-50 dark:bg-[#070b13] border border-slate-200 dark:border-slate-800 rounded-2xl px-3 py-2 text-xs font-bold outline-none focus:border-orange-500"
                  >
                    <option value="normal">Normal</option>
                    <option value="medium">Medium</option>
                    <option value="high">High (Urgent)</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="text-[11px] font-black text-slate-400 block mb-1">
                  Target Class
                </label>
                <select
                  value={newClass}
                  onChange={(e) => setNewClass(e.target.value)}
                  className="w-full bg-slate-50 dark:bg-[#070b13] border border-slate-200 dark:border-slate-800 rounded-2xl px-3.5 py-2 text-xs font-bold outline-none focus:border-orange-500"
                >
                  <option value="All Classes">All Classes (School-wide)</option>
                  {classesList.map((cls) => (
                    <option key={cls.id} value={cls.name}>
                      {cls.name} {cls.subject ? `(${cls.subject})` : ''}
                    </option>
                  ))}
                </select>
              </div>

              {triggerAlertsSettings?.autoWhatsAppNotif && (
                <div>
                  <label className="text-[11px] font-black text-emerald-500 flex items-center gap-1 mb-1">
                    <MessageSquare className="h-3 w-3" /> Parent's WhatsApp Number (Optional Direct Push)
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. +923001234567"
                    value={recipientPhone}
                    onChange={(e) => setRecipientPhone(e.target.value)}
                    className="w-full bg-slate-50 dark:bg-[#070b13] border border-emerald-500/30 dark:border-emerald-900/40 rounded-2xl px-3.5 py-2 text-xs font-bold outline-none focus:border-emerald-500"
                  />
                </div>
              )}

              <div>
                <label className="text-[11px] font-black text-slate-400 block mb-1">
                  Alert Message *
                </label>
                <textarea
                  rows={3}
                  required
                  placeholder="Type the alert message for students & parents..."
                  value={newMessage}
                  onChange={(e) => setNewMessage(e.target.value)}
                  className="w-full bg-slate-50 dark:bg-[#070b13] border border-slate-200 dark:border-slate-800 rounded-2xl p-3 text-xs font-bold outline-none focus:border-orange-500"
                />
              </div>

              <div className="pt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIsCreateModalOpen(false)}
                  className="flex-1 bg-slate-100 dark:bg-slate-800 py-2.5 rounded-2xl text-xs font-black text-slate-600 dark:text-slate-300 hover:bg-slate-200 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="flex-1 bg-orange-500 hover:bg-orange-600 text-white py-2.5 rounded-2xl text-xs font-black shadow-md flex items-center justify-center gap-1.5 transition-all disabled:opacity-50"
                >
                  {isSubmitting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <>
                      <Send className="h-3.5 w-3.5" /> Send Alert Now
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* FLOATING CIRCULAR BOTTOM NAVBAR (WITHOUT ALERTS) */}
      <div className="fixed bottom-4 left-0 right-0 z-50 flex justify-center px-4 pointer-events-none">
        <nav className="pointer-events-auto bg-white/95 dark:bg-[#0c1222]/95 backdrop-blur-xl border border-slate-200/80 dark:border-slate-800/80 shadow-[0_10px_40px_rgba(0,0,0,0.12)] rounded-full px-5 py-2 flex items-center justify-between gap-4 sm:gap-8 max-w-md w-full">
          {navigationTabs.map((tab) => {
            const Icon = tab.icon;
            const isActive =
              location.pathname === tab.href ||
              (tab.id === "fees" && location.pathname.includes("/fees")) ||
              (tab.id === "classes" && location.pathname.includes("/departments"));

            return (
              <Link
                key={tab.id}
                to={tab.href}
                className="flex flex-col items-center justify-center relative transition-transform duration-200 active:scale-95 group"
              >
                {isActive && (
                  <span className="absolute -top-1 w-1.5 h-1.5 bg-orange-500 rounded-full animate-pulse" />
                )}

                <div
                  className={`flex items-center justify-center transition-all duration-300 ${
                    isActive
                      ? "w-10 h-10 rounded-full bg-orange-500 text-white shadow-lg shadow-orange-500/40 scale-105"
                      : "w-10 h-10 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                  }`}
                >
                  <Icon className="h-5 w-5 stroke-[2.2]" />
                </div>

                <span
                  className={`text-[10px] font-black mt-0.5 transition-colors ${
                    isActive
                      ? "text-orange-500"
                      : "text-slate-400 dark:text-slate-500"
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
