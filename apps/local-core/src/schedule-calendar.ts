import { Temporal } from "@js-temporal/polyfill";
import type { TriggerSpecDefinition } from "@bpa/schemas";

export type TriggerScheduleDefinition = NonNullable<
  TriggerSpecDefinition["schedule"]
>;

export interface ScheduleOccurrence {
  readonly occurrenceKey: string;
  readonly scheduledAt: string;
  readonly localCalendarKey?: string;
}

const NANOSECONDS_PER_SECOND = 1_000_000_000n;
const LOCAL_TIME_PATTERN = /^(?<hour>[01][0-9]|2[0-3]):(?<minute>[0-5][0-9])$/u;
const IANA_TIMEZONE_PATTERN = /^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9._+-]+)+)$/u;

export function occurrenceAtOrBefore(
  schedule: TriggerScheduleDefinition,
  at: Date
): ScheduleOccurrence | undefined {
  const instant = toInstant(at);
  assertScheduleDefinition(schedule);
  return schedule.type === "daily"
    ? dailyOccurrenceAtOrBefore(schedule, instant)
    : intervalOccurrenceAtOrBefore(schedule, instant);
}

export function occurrencesBetween(
  schedule: TriggerScheduleDefinition,
  afterExclusive: Date,
  throughInclusive: Date,
  maxOccurrences = 1_000
): readonly ScheduleOccurrence[] {
  const after = toInstant(afterExclusive);
  const through = toInstant(throughInclusive);
  assertScheduleDefinition(schedule);
  if (!Number.isSafeInteger(maxOccurrences) || maxOccurrences < 1) {
    throw new RangeError("maxOccurrences must be a positive safe integer.");
  }
  if (Temporal.Instant.compare(after, through) >= 0) return [];

  const occurrences = schedule.type === "daily"
    ? dailyOccurrencesBetween(schedule, after, through, maxOccurrences)
    : intervalOccurrencesBetween(schedule, after, through, maxOccurrences);
  return occurrences;
}

export function occurrencePageBetween(
  schedule: TriggerScheduleDefinition,
  afterExclusive: Date,
  throughInclusive: Date,
  pageSize = 1_000
): readonly ScheduleOccurrence[] {
  const after = toInstant(afterExclusive);
  const through = toInstant(throughInclusive);
  assertScheduleDefinition(schedule);
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw new RangeError("pageSize must be a positive safe integer.");
  }
  if (Temporal.Instant.compare(after, through) >= 0) return [];

  return schedule.type === "daily"
    ? dailyOccurrencePageBetween(schedule, after, through, pageSize)
    : intervalOccurrencePageBetween(schedule, after, through, pageSize);
}

function dailyOccurrenceAtOrBefore(
  schedule: Extract<TriggerScheduleDefinition, { readonly type: "daily" }>,
  at: Temporal.Instant
): ScheduleOccurrence {
  const localNow = at.toZonedDateTimeISO(schedule.timezone);
  let date = localNow.toPlainDate();
  let scheduled = dailyZonedDateTime(schedule, date);
  if (Temporal.Instant.compare(scheduled.toInstant(), at) > 0) {
    date = date.subtract({ days: 1 });
    scheduled = dailyZonedDateTime(schedule, date);
  }
  return dailyOccurrence(schedule, date, scheduled.toInstant());
}

function dailyOccurrencesBetween(
  schedule: Extract<TriggerScheduleDefinition, { readonly type: "daily" }>,
  after: Temporal.Instant,
  through: Temporal.Instant,
  maxOccurrences: number
): ScheduleOccurrence[] {
  const latest = dailyOccurrenceAtOrBefore(schedule, through);
  let date = Temporal.PlainDate.from(latest.localCalendarKey!.slice(0, 10));
  const descending: ScheduleOccurrence[] = [];
  while (true) {
    const scheduled = dailyZonedDateTime(schedule, date).toInstant();
    if (Temporal.Instant.compare(scheduled, after) <= 0) break;
    if (descending.length === maxOccurrences) {
      throw new RangeError(
        `Schedule range exceeds maxOccurrences (${maxOccurrences}).`
      );
    }
    descending.push(dailyOccurrence(schedule, date, scheduled));
    date = date.subtract({ days: 1 });
  }
  return descending.reverse();
}

function dailyOccurrencePageBetween(
  schedule: Extract<TriggerScheduleDefinition, { readonly type: "daily" }>,
  after: Temporal.Instant,
  through: Temporal.Instant,
  pageSize: number
): ScheduleOccurrence[] {
  let date = after.toZonedDateTimeISO(schedule.timezone).toPlainDate();
  let scheduled = dailyZonedDateTime(schedule, date).toInstant();
  if (Temporal.Instant.compare(scheduled, after) <= 0) {
    date = date.add({ days: 1 });
    scheduled = dailyZonedDateTime(schedule, date).toInstant();
  }
  const page: ScheduleOccurrence[] = [];
  while (
    page.length < pageSize &&
    Temporal.Instant.compare(scheduled, through) <= 0
  ) {
    page.push(dailyOccurrence(schedule, date, scheduled));
    date = date.add({ days: 1 });
    scheduled = dailyZonedDateTime(schedule, date).toInstant();
  }
  return page;
}

function dailyZonedDateTime(
  schedule: Extract<TriggerScheduleDefinition, { readonly type: "daily" }>,
  date: Temporal.PlainDate
): Temporal.ZonedDateTime {
  const match = LOCAL_TIME_PATTERN.exec(schedule.localTime)!;
  return Temporal.ZonedDateTime.from(
    {
      timeZone: schedule.timezone,
      year: date.year,
      month: date.month,
      day: date.day,
      hour: Number(match.groups!.hour),
      minute: Number(match.groups!.minute)
    },
    { disambiguation: "compatible" }
  );
}

