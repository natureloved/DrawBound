import { createHash, randomUUID } from "node:crypto";
import type { DecisionReceipt } from "../domain/types";

export function createReceiptId(): string {
  return `rcpt_${randomUUID()}`;
}

export function createReceipt(input: Omit<DecisionReceipt, "receiptDigest">): DecisionReceipt {
  const canonical = JSON.stringify(input);
  return { ...input, receiptDigest: createHash("sha256").update(canonical).digest("hex") };
}
