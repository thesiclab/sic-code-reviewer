// SPDX-License-Identifier: Apache-2.0
import type { FileClass, FilePatch } from "../types.js";
import { NotImplemented } from "../errors.js";

export function parseUnifiedDiff(_text: string): FilePatch[] {
  throw new NotImplemented("diff.parseUnifiedDiff");
}

export function classifyFile(_path: string): FileClass {
  throw new NotImplemented("diff.classifyFile");
}
