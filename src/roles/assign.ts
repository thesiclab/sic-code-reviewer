// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import type { Finding, FindingOrigin, RawFinding } from "../types.js";

export function assignIds(
  raw: RawFinding[],
  origin: FindingOrigin,
  model: string,
  startAt: number,
): Finding[] {
  return raw.map((f, i) => ({
    ...f,
    id: `F${startAt + i}`,
    origin,
    raisedByModel: model,
    fingerprint: fingerprint(f),
  }));
}

/**
 * Shuffled order (seeded, deterministic); origin and model are blanked in the
 * prompt view: every copy says origin "reviewer", raisedByModel "" and
 * fingerprint "", so none of them carries a signal. These copies are for
 * rendering only; keep the originals (by id) for attribution.
 */
export function anonymise(findings: Finding[], seed: string): Finding[] {
  const copies = findings.map((f) => ({
    ...f,
    origin: "reviewer" as FindingOrigin,
    raisedByModel: "",
    fingerprint: "",
  }));
  let counter = 0;
  let pool = Buffer.alloc(0);
  const nextUint32 = (): number => {
    if (pool.length < 4)
      pool = createHash("sha256").update(`${seed}\0${counter++}`).digest();
    const n = pool.readUInt32BE(0);
    pool = pool.subarray(4);
    return n;
  };
  for (let i = copies.length - 1; i > 0; i--) {
    const j = nextUint32() % (i + 1);
    [copies[i], copies[j]] = [copies[j]!, copies[i]!];
  }
  return copies;
}

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** sha256(file, normalized title, lens) -> 12 hex characters. */
export function fingerprint(f: RawFinding): string {
  return createHash("sha256")
    .update(`${f.file}\0${normalizeTitle(f.title)}\0${f.lens}`)
    .digest("hex")
    .slice(0, 12);
}
