import { DateTime } from "luxon";

export const IST = "Asia/Kolkata";

export function nowIST(): DateTime {
  return DateTime.now().setZone(IST);
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
