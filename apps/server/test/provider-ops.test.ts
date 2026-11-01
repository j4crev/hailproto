import {mkdtemp,readFile,writeFile,mkdir,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect,it} from "vitest";

const old="a".repeat(40),candidate="b".repeat(40),digest=`sha256:${"c".repeat(64)}`;
const image=`ghcr.io/j4crev/hailproto/provider@sha256:${"d".repeat(64)}`;
const clientImage=`ghcr.io/j4crev/hailproto/provider-web-client@sha256:${"e".repeat(64)}`;
const clientDigest=`sha256:${"f".repeat(64)}`;
const clientReference=`hail-web-client:rollback-${"f".repeat(64)}`;
const reference=`hail-server-ts:rollback-${"c".repeat(64)}`;
async function fixture(run:(f:{directory:string;execute:(action:string,env?:Record<string,string>)=>Promise<{exit:number;log:string;stderr:string}>})=>Promise<void>){
  const directory=await mkdtemp(join(tmpdir(),"hail-provider-ops-"));
  try{
    const bin=join(directory,"bin");await mkdir(bin);
    const mock=`#!/bin/sh
printf '%s %s\\n' "$(basename "$0")" "$*" >> "$PROBE_LOG"
case "$(basename "$0"):$1" in
  git:*)
    case "$*" in *rev-parse*) echo '${old}';; esac;;
  docker:inspect)
    if [ "\${MISMATCHED_GUI:-}" = 1 ] && [ "$2" = hail-public-provider-gui-1 ]; then echo 'sha256:other'; elif [ "\${COMBINED_RUNNING:-}" = 1 ]; then echo '${digest}'; elif [ "$2" = hail-public-provider-gui-1 ]; then echo '${clientDigest}'; else echo '${digest}'; fi;;
  docker:pull)
    [ "\${FAIL_PULL:-}" != 1 ] || exit 1
    if [ "\${FAIL_CLIENT_PULL:-}" = 1 ] && [ "$2" = '${clientImage}' ]; then exit 1; fi;;
  docker:image)
    case "$*" in *org.opencontainers.image.revision*)
      if [ "\${WRONG_REVISION:-}" = 1 ] || { [ "\${WRONG_CLIENT_REVISION:-}" = 1 ] && [ "$3" = '${clientImage}' ]; }; then echo '${old}'; else echo '${candidate}'; fi
      exit 0;; esac
    [ "\${MISSING_IMAGE:-}" != 1 ] || exit 1
    if [ "\${MISSING_CLIENT_IMAGE:-}" = 1 ] && [ "$3" = '${clientReference}' ]; then exit 1; fi
    if [ "\${WRONG_IMAGE:-}" = 1 ]; then echo 'sha256:wrong'; elif [ "$3" = '${clientReference}' ]; then echo '${clientDigest}'; else echo '${digest}'; fi;;
  docker:compose)
    case "$*" in *'config --quiet'*) [ "\${FAIL_CONFIG:-}" != 1 ] || exit 1;; esac
    case "$*" in *'up -d'*)
      if grep -q rollback- "$PROBE_RELEASE"; then touch "$PROBE_RESTORED";
      else [ "\${FAIL_START:-}" != 1 ] || exit 1; fi;; esac;;
  curl:*)
    [ "\${FAIL_HEALTH:-}" != 1 ] || [ -e "$PROBE_RESTORED" ] || exit 1;;
esac
`;
    for(const name of ["docker","git","curl","backup"])await writeFile(join(bin,name),mock,{mode:0o755});
    const source=await readFile(new URL("../deploy/public/provider-ops.sh",import.meta.url),"utf8");
    await writeFile(join(directory,"ops.sh"),source.replaceAll("/opt/hailproto",join(directory,"checkout"))
      .replaceAll("/etc/hail-provider-release",join(directory,"release")).replaceAll("/etc/hail-provider-postgres",join(directory,"postgres"))
      .replaceAll("/var/lib/",directory+"/").replaceAll("/usr/local/sbin/hail-provider-backup",join(bin,"backup")));
    await run({directory,execute:async(action,env={})=>{
      await writeFile(join(directory,"log"),"");
      const child=Bun.spawn(["sh",join(directory,"ops.sh"),action,...action==="deploy"?[candidate,env.TEST_IMAGE??image,env.TEST_CLIENT_IMAGE??clientImage]:[]],{
        env:{...process.env,PATH:`${bin}:${process.env.PATH}`,PROBE_LOG:join(directory,"log"),PROBE_RESTORED:join(directory,"restored"),PROBE_RELEASE:join(directory,"release/compose.json"),...env},stdout:"pipe",stderr:"pipe"});
      const [exit,stderr]=await Promise.all([child.exited,new Response(child.stderr).text(),new Response(child.stdout).text()]);
      return {exit,stderr,log:await readFile(join(directory,"log"),"utf8")};
    }});
  }finally{await rm(directory,{recursive:true,force:true});}
}

