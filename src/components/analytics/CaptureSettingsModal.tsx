import React, { useState, useEffect } from 'react';
import { X, Settings, Check, Sparkles, Award, GraduationCap, CheckCircle2 } from 'lucide-react';

// Exporting the CaptureCriteria type used in StudentCaptureSection
export type CaptureCriteria = 'Weighted Score' | 'Quiz Marks' | 'Attendance Rate';

interface CaptureSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentCriteria: CaptureCriteria;
  onSaveCriteria: (newCriteria: CaptureCriteria) => void;
}

export const CaptureSettingsModal: React.FC<CaptureSettingsModalProps> = ({
  isOpen,
  onClose,
  currentCriteria,
  onSaveCriteria,
}) => {
  const [selectedCriteria, setSelectedCriteria] = useState<CaptureCriteria>(currentCriteria);

  useEffect(() => {
    setSelectedCriteria(currentCriteria);
  }, [currentCriteria, isOpen]);

  if (!isOpen) return null;

  const options: {
    id: CaptureCriteria;
    title: string;
    description: string;
    icon: React.ReactNode;
    badge: string;
  }[] = [
    {
      id: 'Weighted Score',
      title: 'Weighted Score Formula',
      description: 'Calculates top 4 representatives using 40% Attendance + 60% Quiz Marks weighting.',
      icon: <Award className="h-5 w-5 text-orange-500" />,
      badge: 'Recommended',
    },
    {
      id: 'Quiz Marks',
      title: 'Quiz Marks Priority',
      description: 'Captures representative students strictly based on their total quiz performance.',
      icon: <GraduationCap className="h-5 w-5 text-blue-500" />,
      badge: 'Academic',
    },
    {
      id: 'Attendance Rate',
      title: 'Attendance Priority',
      description: 'Filter student categories purely based on their overall attendance logs.',
      icon: <CheckCircle2 className="h-5 w-5 text-emerald-500" />,
      badge: 'Regularity',
    },
  ];

  const handleSave = () => {
    onSaveCriteria(selectedCriteria);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md p-4 animate-in fade-in duration-200">
      <div className="w-full max-w-md bg-white dark:bg-[#0c1222] border-2 border-orange-400/50 dark:border-slate-800 rounded-3xl p-6 shadow-2xl space-y-6 text-slate-900 dark:text-slate-100 relative overflow-hidden">
        
        {/* Top Decorative Neon Accent */}
        <div className="absolute top-0 left-0 right-0 h-1.5 bg-gradient-to-r from-orange-500 via-amber-500 to-rose-500" />

        {/* Modal Header */}
        <div className="flex items-center justify-between pt-1 border-b border-slate-100 dark:border-slate-800/80 pb-4">
          <div className="flex items-center gap-2.5">
            <div className="p-2.5 rounded-2xl bg-orange-100 dark:bg-orange-950/80 text-orange-600 dark:text-orange-400">
              <Settings className="h-5 w-5 animate-spin" style={{ animationDuration: '10s' }} />
            </div>
            <div>
              <h3 className="text-base font-black text-slate-900 dark:text-white flex items-center gap-1.5">
                Capture Settings <Sparkles className="h-4 w-4 text-amber-500 fill-amber-500" />
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 font-bold">
                Choose evaluation rule for 4 student categories
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Options List */}
        <div className="space-y-3">
          {options.map((opt) => {
            const isSelected = selectedCriteria === opt.id;
            return (
              <div
                key={opt.id}
                onClick={() => setSelectedCriteria(opt.id)}
                className={`p-4 rounded-2xl border-2 transition-all cursor-pointer flex items-start gap-3.5 relative ${
                  isSelected
                    ? 'border-orange-500 bg-orange-500/5 dark:bg-orange-950/20 shadow-md shadow-orange-500/10'
                    : 'border-slate-200 dark:border-slate-800/80 hover:border-orange-300 dark:hover:border-slate-700 bg-slate-50/50 dark:bg-[#070b13]'
                }`}
              >
                <div className="mt-0.5">{opt.icon}</div>
                <div className="flex-1 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-black text-slate-900 dark:text-white">
                      {opt.title}
                    </span>
                    <span className="text-[10px] font-black uppercase px-2 py-0.5 rounded-md bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                      {opt.badge}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 font-medium leading-relaxed">
                    {opt.description}
                  </p>
                </div>

                {isSelected && (
                  <div className="h-5 w-5 rounded-full bg-orange-500 text-white flex items-center justify-center text-xs shrink-0 mt-0.5">
                    <Check className="h-3.5 w-3.5 stroke-[3]" />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Modal Actions */}
        <div className="flex items-center gap-3 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 py-3 rounded-2xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 font-black text-xs transition-all"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="flex-1 py-3 rounded-2xl bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 active:scale-95 text-white font-black text-xs shadow-lg shadow-orange-500/30 transition-all"
          >
            Save Criteria
          </button>
        </div>

      </div>
    </div>
  );
};
