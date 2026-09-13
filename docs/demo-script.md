# 85-Second Demo Script

1. Show the collateralized `pos_demo_01` position: 5,000 native sats in a TAURUS fixture vault and a 150% health proof.
2. Leave the amount at 100 units and authorize the draw. Point to the green `ALLOW` receipt, proof digest, and SatVM transition reference.
3. Select `Unhealthy` and submit the exact same 100-unit request. The covenant freezes the draw and emits a red `DENY` receipt. This is the only wow moment.
4. Click `Repay all` to show repayment remains available while frozen.
5. Click `Request unlock` at zero debt and show the `EXITED` / available recovery status.

Current rehearsal mode is `FIXTURE` on signet. Replace with a recorded live trace only after official Tachi APIs and a real test vault are verified.
