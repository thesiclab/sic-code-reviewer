// SPDX-License-Identifier: Apache-2.0
export class NotImplemented extends Error {
  constructor(what: string) {
    super(`not implemented: ${what}`);
    this.name = "NotImplemented";
  }
}
