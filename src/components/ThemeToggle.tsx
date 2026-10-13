import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { useApp } from '@/contexts/AppContext';

export function ThemeToggle() {
  const { isDarkMode, toggleDarkMode } = useApp();
  const [isMounted, setIsMounted] = useState(false);
  const shouldReduceMotion = useReducedMotion();

  useEffect(() => {
    setIsMounted(true);
  }, []);

  // Premium, heavy mechanical spring physics
  const springConfig = {
    type: 'spring',
    stiffness: 300,
    damping: 20,
    mass: 1.5,
  };

  const environmentSpring = {
    type: 'spring',
    stiffness: 150,
    damping: 22,
    mass: 1,
  };

  if (!isMounted) return <div className="w-[96px] h-[48px] rounded-full bg-slate-200/50 animate-pulse" />;

  return (
    <div
      role="switch"
      aria-checked={isDarkMode}
      tabIndex={0}
      onClick={toggleDarkMode}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggleDarkMode();
        }
      }}
      className={`
        group relative flex h-[48px] w-[96px] cursor-pointer items-center rounded-full p-1.5 
        transition-all duration-700 ease-[cubic-bezier(0.25,1,0.5,1)]
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2
        shadow-[inset_0_4px_10px_rgba(0,0,0,0.2),inset_0_-2px_6px_rgba(255,255,255,0.1),0_2px_12px_rgba(0,0,0,0.1)]
      `}
      style={{
        background: isDarkMode 
          ? 'linear-gradient(180deg, #09111e 0%, #172554 100%)' 
          : 'linear-gradient(180deg, #38bdf8 0%, #e0f2fe 100%)',
        border: '1px solid',
        borderColor: isDarkMode ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.4)',
      }}
    >
      {/* --- BACKGROUND PARALLAX ENVIRONMENT --- */}
      <div className="absolute inset-0 overflow-hidden rounded-full pointer-events-none">
        
        {/* Deep Space Stars (Dark Mode) */}
        <AnimatePresence>
          {isDarkMode && (
            <motion.div
              initial={{ opacity: 0, y: 15, scale: 0.8 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 15, scale: 0.8 }}
              transition={{ duration: 0.7, ease: 'easeOut' }}
              className="absolute inset-0"
            >
              {/* Complex 4-point SVG stars for a sharper, premium look */}
              {[
                { top: '15%', left: '20%', size: 8, delay: 0 },
                { top: '40%', left: '45%', size: 5, delay: 0.2 },
                { top: '25%', left: '70%', size: 10, delay: 0.4 },
                { top: '65%', left: '30%', size: 6, delay: 0.1 },
                { top: '75%', left: '60%', size: 4, delay: 0.3 },
              ].map((star, i) => (
                <motion.svg
                  key={`star-${i}`}
                  viewBox="0 0 24 24"
                  fill="white"
                  className="absolute"
                  style={{ top: star.top, left: star.left, width: star.size, height: star.size }}
                  initial={{ opacity: 0.2, rotate: 0 }}
                  animate={{ 
                    opacity: [0.2, 1, 0.2],
                    rotate: [0, 90, 180]
                  }}
                  transition={{
                    duration: 3 + Math.random() * 2,
                    repeat: Infinity,
                    delay: star.delay,
                    ease: "linear"
                  }}
                >
                  <path d="M12 0L13.5 10.5L24 12L13.5 13.5L12 24L10.5 13.5L0 12L10.5 10.5L12 0Z" />
                </motion.svg>
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Fluffy SVG Clouds (Light Mode) */}
        <AnimatePresence>
          {!isDarkMode && (
            <motion.div
              initial={{ opacity: 0, x: -30, y: 10 }}
              animate={{ opacity: 1, x: 0, y: 0 }}
              exit={{ opacity: 0, x: -30, y: 10 }}
              transition={environmentSpring}
              className="absolute inset-0"
            >
              {/* Back Cloud */}
              <svg className="absolute top-[8px] right-[12px] w-[34px] opacity-70" viewBox="0 0 24 24" fill="white">
                <path d="M17.5 19C19.9853 19 22 16.9853 22 14.5C22 12.1332 20.1783 10.1917 17.8596 10.0152C17.3828 7.18663 14.9398 5 12 5C9.06021 5 6.61718 7.18663 6.14037 10.0152C3.82173 10.1917 2 12.1332 2 14.5C2 16.9853 4.01472 19 6.5 19H17.5Z" />
              </svg>
              {/* Front Cloud */}
              <svg className="absolute bottom-[4px] right-[28px] w-[26px] opacity-95 drop-shadow-sm" viewBox="0 0 24 24" fill="white">
                <path d="M17.5 19C19.9853 19 22 16.9853 22 14.5C22 12.1332 20.1783 10.1917 17.8596 10.0152C17.3828 7.18663 14.9398 5 12 5C9.06021 5 6.61718 7.18663 6.14037 10.0152C3.82173 10.1917 2 12.1332 2 14.5C2 16.9853 4.01472 19 6.5 19H17.5Z" />
              </svg>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* --- THE KNOB (3D SUN / MOON) --- */}
      <motion.div
        layout
        transition={springConfig}
        className={`
          relative z-10 flex h-[36px] w-[36px] items-center justify-center rounded-full
          shadow-[0_4px_12px_rgba(0,0,0,0.3),inset_0_-2px_4px_rgba(0,0,0,0.2),inset_0_2px_4px_rgba(255,255,255,0.6)]
        `}
        style={{
          x: isDarkMode ? 48 : 0,
          background: isDarkMode 
            ? 'linear-gradient(135deg, #e2e8f0 0%, #94a3b8 100%)' // Premium Lunar Silver
            : 'linear-gradient(135deg, #FDF063 0%, #FF9900 100%)' // Fiery Sun Gold
        }}
        whileHover={!shouldReduceMotion ? { scale: 1.08, rotate: isDarkMode ? -5 : 5 } : {}}
        whileTap={!shouldReduceMotion ? { scale: 0.92 } : {}}
      >
        {/* Volumetric Glow Diffusion behind the knob */}
        <motion.div 
          className="absolute inset-0 -z-10 rounded-full blur-[8px]"
          animate={{
            background: isDarkMode ? 'rgba(148, 163, 184, 0.6)' : 'rgba(255, 153, 0, 0.6)',
            scale: isDarkMode ? 1.3 : 1.5,
            opacity: [0.6, 0.8, 0.6] // Pulsing glow effect
          }}
          transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
        />

        {/* Sun Corona Details - Fade & Rotate out in Dark Mode */}
        <motion.div
          animate={{
            rotate: isDarkMode ? 135 : 0,
            scale: isDarkMode ? 0 : 1,
            opacity: isDarkMode ? 0 : 1,
          }}
          transition={{ duration: 0.6, ease: [0.34, 1.56, 0.64, 1] }}
          className="absolute inset-0 flex items-center justify-center"
        >
          {/* Detailed inner sun ring */}
          <div className="absolute h-[24px] w-[24px] rounded-full border border-white/40" />
        </motion.div>

        {/* 3D Moon Craters - Fade & Slide in in Dark Mode */}
        <motion.div
          animate={{
            opacity: isDarkMode ? 1 : 0,
            scale: isDarkMode ? 1 : 0.4,
            rotate: isDarkMode ? 0 : -45,
          }}
          transition={{ duration: 0.6, ease: [0.34, 1.56, 0.64, 1] }}
          className="absolute inset-0"
        >
          <div className="absolute top-[6px] left-[18px] h-[10px] w-[10px] rounded-full bg-[#64748b]/50 shadow-[inset_1px_2px_3px_rgba(0,0,0,0.4),0_1px_1px_rgba(255,255,255,0.4)]" />
          <div className="absolute top-[20px] left-[8px] h-[6px] w-[6px] rounded-full bg-[#64748b]/50 shadow-[inset_1px_2px_3px_rgba(0,0,0,0.4),0_1px_1px_rgba(255,255,255,0.4)]" />
          <div className="absolute top-[22px] left-[22px] h-[5px] w-[5px] rounded-full bg-[#64748b]/50 shadow-[inset_1px_1px_2px_rgba(0,0,0,0.4),0_1px_1px_rgba(255,255,255,0.4)]" />
        </motion.div>
      </motion.div>

      {/* --- CINEMATIC PARTICLE SPARKLES (Triggered purely on switch) --- */}
      <AnimatePresence mode="wait">
        {isDarkMode && (
          <motion.div
            initial={{ opacity: 0, scale: 0, rotate: -90, y: 0 }}
            animate={{ opacity: [0, 1, 0], scale: [0, 1.5, 0], rotate: 45, y: -10 }}
            exit={{ opacity: 0, scale: 0 }}
            transition={{ duration: 0.7, ease: "easeOut" }}
            className="absolute z-20 pointer-events-none"
            style={{ left: '42px', top: '8px' }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path d="M12 0L14.59 9.41L24 12L14.59 14.59L12 24L9.41 14.59L0 12L9.41 9.41L12 0Z" fill="#E2E8F0" />
            </svg>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence mode="wait">
        {!isDarkMode && (
          <motion.div
            initial={{ opacity: 0, scale: 0, rotate: 90, y: 0 }}
            animate={{ opacity: [0, 1, 0], scale: [0, 1.5, 0], rotate: -45, y: 10 }}
            exit={{ opacity: 0, scale: 0 }}
            transition={{ duration: 0.7, ease: "easeOut" }}
            className="absolute z-20 pointer-events-none"
            style={{ right: '42px', bottom: '8px' }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M12 0L14.59 9.41L24 12L14.59 14.59L12 24L9.41 14.59L0 12L9.41 9.41L12 0Z" fill="#FDF063" />
            </svg>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
