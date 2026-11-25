// SPDX-License-Identifier: Apache-2.0
// No test may reach the network (no real model API calls). Any fetch throws.
import { beforeEach, vi } from "vitest";

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("network access is not allowed in tests; inject a fake fetch or use createFakeAdapter");
    }),
  );
});
