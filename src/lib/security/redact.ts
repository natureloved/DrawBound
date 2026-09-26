/**
 * Mask a secret for logs.
 *
 * Length-independent: the previous first4...last4 form leaked ~40% of a 20-char
 * secret, and masked short secrets down to a handful of characters. Everything
 * collapses to a fixed-shape token with the value's length reported, which is
 * what operators actually need for diagnosis.
 */
export function redactSecret(value: string): string {
  return `[redacted:${value.length}]`;
}
