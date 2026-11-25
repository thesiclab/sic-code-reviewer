// SPDX-License-Identifier: Apache-2.0
// Synthetic, obviously fake secret-shaped strings for redaction tests. They are
// assembled at run time from fragments so no secret-shaped literal sits in the
// repository (the secret-guard hook and secret scanners stay quiet). None of
// these is a real credential.
const j = (...parts: string[]) => parts.join("");
const DASH5 = "-----";

export const FAKE = {
  pemFull: j(
    DASH5,
    "BEGIN RSA PRIV",
    "ATE KEY",
    DASH5,
    "\nMIIEowIBAAKCAQEAx\n",
    DASH5,
    "END RSA PRIV",
    "ATE KEY",
    DASH5,
  ),
  pemFullBody: "MIIEowIBAAKCAQEAx",
  pemOpen: j(
    "+",
    DASH5,
    "BEGIN PRIV",
    "ATE KEY",
    DASH5,
    "\n+MIIEvQIBADANBgkqhkiG9w0BAQEF",
  ),
  pemOpenBody: "MIIEvQIBADANBgkqhkiG9w0BAQEF",
  awsAccess: j("AK", "IA", "FAKEFAKEFAKEFAKE"),
  awsSecretValue: j("fakeSecret", "/K7MDENG/", "bPxRfiCYEXAMPLE", "KEYXYZ"),
  ghp: j("gh", "p_", "a".repeat(36)),
  gho: j("gh", "o_", "B".repeat(36)),
  ghs: j("gh", "s_", "c".repeat(36)),
  ghu: j("gh", "u_", "d".repeat(36)),
  ghPat: j("github", "_pat_", "e".repeat(40)),
  anthropic: j("sk", "-ant-", "api03-", "f".repeat(40)),
  openai: j("sk", "-proj-", "g".repeat(40)),
  slack: j("xo", "xb-", "1234567890-abcdefghij"),
  slackP: j("xo", "xp-", "1234567890-abcdefghij"),
  google: j("AI", "za", "h".repeat(35)),
  jwt: j(
    "ey",
    "JhbGciOiJIUzI1NiJ9",
    ".",
    "ey",
    "JzdWIiOiIxMjM0NTY3ODkwIn0",
    ".",
    "fakeSignatureFakeSignature",
  ),
  bearerValue: j("fakebearer", "abcdefghijklmn"),
  dbPassword: j("fake", "hunter2", "secret"),
  assignValue: j("fake", "s3cr3t", "value"),
} as const;
