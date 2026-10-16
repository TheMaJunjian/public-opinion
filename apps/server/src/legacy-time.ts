/** Prisma stores DateTime in PostgreSQL timestamp(3) without a zone as UTC.
 * JSON extraction omits Z; never reinterpret it in the migration host's zone. */
export function legacyTimestamp(value:unknown):string {
  const text=String(value);
  const utc=/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)?`${text.replace(' ','T')}Z`:text;
  const date=new Date(utc);
  if(!Number.isFinite(date.getTime())) throw new Error('旧记录时间无效');
  return date.toISOString();
}
