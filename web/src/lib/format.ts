// Clinic time is Asia/Riyadh; format with Intl so dates read correctly in Arabic and English.
export function riyadhDateTime(iso: string, locale: "ar" | "en" = "en"): string {
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-SA-u-ca-gregory" : "en-GB", {
    timeZone: "Asia/Riyadh",
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

export function riyadhTime(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Riyadh", hour: "2-digit", minute: "2-digit" }).format(
    new Date(iso),
  );
}

export function riyadhDay(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Riyadh",
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(iso));
}

export const sar = (halalas: number) => `${(halalas / 100).toLocaleString("en-US")} SAR`;