it("retains and verifies the running image before replacement and atomically records its identity",async()=>fixture(async({directory,execute})=>{
  const result=await execute("deploy");expect(result.exit,result.stderr).toBe(0);
  expect(result.log.indexOf(`docker tag ${digest} ${reference}`)).toBeLessThan(result.log.indexOf(`checkout --quiet --detach ${candidate}`));
  expect(result.log.indexOf(`docker image inspect ${reference}`)).toBeLessThan(result.log.indexOf(`checkout --quiet --detach ${candidate}`));
  expect(await readFile(join(directory,"hail-provider-previous"),"utf8")).toBe(`${old} ${reference} ${digest} ${clientReference} ${clientDigest}\n`);
  expect(JSON.parse(await readFile(join(directory,"release/compose.json"),"utf8"))).toEqual({services:{provider:{image},gui:{image:clientImage}}});
  expect(result.log).toContain(`docker pull ${image}`);
  expect(result.log).not.toMatch(/build provider|up -d db/);
  expect(result.log).toContain('--no-deps --no-build --pull never');
}));

it.each(["FAIL_CONFIG","FAIL_START","FAIL_HEALTH"])("restores both services from the retained image after %s and still reports deployment failure",async failure=>fixture(async({execute,directory})=>{
  const result=await execute("deploy",{[failure]:"1"});expect(result.exit).toBe(1);
  expect(JSON.parse(await readFile(join(directory,"release/compose.json"),"utf8"))).toEqual({services:{provider:{image:reference},gui:{image:clientReference}}});
  expect(result.log).toContain(`docker image inspect ${reference}`);
  expect(result.log).toContain("up -d --no-deps --no-build --pull never --force-recreate --wait --wait-timeout 180 gui provider");
  expect(result.log.lastIndexOf("curl ")).toBeGreaterThan(result.log.indexOf("--force-recreate"));
}));

it.each(["MISSING_IMAGE","WRONG_IMAGE"])("refuses %s before changing checkout or containers",async failure=>fixture(async({execute,directory})=>{
  await writeFile(join(directory,"hail-provider-previous"),`${old} ${reference} ${digest}\n`);
  const result=await execute("rollback",{[failure]:"1"});expect(result.exit).toBe(1);
  expect(result.log).not.toContain(" checkout --");expect(result.log).not.toContain("docker tag");expect(result.log).not.toContain("compose");
}));

it("manual rollback verifies the retained image and restores both services",async()=>fixture(async({execute,directory})=>{
  await writeFile(join(directory,"hail-provider-previous"),`${old} ${reference} ${digest}\n`);
  const result=await execute("rollback");expect(result.exit,result.stderr).toBe(0);
  expect(result.log.indexOf("image inspect")).toBeLessThan(result.log.indexOf(" checkout --"));
  expect(result.log).toContain("--no-build --pull never --force-recreate --wait --wait-timeout 180 gui provider");
}));

it("refuses legacy unretained rollback records without changing the release",async()=>fixture(async({execute,directory})=>{
  await writeFile(join(directory,"hail-provider-previous"),`${old} ${digest}\n`);
  const result=await execute("rollback");expect(result.exit).toBe(1);expect(result.log).toBe("");
  expect(result.stderr).toContain("lacks a verified retained image");
}));


