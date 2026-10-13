import type { TimeSlot, TimeConfig, TimetableEntry, Faculty, Room, Subject, SubjectAllocation, Conflict } from '@/types';

// Generate time slots based on time configuration
export function generateTimeSlots(config: TimeConfig): TimeSlot[] {
  const slots: TimeSlot[] = [];
  const startMinutes = timeToMinutes(config.startTime);
  const endMinutes = timeToMinutes(config.endTime);
  const shortBreakStart = timeToMinutes(config.shortBreak.startTime);
  const shortBreakEnd = shortBreakStart + config.shortBreak.duration;
  const lunchStart = timeToMinutes(config.lunchBreak.startTime);
  const lunchEnd = lunchStart + config.lunchBreak.duration;

  let currentTime = startMinutes;
  let slotNumber = 1;

  while (currentTime < endMinutes) {
    // Check if current time falls in short break
    if (currentTime >= shortBreakStart && currentTime < shortBreakEnd) {
      slots.push({
        id: `break-${slotNumber}`,
        startTime: minutesToTime(shortBreakStart),
        endTime: minutesToTime(shortBreakEnd),
        type: 'break',
        slotNumber: slotNumber++,
      });
      currentTime = shortBreakEnd;
      continue;
    }

    // Check if current time falls in lunch break
    if (currentTime >= lunchStart && currentTime < lunchEnd) {
      slots.push({
        id: `lunch-${slotNumber}`,
        startTime: minutesToTime(lunchStart),
        endTime: minutesToTime(lunchEnd),
        type: 'lunch',
        slotNumber: slotNumber++,
      });
      currentTime = lunchEnd;
      continue;
    }

    // Regular lecture slot
    const slotEnd = Math.min(currentTime + config.lectureDuration, endMinutes);

    // Don't create slot if it would overlap with breaks
    if (slotEnd > shortBreakStart && currentTime < shortBreakStart) {
      slots.push({
        id: `slot-${slotNumber}`,
        startTime: minutesToTime(currentTime),
        endTime: minutesToTime(shortBreakStart),
        type: 'lecture',
        slotNumber: slotNumber++,
      });
      currentTime = shortBreakStart;
      continue;
    }

    if (slotEnd > lunchStart && currentTime < lunchStart) {
      slots.push({
        id: `slot-${slotNumber}`,
        startTime: minutesToTime(currentTime),
        endTime: minutesToTime(lunchStart),
        type: 'lecture',
        slotNumber: slotNumber++,
      });
      currentTime = lunchStart;
      continue;
    }

    slots.push({
      id: `slot-${slotNumber}`,
      startTime: minutesToTime(currentTime),
      endTime: minutesToTime(slotEnd),
      type: 'lecture',
      slotNumber: slotNumber++,
    });
    currentTime = slotEnd;
  }

  return slots;
}

function timeToMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

function minutesToTime(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
}

interface GeneratorInput {
  allocations: SubjectAllocation[];
  faculty: Faculty[];
  rooms: Room[];
  subjects: Subject[];
  timeSlots: TimeSlot[];
  workingDays: string[];
  classId?: string;
  departmentId?: string;
  year?: number;
}

interface AvailabilityTracker {
  faculty: Map<string, Set<string>>; // facultyId -> Set of "day-slotId" strings
  rooms: Map<string, Set<string>>; // roomId -> Set of "day-slotId" strings
}

