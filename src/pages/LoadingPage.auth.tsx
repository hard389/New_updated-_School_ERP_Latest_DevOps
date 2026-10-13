/**
 * Authentication/profile gate used by LoadingPage.
 * Kept independent of React so its asynchronous lifecycle can be unit-tested.
 */

export const AUTH_INITIALIZATION_TIMEOUT_MS = 15_000;
export const TEACHER_PROFILE_TIMEOUT_MS = 15_000;

export type LoadingGateUser = {
  uid: string;
  email: string | null;
};

type ProfileSnapshot = {
  exists: () => boolean;
  data: () => unknown;
};

type LoadingPageAuthGateDependencies = {
  isAvailable: boolean;
  observeAuth: (
    onUser: (user: LoadingGateUser | null) => void,
    onError: (error: unknown) => void
  ) => () => void;
  getCurrentUser: () => LoadingGateUser | null;
  readTeacherProfile: (normalizedEmail: string) => Promise<ProfileSnapshot>;
  navigate: (path: '/login' | '/dashboard', options: { replace: true }) => void;
  authTimeoutMs?: number;
  profileTimeoutMs?: number;
};

const normalizeEmail = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLowerCase() : '';

const isVerifiedTeacherProfile = (
  snapshot: ProfileSnapshot,
  user: LoadingGateUser,
  normalizedEmail: string
): boolean => {
  if (!snapshot.exists()) return false;

  const rawData = snapshot.data();
  if (!rawData || typeof rawData !== 'object' || Array.isArray(rawData)) return false;

  const profile = rawData as Record<string, unknown>;
  if (typeof profile.uid !== 'string' || profile.uid !== user.uid) return false;
  if (normalizeEmail(profile.email) !== normalizedEmail) return false;
  if (String(profile.role ?? '').trim().toLowerCase() !== 'teacher') return false;
  if (profile.active !== true || profile.disabled === true || profile.deleted === true) return false;

  const status = String(profile.status ?? profile.accountStatus ?? '').trim().toLowerCase();
  if (['disabled', 'inactive', 'suspended', 'deleted', 'blocked'].includes(status)) return false;

  return true;
};

/**
 * Starts the guard and returns complete cleanup for observers and timers.
 * Authentication and Firestore profile verification have separate deadlines.
 */
export function startLoadingPageAuthGuard({
  isAvailable,
  observeAuth,
  getCurrentUser,
  readTeacherProfile,
  navigate,
  authTimeoutMs = AUTH_INITIALIZATION_TIMEOUT_MS,
  profileTimeoutMs = TEACHER_PROFILE_TIMEOUT_MS,
}: LoadingPageAuthGateDependencies): () => void {
  let disposed = false;
  let authInitialized = false;
  let authInitializationExpired = false;
  let eventSequence = 0;
  let lastNavigationKey = '';
  let authTimer: ReturnType<typeof setTimeout> | undefined;
  let profileTimer: ReturnType<typeof setTimeout> | undefined;
  let cancelActiveProfileCheck: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined;

  const isLiveEvent = (sequence: number): boolean => !disposed && sequence === eventSequence;

  const navigateOnce = (path: '/login' | '/dashboard', identity = ''): void => {
    if (disposed) return;
    const key = path === '/dashboard' ? `${path}:${identity}` : path;
    if (key === lastNavigationKey) return;
    lastNavigationKey = key;
    navigate(path, { replace: true });
  };

  const cancelProfileCheck = (): void => {
    if (profileTimer !== undefined) {
      clearTimeout(profileTimer);
      profileTimer = undefined;
    }
    const cancel = cancelActiveProfileCheck;
    cancelActiveProfileCheck = undefined;
    cancel?.();
  };

  if (!isAvailable) {
    navigateOnce('/login');
    return () => {
      disposed = true;
    };
  }

  authTimer = setTimeout(() => {
    if (disposed || authInitialized) return;
    authInitializationExpired = true;
    eventSequence += 1;
    navigateOnce('/login');
  }, authTimeoutMs);

  const handleAuthState = (user: LoadingGateUser | null): void => {
    if (disposed || authInitializationExpired) return;

    const sequence = ++eventSequence;
    cancelProfileCheck();
    authInitialized = true;
    if (authTimer !== undefined) {
      clearTimeout(authTimer);
      authTimer = undefined;
    }

    if (!user || !user.uid) {
      navigateOnce('/login');
      return;
    }

    const email = normalizeEmail(user.email);
    if (!email) {
      navigateOnce('/login');
      return;
    }

    let rejectCancellation: ((reason?: unknown) => void) | undefined;
    const cancellationPromise = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    cancelActiveProfileCheck = () => {
      rejectCancellation?.(new Error('Profile verification cancelled because auth state changed.'));
    };

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      profileTimer = setTimeout(() => {
        reject(new Error('Teacher profile verification timed out.'));
      }, profileTimeoutMs);
    });

    void Promise.race([
      Promise.resolve().then(() => readTeacherProfile(email)),
      timeoutPromise,
      cancellationPromise,
    ])
      .then((snapshot) => {
        if (!isLiveEvent(sequence)) return;

        // Ignore a result if Firebase's current session no longer matches the event
        // whose profile was fetched. A later observer event will handle the new user.
        const currentUser = getCurrentUser();
        if (
          !currentUser ||
          currentUser.uid !== user.uid ||
          normalizeEmail(currentUser.email) !== email
        ) {
          return;
        }

        if (!isVerifiedTeacherProfile(snapshot, user, email)) {
          navigateOnce('/login');
          return;
        }

        navigateOnce('/dashboard', user.uid);
      })
      .catch(() => {
        // Network, permission, missing-profile and timeout failures must never grant access.
        if (isLiveEvent(sequence)) navigateOnce('/login');
      })
      .finally(() => {
        if (!isLiveEvent(sequence)) return;
        if (profileTimer !== undefined) {
          clearTimeout(profileTimer);
          profileTimer = undefined;
        }
        cancelActiveProfileCheck = undefined;
      });
  };

  try {
    unsubscribe = observeAuth(
      handleAuthState,
      () => {
        if (disposed) return;
        authInitializationExpired = true;
        eventSequence += 1;
        cancelProfileCheck();
        if (authTimer !== undefined) {
          clearTimeout(authTimer);
          authTimer = undefined;
        }
        navigateOnce('/login');
      }
    );
  } catch {
    authInitializationExpired = true;
    eventSequence += 1;
    if (authTimer !== undefined) {
      clearTimeout(authTimer);
      authTimer = undefined;
    }
    navigateOnce('/login');
  }

  return () => {
    if (disposed) return;
    disposed = true;
    eventSequence += 1;
    if (authTimer !== undefined) clearTimeout(authTimer);
    if (profileTimer !== undefined) clearTimeout(profileTimer);
    authTimer = undefined;
    profileTimer = undefined;
    cancelProfileCheck();
    unsubscribe?.();
  };
}
