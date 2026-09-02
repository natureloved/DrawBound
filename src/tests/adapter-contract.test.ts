import { describe, expect, it } from "vitest";
import { FixtureTachiAdapter } from "@/lib/tachi/fixture-adapter";
import { fixtureTransport } from "@/lib/tachi/fixture-transport";

describe("fixture adapter contract", () => {
  it("creates a TAURUS-style vault reference and transition receipts", async () => {
    const adapter = new FixtureTachiAdapter();
    await expect(adapter.createVault({ owner: "demo", collateralSats: 5000 })).resolves.toMatchObject({ vaultRef: expect.stringContaining("vault:taurus") });
    await expect(adapter.submitCreditTransition({ positionId: "p", action: "DRAW", amount: 100 })).resolves.toMatchObject({ transitionRef: expect.stringContaining("satvm:fixture") });
  });

  it("exposes the same read/submit shape through the transport", async () => {
    await expect(fixtureTransport.readState("vault:x")).resolves.toMatchObject({ ref: "vault:x" });
    await expect(fixtureTransport.submitTransition({ action: "DRAW" })).resolves.toHaveProperty("transitionRef");
  });
});
