import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import type { Department, TimeConfig } from '@/types';
import { departmentService, classService, timeConfigService } from '@/services/firebaseService';

interface AppContextType {
  departments: Department[];
  timeConfig: TimeConfig | null;
  selectedDepartment: string | null;
  setSelectedDepartment: (id: string | null) => void;
  selectedYear: number | null;
  setSelectedYear: (year: number | null) => void;
  isLoading: boolean;
  isDarkMode: boolean;
  toggleDarkMode: () => void;
  refreshData: () => Promise<void>;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export function AppProvider({ children }: { children: ReactNode }) {
  const [departments, setDepartments] = useState<Department[]>([]);
  const [timeConfig, setTimeConfig] = useState<TimeConfig | null>(null);
  const [selectedDepartment, setSelectedDepartment] = useState<string | null>(null);
  const [selectedYear, setSelectedYear] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isDarkMode, setIsDarkMode] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('darkMode') === 'true';
    }
    return false;
  });

  const toggleDarkMode = () => {
    setIsDarkMode((prev) => {
      const newValue = !prev;
      localStorage.setItem('darkMode', String(newValue));
      return newValue;
    });
  };

  useEffect(() => {
    if (isDarkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDarkMode]);

  const fetchData = async () => {
    setIsLoading(true);
    try {
      const [depts, configs] = await Promise.all([
        departmentService.getAll(),
        timeConfigService.getByInstitutionType('college'),
      ]);
      setDepartments(depts);
      setTimeConfig(configs[0] || null);
    } catch (error) {
      console.error('Error fetching data:', error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const refreshData = async () => {
    await fetchData();
  };

  return (
    <AppContext.Provider
      value={{
        departments,
        timeConfig,
        selectedDepartment,
        setSelectedDepartment,
        selectedYear,
        setSelectedYear,
        isLoading,
        isDarkMode,
        toggleDarkMode,
        refreshData,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const context = useContext(AppContext);
  if (context === undefined) {
    throw new Error('useApp must be used within an AppProvider');
  }
  return context;
}
