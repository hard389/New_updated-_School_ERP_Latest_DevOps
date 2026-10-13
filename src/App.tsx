import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AppProvider } from "@/contexts/AppContext";
import { Layout } from "@/components/Layout";

// Auth & Public Pages
import LoadingPage from "./pages/LoadingPage";
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import SharedDocumentPage from "@/components/SharedDocumentPage";

// Main Dashboard Pages
import Dashboard from "./pages/Dashboard";
import ClassesPage from "./pages/ClassesPage";
import DepartmentsPage from "./pages/DepartmentsPage";
import Attendance from "./pages/attendance";
import Fees from "./pages/fees";
import Reports from "./pages/reports";  
import Analytics from "./pages/analytics";
import Notes from "./pages/notes";
import Alerts from "./pages/alerts"; 
import Quiz from "./pages/quiz";
import Settings from "./pages/settings";
import ExtraFee from "./components/fees/extrafee";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <AppProvider>
        <Toaster />
        <Sonner />
        <BrowserRouter>
          <Routes>
            {/* 1. INITIAL LOADING SCREEN */}
            <Route path="/" element={<LoadingPage />} />

            {/* 2. AUTHENTICATION PAGES */}
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />

            {/* 3. PUBLIC SHARE ROUTE */}
            <Route path="/notes/share" element={<SharedDocumentPage />} />

            {/* 4. MAIN APP ROUTES */}
            <Route
              path="/*"
              element={
                <Layout>
                  <Routes>
                    <Route path="dashboard" element={<Dashboard />} />
                    <Route path="classes" element={<ClassesPage />} />
                    <Route path="departments" element={<DepartmentsPage />} />
                    <Route path="attendance" element={<Attendance />} />
                    <Route path="fees" element={<Fees />} />
                    <Route path="reports" element={<Reports />} />
                    <Route path="analytics" element={<Analytics />} />
                    <Route path="notes" element={<Notes />} />
                    <Route path="alerts" element={<Alerts />} />
                    <Route path="quiz" element={<Quiz />} />
                    <Route path="settings" element={<Settings />} />
                    <Route path="extra-fee" element={<ExtraFee />} />
                    {/* Fallback to dashboard instead of loading screen */}
                    <Route path="*" element={<Navigate to="/dashboard" replace />} />
                  </Routes>
                </Layout>
              }
            />
          </Routes>
        </BrowserRouter>
      </AppProvider>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