export function generateTimetable(input: GeneratorInput): { entries: TimetableEntry[]; conflicts: Conflict[] } {
  const { allocations, faculty, rooms, subjects, timeSlots, workingDays, classId, departmentId, year } = input;

  const entries: TimetableEntry[] = [];
  const conflicts: Conflict[] = [];

  // Initialize availability tracker
  const availability: AvailabilityTracker = {
    faculty: new Map(),
    rooms: new Map(),
  };

  // Get lecture slots only (exclude breaks)
  const lectureSlots = timeSlots.filter(slot => slot.type === 'lecture');
  const labRooms = rooms.filter(r => r.type === 'lab');
  const classrooms = rooms.filter(r => r.type === 'classroom');

  // Create subject schedules with hours needed
  const subjectSchedules = allocations.map(allocation => {
    const subject = subjects.find(s => s.id === allocation.subjectId);
    const facultyMember = faculty.find(f => f.id === allocation.facultyId);
    return {
      allocation,
      subject,
      faculty: facultyMember,
      hoursNeeded: subject?.weeklyHours || 0,
      hoursScheduled: 0,
    };
  }).filter(s => s.subject && s.faculty);

  // Calculate total slots available
  const totalSlots = workingDays.length * lectureSlots.length;
  const totalHoursNeeded = subjectSchedules.reduce((sum, s) => sum + s.hoursNeeded, 0);

  console.log(`Scheduling ${subjectSchedules.length} subjects`);
  console.log(`Total slots: ${totalSlots}, Total hours needed: ${totalHoursNeeded}`);
  console.log('Subjects:', subjectSchedules.map(s => `${s.subject!.name} (${s.hoursNeeded}h)`).join(', '));

  // Round-robin distribution with prime number offsets for true variety
  let currentSubjectIndex = 0;
  let allSubjectsScheduled = false;
  let dayIndex = 0;

  // Use prime numbers for offsets to ensure no repeating patterns
  const primeOffsets = [0, 5, 3, 7, 2]; // Different prime-based offsets for each day

  for (const day of workingDays) {
    // Use prime number offset to ensure each day has unique schedule
    const dayOffset = primeOffsets[dayIndex % primeOffsets.length];
    let daySubjectIndex = (currentSubjectIndex + dayOffset) % subjectSchedules.length;

    for (const slot of lectureSlots) {
      if (allSubjectsScheduled) break;

      // Try to schedule the next subject that needs hours
      let attempts = 0;
      const maxAttempts = subjectSchedules.length * 2; // Allow multiple passes

      while (attempts < maxAttempts) {
        const schedule = subjectSchedules[daySubjectIndex];

        // Check if this subject still needs hours
        if (schedule.hoursScheduled >= schedule.hoursNeeded) {
          daySubjectIndex = (daySubjectIndex + 1) % subjectSchedules.length;
          attempts++;

          // Check if all subjects are done
          if (subjectSchedules.every(s => s.hoursScheduled >= s.hoursNeeded)) {
            allSubjectsScheduled = true;
            break;
          }
          continue;
        }

        const slotKey = `${day}-${slot.id}`;

        // Check faculty availability
        const facultyKey = availability.faculty.get(schedule.allocation.facultyId) || new Set();
        if (facultyKey.has(slotKey)) {
          currentSubjectIndex = (currentSubjectIndex + 1) % subjectSchedules.length;
          attempts++;
          continue;
        }

        // Find available room
        const roomPool = schedule.subject!.labRequired ? labRooms : classrooms;
        let selectedRoom: Room | undefined;

        for (const room of roomPool) {
          const roomKey = availability.rooms.get(room.id) || new Set();
          if (!roomKey.has(slotKey)) {
            selectedRoom = room;
            break;
          }
        }

        // Try any room if preferred type not available
        if (!selectedRoom) {
          for (const room of rooms) {
            const roomKey = availability.rooms.get(room.id) || new Set();
            if (!roomKey.has(slotKey)) {
              selectedRoom = room;
              break;
            }
          }
        }

        if (!selectedRoom) {
          currentSubjectIndex = (currentSubjectIndex + 1) % subjectSchedules.length;
          attempts++;
          continue;
        }

        // Schedule this slot
        if (!availability.faculty.has(schedule.allocation.facultyId)) {
          availability.faculty.set(schedule.allocation.facultyId, new Set());
        }
        availability.faculty.get(schedule.allocation.facultyId)!.add(slotKey);

        if (!availability.rooms.has(selectedRoom.id)) {
          availability.rooms.set(selectedRoom.id, new Set());
        }
        availability.rooms.get(selectedRoom.id)!.add(slotKey);

        entries.push({
          id: `entry-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          day,
          timeSlotId: slot.id,
          timeSlot: slot,
          subjectId: schedule.subject!.id,
          subject: schedule.subject!,
          facultyId: schedule.faculty!.id,
          faculty: schedule.faculty!,
          roomId: selectedRoom.id,
          room: selectedRoom,
          classId,
          departmentId,
          year,
          isLocked: false,
        });

        schedule.hoursScheduled++;
        console.log(`Scheduled ${schedule.subject!.name} on ${day} at ${slot.startTime} (${schedule.hoursScheduled}/${schedule.hoursNeeded})`);

        daySubjectIndex = (daySubjectIndex + 1) % subjectSchedules.length;
        break; // Successfully scheduled, move to next slot
      }
    }

    // Increment day counter for next day's offset
    dayIndex++;
  }

  // Check for subjects that couldn't be fully scheduled
  for (const schedule of subjectSchedules) {
    if (schedule.hoursScheduled < schedule.hoursNeeded) {
      conflicts.push({
        type: 'subject',
        message: `Could not schedule all hours for ${schedule.subject!.name}. Scheduled: ${schedule.hoursScheduled}/${schedule.hoursNeeded}`,
        entry1: entries.find(e => e.subjectId === schedule.subject!.id),
      });
      console.warn(`⚠️ ${schedule.subject!.name}: only ${schedule.hoursScheduled}/${schedule.hoursNeeded} hours scheduled`);
    } else {
      console.log(`✅ ${schedule.subject!.name}: ${schedule.hoursScheduled}/${schedule.hoursNeeded} hours scheduled`);
    }
  }

  // Fill empty Friday slots with Library/Self-Study hours
  const fridayEntries = entries.filter(e => e.day === 'Friday');
  console.log(`Friday has ${fridayEntries.length} scheduled classes`);

  if (workingDays.includes('Friday') && fridayEntries.length < lectureSlots.length) {
    console.log('Adding Library/Self-Study hours to fill empty Friday slots...');

    for (const slot of lectureSlots) {
      const slotKey = `Friday-${slot.id}`;
      const existingEntry = entries.find(e => e.day === 'Friday' && e.timeSlotId === slot.id);

      if (!existingEntry) {
        // Find an available room for library hour
        let libraryRoom: Room | undefined;
        for (const room of rooms) {
          const roomKey = availability.rooms.get(room.id) || new Set();
          if (!roomKey.has(slotKey)) {
            libraryRoom = room;
            break;
          }
        }

        if (libraryRoom) {
          entries.push({
            id: `entry-library-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            day: 'Friday',
            timeSlotId: slot.id,
            timeSlot: slot,
            subjectId: 'library-hour',
            subject: {
              id: 'library-hour',
              name: 'Library / Self-Study',
              code: 'LIB',
              type: 'theory',
              weeklyHours: 0,
              labRequired: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            } as Subject,
            facultyId: 'self-study',
            faculty: {
              id: 'self-study',
              name: 'Self-Study',
              email: '',
              phone: '',
              createdAt: new Date(),
              updatedAt: new Date(),
            } as Faculty,
            roomId: libraryRoom.id,
            room: libraryRoom,
            classId,
            departmentId,
            year,
            isLocked: false,
          });

          // Mark room as used
          if (!availability.rooms.has(libraryRoom.id)) {
            availability.rooms.set(libraryRoom.id, new Set());
          }
          availability.rooms.get(libraryRoom.id)!.add(slotKey);

          console.log(`Added Library/Self-Study on Friday at ${slot.startTime}`);
        }
      }
    }
  }

  console.log(`Total entries created: ${entries.length}`);
  return { entries, conflicts };
}

