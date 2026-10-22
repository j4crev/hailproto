import {expect,it} from "vitest";
import {clientAddress,FixedWindowRateLimit} from "../src/http/rate-limit.js";

it("isolates bounded client buckets and resets their fixed windows",()=>{
  const limit=new FixedWindowRateLimit(2);
  expect(limit.take("client-a",1,0)).toBeNull();expect(limit.take("client-a",1,0)).toBe(60);
  expect(limit.take("client-b",1,0)).toBeNull();expect(limit.take("client-b",1,60_000)).toBeNull();
  expect(limit.take("client-c",1,60_000)).toBeNull();
  expect(limit.take("client-a",1,60_000)).toBeNull();
});

it("accepts only canonical trusted client addresses",()=>{
  expect(clientAddress(new Request("https://example.com",{headers:{"X-Hail-Trusted-Client-IP":"192.0.2.1"}}))).toBe("192.0.2.1");
  expect(clientAddress(new Request("https://example.com",{headers:{"X-Hail-Trusted-Client-IP":"attacker"}}))).toBe("unidentified");
});
