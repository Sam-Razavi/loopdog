import { addDays, dayOfWeek } from "./time";

export interface SwedishHoliday {
  name: string;
  date: string; // YYYY-MM-DD
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * The standard Meeus/Jones/Butcher algorithm for the Gregorian Easter date.
 * Pure integer math, valid for any Gregorian year — no external table or
 * dependency, same spirit as the project's hand-rolled PNG encoder.
 */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * The (exactly one) Saturday between two YYYY-MM-DD dates inclusive — used
 * for Midsummer Day and All Saints' Day, both officially defined as "the
 * Saturday that falls within this week-long range" rather than a fixed
 * calendar date.
 */
function saturdayBetween(start: string, end: string): string {
  let day = start;
  while (day <= end) {
    if (dayOfWeek(day) === 6) return day;
    day = addDays(day, 1);
  }
  throw new Error(`no Saturday found between ${start} and ${end} — this should be unreachable`);
}

/**
 * Sweden's 13 official public holidays ("röda dagar") for a given year,
 * sorted chronologically. Deliberately excludes non-official "klämdagar" /
 * eve days (Christmas Eve, New Year's Eve, Midsummer Eve) — those are
 * traditionally observed but not on the official list.
 */
export function listSwedishHolidays(year: number): SwedishHoliday[] {
  const easter = easterSunday(year);

  const holidays: SwedishHoliday[] = [
    { name: "Nyårsdagen (New Year's Day)", date: `${year}-01-01` },
    { name: "Trettondedag jul (Epiphany)", date: `${year}-01-06` },
    { name: "Långfredagen (Good Friday)", date: addDays(easter, -2) },
    { name: "Påskdagen (Easter Sunday)", date: easter },
    { name: "Annandag påsk (Easter Monday)", date: addDays(easter, 1) },
    { name: "Första maj (May Day)", date: `${year}-05-01` },
    { name: "Kristi himmelsfärdsdag (Ascension Day)", date: addDays(easter, 39) },
    { name: "Pingstdagen (Whit Sunday)", date: addDays(easter, 49) },
    { name: "Sveriges nationaldag (National Day)", date: `${year}-06-06` },
    {
      name: "Midsommardagen (Midsummer Day)",
      date: saturdayBetween(`${year}-06-20`, `${year}-06-26`),
    },
    {
      name: "Alla helgons dag (All Saints' Day)",
      date: saturdayBetween(`${year}-10-31`, `${year}-11-06`),
    },
    { name: "Juldagen (Christmas Day)", date: `${year}-12-25` },
    { name: "Annandag jul (Boxing Day)", date: `${year}-12-26` },
  ];

  return holidays.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
