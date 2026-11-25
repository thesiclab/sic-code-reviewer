// SPDX-License-Identifier: Apache-2.0
export const cases = [
  {
    id: "planted-off-by-one-page",
    title: "Switch pagination to 1-based page numbers",
    body: "The API now takes 1-based page numbers, like the UI.",
    files: {
      "src/paginate.ts": {
        before: `export function page<T>(items: T[], pageNo: number, size: number): T[] {
  const start = pageNo * size;
  return items.slice(start, start + size);
}

export function pageCount(total: number, size: number): number {
  return Math.ceil(total / size);
}
`,
        after: `// Pages are 1-based: page 1 is the first page.
export function page<T>(items: T[], pageNo: number, size: number): T[] {
  const start = pageNo * size;
  return items.slice(start, start + size + 1);
}

export function pageCount(total: number, size: number): number {
  return Math.ceil(total / size);
}
`,
      },
    },
    bugs: [
      { file: "src/paginate.ts", find: "const start = pageNo * size;", note: "Page 1 starts at index size, so the first page of results is never returned" },
      { file: "src/paginate.ts", find: "start + size + 1", note: "Slice end adds one, so every page returns size + 1 items and overlaps the next page" },
    ],
  },
  {
    id: "planted-sql-injection",
    title: "Add user search by name",
    body: "Adds GET /users?name= for the admin panel.",
    files: {
      "src/db/users.ts": {
        before: `import { db } from "./pool.js";

export async function getUser(id: number) {
  const { rows } = await db.query("SELECT id, name, email FROM users WHERE id = $1", [id]);
  return rows[0] ?? null;
}
`,
        after: `import { db } from "./pool.js";

export async function getUser(id: number) {
  const { rows } = await db.query("SELECT id, name, email FROM users WHERE id = $1", [id]);
  return rows[0] ?? null;
}

export async function searchUsers(name: string) {
  const { rows } = await db.query(\`SELECT id, name, email FROM users WHERE name LIKE '%\${name}%'\`);
  return rows;
}
`,
      },
    },
    bugs: [{ file: "src/db/users.ts", find: "WHERE name LIKE", severity: "critical", note: "SQL injection: the name query parameter is interpolated into the SQL string" }],
  },
  {
    id: "planted-missing-await",
    title: "Mark invoices paid after charging",
    body: "Charge the card, then mark the invoice paid.",
    files: {
      "src/billing.ts": {
        before: `import { chargeCard } from "./stripe.js";
import { invoices } from "./store.js";

export async function settle(invoiceId: string): Promise<void> {
  const inv = await invoices.get(invoiceId);
  await chargeCard(inv.customerId, inv.amountCents);
}
`,
        after: `import { chargeCard } from "./stripe.js";
import { invoices } from "./store.js";

export async function settle(invoiceId: string): Promise<void> {
  const inv = await invoices.get(invoiceId);
  chargeCard(inv.customerId, inv.amountCents);
  await invoices.markPaid(invoiceId);
}
`,
      },
    },
    bugs: [{ file: "src/billing.ts", find: "  chargeCard(inv", note: "chargeCard is not awaited, so the invoice is marked paid even when the charge fails" }],
  },
  {
    id: "planted-inverted-auth",
    title: "Refactor admin middleware",
    body: "Small cleanup of requireAdmin.",
    files: {
      "src/middleware/admin.ts": {
        before: `import type { Request, Response, NextFunction } from "express";

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role === "admin") {
    return next();
  }
  return res.status(403).json({ error: "forbidden" });
}
`,
        after: `import type { Request, Response, NextFunction } from "express";

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role !== "admin") return next();
  return res.status(403).json({ error: "forbidden" });
}
`,
      },
    },
    bugs: [{ file: "src/middleware/admin.ts", find: 'role !== "admin"', severity: "critical", note: "Auth check inverted: non-admins pass and admins get 403" }],
  },
  {
    id: "planted-path-traversal",
    title: "Serve uploaded files by name",
    body: "Adds GET /files/:name.",
    files: {
      "src/routes/files.ts": {
        before: null,
        after: `import path from "node:path";
import { createReadStream } from "node:fs";
import type { Request, Response } from "express";

const UPLOAD_DIR = "/var/app/uploads";

export function getFile(req: Request, res: Response) {
  const full = path.join(UPLOAD_DIR, req.params.name);
  createReadStream(full).pipe(res);
}
`,
      },
    },
    bugs: [{ file: "src/routes/files.ts", find: "path.join(UPLOAD_DIR", severity: "critical", note: "Path traversal: a name like ../../etc/passwd escapes the upload directory" }],
  },
  {
    id: "planted-undefined-cache",
    title: "Read feature flags from the cache",
    body: "Feature flags are now cached.",
    files: {
      "src/flags.ts": {
        before: `import { loadFlags } from "./remote.js";

export async function isEnabled(name: string): Promise<boolean> {
  const flags = await loadFlags();
  return flags[name]?.enabled ?? false;
}
`,
        after: `import { loadFlags } from "./remote.js";

const cache = new Map<string, { enabled: boolean }>();

export async function warm(): Promise<void> {
  const flags = await loadFlags();
  for (const [k, v] of Object.entries(flags)) cache.set(k, v);
}

export async function isEnabled(name: string): Promise<boolean> {
  return cache.get(name).enabled;
}
`,
      },
    },
    bugs: [{ file: "src/flags.ts", find: "cache.get(name).enabled", note: "cache.get returns undefined for an unknown flag or before warm(), so isEnabled throws a TypeError" }],
  },
  {
    id: "planted-python-mutable-default",
    title: "Collect tags per post",
    body: "Helper to add tags.",
    files: {
      "app/tags.py": {
        before: `def normalize(tag):
    return tag.strip().lower()
`,
        after: `def normalize(tag):
    return tag.strip().lower()


def add_tag(tag, tags=[]):
    tags.append(normalize(tag))
    return tags
`,
      },
    },
    bugs: [{ file: "app/tags.py", find: "def add_tag(tag, tags=[])", note: "Mutable default argument: tags from one call leak into every later call without a list" }],
  },
  {
    id: "planted-clean-docs",
    title: "Document the capitalize helper",
    body: "Doc comment only, no behaviour change.",
    files: {
      "src/strings.ts": {
        before: `export function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}
`,
        after: `/** Upper-cases the first character; empty strings are returned unchanged. */
export function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}
`,
      },
    },
    bugs: [],
  },
];
