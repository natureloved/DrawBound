import { NextResponse } from "next/server";
import { getReceipts } from "@/lib/store";

export async function GET() {
  return NextResponse.json({ receipts: getReceipts() });
}
