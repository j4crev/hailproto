import {expect,it,vi} from "vitest";
import {Hono} from "hono";
import {registerSignupRoutes,type SignupCoordinator} from "../src/onboarding/signup.js";
import type {AccountApiRepository} from "../src/accounts/repository.js";

it("routes invited address checks through the bounded, origin-checked signup surface",async()=>{
  const checkAddress=vi.fn(async(input)=>({address:input.address,available:true}));
  const app=new Hono(),origin="https://provider.example";
  registerSignupRoutes(app,{checkAddress} as unknown as SignupCoordinator,{} as AccountApiRepository,origin);
  const headers={Origin:origin,"Content-Type":"application/json",Authorization:"Bearer hailp_"+"A".repeat(43)};
  const response=await app.request(origin+"/api/v1/signup/check-address",{method:"POST",headers,body:JSON.stringify({address:"alice@provider.example",invitation:"test"})});
  expect(response.status).toBe(200);expect(await response.json()).toEqual({address:"alice@provider.example",available:true});
  expect(checkAddress).toHaveBeenCalledOnce();
  expect((await app.request(origin+"/api/v1/signup/check-address",{headers})).status).toBe(405);
  expect((await app.request(origin+"/api/v1/signup/check-address",{method:"POST",headers:{...headers,Origin:"https://other.example"},body:"{}"})).status).toBe(403);
  expect((await app.request(origin+"/api/v1/signup/check-address",{method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},body:"{}"})).status).toBe(401);
  expect(checkAddress).toHaveBeenCalledOnce();
});