function dailyOccurrence(
  schedule: Extract<TriggerScheduleDefinition, { readonly type: "daily" }>,
  date: Temporal.PlainDate,
  instant: Temporal.Instant
): ScheduleOccurrence {
  const localCalendarKey = `${date.toString()}T${schedule.localTime}[${schedule.timezone}]`;
  return {
    occurrenceKey: `schedule:daily:${localCalendarKey}`,
    scheduledAt: canonicalInstant(instant),
    localCalendarKey
  };
}

function intervalOccurrenceAtOrBefore(
  schedule: Extract<TriggerScheduleDefinition, { readonly type: "interval" }>,
  at: Temporal.Instant
): ScheduleOccurrence | undefined {
  const anchor = Temporal.Instant.from(schedule.anchorAt);
  const elapsed = at.epochNanoseconds - anchor.epochNanoseconds;
  if (elapsed < 0n) return undefined;
  const interval = BigInt(schedule.intervalSeconds) * NANOSECONDS_PER_SECOND;
  const occurrence = Temporal.Instant.fromEpochNanoseconds(
    anchor.epochNanoseconds + (elapsed / interval) * interval
  );
  return intervalOccurrence(occurrence);
}

function intervalOccurrencesBetween(
  schedule: Extract<TriggerScheduleDefinition, { readonly type: "interval" }>,
  after: Temporal.Instant,
  through: Temporal.Instant,
  maxOccurrences: number
): ScheduleOccurrence[] {
  const anchor = Temporal.Instant.from(schedule.anchorAt);
  const interval = BigInt(schedule.intervalSeconds) * NANOSECONDS_PER_SECOND;
  const earliest = after.epochNanoseconds < anchor.epochNanoseconds
    ? anchor.epochNanoseconds
    : anchor.epochNanoseconds +
      ((after.epochNanoseconds - anchor.epochNanoseconds) / interval + 1n) *
        interval;
  if (earliest > through.epochNanoseconds) return [];

  const count = Number((through.epochNanoseconds - earliest) / interval + 1n);
  if (count > maxOccurrences) {
    throw new RangeError(
      `Schedule range exceeds maxOccurrences (${maxOccurrences}).`
    );
  }
  return Array.from({ length: count }, (_, index) =>
    intervalOccurrence(
      Temporal.Instant.fromEpochNanoseconds(
        earliest + BigInt(index) * interval
      )
    )
  );
}

function intervalOccurrencePageBetween(
  schedule: Extract<TriggerScheduleDefinition, { readonly type: "interval" }>,
  after: Temporal.Instant,
  through: Temporal.Instant,
  pageSize: number
): ScheduleOccurrence[] {
  const anchor = Temporal.Instant.from(schedule.anchorAt);
  const interval = BigInt(schedule.intervalSeconds) * NANOSECONDS_PER_SECOND;
  const earliest = after.epochNanoseconds < anchor.epochNanoseconds
    ? anchor.epochNanoseconds
    : anchor.epochNanoseconds +
      ((after.epochNanoseconds - anchor.epochNanoseconds) / interval + 1n) *
        interval;
  if (earliest > through.epochNanoseconds) return [];
  const available =
    (through.epochNanoseconds - earliest) / interval + 1n;
  const count = Number(
    available < BigInt(pageSize) ? available : BigInt(pageSize)
  );
  return Array.from({ length: count }, (_, index) =>
    intervalOccurrence(
      Temporal.Instant.fromEpochNanoseconds(
        earliest + BigInt(index) * interval
      )
    )
  );
}

function intervalOccurrence(instant: Temporal.Instant): ScheduleOccurrence {
  const scheduledAt = canonicalInstant(instant);
  return {
    occurrenceKey: `schedule:interval:${scheduledAt}`,
    scheduledAt
  };
}

function canonicalInstant(instant: Temporal.Instant): string {
  return instant.toString({ smallestUnit: "millisecond" });
}

export function assertScheduleDefinition(
  schedule: TriggerScheduleDefinition
): void {
  if (!Number.isSafeInteger(schedule.onTimeWindowSeconds) || schedule.onTimeWindowSeconds < 1) {
    throw new RangeError("onTimeWindowSeconds must be a positive safe integer.");
  }
  if (schedule.type === "daily") {
    if (!IANA_TIMEZONE_PATTERN.test(schedule.timezone)) {
      throw new RangeError(`Invalid IANA timezone: ${schedule.timezone}`);
    }
    if (!LOCAL_TIME_PATTERN.test(schedule.localTime)) {
      throw new RangeError(`Invalid localTime: ${schedule.localTime}`);
    }
    try {
      Temporal.Instant.from("1970-01-01T00:00:00Z")
        .toZonedDateTimeISO(schedule.timezone);
    } catch {
      throw new RangeError(`Invalid IANA timezone: ${schedule.timezone}`);
    }
    return;
  }
  if (schedule.type !== "interval") {
    throw new RangeError("Unknown schedule type.");
  }
  if (!Number.isSafeInteger(schedule.intervalSeconds) || schedule.intervalSeconds < 60) {
    throw new RangeError("intervalSeconds must be an integer of at least 60.");
  }
  try {
    Temporal.Instant.from(schedule.anchorAt);
  } catch {
    throw new RangeError(`Invalid interval anchorAt: ${schedule.anchorAt}`);
  }
}

function toInstant(date: Date): Temporal.Instant {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new RangeError("Schedule calendar requires a valid Date.");
  }
  return Temporal.Instant.fromEpochMilliseconds(date.getTime());
}
