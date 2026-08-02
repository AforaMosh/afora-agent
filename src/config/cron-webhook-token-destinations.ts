export function normalizeCronWebhookTokenDestination(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.hash ||
      parsed.hostname.includes("*")
    ) {
      return null;
    }
    if (!parsed.hostname.startsWith("[") && parsed.hostname.endsWith(".")) {
      parsed.hostname = parsed.hostname.replace(/\.+$/, "");
    }
    return parsed.href;
  } catch {
    return null;
  }
}

export function resolveCronWebhookTokenDestinations(
  values: readonly string[] | undefined,
): ReadonlySet<string> | undefined {
  // Unset preserves the shipped attach-everywhere behavior; an explicit empty
  // list opts into withholding the bearer from every destination.
  if (values === undefined) {
    return undefined;
  }
  const destinations = new Set<string>();
  for (const value of values) {
    const normalized = normalizeCronWebhookTokenDestination(value);
    if (normalized) {
      destinations.add(normalized);
    }
  }
  return destinations;
}

export function isCronWebhookTokenDestinationAllowed(
  value: string,
  destinations: ReadonlySet<string> | undefined,
): boolean {
  if (destinations === undefined) {
    return true;
  }
  const normalized = normalizeCronWebhookTokenDestination(value);
  return normalized !== null && destinations.has(normalized);
}
