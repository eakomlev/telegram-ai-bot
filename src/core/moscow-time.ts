const MOSCOW_TZ = 'Europe/Moscow';

export type MoscowParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

export function moscowParts(date = new Date()): MoscowParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: MOSCOW_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(
    fmt
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

export function moscowDateString(date = new Date()): string {
  const parts = moscowParts(date);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

/** Instant of the 1st of the current Moscow calendar month at 00:00:00. */
export function moscowMonthStart(now = new Date()): Date {
  const { year, month } = moscowParts(now);
  return zonedMoscowTime(year, month, 1, 0, 0, 0);
}

/** Instant of the 1st of the next Moscow calendar month at 00:00:00. */
export function moscowNextMonthStart(now = new Date()): Date {
  const { year, month } = moscowParts(now);
  return month === 12
    ? zonedMoscowTime(year + 1, 1, 1, 0, 0, 0)
    : zonedMoscowTime(year, month + 1, 1, 0, 0, 0);
}

/** Instant corresponding to the given civil time in Europe/Moscow. */
export function zonedMoscowTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0,
): Date {
  let utcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  for (let i = 0; i < 3; i += 1) {
    const asMoscow = moscowParts(new Date(utcMs));
    const asUtc = Date.UTC(
      asMoscow.year,
      asMoscow.month - 1,
      asMoscow.day,
      asMoscow.hour,
      asMoscow.minute,
      asMoscow.second,
    );
    const wanted = Date.UTC(year, month - 1, day, hour, minute, second);
    utcMs += wanted - asUtc;
  }
  return new Date(utcMs);
}

const NEWS_WINDOW_START_HOUR = 10;
const NEWS_WINDOW_HOURS = 11; // [10:00, 21:00)

function moscowNewsWindowBounds(parts: MoscowParts) {
  const start = zonedMoscowTime(parts.year, parts.month, parts.day, NEWS_WINDOW_START_HOUR, 0);
  const end = zonedMoscowTime(
    parts.year,
    parts.month,
    parts.day,
    NEWS_WINDOW_START_HOUR + NEWS_WINDOW_HOURS,
    0,
  );
  return { start, end };
}

function nextMoscowCalendarDay(parts: MoscowParts): MoscowParts {
  const noon = zonedMoscowTime(parts.year, parts.month, parts.day, 12, 0);
  return moscowParts(new Date(noon.getTime() + 24 * 60 * 60 * 1000));
}

/**
 * Random instant in today's remaining Moscow news window [10:00, 21:00),
 * strictly after `notBefore`. If no time remains today, samples tomorrow's full window.
 */
export function pickRandomNewsRunAt(notBefore: Date, random = Math.random): Date {
  let day = moscowParts(notBefore);
  let { start, end } = moscowNewsWindowBounds(day);
  let rangeStartMs = Math.max(start.getTime(), notBefore.getTime() + 1);

  if (rangeStartMs >= end.getTime()) {
    day = nextMoscowCalendarDay(day);
    ({ start, end } = moscowNewsWindowBounds(day));
    rangeStartMs = start.getTime();
  }

  const spanMs = end.getTime() - rangeStartMs;
  const offsetMs = Math.floor(random() * spanMs);
  return new Date(rangeStartMs + offsetMs);
}
