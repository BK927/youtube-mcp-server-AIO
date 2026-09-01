import { YouTubeMcpError } from "../errors.js";

export function parseIso8601Duration(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.match(
    /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i,
  );
  if (!match) return undefined;

  const [, days = "0", hours = "0", minutes = "0", seconds = "0"] = match;
  return (
    Number.parseFloat(days) * 86_400 +
    Number.parseFloat(hours) * 3_600 +
    Number.parseFloat(minutes) * 60 +
    Number.parseFloat(seconds)
  );
}

export function parseTimeInput(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new YouTubeMcpError(
        "INVALID_TIME",
        "Time values must be finite, non-negative seconds.",
        { value },
      );
    }
    return value;
  }

  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Number.parseFloat(trimmed);

  if (/^\d{1,3}:\d{1,2}(?::\d{1,2}(?:\.\d+)?)?$/.test(trimmed)) {
    const parts = trimmed.split(":").map(Number);
    if (parts.some((part) => !Number.isFinite(part))) {
      throw new YouTubeMcpError("INVALID_TIME", `Invalid time value '${value}'.`);
    }
    if (parts.length === 2) {
      return (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
    }
    return (
      (parts[0] ?? 0) * 3_600 +
      (parts[1] ?? 0) * 60 +
      (parts[2] ?? 0)
    );
  }

  const unitPattern = /(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?/;
  const unitMatch = trimmed.match(new RegExp(`^${unitPattern.source}$`, "i"));
  if (unitMatch && unitMatch[0]) {
    return (
      Number.parseFloat(unitMatch[1] ?? "0") * 3_600 +
      Number.parseFloat(unitMatch[2] ?? "0") * 60 +
      Number.parseFloat(unitMatch[3] ?? "0")
    );
  }

  throw new YouTubeMcpError(
    "INVALID_TIME",
    "Use seconds, MM:SS, HH:MM:SS, or a value such as 1h2m3s.",
    { value },
  );
}

export function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const remainingSeconds = total % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}
