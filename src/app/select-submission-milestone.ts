import type { GitLabMilestone } from "../gitlab/types.ts";

export interface SubmissionMilestoneSelection {
  readonly submissionDate: string;
  readonly reason: "nearest-future" | "no-future-milestone";
  readonly milestone: { readonly id: number; readonly title: string; readonly dueDate: string } | null;
}

/** Gregorian calendar validation without Date parsing or clock access. */
function calendarDate(value: string): boolean {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(value)) return false;
  const year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7)), day = Number(value.slice(8, 10));
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
}

export function selectSubmissionMilestone(
  candidates: readonly GitLabMilestone[], submissionDate: string,
): SubmissionMilestoneSelection {
  if (!calendarDate(submissionDate)) throw new TypeError("Submission date must be a valid Gregorian YYYY-MM-DD date");
  let selected: GitLabMilestone | null = null;
  for (const candidate of candidates) {
    if (candidate.state !== "active" || candidate.dueDate === null || !calendarDate(candidate.dueDate) ||
        candidate.dueDate <= submissionDate) continue;
    if (selected === null || candidate.dueDate < selected.dueDate! ||
        (candidate.dueDate === selected.dueDate && candidate.id < selected.id)) selected = candidate;
  }
  return Object.freeze({ submissionDate, reason: selected === null ? "no-future-milestone" : "nearest-future",
    milestone: selected === null ? null : Object.freeze({ id: selected.id, title: selected.title, dueDate: selected.dueDate! }) });
}
