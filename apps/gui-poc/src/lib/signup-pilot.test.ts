import {expect,it} from "vitest";
import {execFileSync} from "node:child_process";

it("console pilot enablement preserves other settings and refuses existing gates or key rotation",async()=>{
  const script=new URL("../../../server/deploy/public/enable-signup-pilot.py",import.meta.url).pathname;
  const code=`import base64,importlib.util,sys
spec=importlib.util.spec_from_file_location('pilot',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
old='# untouched\\r\\nSIGNUP_MONITOR_TOKEN=unchanged\\r\\nPUBLIC_ALPHA_SIGNUP=false\\n'
new,values=m.candidate(old)
assert new.startswith('# untouched\\r\\nSIGNUP_MONITOR_TOKEN=unchanged\\r\\n')
assert values['PUBLIC_ALPHA_SIGNUP']=='true' and values['ALPHA_SIGNUP_MONITOR_ORIGIN']=='https://plcmonitor.us'
assert len(values['ALPHA_SIGNUP_INVITE_KEY'])==43
assert len(base64.urlsafe_b64decode(values['ALPHA_SIGNUP_INVITE_KEY']+'='))==32
for old in [new,'PUBLIC_ALPHA_SIGNUP=false\\nPUBLIC_ALPHA_SIGNUP=false\\n','ALPHA_SIGNUP_INVITE_KEY=existing\\n','ALPHA_SIGNUP_INVITE_KEY=false\\n']:
 try:m.candidate(old)
 except ValueError:pass
 else:raise AssertionError('Existing pilot state replaced')
print('PASS')`;
  const stdout=execFileSync("python3",["-c",code,script],{env:{...process.env,PYTHONDONTWRITEBYTECODE:"1"},encoding:"utf8"});
  expect(stdout.trim()).toBe("PASS");
});
