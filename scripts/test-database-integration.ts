/** Run each suite in fresh databases. Never point individual tests at a real database. */
import { SQL } from "bun";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const adminUrl = process.env.DATABASE_TEST_ADMIN_URL;
if (!adminUrl) throw new Error("DATABASE_TEST_ADMIN_URL is required (disposable PostgreSQL with CREATE DATABASE permission)");
const root = fileURLToPath(new URL("../", import.meta.url));
const admin = new SQL(adminUrl);
const reports = await mkdtemp(join(tmpdir(), "hail-integration-"));
const filters = process.argv.slice(2);
let suites = 0;
let failures = 0;
try {
  for (const app of ["server", "plc-monitor"]) {
    const cwd = join(root, "apps", app);
    const files = Array.from(new Bun.Glob("test/**/*.integration.test.ts").scanSync({ cwd })).sort();
    for (const file of files) {
      if (filters.length && !filters.some(filter => `${app}/${file}`.includes(filter))) continue;
      suites++;
      const prefix = `hail_test_${crypto.randomUUID().replaceAll("-", "")}`;
      const databases = [`${prefix}_source`, `${prefix}_target`];
      const created: string[] = [];
      const url = (database: string) => {
        const value = new URL(adminUrl);
        value.pathname = `/${database}`;
        return value.toString();
      };
      try {
        for (const database of databases) {
          await admin.unsafe(`CREATE DATABASE "${database}"`);
          created.push(database);
        }
        console.info(`Integration: ${app}/${file}`);
        const report = join(reports, `${suites}.json`);
        const child = Bun.spawn(["bun", "--bun", "vitest", "run", file,
          "--no-file-parallelism", "--disableConsoleIntercept", "--reporter=json", `--outputFile=${report}`], {
          cwd, stdout: "inherit", stderr: "inherit",
          env: { ...process.env, NODE_ENV: "test", DATABASE_URL: url(databases[0]!),
            TRANSFER_TARGET_DATABASE_URL: url(databases[1]!) },
        });
        const code = await child.exited;
        const result = JSON.parse(await readFile(report, "utf8"));
        if (code !== 0 || result.numTotalTests < 1 || result.numPendingTests > 0 || result.numTodoTests > 0 || !result.success) {
          failures++;
          console.error(`FAIL ${app}/${file}: ${result.numFailedTests} failed, ${result.numPendingTests} skipped`);
          for (const suite of result.testResults ?? []) {
            for (const test of suite.assertionResults ?? []) {
              if (test.status === "failed") console.error(test.fullName, ...(test.failureMessages ?? []));
            }
          }
        }
      } finally {
        for (const database of created.reverse()) await admin.unsafe(`DROP DATABASE "${database}" WITH (FORCE)`);
      }
    }
  }
  if (!suites) throw new Error("No integration suites matched");
  console.info(`Database integration: ${suites} suites, ${failures} failed; skipped tests are failures.`);
  if (failures) process.exitCode = 1;
} finally {
  await admin.close();
  await rm(reports, { recursive: true, force: true });
}
