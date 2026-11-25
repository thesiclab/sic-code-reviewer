// SPDX-License-Identifier: Apache-2.0
// Thin GitHub REST/GraphQL client. Readers are used by the read job (pull-requests: read);
// the writer (output/poster.ts GitHubWriter) is used only by the post job.
//
// No retries here: callers decide. Errors carry the HTTP status and a short,
// single-line message, never a response body or a token.

export interface PrInfo {
  number: number;
  title: string;
  body: string;
  author: string;
  baseSha: string;
  headSha: string;
  baseRef: string;
  /** True when head repo != base repo. Fork PRs are not reviewed in v1. */
  isFork: boolean;
  isPrivateRepo: boolean;
}

export interface ReviewRecord {
  id: number;
  body: string;
  commitId: string;
  author: string;
  authorType: "Bot" | "User" | "Organization";
}

export interface ReviewThreadComment {
  id: string;
  author: string;
  authorAssociation: string;
  body: string;
  url: string;
}

export interface ReviewThread {
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  comments: ReviewThreadComment[];
}

export interface GitHubReader {
  getPr(repo: string, pr: number): Promise<PrInfo>;
  listReviews(repo: string, pr: number): Promise<ReviewRecord[]>;
  listReviewThreads(repo: string, pr: number): Promise<ReviewThread[]>;
}

export class GitHubHttpError extends Error {
  constructor(
    readonly status: number | undefined,
    message: string,
    readonly retryAfterS?: number,
  ) {
    super(message);
    this.name = "GitHubHttpError";
  }
}

export const DEFAULT_API_URL = "https://api.github.com";
const TIMEOUT_MS = 30_000;
/** Pagination ceilings: a PR with more than this is truncated, never an endless loop. */
export const MAX_REVIEW_PAGES = 30;
export const MAX_THREAD_PAGES = 10;

const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*)\/[A-Za-z0-9_.-]+$/;

export function isValidRepo(repo: string): boolean {
  return REPO_RE.test(repo) && !/\/\.{1,2}$/.test(repo);
}

export function assertRepo(repo: string): void {
  if (!isValidRepo(repo)) throw new Error("invalid repository name");
}

export interface HttpClient {
  request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown; headers: Headers }>;
}

function shortMessage(json: unknown, status: number): string {
  const m =
    json &&
    typeof json === "object" &&
    typeof (json as { message?: unknown }).message === "string"
      ? (json as { message: string }).message
      : `HTTP ${status}`;
  // eslint-disable-next-line no-control-regex
  return m.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 200);
}

