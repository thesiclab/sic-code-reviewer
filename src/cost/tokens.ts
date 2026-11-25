// SPDX-License-Identifier: Apache-2.0
/** chars/4, rounded up. Shared by the context engine and the cost estimate. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
