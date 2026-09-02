import { NextResponse } from "next/server";
import { resetDemo } from "@/lib/store";

export async function POST() {
  return NextResponse.json({ position: resetDemo(), receipts: [] });
}
