export function toDate(value: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid date: ${value}`);
  }
  return d;
}

export function daysBetween(a: string, b: string): number {
  const ms = Math.abs(toDate(a).getTime() - toDate(b).getTime());
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

export function addDays(date: string, days: number): string {
  const d = toDate(date);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
