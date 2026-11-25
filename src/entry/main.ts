// SPDX-License-Identifier: Apache-2.0
// Action entrypoint: one bundle, two jobs. `mode: review` runs the read job,
// `mode: post` runs the write job. Each job gets only its own permissions in
// the caller workflow; this file only dispatches.
import { pathToFileURL } from "node:url";
import { readInputs } from "./env.js";

export async function dispatch(
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const mode = readInputs(env)["mode"];
  if (mode === "review") return (await import("./review.js")).main(env);
  if (mode === "post") return (await import("./post.js")).main(env);
  process.stderr.write(
    "::error::sic-code-reviewer: input 'mode' must be 'review' or 'post'\n",
  );
  return 2;
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) {
  dispatch().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.stderr.write("::error::sic-code-reviewer crashed\n");
      process.exitCode = 1;
    },
  );
}
