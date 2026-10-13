import { cn } from '@/lib/utils';
import type { TimeSlot, TimetableEntry } from '@/types';

interface TimetableGridProps {
  entries: TimetableEntry[];
  timeSlots: TimeSlot[];
  workingDays: string[];
  onEntryClick?: (entry: TimetableEntry) => void;
  onEmptySlotClick?: (day: string, slot: TimeSlot) => void;
}

const dayColors: Record<string, string> = {
  Monday: 'bg-chart-1/10 border-chart-1/30',
  Tuesday: 'bg-chart-2/10 border-chart-2/30',
  Wednesday: 'bg-chart-3/10 border-chart-3/30',
  Thursday: 'bg-chart-4/10 border-chart-4/30',
  Friday: 'bg-chart-5/10 border-chart-5/30',
  Saturday: 'bg-muted border-muted-foreground/30',
};

export function TimetableGrid({
  entries,
  timeSlots,
  workingDays,
  onEntryClick,
  onEmptySlotClick,
}: TimetableGridProps) {
  // Debug logging
  console.log('TimetableGrid - Working Days:', workingDays);
  console.log('TimetableGrid - Total Entries:', entries.length);
  console.log('TimetableGrid - Friday Entries:', entries.filter(e => e.day === 'Friday').length);

  const getEntry = (day: string, slotId: string): TimetableEntry | undefined => {
    return entries.find((e) => e.day === day && e.timeSlotId === slotId);
  };

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[800px]">
        {/* Header row */}
        <div className="grid gap-1" style={{ gridTemplateColumns: `100px repeat(${workingDays.length}, 1fr)` }}>
          <div className="border-2 border-border bg-primary p-3 text-center font-bold text-primary-foreground">
            Time
          </div>
          {workingDays.map((day) => (
            <div
              key={day}
              className="border-2 border-border bg-primary p-3 text-center font-bold text-primary-foreground"
            >
              {day}
            </div>
          ))}
        </div>

        {/* Time slot rows */}
        {timeSlots.map((slot) => (
          <div key={slot.id} className="grid gap-1 mt-1" style={{ gridTemplateColumns: `100px repeat(${workingDays.length}, 1fr)` }}>
            {/* Time column */}
            <div
              className={cn(
                'border-2 border-border p-2 text-center text-sm font-mono',
                slot.type === 'break' || slot.type === 'lunch'
                  ? 'bg-muted text-muted-foreground'
                  : 'bg-card'
              )}
            >
              <div>{slot.startTime}</div>
              <div className="text-muted-foreground">-</div>
              <div>{slot.endTime}</div>
            </div>

            {/* Day columns */}
            {workingDays.map((day) => {
              if (slot.type === 'break') {
                return (
                  <div
                    key={`${day}-${slot.id}`}
                    className="flex items-center justify-center border-2 border-dashed border-border bg-muted p-2"
                  >
                    <span className="text-sm font-medium text-muted-foreground">
                      SHORT BREAK
                    </span>
                  </div>
                );
              }

              if (slot.type === 'lunch') {
                return (
                  <div
                    key={`${day}-${slot.id}`}
                    className="flex items-center justify-center border-2 border-dashed border-border bg-muted p-2"
                  >
                    <span className="text-sm font-medium text-muted-foreground">
                      LUNCH BREAK
                    </span>
                  </div>
                );
              }

              const entry = getEntry(day, slot.id);

              if (entry) {
                return (
                  <div
                    key={`${day}-${slot.id}`}
                    onClick={() => onEntryClick?.(entry)}
                    className={cn(
                      'cursor-pointer border-2 border-border p-2 transition-all hover:shadow-sm',
                      dayColors[day] || 'bg-secondary',
                      entry.isLocked && 'ring-2 ring-primary ring-offset-2'
                    )}
                  >
                    <div className="font-bold text-sm truncate">
                      {entry.subject?.name}
                      {entry.subject?.type && (
                        <span className="ml-1 text-xs font-normal text-muted-foreground">
                          ({entry.subject.type === 'lab' ? 'Lab' : entry.subject.type === 'practical' ? 'Practical' : 'Theory'})
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground truncate mt-1">
                      {entry.faculty?.name}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                      {entry.room?.roomNumber}
                    </div>
                    {entry.isLocked && (
                      <div className="mt-1 text-xs font-medium">🔒</div>
                    )}
                  </div>
                );
              }

              return (
                <div
                  key={`${day}-${slot.id}`}
                  onClick={() => onEmptySlotClick?.(day, slot)}
                  className="cursor-pointer border-2 border-dashed border-border bg-card p-2 transition-all hover:bg-secondary"
                >
                  <span className="text-xs text-muted-foreground">Empty</span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
