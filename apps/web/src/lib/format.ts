export function formatNumber(value: number | string | null | undefined, digits = 1): string {
  if (value === null || value === undefined || value === "") return "-";
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  return new Intl.NumberFormat("ja-JP", { maximumFractionDigits: digits }).format(number);
}

export function formatPercent(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "-";
  return `${formatNumber(value)}%`;
}

export function formatYen(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "-";
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  if (number >= 1_000_000_000_000) return `${formatNumber(number / 1_000_000_000_000, 2)}兆円`;
  if (number >= 100_000_000) return `${formatNumber(number / 100_000_000, 1)}億円`;
  return `${formatNumber(number, 0)}円`;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ja-JP", { month: "2-digit", day: "2-digit" }).format(date);
}

export function scoreToPercent(value: number | string | null | undefined): number {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, number <= 10 ? number * 10 : number));
}

