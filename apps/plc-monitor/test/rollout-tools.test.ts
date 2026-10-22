import {randomBytes} from "node:crypto";
import {mkdtemp,writeFile,unlink,rmdir} from "node:fs/promises";
import {expect,it} from "vitest";
import {tmpdir} from "node:os";
import {join} from "node:path";

const monitorScript=new URL("../deploy/public/enrollment-setup.py",import.meta.url).pathname;
const providerScript=new URL("../../server/deploy/public/configure-signup-monitor.py",import.meta.url).pathname;
async function python(code:string,input:unknown){
  const child=Bun.spawn(["python3","-c",code,monitorScript,providerScript],{env:{...process.env,PYTHONDONTWRITEBYTECODE:"1"},stdin:"pipe",stdout:"pipe",stderr:"pipe"});
  child.stdin.write(JSON.stringify(input));child.stdin.end();
  const [status,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  expect(status,stderr).toBe(0);return stdout;
}

it("renders a provider-only edge and loopback API without replacing storage, keys or the DB image",async()=>{
  const token=randomBytes(32).toString("base64url");
  const output=await python(`import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('setup',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
cfg=m.validate(json.load(sys.stdin)); rendered=m.override(); edge=m.caddy(cfg['api_domain'])
assert 'db' not in rendered['services'] and 'monitor_db' not in rendered['volumes']
assert rendered['services']['monitor']['ports']==['127.0.0.1:3001:3001']
assert 'volumes' not in rendered['services']['monitor']
assert rendered['services']['monitor']['build']['context']=='/opt/hailproto'
assert 'remote_ip 5.161.254.78' in edge and 'respond 403' in edge and 'admin off' in edge
assert 'reverse_proxy 127.0.0.1:3001' in edge and 'header' not in edge
assert cfg['enrollment_token'] not in edge and cfg['enrollment_token'] not in json.dumps(rendered)
for bad in [dict(cfg,api_domain='enroll.plcmonitor.us\\nmalicious'),dict(cfg,api_domain='attacker.example.com'),dict(cfg,enrollment_token='bad'),dict(cfg,arbitrary='setting')]:
 try:m.validate(bad)
 except Exception:pass
 else:raise AssertionError('Invalid config accepted')
m.preserved({'rows':[{'id':1,'detail':{'a':2}}]},{'rows':[{'detail':{'a':2},'id':1},{'id':2}]})
for after in [[],[{'id':1,'detail':{'a':3}}]]:
 try:m.preserved({'rows':[{'id':1,'detail':{'a':2}}]},{'rows':after})
 except m.SetupError:pass
 else:raise AssertionError('Retained state lost')
class PublicKey:
 def read_bytes(self):return b'public key material'
m.subprocess.check_output=lambda *args,**kwargs:('pub:-:::::::::\\nfpr:::::::::'+m.RECIPIENT+':\\n').encode()
m.backup_recipient(PublicKey())
m.subprocess.check_output=lambda *args,**kwargs:('sec:-:::::::::\\nfpr:::::::::'+m.RECIPIENT+':\\n').encode()
try:m.backup_recipient(PublicKey())
except m.SetupError:pass
else:raise AssertionError('Private decryption key accepted')
print('PASS')`,{api_domain:"enroll.plcmonitor.us",enrollment_token:token});
  expect(output.trim()).toBe("PASS");expect(output).not.toContain(token);
});

it("provider configuration preserves unrelated settings, refuses rotation/extra fields and emits no secret",async()=>{
  const token=randomBytes(32).toString("base64url");
  const value={SIGNUP_MONITOR_API_ORIGIN:"https://enroll.plcmonitor.us",SIGNUP_MONITOR_TOKEN:token,SIGNUP_MONITOR_PUBLIC_KEY:"did:key:z6MkTest"};
  const output=await python(`import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('provider',sys.argv[2]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
value=m.validate(json.load(sys.stdin));old='# comment\\r\\nPUBLIC_ALPHA_SIGNUP=false\\r\\nKEY_ENCRYPTION_KEY=unchanged\\r\\n'
new=m.replace_settings(old,value);assert new.startswith(old)
assert m.replace_settings(new,value)==new
for bad in [dict(value,SIGNUP_MONITOR_TOKEN='bad'),dict(value,SIGNUP_MONITOR_API_ORIGIN='http://enroll.plcmonitor.us'),dict(value,SIGNUP_MONITOR_API_ORIGIN='https://enroll.plcmonitor.us\\n'),dict(value,PUBLIC_ALPHA_SIGNUP='true')]:
 try:m.validate(bad)
 except Exception:pass
 else:raise AssertionError('Invalid settings accepted')
for old in ['SIGNUP_MONITOR_TOKEN=different\\n','SIGNUP_MONITOR_TOKEN=\\nSIGNUP_MONITOR_TOKEN=\\n']:
 try:m.replace_settings(old,value)
 except ValueError:pass
 else:raise AssertionError('Existing settings overwritten')
print('PASS')`,value);
  expect(output.trim()).toBe("PASS");expect(output).not.toContain(token);
});

it("console preflight accepts a private config without requiring or printing its service secret",async()=>{
  const directory=await mkdtemp(join(process.env.OPENCODE_TMP_DIR||tmpdir(),"hail-rollout-check-"));
  const path=join(directory,"config.json"),token=randomBytes(32).toString("base64url");
  try{
    await writeFile(path,JSON.stringify({api_domain:"enroll.plcmonitor.us",enrollment_token:token}),{mode:0o600});
    const child=Bun.spawn(["python3",monitorScript,"--check-config",path],{stdout:"pipe",stderr:"pipe"});
    const [status,output]=await Promise.all([child.exited,new Response(child.stdout).text()]);
    expect(status).toBe(0);expect(JSON.parse(output)).toEqual({valid:true,apiOrigin:"https://enroll.plcmonitor.us"});expect(output).not.toContain(token);
  }finally{await unlink(path);await rmdir(directory);}
});

it("legacy rollback restores only the runtime and wrapper, retaining data/configuration and stopping the new edge",async()=>{
  const output=await python(`import importlib.util,sys,tempfile
from pathlib import Path
spec=importlib.util.spec_from_file_location('setup',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as directory:
 p=Path(directory);m.CONFIG=p/'configuration';m.CONFIG.mkdir();m.WRAPPER=p/'ops'
 m.WRAPPER.write_bytes(b'new wrapper');(m.CONFIG/'active').write_text('new release');(m.CONFIG/'enrollment.env').write_text('retained private config')
 calls=[];m.run=lambda *args,**kwargs:calls.append(list(args));m.subprocess.run=lambda args,**kwargs:calls.append(list(args))
 m.restore_legacy('old-image',b'original wrapper')
 assert m.WRAPPER.read_bytes()==b'original wrapper' and m.WRAPPER.stat().st_mode&0o777==0o755
 assert not (m.CONFIG/'active').exists() and (m.CONFIG/'enrollment.env').exists()
 assert any(call[:3]==['docker','tag','old-image'] for call in calls)
 assert any('--no-deps' in call and '--force-recreate' in call and call[-1]=='monitor' for call in calls)
 assert any(call[-2:]==['stop','enrollment-edge'] for call in calls)
 assert not any('down' in call or 'pg_restore' in call or 'rm' in call or 'db' in call for call in calls)
 print('PASS')`,{});
  expect(output.trim()).toBe("PASS");
});