export function detectConflicts(entries: TimetableEntry[]): Conflict[] {
  const conflicts: Conflict[] = [];
  const slotMap = new Map<string, TimetableEntry[]>();

  // Group entries by day and time slot
  for (const entry of entries) {
    const key = `${entry.day}-${entry.timeSlotId}`;
    if (!slotMap.has(key)) {
      slotMap.set(key, []);
    }
    slotMap.get(key)!.push(entry);
  }

  // Check for conflicts
  for (const [key, slotEntries] of slotMap) {
    // Check faculty conflicts
    const facultyMap = new Map<string, TimetableEntry[]>();
    for (const entry of slotEntries) {
      if (!facultyMap.has(entry.facultyId)) {
        facultyMap.set(entry.facultyId, []);
      }
      facultyMap.get(entry.facultyId)!.push(entry);
    }

    for (const [facultyId, facultyEntries] of facultyMap) {
      if (facultyEntries.length > 1) {
        conflicts.push({
          type: 'faculty',
          message: `Faculty ${facultyEntries[0].faculty?.name} is assigned to multiple classes at the same time`,
          entry1: facultyEntries[0],
          entry2: facultyEntries[1],
        });
      }
    }

    // Check room conflicts
    const roomMap = new Map<string, TimetableEntry[]>();
    for (const entry of slotEntries) {
      if (!roomMap.has(entry.roomId)) {
        roomMap.set(entry.roomId, []);
      }
      roomMap.get(entry.roomId)!.push(entry);
    }

    for (const [roomId, roomEntries] of roomMap) {
      if (roomEntries.length > 1) {
        conflicts.push({
          type: 'room',
          message: `Room ${roomEntries[0].room?.name} is double-booked`,
          entry1: roomEntries[0],
          entry2: roomEntries[1],
        });
      }
    }
  }

  return conflicts;
}
