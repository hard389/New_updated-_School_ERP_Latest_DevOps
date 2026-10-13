import { useState, useEffect, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { auth, db } from '@/lib/firebase';
import { signInWithEmailAndPassword, onAuthStateChanged, signOut } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { Sun, Moon, Eye, EyeOff, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';

// The registration flow stores teacher profiles at users/{normalizedEmail} with
// uid, email, role: "teacher", and active: true. Authentication alone is not
// sufficient to enter the app: this profile must exist and match the Auth user.
type TeacherIdentity = { uid: string; email: string | null };

const normalizeEmail = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLowerCase() : '';

const validateTeacherProfileData = (
  user: TeacherIdentity,
  profileData: Record<string, any> | undefined
): string | null => {
  const email = normalizeEmail(user.email);
  if (!user.uid || !email) {
    return 'This account does not have a valid email identity. Please contact support.';
  }
  if (!profileData) {
    return 'No teacher profile was found for this account. Please contact the administrator.';
  }

  // Fail closed if ownership fields are missing or don't match.
  if (typeof profileData.uid !== 'string' || profileData.uid !== user.uid) {
    return 'Your teacher profile could not be verified for this account.';
  }
  if (normalizeEmail(profileData.email) !== email) {
    return 'Your teacher profile email does not match this account.';
  }
  if (String(profileData.role ?? '').trim().toLowerCase() !== 'teacher') {
    return 'This account is not authorized to access the teacher portal.';
  }
  const status = String(profileData.status ?? profileData.accountStatus ?? '').trim().toLowerCase();
  if (
    profileData.active !== true ||
    profileData.disabled === true ||
    profileData.deleted === true ||
    ['disabled', 'inactive', 'suspended', 'deleted', 'blocked'].includes(status)
  ) {
    return 'This teacher account is inactive or disabled. Please contact the administrator.';
  }
  return null;
};

const getFriendlyAuthError = (error: any, context: 'login' | 'profile' = 'login'): string => {
  const code = String(error?.code ?? '').replace(/^firestore\//, '');

  if (context === 'profile') {
    if (code === 'permission-denied') {
      return 'Access to your teacher profile was denied. Please contact the administrator.';
    }
    if (
      code === 'unavailable' ||
      code === 'deadline-exceeded' ||
      code === 'auth/network-request-failed' ||
      code === 'network-request-failed' ||
      code === 'cancelled'
    ) {
      return 'Unable to verify your teacher profile because of a network problem. Please reconnect and try again.';
    }
    if (code === 'unauthenticated' || code === 'auth/user-token-expired') {
      return 'Your session has expired. Please sign in again.';
    }
    return 'Your teacher profile could not be verified. Access has been denied for your safety.';
  }

  if (
    code === 'auth/invalid-credential' ||
    code === 'auth/invalid-login-credentials' ||
    code === 'auth/wrong-password' ||
    code === 'auth/user-not-found'
  ) {
    return 'Invalid email or password. Please check your credentials.';
  }
  if (code === 'auth/invalid-email') {
    return 'The email address structure is badly formatted.';
  }
  if (code === 'auth/too-many-requests') {
    return 'Account temporarily locked due to too many failed attempts. Try again later.';
  }
  if (code === 'auth/user-disabled') {
    return 'This account has been disabled. Please contact the administrator.';
  }
  if (
    code === 'auth/network-request-failed' ||
    code === 'unavailable' ||
    code === 'deadline-exceeded' ||
    code === 'network-request-failed'
  ) {
    return 'Unable to connect to Firebase. Check your internet connection and try again.';
  }
  if (code === 'permission-denied') {
    return 'Access was denied while verifying your account. Please contact the administrator.';
  }
  if (code === 'auth/operation-not-allowed') {
    return 'Email and password sign-in is currently unavailable. Please contact the administrator.';
  }
  return 'Unable to sign in right now. Please try again.';
};

export default function LoginPage() {
  const navigate = useNavigate();
  const [isDark, setIsDark] = useState(true);

  // Form & Interaction States
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  // Async Operation States
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Observer sequencing prevents stale profile reads from an old session/tenant
  // from navigating after logout or after another account signs in.
  const mountedRef = useRef(true);
  const authInitializedRef = useRef(false);
  const authEventSequenceRef = useRef(0);
  const loginRequestInFlightRef = useRef(false);
  const redirectedUidRef = useRef<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    let disposed = false;

    const unsubscribe = onAuthStateChanged(
      auth,
      async (user) => {
        const eventSequence = ++authEventSequenceRef.current;
        authInitializedRef.current = true;

        if (!user) {
          redirectedUidRef.current = null;
          // Do not let the initial signed-out event undo the loading state of a
          // login request that is currently in progress.
          if (!loginRequestInFlightRef.current && !disposed) setLoading(false);
          return;
        }

        if (disposed) return;
        setLoading(true);
        setError('');

        try {
          const emailId = normalizeEmail(user.email);
          if (!emailId || !user.uid || emailId.includes('/')) {
            throw { code: 'profile/invalid-identity' };
          }

          // Only the authenticated user's normalized email tenant is read.
          // No UID/global collection fallback and no hardcoded tenant identity.
          const profileRef = doc(db, 'users', emailId);
          const profileSnap = await getDoc(profileRef);
          const profileData = profileSnap.exists()
            ? (profileSnap.data() as Record<string, any>)
            : undefined;
          const profileError = validateTeacherProfileData(
            { uid: user.uid, email: user.email },
            profileData
          );

          if (disposed || eventSequence !== authEventSequenceRef.current) return;
          if (auth.currentUser?.uid !== user.uid) return;

          if (profileError) {
            // Set the reason before signOut; the signed-out observer intentionally
            // preserves this message rather than clearing it during the callback.
            setError(profileError);
            try {
              await signOut(auth);
            } catch {
              // Fail closed: don't navigate. Route guards must also validate auth.
            }
            if (
              !disposed &&
              (!auth.currentUser || auth.currentUser.uid === user.uid)
            ) {
              setLoading(false);
            }
            return;
          }

          if (redirectedUidRef.current !== user.uid) {
            redirectedUidRef.current = user.uid;
            navigate('/dashboard', { replace: true });
          }
          if (!disposed) setLoading(false);
        } catch (verificationError: any) {
          if (disposed || eventSequence !== authEventSequenceRef.current) return;
          if (auth.currentUser?.uid !== user.uid) return;

          const profileMessage = getFriendlyAuthError(verificationError, 'profile');
          setError(profileMessage);
          try {
            await signOut(auth);
          } catch {
            // Do not grant access if we couldn't complete profile verification.
          }
          if (
            !disposed &&
            (!auth.currentUser || auth.currentUser.uid === user.uid)
          ) {
            setLoading(false);
          }
        }
      },
      (observerError) => {
        if (disposed) return;
        ++authEventSequenceRef.current;
        authInitializedRef.current = true;
        setLoading(false);
        setError(getFriendlyAuthError(observerError, 'profile'));
      }
    );

    return () => {
      disposed = true;
      mountedRef.current = false;
      ++authEventSequenceRef.current;
      unsubscribe();
    };
  }, [navigate]);

  // Sync current layout with HTML document classList
  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDark]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loginRequestInFlightRef.current) return;

    if (!authInitializedRef.current) {
      setError('Please wait while your existing session is checked, then try again.');
      return;
    }
    // If a session already exists, the Auth observer must verify its profile;
    // don't race a second sign-in attempt against that verification.
    if (auth.currentUser) {
      // The observer owns verification/navigation for this existing session.
      // If verification failed and signOut was denied, don't trap the form in loading.
      return;
    }

    const cleanEmail = normalizeEmail(email);
    if (!cleanEmail) {
      setError('Please enter a valid email address.');
      return;
    }
    if (!auth || !db) {
      setError('Firebase authentication is unavailable. Please contact the administrator.');
      return;
    }

    setEmail(cleanEmail);
    setError('');
    setLoading(true);
    loginRequestInFlightRef.current = true;
    const loginStartAuthSequence = authEventSequenceRef.current;

    try {
      await signInWithEmailAndPassword(auth, cleanEmail, password);
      // Navigation is exclusively handled by the Auth observer after profile
      // ownership/status verification, preventing duplicate/early redirects.
      setPassword('');
    } catch (loginError: any) {
      // Don't let a stale failed request overwrite a newer auth-state transition.
      if (
        mountedRef.current &&
        !auth.currentUser &&
        authEventSequenceRef.current === loginStartAuthSequence
      ) {
        setError(getFriendlyAuthError(loginError, 'login'));
        setLoading(false);
      }
    } finally {
      loginRequestInFlightRef.current = false;
      // After a successful sign-in keep loading until the Auth observer finishes
      // profile verification. Failed sign-in has no current user and stops here.
      if (mountedRef.current && !auth.currentUser) setLoading(false);
    }
  };

  return (
    <div className={`min-h-screen flex items-center justify-center relative overflow-hidden px-4 py-12 transition-colors duration-700 ease-in-out ${
      isDark 
        ? 'bg-gradient-to-b from-[#0B1224] via-[#0F172A] to-[#0B1224]' 
        : 'bg-gradient-to-b from-[#F8FAFC] via-[#F1F5F9] to-[#E2E8F0]'
    }`}>
      
      {/* Day/Night Controller */}
      <div className="absolute top-6 right-6 z-50 flex items-center gap-3">
        <button
          onClick={() => setIsDark(!isDark)}
          type="button"
          className={`relative w-16 h-9 rounded-full p-1 transition-all duration-500 shadow-lg border focus:outline-none ${
            isDark ? 'bg-[#131E35] border-orange-500/30' : 'bg-slate-200 border-slate-300'
          }`}
        >
          <div className={`w-7 h-7 rounded-full flex items-center justify-center transform transition-all duration-500 ease-out ${
            isDark ? 'translate-x-7 bg-gradient-to-r from-orange-500 to-amber-500 text-white' : 'translate-x-0 bg-white text-slate-600'
          }`}>
            {isDark ? <Moon className="w-3.5 h-3.5 fill-white stroke-white" /> : <Sun className="w-3.5 h-3.5 text-amber-500" />}
          </div>
        </button>
      </div>

      <div className="absolute top-0 right-0 w-[450px] h-[450px] bg-orange-500/10 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute bottom-0 left-0 w-[450px] h-[450px] bg-blue-500/5 rounded-full blur-[120px] pointer-events-none" />

      {/* Login Card */}
      <div className={`w-full max-w-md relative z-10 p-6 md:p-8 rounded-[2.5rem] border transition-all duration-700 ${
        isDark 
          ? 'bg-[#131E35]/90 border-slate-700/50 shadow-[0_25px_50px_-12px_rgba(0,0,0,0.5)] backdrop-blur-md' 
          : 'bg-white border-slate-200 shadow-[0_25px_50px_-12px_rgba(15,23,42,0.08)]'
      }`}>
        
        <div className="flex flex-col items-center text-center">
          <div className="w-36 h-36 mb-1 drop-shadow-md">
            <img 
              src="/ChatGPT Image Jul 20, 2026, 05_05_41 PM.png" 
              alt="EduTrack Enterprise Logo" 
              className="w-full h-full object-contain"
            />
          </div>
          <h2 className={`text-2xl font-bold tracking-tight ${isDark ? 'text-white' : 'text-slate-900'}`}>
            Teacher Portal
          </h2>
          <p className={`text-xs mt-1 font-medium ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
            Sign in to continue to your workspace
          </p>
        </div>

        {error && (
          <div className="p-3 mt-4 -mb-2 rounded-xl text-xs font-medium flex items-center gap-2 bg-red-500/10 border border-red-500/20 text-red-400 animate-pulse">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleLogin} className="mt-6 space-y-4" autoComplete="off">
          
          <div className="space-y-1">
            <Label htmlFor="email" className={`text-xs font-semibold ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>Email Address</Label>
            <Input 
              id="email" 
              type="email" 
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={`rounded-xl h-11 transition-all ${isDark ? 'bg-[#0B1224] border-slate-700 text-white focus:border-orange-500' : 'bg-slate-50 border-slate-200 text-slate-900 focus:border-orange-500'}`}
              placeholder="teacher@edutrack.com"
              autoComplete="off"
              required 
            />
          </div>

          <div className="space-y-1 relative">
            <Label htmlFor="password" className={`text-xs font-semibold ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>Password</Label>
            <div className="relative">
              <Input 
                id="password" 
                type={showPassword ? "text" : "password"} 
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={`rounded-xl h-11 pr-10 transition-all ${isDark ? 'bg-[#0B1224] border-slate-700 text-white focus:border-orange-500' : 'bg-slate-50 border-slate-200 text-slate-900 focus:border-orange-500'}`}
                autoComplete="new-password"
                required 
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-orange-500 transition-colors focus:outline-none"
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between text-xs pt-1">
            <div className="flex items-center space-x-2">
              <Checkbox 
                id="remember" 
                className={`rounded-md transition-all ${
                  isDark 
                    ? 'border-slate-600 data-[state=checked]:bg-orange-500 data-[state=checked]:border-orange-500' 
                    : 'border-slate-300 data-[state=checked]:bg-orange-500 data-[state=checked]:border-orange-500'
                }`} 
              />
              <label htmlFor="remember" className={`font-semibold cursor-pointer select-none ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                Remember Me
              </label>
            </div>
            <a href="#" className="font-bold text-orange-400 hover:text-orange-500 transition-colors">
              Forgot Password?
            </a>
          </div>

          <Button 
            type="submit" 
            disabled={loading}
            className="w-full h-11 rounded-xl bg-gradient-to-r from-orange-500 to-amber-500 text-white font-bold tracking-wide shadow-lg shadow-orange-500/20 hover:opacity-95 transform active:scale-[0.99] transition-all duration-300 mt-2"
          >
            {loading ? (
              <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            ) : (
              "Login"
            )}
          </Button>

          <div className="text-center text-xs pt-2">
            <span className={isDark ? 'text-slate-400' : 'text-slate-500'}>Don't have an account? </span>
            <Link to="/register" className="font-bold text-orange-400 hover:text-orange-500 transition-colors underline-offset-4 hover:underline ml-1">
              Sign Up
            </Link>
          </div>

        </form>
      </div>
    </div>
  );
}
