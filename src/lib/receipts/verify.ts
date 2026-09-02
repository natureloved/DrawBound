import { createHash } from "node:crypto";
import type { DecisionReceipt } from "../domain/types";

export function verifyReceipt(receipt: DecisionReceipt): boolean {
  const { receiptDigest, ...input } = receipt;
  return receiptDigest === createHash("sha256").update(JSON.stringify(input)).digest("hex");
}
