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

/** Random minute in [10:00, 21:00) Moscow; if <= notBefore, same clock on the next Moscow day. */
export function pickRandomNewsRunAt(notBefore: Date, random = Math.random): Date {
  const offsetMinutes = Math.floor(random() * NEWS_WINDOW_HOURS * 60);
  const hour = NEWS_WINDOW_START_HOUR + Math.floor(offsetMinutes / 60);
  const minute = offsetMinutes % 60;

  const parts = moscowParts(notBefore);
  let candidate = zonedMoscowTime(parts.year, parts.month, parts.day, hour, minute);
  if (candidate.getTime() <= notBefore.getTime()) {
    const noon = zonedMoscowTime(parts.year, parts.month, parts.day, 12, 0);
    const nextParts = moscowParts(new Date(noon.getTime() + 24 * 60 * 60 * 1000));
    candidate = zonedMoscowTime(nextParts.year, nextParts.month, nextParts.day, hour, minute);
  }
  return candidate;
}
