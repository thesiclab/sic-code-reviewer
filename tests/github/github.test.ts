// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { createGitHubReader, GitHubHttpError } from "../../src/github/index.js";

type Handler = (
  url: string,
  init: RequestInit,
) => { status: number; json: unknown; headers?: Record<string, string> };
const fakeFetch = (h: Handler) =>
  (async (url: string, init: RequestInit) => {
    const r = h(url, init);
    return new Response(JSON.stringify(r.json), {
      status: r.status,
      headers: r.headers ?? {},
    });
  }) as unknown as typeof fetch;

describe("github reader", () => {
  it("getPr maps fields and flags forks and deleted head repos", async () => {
    const pr = (headRepo: unknown) => ({
      number: 7,
      title: "T",
      body: null,
      user: { login: "dana" },
      base: {
        sha: "b".repeat(40),
        ref: "main",
        repo: { full_name: "o/r", private: true },
      },
      head: { sha: "a".repeat(40), repo: headRepo },
    });
    const same = await createGitHubReader(
      "t",
      fakeFetch(() => ({ status: 200, json: pr({ full_name: "o/r" }) })),
    ).getPr("o/r", 7);
    expect(same).toMatchObject({
      author: "dana",
      body: "",
      isFork: false,
      isPrivateRepo: true,
      baseRef: "main",
    });
    const fork = await createGitHubReader(
      "t",
      fakeFetch(() => ({ status: 200, json: pr({ full_name: "x/r" }) })),
    ).getPr("o/r", 7);
    expect(fork.isFork).toBe(true);
    const gone = await createGitHubReader(
      "t",
      fakeFetch(() => ({ status: 200, json: pr(null) })),
    ).getPr("o/r", 7);
    expect(gone.isFork).toBe(true);
  });

  it("paginates reviews and keeps the user type", async () => {
    const pages: Record<string, unknown[]> = {
      "1": Array.from({ length: 100 }, (_, i) => ({
        id: i,
        body: "",
        commit_id: "c",
        user: { login: "u", type: "User" },
      })),
      "2": [
        {
          id: 100,
          body: "x",
          commit_id: "c",
          user: { login: "github-actions[bot]", type: "Bot" },
        },
      ],
    };
    const r = await createGitHubReader(
      "t",
      fakeFetch((url) => ({
        status: 200,
        json: pages[new URL(url).searchParams.get("page")!] ?? [],
      })),
    ).listReviews("o/r", 7);
    expect(r).toHaveLength(101);
    expect(r[100]).toEqual({
      id: 100,
      body: "x",
      commitId: "c",
      author: "github-actions[bot]",
      authorType: "Bot",
    });
  });

  it("reads review threads over GraphQL and normalises bot logins", async () => {
    let calls = 0;
    const r = await createGitHubReader(
      "t",
      fakeFetch((_url, init) => {
        calls++;
        const after = JSON.parse(String(init.body)).variables.after;
        return {
          status: 200,
          json: {
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    pageInfo: { hasNextPage: after === null, endCursor: "C1" },
                    nodes: [
                      {
                        isResolved: false,
                        isOutdated: true,
                        path: "a.ts",
                        line: after === null ? 3 : null,
                        comments: {
                          nodes: [
                            {
                              id: "1",
                              url: "u",
                              body: "b",
                              authorAssociation: "NONE",
                              author: {
                                __typename: "Bot",
                                login: "github-actions",
                              },
                            },
                            {
                              id: "2",
                              url: "u2",
                              body: "r",
                              authorAssociation: "OWNER",
                              author: { __typename: "User", login: "dana" },
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              },
            },
          },
        };
      }),
    ).listReviewThreads("o/r", 7);
    expect(calls).toBe(2);
    expect(r).toHaveLength(2);
    expect(r[0]!.comments[0]!.author).toBe("github-actions[bot]");
    expect(r[0]!.comments[1]!.author).toBe("dana");
    expect(r[1]!.line).toBeNull();
  });

  it("errors carry the status and a short message, never the token", async () => {
    const gh = createGitHubReader(
      "secret-token",
      fakeFetch(() => ({ status: 404, json: { message: "Not Found" } })),
    );
    const e = await gh.getPr("o/r", 7).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(GitHubHttpError);
    expect((e as GitHubHttpError).status).toBe(404);
    expect(String((e as Error).message)).not.toContain("secret-token");
    await expect(gh.getPr("../evil", 7)).rejects.toThrow(/invalid repository/);
  });
});
