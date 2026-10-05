type Reading = string | null | undefined;

// API quantities are decimal strings. Compare the supplied precision without
// converting large cargo quantities to floating-point numbers.
function decimal(value: Reading): { digits: bigint; places: number } | null {
  if (value == null || value.length > 200) return null;
  const match = /^([+-]?)(?:(\d+)(?:\.(\d+))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(value.trim());
  if (!match) return null;
  const fraction = match[3] ?? match[4] ?? "";
  const digits = BigInt((match[2] ?? "0") + fraction);
  const exponent = Number(match[5] ?? "0");
  // Bound exponent expansion for intermediate form input. Persisted API
  // quantities have at most 18 digits and 3 decimal places.
  if (Math.abs(exponent) > 100 || (match[1] === "-" && digits !== 0n)) return null;
  const places = fraction.length - exponent;
  return places < 0 ? { digits: digits * 10n ** BigInt(-places), places: 0 } : { digits, places };
}

function decimalText(digits: bigint, places: number): string {
  const negative = digits < 0n;
  const absolute = (negative ? -digits : digits).toString().padStart(places + 1, "0");
  const whole = places ? absolute.slice(0, -places) : absolute;
  const fraction = places ? absolute.slice(-places).replace(/0+$/, "") : "";
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export function readingQuantity(value: Reading): string {
  const parsed = decimal(value);
  if (!parsed) return "Not provided";
  if (parsed.digits === 0n) return "NIL (0)";
  const [whole, fraction] = decimalText(parsed.digits, parsed.places).split(".");
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${fraction ? `.${fraction}` : ""}`;
}

export function quantityDifference(measured: Reading, declared: Reading): string | null {
  const reading = decimal(measured);
  const baseline = decimal(declared);
  if (!reading || !baseline) return null;
  const places = Math.max(reading.places, baseline.places);
  const difference = reading.digits * 10n ** BigInt(places - reading.places)
    - baseline.digits * 10n ** BigInt(places - baseline.places);
  return `${difference > 0n ? "+" : ""}${decimalText(difference, places)}`;
}

export function tallyResult(measured: Reading, declared: Reading): {
  status: "tallies" | "above" | "below" | "unknown";
  label: string;
  difference: string | null;
} {
  const difference = quantityDifference(measured, declared);
  if (difference === null) return { status: "unknown", label: "Awaiting comparison", difference };
  if (difference === "0") return { status: "tallies", label: "Tallies", difference };
  return difference.startsWith("-")
    ? { status: "below", label: "Below declaration", difference }
    : { status: "above", label: "Above declaration", difference };
}