export function parseRetryAfter(headers: Headers): number | undefined {
  const v = headers.get("retry-after");
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Shared low-level client used by the reader and the writer. */
export function createHttpClient(
  token: string,
  fetchImpl: typeof fetch,
  apiUrl: string = DEFAULT_API_URL,
): HttpClient {
  const base = apiUrl.replace(/\/+$/, "");
  return {
    async request(method, path, body) {
      let res: Response;
      try {
        res = await fetchImpl(`${base}${path}`, {
          method,
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${token}`,
            "x-github-api-version": "2022-11-28",
            "user-agent": "sic-code-reviewer",
            ...(body !== undefined
              ? { "content-type": "application/json" }
              : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (e) {
        const name = e instanceof Error ? e.name : "Error";
        throw new GitHubHttpError(undefined, `request failed (${name})`);
      }
      let json: unknown = null;
      const text = await res.text();
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      return { status: res.status, json, headers: res.headers };
    },
  };
}

async function getJson(http: HttpClient, path: string): Promise<unknown> {
  const r = await http.request("GET", path);
  if (r.status < 200 || r.status >= 300) {
    throw new GitHubHttpError(
      r.status,
      shortMessage(r.json, r.status),
      parseRetryAfter(r.headers),
    );
  }
  return r.json;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json =>
  v && typeof v === "object" ? (v as Json) : {};
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function toReviewRecord(v: unknown): ReviewRecord {
  const o = obj(v);
  const user = obj(o.user);
  const t = str(user.type);
  return {
    id: typeof o.id === "number" ? o.id : 0,
    body: str(o.body),
    commitId: str(o.commit_id),
    author: str(user.login),
    authorType: t === "Bot" || t === "Organization" ? t : "User",
  };
}

export async function listAllReviews(
  http: HttpClient,
  repo: string,
  pr: number,
): Promise<ReviewRecord[]> {
  assertRepo(repo);
  const out: ReviewRecord[] = [];
  for (let page = 1; page <= MAX_REVIEW_PAGES; page++) {
    const data = await getJson(
      http,
      `/repos/${repo}/pulls/${pr}/reviews?per_page=100&page=${page}`,
    );
    if (!Array.isArray(data)) break;
    out.push(...data.map(toReviewRecord));
    if (data.length < 100) break;
  }
  return out;
}

const THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!,$after:String){
  repository(owner:$owner,name:$name){pullRequest(number:$number){
    reviewThreads(first:100,after:$after){
      pageInfo{hasNextPage endCursor}
      nodes{isResolved isOutdated path line
        comments(first:50){nodes{id url body authorAssociation author{__typename login}}}}}}}}`;

/** GraphQL gives bot logins without the "[bot]" suffix REST uses; normalise to the REST form. */
function graphLogin(author: unknown): string {
  const a = obj(author);
  const login = str(a.login);
  if (a.__typename === "Bot" && login && !login.endsWith("[bot]"))
    return `${login}[bot]`;
  return login;
}

export function createGitHubReader(
  token: string,
  fetchImpl: typeof fetch,
  apiUrl: string = DEFAULT_API_URL,
): GitHubReader {
  const http = createHttpClient(token, fetchImpl, apiUrl);
  return {
    async getPr(repo, pr) {
      assertRepo(repo);
      const o = obj(await getJson(http, `/repos/${repo}/pulls/${pr}`));
      const base = obj(o.base);
      const head = obj(o.head);
      const baseRepo = obj(base.repo);
      const headRepo = head.repo ? obj(head.repo) : null;
      return {
        number: typeof o.number === "number" ? o.number : pr,
        title: str(o.title),
        body: str(o.body),
        author: str(obj(o.user).login),
        baseSha: str(base.sha),
        headSha: str(head.sha),
        baseRef: str(base.ref),
        // A deleted head repo (null) is treated as a fork: fail closed.
        isFork:
          !headRepo || str(headRepo.full_name) !== str(baseRepo.full_name),
        isPrivateRepo: baseRepo.private === true,
      };
    },
    listReviews(repo, pr) {
      return listAllReviews(http, repo, pr);
    },
    async listReviewThreads(repo, pr) {
      assertRepo(repo);
      const [owner, name] = repo.split("/") as [string, string];
      const out: ReviewThread[] = [];
      let after: string | null = null;
      for (let page = 0; page < MAX_THREAD_PAGES; page++) {
        const r = await http.request("POST", "/graphql", {
          query: THREADS_QUERY,
          variables: { owner, name, number: pr, after },
        });
        if (r.status !== 200)
          throw new GitHubHttpError(r.status, shortMessage(r.json, r.status));
        const root = obj(r.json);
        if (Array.isArray(root.errors) && root.errors.length > 0) {
          throw new GitHubHttpError(200, "GraphQL error");
        }
        const threads = obj(
          obj(obj(obj(root.data).repository).pullRequest).reviewThreads,
        );
        const nodes = Array.isArray(threads.nodes) ? threads.nodes : [];
        for (const n of nodes) {
          const t = obj(n);
          const comments = Array.isArray(obj(t.comments).nodes)
            ? (obj(t.comments).nodes as unknown[])
            : [];
          out.push({
            isResolved: t.isResolved === true,
            isOutdated: t.isOutdated === true,
            path: str(t.path),
            line: typeof t.line === "number" ? t.line : null,
            comments: comments.map((c) => {
              const co = obj(c);
              return {
                id: str(co.id),
                author: graphLogin(co.author),
                authorAssociation: str(co.authorAssociation),
                body: str(co.body),
                url: str(co.url),
              };
            }),
          });
        }
        const info = obj(threads.pageInfo);
        if (info.hasNextPage !== true || typeof info.endCursor !== "string")
          break;
        after = info.endCursor;
      }
      return out;
    },
  };
}
