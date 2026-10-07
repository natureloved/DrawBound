/**
 * Minimal bech32 / bech32m (BIP-173 + BIP-350) segwit address decoder.
 *
 * WHY THIS IS HERE RATHER THAN "JUST USE bip322-js"
 * `Address.isP2TR()` from bip322-js only inspects the prefix: it returns true for
 * `tb1pINVALID...`, which is not even in the bech32 character set. This repo used
 * that check in two places that then treated the result as "a real address on this
 * network": the BIP-322 ownership-proof gate, and the live vault binding. A
 * checksum-validity check is ~60 lines and removes the discrepancy, so the
 * protocol's notion of "a vault address that can exist" is its own.
 *
 * Vectors below in the test suite come from BIP-350.
 */

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32_CONST = 1;
const BECH32M_CONST = 0x2bc830a3;

function polymod(values: number[]): number {
  const gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const value of values) {
    // BIP-173's reference loop: the top 5 bits of the 30-bit accumulator decide
    // which generators to mix in, then the accumulator is shifted by 5 and the
    // next symbol is folded in. (`>> 25` / `& 0x1ffffff`, not 24 / 0xffffff —
    // the off-by-one there silently accepts nothing and rejects everything.)
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) {
      if ((top >> i) & 1) chk ^= gen[i];
    }
  }
  return chk >>> 0;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

function convertBits(data: number[], from: number, to: number, pad: boolean): number[] | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >> from !== 0) return null;
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || (acc << (to - bits)) & maxv) {
    return null;
  }
  return out;
}

export interface SegwitDecode {
  /** bech32 human-readable prefix: "bc" | "tb" | "bcrt". */
  hrp: string;
  /** Segwit witness version (1 for P2TR). */
  witnessVersion: number;
  /** Witness program as lowercase hex. */
  programHex: string;
  /** Which checksum encoding was used. */
  spec: "bech32" | "bech32m";
}

/**
 * Decode and fully validate a segwit address. Returns null when the string is not
 * an address that can exist: wrong charset, mixed case, bad checksum, bad program
 * length, a witness version that disagrees with the encoding (v0 must be bech32,
 * v1+ must be bech32m), or padding bits left over.
 */
export function decodeSegwitAddress(address: string): SegwitDecode | null {
  if (typeof address !== "string" || address.length < 14 || address.length > 90) return null;
  const lowered = address.toLowerCase();
  const upper = address.toUpperCase();
  if (address !== lowered && address !== upper) return null;
  const value = lowered;

  const sep = value.lastIndexOf("1");
  if (sep < 1 || sep + 7 > value.length) return null;
  const hrp = value.slice(0, sep);
  const dataPart = value.slice(sep + 1);

  const data: number[] = [];
  for (const char of dataPart) {
    const index = CHARSET.indexOf(char);
    if (index === -1) return null;
    data.push(index);
  }

  const checksumOk = polymod([...hrpExpand(hrp), ...data]);
  const spec: SegwitDecode["spec"] | null =
    checksumOk === BECH32M_CONST ? "bech32m" : checksumOk === BECH32_CONST ? "bech32" : null;
  if (!spec) return null;

  const witnessVersion = data[0];
  if (witnessVersion < 0 || witnessVersion > 16) return null;
  // BIP-350: v0 predates bech32m and must not use it; v1+ must not use bech32.
  if ((witnessVersion === 0 && spec !== "bech32") || (witnessVersion !== 0 && spec !== "bech32m")) return null;

  // The last six symbols are the checksum: they must be excluded before the
  // 5-bit groups are re-packed into the 8-bit witness program.
  const program = convertBits(data.slice(1, data.length - 6), 5, 8, false);
  if (program === null) return null;
  if (program.length < 2 || program.length > 40) return null;
  if (witnessVersion === 0 && program.length !== 20 && program.length !== 32) return null;
  if (witnessVersion !== 0 && program.length !== 32) return null;

  return { hrp, witnessVersion, programHex: program.map((b) => b.toString(16).padStart(2, "0")).join(""), spec };
}

/**
 * True when `address` is a pay-to-taproot (witness v1) output on one of the known
 * bech32 prefixes. `expectedHrp` additionally pins the network.
 */
export function isP2trAddress(address: string, expectedHrp?: string): boolean {
  const decoded = decodeSegwitAddress(address);
  if (!decoded) return false;
  if (decoded.witnessVersion !== 1) return false;
  return expectedHrp === undefined || decoded.hrp === expectedHrp;
}
