import { config } from "./config";
import { addDays, localDay } from "./time";
import { extractReadableText } from "./webfetch";
import { ToolError } from "./errors";

/**
 * Canvas LMS (Instructure) — courses, assignments, and announcements, read
 * only. Every Canvas instance is institution-hosted (e.g.
 * https://kth.instructure.com), so there's no single host to test against
 * even in principle; on top of that, this sandbox's egress proxy blocks the
 * Instructure hosts reachable from documentation searches (canvas.instructure.com,
 * documentation.instructure.com, developerdocs.instructure.com) the same way
 * it blocks the Sweden-connectivity hosts. The shapes below are built from
 * Canvas's own REST API docs (fetched via search snippets, not a live page)
 * plus general knowledge of the API's conventions — reasonably confident for
 * courses and assignments (some of the most standard, stable Canvas
 * endpoints), less so for the exact optional query parameters on
 * announcements. Every field access is defensive for exactly that reason,
 * same posture as transit.ts/electricity.ts/smhiwarnings.ts.
 */

function requireCanvasConfig(): { baseUrl: string; token: string } {
  if (!config.canvasBaseUrl || !config.canvasApiToken) {
    throw new ToolError(
      "Canvas isn't set up yet — CANVAS_BASE_URL and CANVAS_API_TOKEN aren't configured.",
    );
  }
  return { baseUrl: config.canvasBaseUrl, token: config.canvasApiToken };
}

async function canvasGet(path: string, params: Record<string, string | string[]> = {}): Promise<unknown> {
  const { baseUrl, token } = requireCanvasConfig();
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const v of value) url.searchParams.append(key, v);
    } else {
      url.searchParams.set(key, value);
    }
  }

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new ToolError(`couldn't reach Canvas: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new ToolError("Canvas rejected the request — CANVAS_API_TOKEN may be wrong or expired.");
  }
  if (!response.ok) throw new ToolError(`Canvas request failed (HTTP ${response.status})`);

  return response.json();
}

export interface CanvasCourse {
  id: number;
  name: string;
  code: string;
}

/** Pure over an already-fetched array — same reasoning as every other parser in this codebase. */
export function parseCourses(raw: unknown[]): CanvasCourse[] {
  const courses: CanvasCourse[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const c = entry as Record<string, unknown>;
    if (typeof c.id !== "number" || typeof c.name !== "string") continue;
    courses.push({ id: c.id, name: c.name, code: typeof c.course_code === "string" ? c.course_code : "" });
  }
  return courses;
}

export async function getCourses(): Promise<CanvasCourse[]> {
  const data = await canvasGet("/api/v1/courses", { enrollment_state: "active", per_page: "100" });
  return parseCourses(Array.isArray(data) ? data : []);
}

export interface CanvasAssignment {
  id: number;
  name: string;
  course: string;
  dueAt: string;
  url: string | null;
}

/**
 * Pure. Only keeps assignments with a real due date — an assignment with no
 * due_at can't be sorted or windowed against `days`, and Canvas already
 * returns plenty of those (drafts, ungraded surveys) even with
 * bucket=upcoming.
 */
export function parseAssignments(raw: unknown[], course: string): CanvasAssignment[] {
  const assignments: CanvasAssignment[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const a = entry as Record<string, unknown>;
    if (typeof a.id !== "number" || typeof a.name !== "string" || typeof a.due_at !== "string") continue;
    assignments.push({
      id: a.id,
      name: a.name,
      course,
      dueAt: a.due_at,
      url: typeof a.html_url === "string" ? a.html_url : null,
    });
  }
  return assignments;
}

/** Pure. Sorts soonest-due first and keeps only what falls within the next `days` days of `today`. */
export function withinWindow(assignments: CanvasAssignment[], days: number, today: string): CanvasAssignment[] {
  const cutoff = addDays(today, days);
  return assignments
    .filter((a) => a.dueAt.slice(0, 10) >= today && a.dueAt.slice(0, 10) <= cutoff)
    .sort((a, b) => (a.dueAt < b.dueAt ? -1 : a.dueAt > b.dueAt ? 1 : 0));
}

export async function getAssignments(days: number): Promise<CanvasAssignment[]> {
  const courses = await getCourses();
  const perCourse = await Promise.all(
    courses.map(async (course) => {
      const data = await canvasGet(`/api/v1/courses/${course.id}/assignments`, {
        bucket: "upcoming",
        per_page: "100",
      });
      return parseAssignments(Array.isArray(data) ? data : [], course.name);
    }),
  );
  return withinWindow(perCourse.flat(), days, localDay());
}

export interface CanvasAnnouncement {
  id: number;
  title: string;
  message: string;
  course: string;
  postedAt: string | null;
  url: string | null;
}

/**
 * Pure. `courseByContextCode` maps Canvas's "course_<id>" context code back
 * to the course name for display, since the announcement object itself only
 * carries the context code.
 */
export function parseAnnouncements(
  raw: unknown[],
  courseByContextCode: Map<string, string>,
): CanvasAnnouncement[] {
  const announcements: CanvasAnnouncement[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const a = entry as Record<string, unknown>;
    if (typeof a.id !== "number" || typeof a.title !== "string") continue;
    const contextCode = typeof a.context_code === "string" ? a.context_code : "";
    const message = typeof a.message === "string" ? extractReadableText(a.message).text : "";
    announcements.push({
      id: a.id,
      title: a.title,
      message,
      course: courseByContextCode.get(contextCode) ?? contextCode,
      postedAt: typeof a.posted_at === "string" ? a.posted_at : null,
      url: typeof a.html_url === "string" ? a.html_url : null,
    });
  }
  return announcements.sort((a, b) => (b.postedAt ?? "").localeCompare(a.postedAt ?? ""));
}

export async function getAnnouncements(days: number): Promise<CanvasAnnouncement[]> {
  const courses = await getCourses();
  if (courses.length === 0) return [];

  const courseByContextCode = new Map(courses.map((c) => [`course_${c.id}`, c.name]));
  const data = await canvasGet("/api/v1/announcements", {
    "context_codes[]": courses.map((c) => `course_${c.id}`),
    start_date: `${addDays(localDay(), -days)}T00:00:00Z`,
  });
  return parseAnnouncements(Array.isArray(data) ? data : [], courseByContextCode);
}
