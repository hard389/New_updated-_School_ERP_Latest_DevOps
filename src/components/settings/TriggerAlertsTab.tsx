import React, { useState, useEffect } from 'react';
import { 
  AlertCircle, 
  Save, 
  CheckCircle2, 
  Loader2, 
  Bell, 
  MessageSquare, 
  Smartphone 
} from 'lucide-react';
import { db, auth } from "../../lib/firebase"; 
import { doc, getDoc, setDoc } from 'firebase/firestore';

export interface Thresholds {
  lowAttendanceLimit: number;
  autoSendSms: boolean;
  autoWhatsAppNotif: boolean;
}

interface TriggerAlertsTabProps {
  userId?: string;
  thresholds?: Thresholds;
  setThresholds?: React.Dispatch<React.SetStateAction<Thresholds>>;
}

const DEFAULT_THRESHOLDS: Thresholds = {
  lowAttendanceLimit: 75,
  autoSendSms: true,
  autoWhatsAppNotif: true,
};

export default function TriggerAlertsTab({ 
  userId, 
  thresholds: propThresholds, 
  setThresholds: propSetThresholds 
}: TriggerAlertsTabProps) {

  // Dynamic User Document ID fallback strategy
  const userDocId = userId || auth?.currentUser?.email || "admin@gmail.com";

  // Internal State
  const [localThresholds, setLocalThresholds] = useState<Thresholds>(propThresholds || DEFAULT_THRESHOLDS);
  const [loading, setLoading] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [showNotification, setShowNotification] = useState<boolean>(false);

  // Sync internal state with props if provided
  const thresholds = propThresholds || localThresholds;
  const updateThresholds = (newVal: Thresholds) => {
    if (propSetThresholds) propSetThresholds(newVal);
    setLocalThresholds(newVal);
  };

  // 1. Fetch saved settings from Firestore on Mount
  useEffect(() => {
    const fetchAlertSettings = async () => {
      if (!userDocId) return;
      setLoading(true);
      try {
        const docRef = doc(db, 'users', userDocId, 'settings', 'trigger_alerts');
        const docSnap = await getDoc(docRef);

        if (docSnap.exists()) {
          const data = docSnap.data() as Thresholds;
          updateThresholds(data);
        }
      } catch (error) {
        console.error('Error fetching alert settings:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchAlertSettings();
  }, [userDocId]);

  // 2. Save settings to Firestore
  const handleSaveToFirestore = async () => {
    setSaving(true);
    try {
      const docRef = doc(db, 'users', userDocId, 'settings', 'trigger_alerts');
      await setDoc(docRef, {
        ...thresholds,
        updatedAt: new Date().toISOString(),
      }, { merge: true });

      setShowNotification(true);
    } catch (error) {
      console.error('Error saving trigger alert settings:', error);
      alert('Failed to save settings!');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto p-2 sm:p-4">
      {loading ? (
        <div className="flex flex-col items-center justify-center py-16 space-y-3">
          <Loader2 className="w-8 h-8 text-orange-500 animate-spin" />
          <p className="text-xs text-slate-400 font-bold">Loading Alert Rules...</p>
        </div>
      ) : (
        /* MAIN OUTER CARD WITH GLOWING BORDER ONLY */
        <div className="relative rounded-[32px] p-[2.5px] bg-gradient-to-r from-orange-500 via-amber-400 to-orange-500 shadow-[0_0_25px_rgba(249,115,22,0.3)]">
          
          {/* INNER MAIN CONTAINER */}
          <div className="bg-white dark:bg-[#0c1222] w-full rounded-[30px] p-6 shadow-2xl space-y-6">
            
            {/* Header */}
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-4">
              <div>
                <h3 className="text-base font-black flex items-center gap-2 text-slate-800 dark:text-slate-100 uppercase tracking-wide">
                  <AlertCircle className="h-5 w-5 text-orange-500" /> Automatic Alert Triggers
                </h3>
                <p className="text-xs text-slate-400 font-medium mt-1">
                  Configure real-time automated warning thresholds for students & parents.
                </p>
              </div>
              <span className="text-[10px] font-black bg-orange-500/10 text-orange-600 px-3 py-1 rounded-full uppercase tracking-wider shrink-0 border border-orange-500/20">
                Live Engine
              </span>
            </div>

            {/* CONTROLS SECTION */}
            <div className="space-y-6">
              
              {/* Control 1: Attendance Slider */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-black text-slate-600 dark:text-slate-300 flex items-center gap-2">
                    <Bell className="w-4 h-4 text-orange-500" /> Low Attendance Threshold
                  </label>
                  <span className="text-xs font-black bg-rose-500/10 text-rose-500 border border-rose-500/20 px-3 py-1 rounded-xl shadow-sm">
                    &lt; {thresholds.lowAttendanceLimit}%
                  </span>
                </div>

                <div className="flex items-center gap-4 pt-1">
                  <span className="text-[10px] font-bold text-slate-400">50%</span>
                  <input
                    type="range"
                    min="50"
                    max="90"
                    value={thresholds.lowAttendanceLimit}
                    onChange={(e) => updateThresholds({ ...thresholds, lowAttendanceLimit: parseInt(e.target.value) })}
                    className="flex-1 accent-orange-500 h-2 bg-slate-100 dark:bg-slate-800 rounded-lg cursor-pointer"
                  />
                  <span className="text-[10px] font-bold text-slate-400">90%</span>
                </div>
              </div>

              <div className="border-t border-slate-100 dark:border-slate-800/60" />

              {/* Control 2 & 3: Toggles */}
              <div className="space-y-4">
                
                {/* Auto SMS */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <Smartphone className="w-4 h-4 text-orange-500" />
                    <div>
                      <p className="text-xs font-bold text-slate-700 dark:text-slate-200">Auto SMS Alert on Low Rating</p>
                      <p className="text-[10px] text-slate-400">Trigger immediate SMS warning to primary guardian</p>
                    </div>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={thresholds.autoSendSms}
                      onChange={(e) => updateThresholds({ ...thresholds, autoSendSms: e.target.checked })}
                      className="sr-only peer"
                    />
                    <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer dark:bg-slate-800 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-slate-600 peer-checked:bg-orange-500"></div>
                  </label>
                </div>

                {/* WhatsApp Notification */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <MessageSquare className="w-4 h-4 text-emerald-500" />
                    <div>
                      <p className="text-xs font-bold text-slate-700 dark:text-slate-200">WhatsApp Integration</p>
                      <p className="text-[10px] text-slate-400">Dispatch structured automated messages via API</p>
                    </div>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={thresholds.autoWhatsAppNotif}
                      onChange={(e) => updateThresholds({ ...thresholds, autoWhatsAppNotif: e.target.checked })}
                      className="sr-only peer"
                    />
                    <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer dark:bg-slate-800 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-slate-600 peer-checked:bg-orange-500"></div>
                  </label>
                </div>

              </div>

            </div>

            {/* SAVE BUTTON */}
            <div className="pt-2">
              <button
                onClick={handleSaveToFirestore}
                disabled={saving}
                className="w-full bg-orange-500 hover:bg-orange-600 text-white font-black py-4 px-6 rounded-full shadow-lg shadow-orange-500/25 active:scale-[0.98] transition-all duration-200 flex items-center justify-center gap-2 text-sm uppercase tracking-wider cursor-pointer"
              >
                {saving ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <Save className="w-5 h-5" />
                )}
                <span>Save Alert Rules</span>
              </button>
            </div>

          </div>
        </div>
      )}

      {/* ================= BEAUTIFUL GLOWING SUCCESS POPUP ================= */}
      {showNotification && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="relative w-full max-w-xs rounded-[28px] p-[2px] bg-gradient-to-r from-orange-500 via-amber-500 to-orange-500 shadow-[0_0_25px_rgba(249,115,22,0.4)]">
            <div className="bg-white dark:bg-[#0c1222] rounded-[26px] p-6 text-center space-y-4 animate-in fade-in zoom-in-95 duration-200">
              <div className="w-14 h-14 bg-emerald-500/10 text-emerald-500 rounded-2xl border border-emerald-500/20 flex items-center justify-center mx-auto shadow-inner">
                <CheckCircle2 className="w-8 h-8 stroke-[2.5]" />
              </div>

              <div className="space-y-1">
                <h4 className="text-base font-black text-slate-800 dark:text-slate-100">
                  Settings Saved!
                </h4>
                <p className="text-xs text-slate-500 dark:text-slate-400 font-medium">
                  Trigger alert thresholds updated successfully in Firebase.
                </p>
              </div>

              <button
                onClick={() => setShowNotification(false)}
                className="w-full bg-orange-500 hover:bg-orange-600 text-white font-black py-3 rounded-xl text-xs transition-colors shadow-md shadow-orange-500/20 cursor-pointer"
              >
                Continue
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
