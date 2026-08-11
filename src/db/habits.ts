import { getDb } from "./index";
import { addDays, localDay, nowUtcIso } from "../time";
import { computeStreak, type StreakInfo } from "../streak";

const MILESTONES = [7, 30, 100] as const;

export { computeStreak, type StreakInfo };

export interface HabitSummary extends StreakInfo {
  name: string;
}

export interface HabitDetail extends HabitSummary {
  history: { day: string; logged: boolean }[];
}

export interface LogResult extends StreakInfo {
  name: string;
  day: string;
  already_logged: boolean;
  /** 7, 30 or 100 the moment the streak reaches it; null otherwise. */
  milestone: number | null;
}

function findHabit(name: string): { id: number; name: string } | undefined {
  return getDb().prepare(`SELECT id, name FROM habits WHERE name = ?`).get(name.trim()) as
    | { id: number; name: string }
    | undefined;
}

/** Habits are implicit: the first `log_habit` call creates them. */
function ensureHabit(name: string): { id: number; name: string } {
  const trimmed = name.trim();
  const existing = findHabit(trimmed);
  if (existing) return existing;
  getDb().prepare(`INSERT INTO habits (name, created_at) VALUES (?, ?)`).run(
    trimmed,
    nowUtcIso(),
  );
  return findHabit(trimmed)!;
}

function loggedDays(habitId: number): string[] {
  const rows = getDb()
    .prepare(`SELECT day FROM habit_logs WHERE habit_id = ? ORDER BY day ASC`)
    .all(habitId) as { day: string }[];
  return rows.map((row) => row.day);
}

export function logHabit(name: string, day: string, note?: string): LogResult {
  const habit = ensureHabit(name);
  const result = getDb()
    .prepare(
      `INSERT OR IGNORE INTO habit_logs (habit_id, day, note, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(habit.id, day, note ?? null, nowUtcIso());

  const alreadyLogged = result.changes === 0;
  const streak = computeStreak(loggedDays(habit.id), localDay());

  // Only fire on the log that actually reaches the number, so a milestone is
  // never re-announced on subsequent days.
  const milestone =
    !alreadyLogged &&
    (MILESTONES as readonly number[]).includes(streak.current_streak)
      ? streak.current_streak
      : null;

  return {
    ...streak,
    name: habit.name,
    day,
    already_logged: alreadyLogged,
    milestone,
  };
}

export function getHabitDetail(name: string, historyDays: number): HabitDetail | null {
  const habit = findHabit(name);
  if (!habit) return null;

  const days = loggedDays(habit.id);
  const logged = new Set(days);
  const today = localDay();
  const streak = computeStreak(days, today);

  const history: { day: string; logged: boolean }[] = [];
  for (let offset = historyDays - 1; offset >= 0; offset--) {
    const day = addDays(today, -offset);
    history.push({ day, logged: logged.has(day) });
  }

  return { ...streak, name: habit.name, history };
}

export function listHabits(): HabitSummary[] {
  const habits = getDb()
    .prepare(`SELECT id, name FROM habits ORDER BY name ASC`)
    .all() as { id: number; name: string }[];
  const today = localDay();

  return habits
    .map((habit) => ({
      ...computeStreak(loggedDays(habit.id), today),
      name: habit.name,
    }))
    .sort((a, b) => b.current_streak - a.current_streak);
}

/** Habits with a live streak and nothing logged today — fuel for a nudge. */
export function habitsAtRisk(): HabitSummary[] {
  return listHabits().filter((habit) => habit.at_risk);
}