it("refuses a failed retention verification before checkout or build",async()=>fixture(async({execute})=>{
  const result=await execute("deploy",{WRONG_IMAGE:"1"});expect(result.exit).toBe(1);
  expect(result.log).not.toContain(" checkout --");expect(result.log).not.toContain("build provider");
}));

it("does not overwrite the prior successful rollback record on failed deployment",async()=>fixture(async({execute,directory})=>{
  const record=`${old} ${reference} ${digest}\n`;
  await writeFile(join(directory,"hail-provider-previous"),record);
  expect((await execute("deploy",{FAIL_START:"1"})).exit).toBe(1);
  expect(await readFile(join(directory,"hail-provider-previous"),"utf8")).toBe(record);
}));

it.each(["FAIL_PULL","WRONG_REVISION"])("rejects %s before backup, checkout or service changes",async failure=>fixture(async({execute})=>{
  const result=await execute("deploy",{[failure]:"1"});expect(result.exit).toBe(1);
  expect(result.log).not.toContain("backup ");expect(result.log).not.toContain(" checkout --");expect(result.log).not.toContain("compose");
}));

it("rejects mutable image tags before executing external commands",async()=>fixture(async({execute})=>{
  const result=await execute("deploy",{TEST_IMAGE:"ghcr.io/j4crev/hailproto/provider:latest"});
  expect(result.exit).toBe(2);expect(result.log).toBe("");
}));

it("refuses an invalid running web-client image identity before replacing either",async()=>fixture(async({execute})=>{
  const result=await execute("deploy",{MISMATCHED_GUI:"1"});expect(result.exit).toBe(1);
  expect(result.log).not.toContain(" checkout --");expect(result.log).not.toContain("compose");
}));

it("rejects a mutable client image before pulling either candidate",async()=>fixture(async({execute})=>{
  const result=await execute("deploy",{TEST_CLIENT_IMAGE:"ghcr.io/example/client:latest"});
  expect(result.exit).toBe(2);expect(result.log).toBe("");
}));

it("restores two different retained images on manual rollback",async()=>fixture(async({execute,directory})=>{
  await writeFile(join(directory,"hail-provider-previous"),`${old} ${reference} ${digest} ${clientReference} ${clientDigest}\n`);
  const result=await execute("rollback");expect(result.exit,result.stderr).toBe(0);
  expect(JSON.parse(await readFile(join(directory,"release/compose.json"),"utf8")))
    .toEqual({services:{provider:{image:reference},gui:{image:clientReference}}});
}));

it.each(["FAIL_CLIENT_PULL", "WRONG_CLIENT_REVISION"])("rejects %s before backup or checkout",async failure=>fixture(async({execute})=>{
  const result=await execute("deploy",{[failure]:"1"});expect(result.exit).toBe(1);
  expect(result.log).not.toContain("backup ");expect(result.log).not.toContain(" checkout --");
  expect(result.log).not.toContain("compose");
}));

it("refuses a missing retained client before changing checkout or image selection",async()=>fixture(async({execute,directory})=>{
  await writeFile(join(directory,"hail-provider-previous"),`${old} ${reference} ${digest} ${clientReference} ${clientDigest}\n`);
  const result=await execute("rollback",{MISSING_CLIENT_IMAGE:"1"});expect(result.exit).toBe(1);
  expect(result.log).not.toContain(" checkout --");expect(result.log).not.toContain("compose");
}));

it("retains the existing combined image under both roles during the first split rollout",async()=>fixture(async({execute,directory})=>{
  const result=await execute("deploy",{COMBINED_RUNNING:"1"});expect(result.exit,result.stderr).toBe(0);
  expect(await readFile(join(directory,"hail-provider-previous"),"utf8"))
    .toBe(`${old} ${reference} ${digest} hail-web-client:rollback-${digest.slice(7)} ${digest}\n`);
}));
