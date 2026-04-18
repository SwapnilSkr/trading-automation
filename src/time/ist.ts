import { DateTime } from "luxon";

export const IST = "Asia/Kolkata";

export function nowIST(): DateTime {
  return DateTime.now().setZone(IST);
}

export function minutesSinceMidnightIST(dt: DateTime = nowIST()): number {
  return dt.hour * 60 + dt.minute;
}

/** Next Mon–Fri on or after `dt` (calendar day in IST). */
export function nextIndianWeekdayOnOrAfter(dt: DateTime): DateTime {
  let d = dt.startOf("day");
  while (!isIndianWeekday(d)) {
    d = d.plus({ days: 1 });
  }
  return d;
}

/** Next Mon–Fri strictly after `dt`'s calendar date. */
export function nextIndianWeekdayAfter(dt: DateTime): DateTime {
  return nextIndianWeekdayOnOrAfter(dt.plus({ days: 1 }));
}

export function istDateString(dt?: DateTime): string {
  return (dt ?? nowIST()).toFormat("yyyy-MM-dd");
}

export function parseIST(date: string, time: string): Date {
  return DateTime.fromISO(`${date}T${time}`, { zone: IST }).toJSDate();
}

/** Market weekday in India (Mon–Fri) */
export function isIndianWeekday(dt: DateTime = nowIST()): boolean {
  return dt.weekday >= 1 && dt.weekday <= 5;
}
