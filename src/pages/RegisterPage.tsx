import { useState, useEffect, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { auth, db } from '@/lib/firebase';
import { createUserWithEmailAndPassword } from 'firebase/auth';
import type { User as FirebaseUser } from 'firebase/auth';
import { doc, runTransaction } from 'firebase/firestore';
import {
  Sun, Moon, Eye, EyeOff, Camera, ArrowLeft,
  AlertCircle, Check, CheckCircle2, XCircle, Mail, Lock, User, Trash2
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const DEFAULT_AVATAR = 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?q=80&w=256&auto=format&fit=crop';

// Firestore documents are limited to 1 MiB. A lower ceiling leaves space for field/document overhead.
// Legacy profileImage URLs and data URLs remain readable. New data URLs are bounded; a future
// Storage migration should write download URLs to this same field and retain reads of old data URLs.
const MAX_PROFILE_IMAGE_DATA_URL_CHARS = 600 * 1024;
const MAX_PROFILE_DOCUMENT_BYTES = 700 * 1024;

const normalizeEmail = (value: string) => value.trim().toLowerCase();
const isAllowedGmail = (value: string) => /^[a-zA-Z0-9._%+-]+@gmail\.com$/.test(normalizeEmail(value));

class RegistrationFlowError extends Error {
  code: string;

  constructor(code: string) {
    super(code);
    this.name = 'RegistrationFlowError';
    this.code = code;
  }
}

const getErrorCode = (err: unknown): string => {
  if (err instanceof RegistrationFlowError) return err.code;
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return 'unknown';
};

/*
AUDIT NOTES
Confirmed from the supplied RegisterPage.tsx:
- Auth account creation was followed by unconditional setDoc at users/{normalizedEmail}; retries could overwrite a profile.
- There was no in-flight submission lock or check that the active Auth UID/email owned the target profile.
- A 5 MB image could be converted to a much larger data URL and included in a Firestore document write.
- A Firestore failure after Auth creation was shown as a generic error, with no explicit safe recovery path.
- The client wrote role/active values, so Security Rules must pin these fields instead of trusting the client.

Local verification performed for this artifact: TSX syntax transpilation PASS; original JSX return block byte-identical PASS.
Not executed: Firebase Auth/Firestore integration scenarios (existing email, successful cloud registration, network loss after Auth, permission denial, actual image read/upload failure, and end-to-end recovery). Those require this app's Firebase project/emulator configuration and deployed/effective Security Rules. Do not interpret local syntax checks as cloud integration tests.
*/

/*
REQUIRED FIRESTORE RULES CONTRACT — merge into the project's existing rules; do not simply append
this beside a broader permissive `allow write` rule, because matching Firestore allows are ORed.

match /users/{emailDocId} {
  function isSelfEmailPath() {
    return request.auth != null
      && request.auth.token.email is string
      && request.auth.token.email == emailDocId;
  }

  // Needed so a signed-in user can safely distinguish a missing profile from a prior successful write.
  allow get: if isSelfEmailPath();
  // Keep/narrow any separate, explicit admin list/read permissions required by the application.
  allow list: if false;

  allow create: if isSelfEmailPath()
    && request.resource.data.keys().hasAll([
      'uid', 'email', 'teacherName', 'whatsappNumber', 'paymentMethod',
      'profileImage', 'active', 'role', 'createdAt'
    ])
    && request.resource.data.keys().hasOnly([
      'uid', 'email', 'teacherName', 'whatsappNumber', 'paymentMethod',
      'profileImage', 'active', 'role', 'createdAt'
    ])
    && request.resource.data.uid == request.auth.uid
    && request.resource.data.email == emailDocId
    && emailDocId.matches('^[a-z0-9._%+-]+@gmail\\.com$')
    && request.resource.data.teacherName is string
    && request.resource.data.teacherName.size() > 0
    && request.resource.data.teacherName.size() <= 200
    && request.resource.data.whatsappNumber.matches('^\\+92[0-9]{10}$')
    && request.resource.data.paymentMethod in ['JazzCash', 'easypaisa', 'PayPal']
    && request.resource.data.profileImage is string
    && request.resource.data.profileImage.size() <= 614400
    && request.resource.data.active == true
    && request.resource.data.role == 'teacher'
    && request.resource.data.createdAt is string;

  allow update: if isSelfEmailPath()
    && resource.data.uid == request.auth.uid
    && resource.data.email == emailDocId
    && request.resource.data.uid == resource.data.uid
    && request.resource.data.email == resource.data.email
    && request.resource.data.role == resource.data.role
    && request.resource.data.active == resource.data.active
    && request.resource.data.createdAt == resource.data.createdAt
    && request.resource.data.diff(resource.data).affectedKeys().hasOnly([
      'teacherName', 'whatsappNumber', 'paymentMethod', 'profileImage'
    ])
    && request.resource.data.teacherName is string
    && request.resource.data.teacherName.size() > 0
    && request.resource.data.teacherName.size() <= 200
    && request.resource.data.whatsappNumber.matches('^\\+92[0-9]{10}$')
    && request.resource.data.paymentMethod in ['JazzCash', 'easypaisa', 'PayPal']
    && request.resource.data.profileImage is string
    && request.resource.data.profileImage.size() <= 614400;

  allow delete: if false;
}

Admin or trusted backend operations must use an explicit admin authorization path (or Admin SDK).
Firestore Rules do not prevent Auth account creation itself. If registration must be invite-only, enforce that policy
with trusted backend logic / an Authentication blocking function, not only this client form.
These example constraints must be reconciled with existing tenant/admin rules before deployment.
*/

export default function RegisterPage() {
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const submissionInProgressRef = useRef(false);
  const [isDark, setIsDark] = useState(true);

  // Form Field States
  const [name, setName] = useState('');
  const [whatsappDigits, setWhatsappDigits] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('JazzCash');
  const [profileImage, setProfileImage] = useState<string>(DEFAULT_AVATAR);

  // UI Helper States
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDark]);

  // Handle Profile Image Upload / Edit. Preserve the data-URL field for backward compatibility,
  // but reject a data URL that would make a Firestore profile document too large.
  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setError('');
    if (!file.type.startsWith('image/')) {
      setError('Please select a valid image file.');
      e.target.value = '';
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError('Image size should be less than 5MB, mere jaan!');
      e.target.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        setError('The selected image could not be read. Please try another image.');
        e.target.value = '';
        return;
      }
      if (reader.result.length > MAX_PROFILE_IMAGE_DATA_URL_CHARS) {
        setError('This image is too large to store safely in the teacher profile. Choose a smaller image or use the default image.');
        e.target.value = '';
        return;
      }
      setProfileImage(reader.result);
      setError('');
    };
    reader.onerror = () => {
      setError('The selected image could not be read. Please try another image.');
      e.target.value = '';
    };
    reader.onabort = () => {
      setError('Image reading was cancelled. Please select the image again.');
      e.target.value = '';
    };
    reader.readAsDataURL(file);
  };

  // Handle Picture Delete
  const handleDeleteImage = (e: React.MouseEvent) => {
    e.stopPropagation();
    setProfileImage(DEFAULT_AVATAR);
    setError('');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  // WhatsApp Input Formatter (+92 handled automatically)
  const handleWhatsappChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let raw = e.target.value;
    if (raw.startsWith('+92')) raw = raw.replace('+92', '');
    else if (raw.startsWith('92')) raw = raw.replace('92', '');
    else if (raw.startsWith('0')) raw = raw.replace(/^0+/, '');

    const digitsOnly = raw.replace(/\D/g, '').slice(0, 10);
    setWhatsappDigits(digitsOnly);
  };

  // Validation rules are intentionally kept compatible with the existing form policy.
  const isWhatsappValid = /^\d{10}$/.test(whatsappDigits);
  const isGmailValid = isAllowedGmail(email);
  const hasCapitalLetter = /[A-Z]/.test(password);
  const hasSpecialChar = /[!@#$%^&*(),.?":{}|<>]/.test(password);
  const isPasswordValid = password.length >= 6 && hasCapitalLetter && hasSpecialChar;
  const isPasswordMatched = password === confirmPassword && confirmPassword.length > 0;

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submissionInProgressRef.current) return;
    setError('');

    const cleanEmail = normalizeEmail(email);
    const cleanName = name.trim();

    if (!cleanName) {
      setError('Teacher Name is required, mere jaan!');
      return;
    }

    if (!isAllowedGmail(cleanEmail)) {
      setError('Please enter a valid Gmail address ending with @gmail.com');
      return;
    }

    if (!isWhatsappValid) {
      setError(`Please enter complete 10 digits after +92. (${10 - whatsappDigits.length} remaining)`);
      return;
    }

    if (!isPasswordValid) {
      if (password.length < 6) {
        setError('Password must be at least 6 characters long!');
      } else if (!hasCapitalLetter) {
        setError('Password must contain at least 1 Uppercase (Capital) Letter!');
      } else if (!hasSpecialChar) {
        setError('Password must contain at least 1 Special Character (@, #, $, etc.)!');
      }
      return;
    }

    if (password !== confirmPassword) {
      setError('Password and Confirm Password do not match, mere jaan!');
      return;
    }

    if (!auth || !db) {
      setError('Firebase setup is missing! Please configure environment variables.');
      return;
    }

    const fullWhatsappNumber = `+92${whatsappDigits}`;
    const prospectiveProfile = {
      uid: 'u'.repeat(128),
      email: cleanEmail,
      teacherName: cleanName,
      whatsappNumber: fullWhatsappNumber,
      paymentMethod,
      profileImage,
      active: true,
      role: 'teacher',
      createdAt: new Date().toISOString(),
    };

    // Validate payload size before creating an Auth account, avoiding an avoidable partial signup.
    if (profileImage.length > MAX_PROFILE_IMAGE_DATA_URL_CHARS ||
        new TextEncoder().encode(JSON.stringify(prospectiveProfile)).byteLength > MAX_PROFILE_DOCUMENT_BYTES) {
      setError('The profile data is too large for Firestore. Choose a smaller image or use the default image.');
      return;
    }

    submissionInProgressRef.current = true;
    setLoading(true);

    let userForProfileRecovery: FirebaseUser | null = null;

    try {
      let user = auth.currentUser;

      // Never replace an unrelated signed-in account or write a profile under another user's email.
      if (user && normalizeEmail(user.email ?? '') !== cleanEmail) {
        throw new RegistrationFlowError('AUTH_SESSION_MISMATCH');
      }

      // If Auth succeeded but the previous Firestore write failed, a still-authenticated user retries
      // profile creation here instead of attempting to create a duplicate Auth account.
      if (!user) {
        const userCredential = await createUserWithEmailAndPassword(auth, cleanEmail, password);
        user = userCredential.user;
      }
      const authenticatedUser = user;
      userForProfileRecovery = authenticatedUser;

      if (auth.currentUser?.uid !== authenticatedUser.uid || normalizeEmail(authenticatedUser.email ?? '') !== cleanEmail) {
        throw new RegistrationFlowError('AUTH_SESSION_MISMATCH');
      }

      const userDocRef = doc(db, 'users', cleanEmail);
      const profile = {
        uid: authenticatedUser.uid,
        email: cleanEmail,
        teacherName: cleanName,
        whatsappNumber: fullWhatsappNumber,
        paymentMethod,
        profileImage,
        active: true,
        role: 'teacher',
        // Keep the current schema's ISO string type; do not silently change it to a Firestore Timestamp.
        createdAt: new Date().toISOString(),
      };

      const profileAlreadyExisted = await runTransaction(db, async (transaction) => {
        if (auth.currentUser?.uid !== authenticatedUser.uid) {
          throw new RegistrationFlowError('AUTH_SESSION_MISMATCH');
        }

        const existingSnapshot = await transaction.get(userDocRef);
        if (existingSnapshot.exists()) {
          const existing = existingSnapshot.data();
          if (existing.uid !== authenticatedUser.uid || normalizeEmail(String(existing.email ?? '')) !== cleanEmail) {
            throw new RegistrationFlowError('PROFILE_CONFLICT');
          }
          if (existing.role !== 'teacher' || existing.active !== true) {
            throw new RegistrationFlowError('PROFILE_STATUS_CONFLICT');
          }
          // A matching profile is already complete enough to recover from a prior navigation/network issue.
          // Never overwrite its fields during a retry.
          return true;
        }

        transaction.set(userDocRef, profile);
        return false;
      });

      navigate('/login', {
        state: {
          registeredEmail: cleanEmail,
          message: profileAlreadyExisted
            ? 'Your teacher profile already exists. Please login with your credentials.'
            : 'Registration successful! Please login with your credentials.',
        },
      });
    } catch (err: unknown) {
      const code = getErrorCode(err);

      if (code === 'AUTH_SESSION_MISMATCH') {
        setError('A different account is currently signed in, or the authentication session changed. Sign out and retry with the correct account.');
      } else if (code === 'PROFILE_CONFLICT') {
        setError('A profile already exists for this email but belongs to another account. Nothing was overwritten. Please contact the administrator.');
      } else if (code === 'PROFILE_STATUS_CONFLICT') {
        setError('The existing profile has an unexpected role or inactive status. Nothing was changed. Please contact the administrator.');
      } else if (code === 'auth/email-already-in-use') {
        setError('This email address is already registered. Sign in with that account; if registration was interrupted, return here while signed in to safely retry profile recovery.');
      } else if (code === 'auth/weak-password') {
        setError('Password should be at least 6 characters long.');
      } else if (code === 'auth/invalid-email') {
        setError('Please enter a valid Gmail address ending with @gmail.com');
      } else if (code === 'auth/operation-not-allowed') {
        setError('Email/password registration is disabled in Firebase Authentication. Please contact the administrator.');
      } else if (code === 'auth/too-many-requests') {
        setError('Too many attempts were made. Please wait before trying again.');
      } else if (code === 'permission-denied' || code === 'firestore/permission-denied') {
        setError(userForProfileRecovery
          ? 'Your Firebase Auth account exists, but Firestore denied saving or verifying the teacher profile. Registration is incomplete. Keep this page open and retry after the Security Rules are corrected; do not create another account.'
          : 'Firestore denied this operation. Check the Firebase Security Rules and try again.');
      } else if (code === 'unavailable' || code === 'deadline-exceeded' || code === 'network-request-failed' || code === 'auth/network-request-failed' || code === 'aborted') {
        setError(userForProfileRecovery
          ? 'Your Firebase Auth account is signed in, but the teacher profile could not be confirmed because of a network problem. Registration is incomplete. Keep this page open and submit again to retry safely.'
          : 'A network problem interrupted registration. Check your connection and try again.');
      } else if (code === 'PROFILE_TOO_LARGE') {
        setError('The profile data is too large for Firestore. Choose a smaller image or use the default image.');
      } else {
        setError(userForProfileRecovery
          ? 'Your Firebase Auth account exists, but teacher profile creation could not be confirmed. Registration is incomplete. Keep this page open and submit again to retry safely.'
          : 'Registration could not be completed. Please check your details and try again.');
      }
    } finally {
      submissionInProgressRef.current = false;
      setLoading(false);
    }
  };

  return (
    <div className={`min-h-screen flex items-center justify-center relative overflow-hidden px-4 py-8 transition-colors duration-700 ease-in-out ${
      isDark 
        ? 'bg-gradient-to-b from-[#0B1224] via-[#0F172A] to-[#0B1224]' 
        : 'bg-gradient-to-b from-[#F8FAFC] via-[#F1F5F9] to-[#E2E8F0]'
    }`}>
      
      {/* Hidden File Input for Picture Upload */}
      <input 
        type="file" 
        ref={fileInputRef} 
        onChange={handleImageUpload} 
        accept="image/*" 
        className="hidden" 
      />

      {/* Day / Night Toggle Button */}
      <div className="absolute top-6 right-6 z-50 flex items-center gap-3">
        <button
          onClick={() => setIsDark(!isDark)}
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

      {/* Ambient Glows */}
      <div className="absolute top-0 right-0 w-[450px] h-[450px] bg-orange-500/10 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute bottom-0 left-0 w-[450px] h-[450px] bg-blue-500/5 rounded-full blur-[120px] pointer-events-none" />

      {/* Card Container */}
      <div className={`w-full max-w-md relative z-10 p-6 md:p-8 rounded-[2.5rem] border transition-all duration-700 ${
        isDark 
          ? 'bg-[#131E35]/90 border-slate-700/50 shadow-[0_25px_50px_-12px_rgba(0,0,0,0.5)] backdrop-blur-md' 
          : 'bg-white border-slate-200 shadow-[0_25px_50px_-12px_rgba(15,23,42,0.08)]'
      }`}>
        
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <Link to="/login" className={`p-2 rounded-xl transition-colors ${isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-100 text-slate-600'}`}>
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="flex items-center gap-2">
            <span className={`text-base font-bold tracking-wide ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>Teacher Register</span>
          </div>
          <div className="w-9" />
        </div>

        {/* Profile Picture Box with Edit & Delete options */}
        <div className="flex flex-col items-center justify-center mb-6">
          <div className="relative group">
            <div className="w-24 h-24 rounded-full border-2 border-orange-500/60 p-1 overflow-hidden transition-transform duration-300 shadow-md">
              <img 
                src={profileImage} 
                alt="Teacher Profile" 
                className="w-full h-full object-cover rounded-full"
              />
            </div>

            {/* Edit Button (Camera Icon) */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="absolute bottom-0 right-0 w-8 h-8 bg-[#1E293B] border-2 border-orange-500 rounded-full flex items-center justify-center text-white shadow-lg hover:bg-orange-500 transition-colors"
              title="Upload / Change Picture"
            >
              <Camera className="w-4 h-4" />
            </button>

            {/* Delete Button (Trash Icon - visible if picture modified) */}
            {profileImage !== DEFAULT_AVATAR && (
              <button
                type="button"
                onClick={handleDeleteImage}
                className="absolute bottom-0 -left-1 w-8 h-8 bg-red-600 border-2 border-white rounded-full flex items-center justify-center text-white shadow-lg hover:bg-red-700 transition-colors"
                title="Remove Picture"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <span className="text-[11px] text-slate-400 mt-2 font-medium">Click camera to upload or change picture</span>
        </div>

        {/* Glowing Animated Red Notification Alert */}
        {error && (
          <div className="p-3.5 mb-5 rounded-2xl text-xs font-bold flex items-center gap-2.5 bg-red-500/15 border-2 border-red-500/60 text-red-400 shadow-[0_0_20px_rgba(239,68,68,0.4)] animate-pulse transition-all">
            <AlertCircle className="w-5 h-5 shrink-0 text-red-500 animate-bounce" />
            <span className="leading-tight">{error}</span>
          </div>
        )}

        {/* Form Fields */}
        <form onSubmit={handleRegister} className="space-y-4">
          
          {/* Teacher Name */}
          <div className="space-y-1">
            <Label htmlFor="name" className={`text-xs font-bold uppercase tracking-wider ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
              Teacher Name
            </Label>
            <div className="relative">
              <Input 
                id="name" 
                type="text" 
                placeholder="Ahmed Ali"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={`rounded-xl h-11 pl-9 transition-all ${
                  isDark ? 'bg-[#0B1224] border-slate-700 text-white focus:border-orange-500' : 'bg-slate-50 border-slate-200 text-slate-900 focus:border-orange-500'
                }`}
              />
              <User className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            </div>
          </div>

          {/* Email Address */}
          <div className="space-y-1">
            <Label htmlFor="email" className={`text-xs font-bold uppercase tracking-wider ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
              Gmail Address (@gmail.com)
            </Label>
            <div className="relative">
              <Input 
                id="email" 
                type="email" 
                placeholder="admin@gmail.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={`rounded-xl h-11 pl-9 pr-10 transition-all ${
                  email.length === 0
                    ? (isDark ? 'bg-[#0B1224] border-slate-700 text-white' : 'bg-slate-50 border-slate-200 text-slate-900')
                    : isGmailValid
                      ? 'bg-emerald-500/10 border-emerald-500/80 text-emerald-400 focus:border-emerald-500'
                      : 'bg-red-500/10 border-red-500/80 text-red-400 focus:border-red-500'
                }`}
              />
              <Mail className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              {email.length > 0 && (
                <div className="absolute right-3 top-1/2 -translate-y-1/2">
                  {isGmailValid ? <CheckCircle2 className="w-5 h-5 text-emerald-500 fill-emerald-500/20" /> : <AlertCircle className="w-5 h-5 text-red-500" />}
                </div>
              )}
            </div>
            {email.length > 0 && !isGmailValid && (
              <p className="text-[11px] text-red-400 font-semibold mt-1">Email must end strictly with @gmail.com</p>
            )}
          </div>

          {/* Contact WhatsApp */}
          <div className="space-y-1">
            <div className="flex justify-between items-center">
              <Label htmlFor="whatsapp" className={`text-xs font-bold uppercase tracking-wider ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                Contact WhatsApp
              </Label>
              <span className={`text-[11px] font-bold ${isWhatsappValid ? 'text-emerald-500' : 'text-slate-400'}`}>
                {whatsappDigits.length} / 10 Digits
              </span>
            </div>
            
            <div className="relative flex items-center">
              <div className={`absolute left-0 top-0 bottom-0 px-3 flex items-center font-bold text-sm rounded-l-xl border-r z-10 ${
                isDark ? 'bg-slate-800 border-slate-700 text-orange-400' : 'bg-slate-200 border-slate-300 text-orange-600'
              }`}>
                +92
              </div>

              <Input 
                id="whatsapp" 
                type="tel" 
                placeholder="303 2093780"
                value={whatsappDigits}
                onChange={handleWhatsappChange}
                className={`rounded-xl h-11 pl-16 pr-10 font-bold transition-all ${
                  whatsappDigits.length === 0
                    ? (isDark ? 'bg-[#0B1224] border-slate-700 text-white' : 'bg-slate-50 border-slate-200 text-slate-900')
                    : isWhatsappValid
                      ? 'bg-emerald-500/10 border-emerald-500/80 text-emerald-400 focus:border-emerald-500'
                      : 'bg-red-500/10 border-red-500/80 text-red-400 focus:border-red-500'
                }`}
              />

              {whatsappDigits.length > 0 && (
                <div className="absolute right-3 top-1/2 -translate-y-1/2">
                  {isWhatsappValid ? (
                    <CheckCircle2 className="w-5 h-5 text-emerald-500 fill-emerald-500/20" />
                  ) : (
                    <XCircle className="w-5 h-5 text-red-500/70" />
                  )}
                </div>
              )}
            </div>

            {whatsappDigits.length > 0 && !isWhatsappValid && (
              <p className="text-[11px] text-red-400 font-semibold mt-1">
                Please enter remaining {10 - whatsappDigits.length} digits after +92.
              </p>
            )}
          </div>

          {/* Password Field */}
          <div className="space-y-1">
            <Label htmlFor="password" className={`text-xs font-bold uppercase tracking-wider ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
              Password
            </Label>
            <div className="relative">
              <Input 
                id="password" 
                type={showPassword ? "text" : "password"} 
                placeholder="••••••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={`rounded-xl h-11 pl-9 pr-10 transition-all ${
                  password.length === 0 
                    ? (isDark ? 'bg-[#0B1224] border-slate-700 text-white' : 'bg-slate-50 border-slate-200 text-slate-900')
                    : isPasswordValid
                      ? 'bg-emerald-500/10 border-emerald-500/80 text-emerald-400'
                      : 'bg-red-500/10 border-red-500/80 text-red-400'
                }`}
              />
              <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <button 
                type="button" 
                onClick={() => setShowPassword(!showPassword)} 
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-orange-500 transition-colors"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>

            {password.length > 0 && (
              <div className="grid grid-cols-2 gap-2 pt-1 text-[11px] font-medium">
                <span className={`flex items-center gap-1 ${hasCapitalLetter ? 'text-emerald-400' : 'text-red-400'}`}>
                  {hasCapitalLetter ? <Check className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />} 1 Capital Letter
                </span>
                <span className={`flex items-center gap-1 ${hasSpecialChar ? 'text-emerald-400' : 'text-red-400'}`}>
                  {hasSpecialChar ? <Check className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />} 1 Special Char
                </span>
              </div>
            )}
          </div>

          {/* Confirm Password */}
          <div className="space-y-1">
            <Label htmlFor="confirmPassword" className={`text-xs font-bold uppercase tracking-wider ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
              Confirm Password
            </Label>
            <div className="relative">
              <Input 
                id="confirmPassword" 
                type={showConfirmPassword ? "text" : "password"} 
                placeholder="••••••••••••"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className={`rounded-xl h-11 pl-9 pr-10 transition-all ${
                  confirmPassword.length === 0
                    ? (isDark ? 'bg-[#0B1224] border-slate-700 text-white' : 'bg-slate-50 border-slate-200 text-slate-900')
                    : isPasswordMatched
                      ? 'bg-emerald-500/10 border-emerald-500/80 text-emerald-400'
                      : 'bg-red-500/10 border-red-500/80 text-red-400'
                }`}
              />
              <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <button 
                type="button" 
                onClick={() => setShowConfirmPassword(!showConfirmPassword)} 
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-orange-500 transition-colors"
              >
                {showConfirmPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {/* Payment Method */}
          <div className="space-y-2 pt-1">
            <Label className={`text-xs font-bold uppercase tracking-wider ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
              Payment Method
            </Label>
            <div className="grid grid-cols-3 gap-2">
              {['JazzCash', 'easypaisa', 'PayPal'].map((method) => (
                <button
                  key={method}
                  type="button"
                  onClick={() => setPaymentMethod(method)}
                  className={`py-2.5 px-2 text-xs font-bold rounded-xl border transition-all duration-300 flex items-center justify-center ${
                    paymentMethod === method
                      ? 'bg-orange-500/10 border-orange-500 text-orange-500 shadow-sm shadow-orange-500/10'
                      : isDark
                        ? 'bg-[#0B1224] border-slate-700 text-slate-400 hover:text-slate-200'
                        : 'bg-slate-50 border-slate-200 text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <span>{method}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Submit Button */}
          <Button 
            type="submit" 
            disabled={loading}
            className="w-full h-12 rounded-xl bg-gradient-to-r from-orange-500 to-amber-500 text-white font-bold tracking-wide shadow-lg shadow-orange-500/20 hover:opacity-95 transform active:scale-[0.99] transition-all duration-300 mt-4"
          >
            {loading ? (
              <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            ) : (
              "Create Account"
            )}
          </Button>

          {/* Login Link */}
          <div className="text-center text-xs pt-2">
            <span className={isDark ? 'text-slate-400' : 'text-slate-500'}>Already have an account? </span>
            <Link to="/login" className="font-bold text-orange-400 hover:text-orange-500 transition-colors underline-offset-4 hover:underline ml-1">
              Login
            </Link>
          </div>

        </form>
      </div>
    </div>
  );
}
