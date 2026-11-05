export const BUSINESS_TIME_ZONE = 'Africa/Cairo';

/** YYYY-MM-DD in the business time zone (not UTC), so "today" is right near midnight in Egypt. */
export function localDate(now: Date, timeZone = BUSINESS_TIME_ZONE): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function localWeekday(now: Date, timeZone = BUSINESS_TIME_ZONE): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'long' }).format(now);
}
