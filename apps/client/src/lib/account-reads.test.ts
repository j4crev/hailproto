import {afterEach,expect,it,vi} from "vitest";
vi.mock("$env/dynamic/private",()=>({env:{}}));
import {AccountApiClient,AccountApiError} from "../../../../packages/hail-client-support/src/account-api.js";
import {canaryAccount} from "./server/canary.js";
import {withAccountReads} from "./server/account-reads.js";
const cookies=(suffix="a")=>({get:()=>`hails_${suffix.repeat(43)}`,delete:vi.fn()});
afterEach(()=>vi.restoreAllMocks());
it("shares concurrent account reads only within one GET rendering scope",async()=>{
  const account=vi.fn(async()=>({did:"owner"}));
  vi.spyOn(AccountApiClient,"fromSession").mockReturnValue({account} as unknown as AccountApiClient);
  const jar=cookies();
  await withAccountReads(async()=>{
    const [a,b]=await Promise.all([canaryAccount(jar),canaryAccount(jar)]);
    expect(a).toBe(b);expect(account).toHaveBeenCalledTimes(1);
    await canaryAccount(jar);expect(account).toHaveBeenCalledTimes(1);
  });
  await withAccountReads(()=>canaryAccount(jar));expect(account).toHaveBeenCalledTimes(2);
  await canaryAccount(jar);await canaryAccount(jar);expect(account).toHaveBeenCalledTimes(4);
});
it("isolates simultaneous requests and different sessions",async()=>{
  const account=vi.fn(async()=>({did:"owner"}));
  vi.spyOn(AccountApiClient,"fromSession").mockReturnValue({account} as unknown as AccountApiClient);
  await Promise.all([withAccountReads(()=>canaryAccount(cookies())),withAccountReads(()=>canaryAccount(cookies()))]);
  expect(account).toHaveBeenCalledTimes(2);
  await withAccountReads(()=>Promise.all([canaryAccount(cookies()),canaryAccount(cookies("b"))]));
  expect(account).toHaveBeenCalledTimes(4);
});
it("preserves expired-session redirects and retries on the next request",async()=>{
  const account=vi.fn().mockRejectedValue(new AccountApiError(401));
  vi.spyOn(AccountApiClient,"fromSession").mockReturnValue({account} as unknown as AccountApiClient);
  const jar=cookies(),url=new URL("https://haili.app/sent");
  await expect(withAccountReads(()=>canaryAccount(jar,url))).rejects.toMatchObject({status:303});
  expect(jar.delete).toHaveBeenCalledWith("hail_session",{path:"/"});
  account.mockResolvedValue({did:"owner"});
  await expect(withAccountReads(()=>canaryAccount(jar,url))).resolves.toMatchObject({account:{did:"owner"}});
});
