// SPDX-License-Identifier: Apache-2.0
// Entrypoint: review. See CONTRACT.md section 2 and module 9. Wired by worker F.
import { NotImplemented } from "../errors.js";

export async function main(): Promise<number> {
  throw new NotImplemented("entry.review");
}
