import { Link, useLocation } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { useApp } from '@/contexts/AppContext';
import { ThemeToggle } from '@/components/ThemeToggle';
import {
  Calendar,
  Users,
  GraduationCap,
  BookOpen,
  Building2,
  Settings,
  Home,
  Clock,
  Menu,
  X,
  Layers,
  DoorOpen,
  ChevronRight,
  HelpCircle,
  FileText,
  PieChart,
  AlertCircle,
  Wallet
} from 'lucide-react';
import { useState, useLayoutEffect } from 'react';

const navigation = [
  { name: 'Dashboard', href: '/dashboard', icon: Home, color: 'from-blue-500 to-cyan-500' },
  { name: 'Classes', href: '/departments', icon: Building2, color: 'from-blue-500 to-cyan-500' },
  { name: 'Attendance', href: '/attendance', icon: Layers, color: 'from-blue-500 to-cyan-500' },
  { name: 'Fees', href: '/fees', icon: Wallet, color: 'from-blue-500 to-cyan-500' },
  { name: 'Quiz Management', href: '/quiz', icon: HelpCircle, color: 'from-blue-500 to-cyan-500' },
  { name: 'Reports', href: '/reports', icon: FileText, color: 'from-blue-500 to-cyan-500' },
  { name: 'Analytics', href: '/analytics', icon: PieChart, color: 'from-blue-500 to-cyan-500' },
  { name: 'Notes & Library', href: '/notes', icon: BookOpen, color: 'from-blue-500 to-cyan-500' },
  { name: 'Alerts And Notification', href: '/alerts', icon: AlertCircle, color: 'from-blue-500 to-cyan-500' },
  { name: 'Settings', href: '/settings', icon: Settings, color: 'from-blue-500 to-cyan-500' },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const { isDarkMode, toggleDarkMode } = useApp();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Synchronize HTML root element dark class directly on mount or state change
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (isDarkMode) {
      root.classList.add('dark');
      localStorage.setItem('theme', 'dark');
    } else {
      root.classList.remove('dark');
      localStorage.setItem('theme', 'light');
    }
  }, [isDarkMode]);

  return (
    <div className="min-h-screen bg-background relative overflow-hidden">
      {/* Animated Background Gradient */}
      <div className="fixed inset-0 -z-10 overflow-hidden pointer-events-none">
        <div className="absolute top-0 right-0 w-96 h-96 bg-gradient-to-bl from-blue-400/10 via-cyan-400/10 to-transparent rounded-full blur-3xl animate-float" />
        <div className="absolute bottom-0 left-0 w-80 h-80 bg-gradient-to-tr from-cyan-400/10 via-blue-400/10 to-transparent rounded-full blur-3xl animate-float" style={{ animationDelay: '2s' }} />
      </div>

      {/* Mobile sidebar backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/20 backdrop-blur-sm lg:hidden transition-all duration-300"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar - Liquid Glass Effect */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 w-72 transform transition-all duration-500 ease-out lg:translate-x-0',
          'backdrop-blur-2xl bg-gradient-to-b from-white/80 via-white/70 to-white/80 dark:from-gray-900/80 dark:via-gray-900/70 dark:to-gray-900/80',
          'border-r border-white/20 dark:border-gray-700/30',
          'shadow-2xl shadow-purple-500/5',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        {/* Gradient Overlay */}
        <div className="absolute inset-0 bg-gradient-to-br from-blue-500/5 via-purple-500/5 to-pink-500/5 pointer-events-none" />

        {/* Header - Logo click navigation fix */}
        <div className="relative flex h-16 items-center justify-between border-b border-white/10 dark:border-gray-700/30 px-6 backdrop-blur-xl">
          <Link to="/dashboard" className="flex items-center gap-3 group">
            <div className="relative p-2 rounded-2xl bg-gradient-to-br from-blue-500/10 to-purple-500/10 backdrop-blur-sm border border-white/20 group-hover:scale-110 transition-all duration-300 group-hover:shadow-lg group-hover:shadow-blue-500/20">
              <img src="/logo.png" alt="Curriflex Logo" className="h-8 w-8 object-contain" />
              <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-blue-500/20 to-purple-500/20 opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
            </div>
            <span className="text-lg font-bold text-gray-900 dark:text-white">
              EduTrack
            </span>
          </Link>
          <button
            onClick={() => setSidebarOpen(false)}
            className="lg:hidden p-2 rounded-xl hover:bg-white/10 dark:hover:bg-gray-800/50 transition-all duration-200 active:scale-95"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Navigation */}
        <nav className="relative flex flex-col gap-2 p-4 overflow-y-auto h-[calc(100vh-4rem)]">
          {navigation.map((item, index) => {
            const isActive = location.pathname === item.href;
            return (
              <Link
                key={item.name}
                to={item.href}
                onClick={() => setSidebarOpen(false)}
                className={cn(
                  'group relative flex items-center gap-3 px-4 py-3.5 rounded-2xl text-sm font-medium overflow-hidden',
                  'transition-all duration-300 ease-out',
                  isActive
                    ? 'text-white shadow-lg scale-[1.02]'
                    : 'text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white hover:scale-[1.01]'
                )}
                style={{
                  animation: `fade-in 0.5s ease-out ${index * 50}ms both`
                }}
              >
                {/* Active Background Gradient */}
                {isActive && (
                  <div className={`absolute inset-0 bg-gradient-to-r ${item.color} opacity-100 rounded-2xl`} />
                )}

                {/* Hover Background */}
                {!isActive && (
                  <div className="absolute inset-0 bg-gradient-to-r from-white/50 to-white/30 dark:from-gray-800/50 dark:to-gray-800/30 opacity-0 group-hover:opacity-100 transition-opacity duration-300 rounded-2xl backdrop-blur-sm" />
                )}

                {/* Glow Effect on Hover */}
                <div className={`absolute inset-0 bg-gradient-to-r ${item.color} opacity-0 group-hover:opacity-20 blur-xl transition-opacity duration-500 rounded-2xl`} />

                {/* Icon */}
                <div className="relative z-10">
                  <item.icon className={cn(
                    'h-5 w-5 transition-all duration-300',
                    isActive ? 'scale-110' : 'group-hover:scale-110'
                  )} />
                </div>

                {/* Text */}
                <span className="relative z-10">{item.name}</span>

                {/* Active Indicator */}
                {isActive && (
                  <div className="absolute right-3 w-1.5 h-8 bg-white/50 rounded-full" />
                )}
              </Link>
            );
          })}
        </nav>

        {/* Bottom Gradient Fade */}
        <div className="absolute bottom-0 left-0 right-0 h-24 bg-gradient-to-t from-white/90 dark:from-gray-900/90 to-transparent pointer-events-none" />
      </aside>

      {/* Main content */}
      <div className="lg:pl-72 transition-all duration-300">
        {/* Top bar - Liquid Glass Effect */}
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between px-4 lg:px-6 backdrop-blur-xl bg-white/70 dark:bg-gray-900/70 border-b border-white/20 dark:border-gray-700/30 shadow-sm">
          <button
            onClick={() => setSidebarOpen(true)}
            className="lg:hidden p-2.5 rounded-xl hover:bg-white/50 dark:hover:bg-gray-800/50 transition-all duration-200 active:scale-95 backdrop-blur-sm"
          >
            <Menu className="h-5 w-5" />
          </button>

          <div className="flex-1" />

          <ThemeToggle />
        </header>

        {/* Page content with subtle animation */}
        <main className="p-4 lg:p-8 animate-fade-in">
          {children}
        </main>
      </div>
    </div>
  );
}
