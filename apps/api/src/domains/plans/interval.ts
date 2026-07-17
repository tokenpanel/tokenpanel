/**
 * Pure subscription period arithmetic (shared admin + management).
 * Canonical home for addInterval (was services/subscription-interval.ts).
 */

export function addInterval(
  date: Date,
  interval: string,
  count: number,
): Date {
  const d = new Date(date.getTime());
  switch (interval) {
    case "day":
      d.setUTCDate(d.getUTCDate() + count);
      break;
    case "week":
      d.setUTCDate(d.getUTCDate() + count * 7);
      break;
    case "month":
      d.setUTCMonth(d.getUTCMonth() + count);
      break;
    case "year":
      d.setUTCFullYear(d.getUTCFullYear() + count);
      break;
    default:
      break;
  }
  return d;
}
