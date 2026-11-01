import {readFile} from "node:fs/promises";
import {expect,it,vi} from "vitest";

const workflow = Bun.YAML.parse(await readFile(
  new URL("../../../.github/workflows/publish-provider.yml", import.meta.url), "utf8",
)) as any;
const script = workflow.jobs.verify.steps[0].with.script;
const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
const sha = "a".repeat(40);
const successfulRun = {
  id: 100, head_sha: sha, head_branch: "main", event: "push",
  head_repository: {full_name: "j4crev/hailproto"},
  status: "completed", conclusion: "success", run_attempt: 2,
  html_url: "https://github.com/j4crev/hailproto/actions/runs/100",
};

async function verify(
  runs: unknown[],
  error?: Error,
  verificationJobs: unknown[] = [{name: "verify-main", conclusion: "success"}],
) {
  const listWorkflowRuns = vi.fn();
  const listJobsForWorkflowRun = vi.fn();
  const paginate = error ? vi.fn().mockRejectedValue(error) : vi.fn().mockImplementation(
    (endpoint: unknown) => Promise.resolve(endpoint === listWorkflowRuns ? runs : verificationJobs),
  );
  const summary = {addHeading: vi.fn(), addLink: vi.fn(), write: vi.fn()};
  summary.addHeading.mockReturnValue(summary);
  summary.addLink.mockReturnValue(summary);
  const core = {setFailed: vi.fn(), info: vi.fn(), summary};
  await new AsyncFunction("github", "context", "core", script)(
    {paginate, rest: {actions: {listWorkflowRuns, listJobsForWorkflowRun}}},
    {repo: {owner: "j4crev", repo: "hailproto"}, sha}, core,
  );
  return {core, paginate, listWorkflowRuns, listJobsForWorkflowRun};
}

it("keeps publication manual and dependent on a read-only CI gate on main", () => {
  expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
  expect(workflow.jobs.verify.if).toBe("github.ref == 'refs/heads/main'");
  expect(workflow.jobs.verify.permissions).toEqual({actions: "read"});
  expect(workflow.jobs.verify.uses).toBeUndefined();
  expect(workflow.jobs.publish.needs).toBe("verify");
  expect(workflow.jobs.publish.if).toBeUndefined();
});

it("accepts exact-commit main CI after verify-main succeeds and records the attempt", async () => {
  const {core, paginate, listWorkflowRuns, listJobsForWorkflowRun} = await verify([successfulRun]);
  expect(paginate).toHaveBeenCalledWith(listWorkflowRuns, {
    owner: "j4crev", repo: "hailproto", workflow_id: "ci.yml",
    branch: "main", event: "push", head_sha: sha, per_page: 100,
  });
  expect(paginate).toHaveBeenCalledWith(listJobsForWorkflowRun, {
    owner: "j4crev", repo: "hailproto", run_id: successfulRun.id, per_page: 100,
  });
  expect(core.setFailed).not.toHaveBeenCalled();
  expect(core.summary.addLink).toHaveBeenCalledWith(
    `Main verification for ${sha} (attempt 2)`, successfulRun.html_url,
  );
  expect(core.summary.write).toHaveBeenCalledOnce();
});

it.each([
  ["missing", []],
  ["failed", [{name: "verify-main", conclusion: "failure"}]],
  ["skipped", [{name: "verify-main", conclusion: "skipped"}]],
])("rejects publication when verify-main is %s", async (_state, jobs) => {
  const {core} = await verify([successfulRun], undefined, jobs);
  expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining("successful verify-main handoff"));
  expect(core.summary.write).not.toHaveBeenCalled();
});

it.each([
  {head_sha: "b".repeat(40)}, {head_branch: "feature"},
  {event: "pull_request"}, {event: "workflow_dispatch"},
  {head_repository: {full_name: "other/hailproto"}}, {head_repository: null},
])("rejects success outside the trusted commit/branch/event/repository: %j", async override => {
  const {core} = await verify([{...successfulRun, ...override}]);
  expect(core.setFailed).toHaveBeenCalledOnce();
  expect(core.summary.write).not.toHaveBeenCalled();
});

it.each([
  ["queued", null], ["in_progress", null], ["completed", "failure"],
  ["completed", "cancelled"], ["completed", "timed_out"],
  ["completed", "skipped"], ["completed", "neutral"],
])("rejects latest CI %s/%s even when an older run succeeded", async (status, conclusion) => {
  const {core} = await verify([successfulRun, {...successfulRun, id: 101, status, conclusion}]);
  expect(core.setFailed).toHaveBeenCalledOnce();
  expect(core.summary.write).not.toHaveBeenCalled();
});

it("rejects missing CI", async () => {
  const {core} = await verify([]);
  expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining("No matching CI run found"));
});

it("fails closed on a GitHub API error", async () => {
  await expect(verify([], new Error("GitHub unavailable"))).rejects.toThrow("GitHub unavailable");
});
