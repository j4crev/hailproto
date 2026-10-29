import {mkdtemp,readFile,writeFile,mkdir,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect,it} from "vitest";

const old="a".repeat(40),candidate="b".repeat(40),digest=`sha256:${"c".repeat(64)}`;
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
  docker:inspect) echo '${digest}';;
  docker:image)
    [ "\${MISSING_IMAGE:-}" != 1 ] || exit 1
    if [ "\${WRONG_IMAGE:-}" = 1 ]; then echo 'sha256:wrong'; else echo '${digest}'; fi;;
  docker:tag)
    [ "$3" != hail-server-ts:public ] || touch "$PROBE_RESTORED";;
  docker:compose)
    case "$*" in *'build provider'*) [ "\${FAIL_BUILD:-}" != 1 ] || exit 1;; esac;;
  curl:*)
    [ "\${FAIL_HEALTH:-}" != 1 ] || [ -e "$PROBE_RESTORED" ] || exit 1;;
esac
`;
    for(const name of ["docker","git","curl","backup"])await writeFile(join(bin,name),mock,{mode:0o755});
    const source=await readFile(new URL("../deploy/public/provider-ops.sh",import.meta.url),"utf8");
    await writeFile(join(directory,"ops.sh"),source.replaceAll("/opt/hailproto",join(directory,"checkout"))
      .replaceAll("/var/lib/",directory+"/").replaceAll("/usr/local/sbin/hail-provider-backup",join(bin,"backup")));
    await run({directory,execute:async(action,env={})=>{
      await writeFile(join(directory,"log"),"");
      const child=Bun.spawn(["sh",join(directory,"ops.sh"),action,...action==="deploy"?[candidate]:[]],{
        env:{...process.env,PATH:`${bin}:${process.env.PATH}`,PROBE_LOG:join(directory,"log"),PROBE_RESTORED:join(directory,"restored"),...env},stdout:"pipe",stderr:"pipe"});
      const [exit,stderr]=await Promise.all([child.exited,new Response(child.stderr).text(),new Response(child.stdout).text()]);
      return {exit,stderr,log:await readFile(join(directory,"log"),"utf8")};
    }});
  }finally{await rm(directory,{recursive:true,force:true});}
}

it("retains and verifies the running image before replacement and atomically records its identity",async()=>fixture(async({directory,execute})=>{
  const result=await execute("deploy");expect(result.exit,result.stderr).toBe(0);
  expect(result.log.indexOf(`docker tag ${digest} ${reference}`)).toBeLessThan(result.log.indexOf("build provider"));
  expect(result.log.indexOf(`docker image inspect ${reference}`)).toBeLessThan(result.log.indexOf(`checkout --quiet --detach ${candidate}`));
  expect(await readFile(join(directory,"hail-provider-previous"),"utf8")).toBe(`${old} ${reference} ${digest}\n`);
}));

it.each(["FAIL_BUILD","FAIL_HEALTH"])("restores both services from the retained image after %s and still reports deployment failure",async failure=>fixture(async({execute})=>{
  const result=await execute("deploy",{[failure]:"1"});expect(result.exit).toBe(1);
  expect(result.log).toContain(`docker tag ${reference} hail-server-ts:public`);
  expect(result.log).toContain("up -d --no-build --pull never --force-recreate gui provider");
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
  expect(result.log).toContain("--no-build --pull never --force-recreate gui provider");
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
  expect((await execute("deploy",{FAIL_BUILD:"1"})).exit).toBe(1);
  expect(await readFile(join(directory,"hail-provider-previous"),"utf8")).toBe(record);
}));
