import { parseExpression } from 'cron-parser';

export function nextCronDate(expression: string, timezone: string, after: Date): Date | null {
  if (expression.trim().split(/\s+/).length !== 5) return null;
  try {
    return parseExpression(expression, { currentDate: after, tz: timezone }).next().toDate();
  } catch {
    return null;
  }
}

export function isValidCron(expression: string): boolean {
  return nextCronDate(expression, 'UTC', new Date()) !== null;
}

export function isValidTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}
