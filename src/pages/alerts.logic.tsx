/** Pure, side-effect-free helpers for EduTrack Alerts. */
export type AlertCategoryValue = 'Fees' | 'Attendance' | 'Announcements' | 'Exams';
export type PriorityLevel = 'high' | 'medium' | 'normal';

export interface AlertDocumentData {
  [key: string]: unknown;
}

export interface AlertRow {
  id: string;
  data: AlertDocumentData;
}

export interface NotificationItem {
  id: string;
  title: string;
  message: string;
  timestamp: string;
  createdAt?: unknown;
  category: AlertCategoryValue;
  priority: PriorityLevel;
  isRead: boolean;
  targetClass: string;
  sender: string;
  whatsappSent?: boolean;
}

/** EduTrack's registration flow stores tenant profiles under normalized email IDs. */
export function normalizeTenantEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (!email || email.includes('/') || email.includes('\\') || /\s/.test(email)) return null;
  if (!email.includes('@') || email.startsWith('@') || email.endsWith('@')) return null;
  return email;
}

/** Fail closed: a profile must prove UID, email, teacher role, and active status. */
export function isOwnedActiveTeacherProfile(
  profile: Record<string, unknown> | null | undefined,
  authenticatedUid: string,
  authenticatedEmail: unknown,
): boolean {
  const email = normalizeTenantEmail(authenticatedEmail);
  if (!profile || !authenticatedUid || !email) return false;
  return profile.uid === authenticatedUid
    && normalizeTenantEmail(profile.email) === email
    && profile.role === 'teacher'
    && profile.active === true;
}

/** Converts Firestore Timestamp, Date, epoch, ISO date, or seconds/nanoseconds shapes safely. */
export function parseAlertDate(value: unknown): Date | null {
  try {
    if (value instanceof Date) {
      return Number.isFinite(value.getTime()) ? value : null;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      const milliseconds = Math.abs(value) < 100_000_000_000 ? value * 1000 : value;
      const date = new Date(milliseconds);
      return Number.isFinite(date.getTime()) ? date : null;
    }
    if (typeof value === 'string' && value.trim()) {
      const milliseconds = Date.parse(value);
      if (!Number.isFinite(milliseconds)) return null;
      return new Date(milliseconds);
    }
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (typeof record.toDate === 'function') {
        const date = (record.toDate as () => unknown)();
        return date instanceof Date && Number.isFinite(date.getTime()) ? date : null;
      }
      if (typeof record.seconds === 'number' && Number.isFinite(record.seconds)) {
        const nanoseconds = typeof record.nanoseconds === 'number' && Number.isFinite(record.nanoseconds)
          ? record.nanoseconds
          : 0;
        const date = new Date(record.seconds * 1000 + nanoseconds / 1_000_000);
        return Number.isFinite(date.getTime()) ? date : null;
      }
    }
  } catch {
    // Malformed Timestamp-like objects should fall back to the existing timestamp label.
  }
  return null;
}

export function getAlertSortMillis(createdAt: unknown): number {
  return parseAlertDate(createdAt)?.getTime() ?? 0;
}

export function formatAlertTimestamp(createdAt: unknown, legacyTimestamp: unknown): string {
  const date = parseAlertDate(createdAt);
  if (date) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  if (typeof legacyTimestamp === 'string' && legacyTimestamp.trim()) {
    // Old documents may store an ISO date in `timestamp`, while most store labels like `Just now`.
    if (/^\d{4}-\d{2}-\d{2}[T ]/.test(legacyTimestamp.trim())) {
      const legacyDate = parseAlertDate(legacyTimestamp);
      if (legacyDate) return legacyDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return legacyTimestamp;
  }
  return 'Recently';
}

export function normalizeNotification(id: string, data: AlertDocumentData): NotificationItem {
  const allowedCategories: AlertCategoryValue[] = ['Fees', 'Attendance', 'Announcements', 'Exams'];
  const category = typeof data.category === 'string' && allowedCategories.includes(data.category as AlertCategoryValue)
    ? data.category as AlertCategoryValue
    : 'Announcements';
  const allowedPriorities: PriorityLevel[] = ['high', 'medium', 'normal'];
  const priority = typeof data.priority === 'string' && allowedPriorities.includes(data.priority as PriorityLevel)
    ? data.priority as PriorityLevel
    : 'normal';
  const createdAt = data.createdAt;

  return {
    id,
    title: typeof data.title === 'string' ? data.title : '',
    message: typeof data.message === 'string' ? data.message : '',
    timestamp: formatAlertTimestamp(createdAt, data.timestamp),
    createdAt,
    category,
    priority,
    // Missing legacy isRead values are treated as unread, matching the existing screen behavior.
    isRead: typeof data.isRead === 'boolean' ? data.isRead : false,
    targetClass: typeof data.targetClass === 'string' && data.targetClass.trim()
      ? data.targetClass
      : 'All Classes',
    sender: typeof data.sender === 'string' && data.sender.trim() ? data.sender : 'Admin System',
    whatsappSent: data.whatsappSent === true,
  };
}

/** Dedupe repeated snapshot rows by their stable Firestore document ID; don't merge by text. */
export function deduplicateAndSortNotifications(rows: AlertRow[]): NotificationItem[] {
  const byId = new Map<string, NotificationItem>();
  for (const row of rows) {
    if (!byId.has(row.id)) byId.set(row.id, normalizeNotification(row.id, row.data));
  }
  return [...byId.values()].sort((a, b) => getAlertSortMillis(b.createdAt) - getAlertSortMillis(a.createdAt));
}

/** Stable content key lets an ambiguous network retry reuse the same pending document ID. */
export function buildAlertPayloadKey(input: {
  title: string;
  message: string;
  category: string;
  priority: string;
  targetClass: string;
  recipientPhone: string;
}): string {
  return JSON.stringify([
    input.title.trim(),
    input.message.trim(),
    input.category,
    input.priority,
    input.targetClass,
    input.recipientPhone.trim(),
  ]);
}

/** Known path contract from the existing component: all alert documents are tenant subcollection docs. */
export function tenantAlertsPath(tenantEmail: unknown): string | null {
  const tenantId = normalizeTenantEmail(tenantEmail);
  return tenantId ? `users/${tenantId}/notifications` : null;
}

export function tenantClassesPath(tenantEmail: unknown): string | null {
  const tenantId = normalizeTenantEmail(tenantEmail);
  return tenantId ? `users/${tenantId}/classes` : null;
}

export function userSettingsProfilePath(authenticatedUid: unknown): string | null {
  if (typeof authenticatedUid !== 'string') return null;
  const uid = authenticatedUid.trim();
  if (!uid || uid.includes('/') || uid.includes('\\')) return null;
  // The supplied Settings page stores its `thresholds` object at this existing path.
  return `users/${uid}/settings/profile_data`;
}
