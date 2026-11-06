import {mkdtemp,readFile,writeFile,mkdir,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect,it} from "vitest";

const old="a".repeat(40),candidate="b".repeat(40),digest=`sha256:${"c".repeat(64)}`;
const image=`ghcr.io/j4crev/hail/provider@sha256:${"d".repeat(64)}`;
const clientImage=`ghcr.io/j4crev/hail/provider-web-client@sha256:${"e".repeat(64)}`;
const clientDigest=`sha256:${"f".repeat(64)}`;
const clientReference=`hail-web-client:rollback-${"f".repeat(64)}`;
const reference=`hail-server-ts:rollback-${"c".repeat(64)}`;
async function fixture(run:(f:{directory:string;execute:(action:string,env?:Record<string,string>)=>Promise<{exit:number;log:string;stderr:string;stdout:string}>})=>Promise<void>){
  const directory=await mkdtemp(join(tmpdir(),"hail-provider-ops-"));
  try{
    const bin=join(directory,"bin");await mkdir(bin);
    const mock=`#!/bin/sh
printf '%s %s\\n' "$(basename "$0")" "$*" >> "$PROBE_LOG"
case "$(basename "$0"):$1" in
  git:*)
    case "$*" in *rev-parse*) echo '${old}';; esac;;
  df:*)
    free=\${FREE_KIB:-9999999}
    if [ -f "$PROBE_PULLED" ]; then free=\${AFTER_PULL_KIB:-$free}; fi
    printf 'Filesystem 1024-blocks Used Available Capacity Mounted\\nmock 40000000 1 %s 1%% /\\n' "$free";;
  docker:info) echo "$PROBE_STORAGE";;
  docker:ps) [ "\${FAIL_CONTAINERS:-}" != 1 ] || exit 1; printf 'provider\\ngui\\nstopped\\n';;
  docker:inspect)
    if [ -n "\${CURRENT_IMAGE:-}" ] && { [ "$2" = provider ] || [ "$2" = hail-public-provider-provider-1 ]; }; then echo "$CURRENT_IMAGE"; exit 0; fi
    if [ -n "\${CURRENT_CLIENT_IMAGE:-}" ] && { [ "$2" = gui ] || [ "$2" = hail-public-provider-gui-1 ]; }; then echo "$CURRENT_CLIENT_IMAGE"; exit 0; fi
    if [ "$2" = stopped ] && [ -n "\${STOPPED_IMAGE:-}" ]; then echo "$STOPPED_IMAGE"; exit 0; fi
    if [ "\${MISMATCHED_GUI:-}" = 1 ] && [ "$2" = hail-public-provider-gui-1 ]; then echo 'sha256:other'; elif [ "\${COMBINED_RUNNING:-}" = 1 ]; then echo '${digest}'; elif [ "$2" = hail-public-provider-gui-1 ] || [ "$2" = gui ]; then echo '${clientDigest}'; else echo '${digest}'; fi;;
  docker:pull)
    touch "$PROBE_PULLED"
    [ "\${FAIL_PULL:-}" != 1 ] || exit 1
    if [ "\${FAIL_CLIENT_PULL:-}" = 1 ] && [ "$2" = '${clientImage}' ]; then exit 1; fi;;
  docker:image)
    if [ "$2" = ls ]; then [ "\${FAIL_LIST:-}" != 1 ] || exit 1;
      if [ "\${CHANGE_INVENTORY:-}" = 1 ]; then
        if [ -e "$PROBE_STORAGE/listed" ]; then exit 0; fi
        touch "$PROBE_STORAGE/listed"
      fi
      printf '%s\\n' "\${RETENTION_TAGS:-}"; exit 0; fi
    if [ "$2" = rm ]; then [ "\${FAIL_REMOVE:-}" != 1 ]; exit $?; fi
    case "$*" in *'{{json .}}'*)
      python3 - "$3" <<'PY_INSPECT'
import json, os, sys
ref=sys.argv[1]
identity='${clientDigest}' if ref=='${clientReference}' else '${digest}'
if os.environ.get('COMBINED_RUNNING')=='1': identity='${digest}'
data=json.loads(os.environ.get('RETENTION_INVENTORY','{}'))
print(json.dumps(data.get(ref, {'Id':identity,'RepoTags':[ref],'RepoDigests':[]})))
PY_INSPECT
      exit 0;; esac
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
    for(const name of ["docker","git","curl","backup","df"])await writeFile(join(bin,name),mock,{mode:0o755});
    const source=await readFile(new URL("../deploy/public/provider-ops.sh",import.meta.url),"utf8");
    await writeFile(join(directory,"ops.sh"),source.replaceAll("/opt/hail",join(directory,"checkout"))
      .replaceAll("/etc/hail-provider-release",join(directory,"release")).replaceAll("/etc/hail-provider-postgres",join(directory,"postgres"))
      .replaceAll("/var/lib/",directory+"/").replaceAll("/usr/local/sbin/hail-provider-backup",join(bin,"backup")));
    await run({directory,execute:async(action,env={})=>{
      await writeFile(join(directory,"log"),"");
      const child=Bun.spawn(["sh",join(directory,"ops.sh"),...action.split(" "),...action==="deploy"?[candidate,env.TEST_IMAGE??image,env.TEST_CLIENT_IMAGE??clientImage]:[]],{
        env:{...process.env,PATH:`${bin}:${process.env.PATH}`,PROBE_STORAGE:directory,PROBE_PULLED:join(directory,"pulled"),PROBE_LOG:join(directory,"log"),PROBE_RESTORED:join(directory,"restored"),PROBE_RELEASE:join(directory,"release/compose.json"),...env},stdout:"pipe",stderr:"pipe"});
      const [exit,stderr,stdout]=await Promise.all([child.exited,new Response(child.stderr).text(),new Response(child.stdout).text()]);
      return {exit,stderr,stdout,log:await readFile(join(directory,"log"),"utf8")};
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
  const result=await execute("deploy",{TEST_IMAGE:"ghcr.io/j4crev/hail/provider:latest"});
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

const staleDigest=`sha256:${"1".repeat(64)}`;
const staleTag=`hail-server-ts:rollback-${staleDigest.slice(7)}`;
const staleClientTag=`hail-web-client:rollback-${staleDigest.slice(7)}`;
const staleData={Id:staleDigest,RepoTags:[staleTag,staleClientTag],RepoDigests:[`ghcr.io/j4crev/hailproto/provider@${staleDigest}`]};
const retentionEnv={RETENTION_TAGS:[reference,clientReference,staleTag,staleClientTag,"postgres:18.6-alpine","hail-server-ts:public"].join("\n"),RETENTION_INVENTORY:JSON.stringify({[staleTag]:staleData,[staleClientTag]:staleData})};
const rollbackRecord=`${old} ${reference} ${digest} ${clientReference} ${clientDigest}\n`;

it("reports obsolete wrapper images without deleting anything by default",async()=>fixture(async({execute,directory})=>{
  await writeFile(join(directory,"hail-provider-previous"),rollbackRecord);
  const result=await execute("image-retention",retentionEnv);
  expect(result.exit,result.stderr).toBe(0);expect(result.stdout).toContain("1 obsolete rollback image(s); mode=report");
  expect(result.stdout).toContain(staleTag);expect(result.log).not.toContain("docker image rm");
}));

it("removes only old wrapper aliases after successful deployment, retaining the new rollback record",async()=>fixture(async({execute,directory})=>{
  const result=await execute("deploy",retentionEnv);expect(result.exit,result.stderr).toBe(0);
  const removal=result.log.split("\n").filter(line=>line.startsWith("docker image rm"));
  expect(removal).toEqual([`docker image rm --no-prune ${staleTag} ${staleClientTag}`]);
  expect(result.log.indexOf(removal[0]!)).toBeGreaterThan(result.log.lastIndexOf("curl "));
  expect(await readFile(join(directory,"hail-provider-previous"),"utf8")).toBe(rollbackRecord);
  expect(result.log).not.toMatch(/docker (system|volume|builder).*prune|docker image rm .*--force/);
}));

it.each(["CURRENT_IMAGE","CURRENT_CLIENT_IMAGE","STOPPED_IMAGE"])("protects a stale-tagged image used by %s",async key=>fixture(async({execute,directory})=>{
  await writeFile(join(directory,"hail-provider-previous"),rollbackRecord);
  const result=await execute("image-retention --apply",{...retentionEnv,[key]:staleDigest});
  expect(result.exit,result.stderr).toBe(0);expect(result.log).not.toContain("docker image rm");
}));

it.each([
  {...staleData,RepoTags:[staleTag,"hail-server-ts:manual-keep"]},
  {...staleData,RepoDigests:[`example.com/foreign@${staleDigest}`]},
])("preserves additional operator/foreign references on old images",async data=>fixture(async({execute,directory})=>{
  await writeFile(join(directory,"hail-provider-previous"),rollbackRecord);
  const result=await execute("image-retention --apply",{RETENTION_TAGS:staleTag,RETENTION_INVENTORY:JSON.stringify({[staleTag]:data})});
  expect(result.exit,result.stderr).toBe(0);expect(result.log).not.toContain("docker image rm");
}));

it.each(["",`${old} ${digest}\n`,`${old} ${reference} sha256:wrong\n`])("refuses cleanup with an invalid rollback record: %s",async record=>fixture(async({execute,directory})=>{
  await writeFile(join(directory,"hail-provider-previous"),record);
  const result=await execute("image-retention --apply",retentionEnv);
  expect(result.exit).toBe(1);expect(result.log).not.toContain("docker image rm");
}));

it("refuses all cleanup if any rollback alias has the wrong identity",async()=>fixture(async({execute,directory})=>{
  await writeFile(join(directory,"hail-provider-previous"),rollbackRecord);
  const result=await execute("image-retention --apply",{...retentionEnv,RETENTION_INVENTORY:JSON.stringify({[staleTag]:staleData,[staleClientTag]:{...staleData,Id:digest}})});
  expect(result.exit).toBe(1);expect(result.log).not.toContain("docker image rm");
}));

it.each(["FAIL_LIST","FAIL_CONTAINERS"])("refuses cleanup when inventory fails: %s",async key=>fixture(async({execute,directory})=>{
  await writeFile(join(directory,"hail-provider-previous"),rollbackRecord);
  const result=await execute("image-retention --apply",{...retentionEnv,[key]:"1"});
  expect(result.exit).toBe(1);expect(result.log).not.toContain("docker image rm");
}));

it("cleanup failure warns but does not roll back a healthy deployment",async()=>fixture(async({execute,directory})=>{
  const result=await execute("deploy",{...retentionEnv,FAIL_REMOVE:"1"});
  expect(result.exit,result.stderr).toBe(0);expect(result.stderr).toContain("deployment succeeded, but image retention needs operator attention");
  expect(await readFile(join(directory,"hail-provider-previous"),"utf8")).toBe(rollbackRecord);
  expect(result.log).not.toContain(`checkout --quiet --detach ${old}`);
}));

it.each(["FAIL_START","FAIL_HEALTH"])("never cleans up after failed deployment: %s",async failure=>fixture(async({execute})=>{
  const result=await execute("deploy",{...retentionEnv,[failure]:"1"});
  expect(result.exit).toBe(1);expect(result.log).not.toContain("docker image rm");expect(result.log).not.toContain("docker image ls");
}));

it.each([{FREE_KIB:"3145727"},{FREE_KIB:"unknown"}])("blocks pulls when initial disk space is insufficient or unreadable",async env=>fixture(async({execute})=>{
  const result=await execute("deploy",env);expect(result.exit).toBe(1);
  expect(result.log).not.toContain("docker pull");expect(result.log).not.toContain("backup ");expect(result.log).not.toContain(" checkout --");
}));

it("checks reserve after pulls and before backup or service replacement",async()=>fixture(async({execute})=>{
  const result=await execute("deploy",{AFTER_PULL_KIB:"1048575"});expect(result.exit).toBe(1);
  expect(result.log).toContain(`docker pull ${clientImage}`);expect(result.log).not.toContain("backup ");expect(result.log).not.toContain(" checkout --");
}));

it("protects both rollback images even when neither is referenced by containers",async()=>fixture(async({execute,directory})=>{
  await writeFile(join(directory,"hail-provider-previous"),rollbackRecord);
  const result=await execute("image-retention --apply",{...retentionEnv,CURRENT_IMAGE:staleDigest,CURRENT_CLIENT_IMAGE:staleDigest,STOPPED_IMAGE:staleDigest});
  expect(result.exit,result.stderr).toBe(0);expect(result.log).not.toContain("docker image rm");
}));

it("does not delete anything when the candidate inventory changes between report and apply",async()=>fixture(async({execute,directory})=>{
  await writeFile(join(directory,"hail-provider-previous"),rollbackRecord);
  const result=await execute("image-retention --apply",{...retentionEnv,CHANGE_INVENTORY:"1"});
  expect(result.exit).toBe(1);expect(result.stderr).toContain("inventory changed");expect(result.log).not.toContain("docker image rm");
}));

it("refuses cleanup with a missing record or missing/mismatched recorded image",async()=>fixture(async({execute,directory})=>{
  expect((await execute("image-retention --apply",retentionEnv)).exit).toBe(1);
  await writeFile(join(directory,"hail-provider-previous"),rollbackRecord);
  const result=await execute("image-retention --apply",{...retentionEnv,RETENTION_INVENTORY:JSON.stringify({[clientReference]:{Id:staleDigest}})});
  expect(result.exit).toBe(1);expect(result.log).not.toContain("docker image rm");
}));

it("supports the verified combined-image rollback record during cleanup",async()=>fixture(async({execute,directory})=>{
  await writeFile(join(directory,"hail-provider-previous"),`${old} ${reference} ${digest}\n`);
  const result=await execute("image-retention --apply",retentionEnv);
  expect(result.exit,result.stderr).toBe(0);expect(result.log).toContain(`docker image rm --no-prune ${staleTag} ${staleClientTag}`);
  expect(result.log).not.toContain(`docker image rm --no-prune ${reference}`);
}));

it("serializes manual image cleanup with deployments and rollbacks",async()=>fixture(async({execute,directory})=>{
  const holder=Bun.spawn(["flock","-x",join(directory,"hail-provider-deploy.lock"),"sh","-c","echo locked; read done"],{stdin:"pipe",stdout:"pipe",stderr:"pipe"});
  try{
    const ready=holder.stdout.getReader();await ready.read();ready.releaseLock();
    const result=await execute("image-retention --apply",retentionEnv);
    expect(result.exit).toBe(1);expect(result.stderr).toContain("another provider deployment or rollback is running");expect(result.log).toBe("");
  }finally{holder.stdin.write("done\n");holder.stdin.end();await holder.exited;}
}));

it.each([false,true])("handles observed containerd digest references (digest in RepoTags: %s)",async digestAlias=>fixture(async({execute,directory})=>{
  await writeFile(join(directory,"hail-provider-previous"),rollbackRecord);
  const remote=`ghcr.io/j4crev/hail/provider@${staleDigest}`;
  const data={Id:staleDigest,RepoTags:[staleTag,...digestAlias?[remote]:[]],RepoDigests:[`hail-server-ts@${staleDigest}`,...digestAlias?[remote]:[]]};
  const result=await execute("image-retention --apply",{RETENTION_TAGS:staleTag,RETENTION_INVENTORY:JSON.stringify({[staleTag]:data,[remote]:data})});
  expect(result.exit,result.stderr).toBe(0);
  expect(result.log.split("\n").filter(line=>line.startsWith("docker image rm")))
    .toEqual([`docker image rm --no-prune ${digestAlias?remote+" ":""}${staleTag}`]);
}));

it.each([`hail-server-ts@${digest}`,`ghcr.io/other/provider@${staleDigest}`,`ghcr.io/j4crev/hail/provider:manual`,`ghcr.io/j4crev/hail/provider@invalid`])("preserves unrecognized or mismatched aliases: %s",async alias=>fixture(async({execute,directory})=>{
  await writeFile(join(directory,"hail-provider-previous"),rollbackRecord);
  const data={...staleData,RepoTags:[staleTag,alias]};
  const result=await execute("image-retention --apply",{RETENTION_TAGS:staleTag,RETENTION_INVENTORY:JSON.stringify({[staleTag]:data})});
  expect(result.exit,result.stderr).toBe(0);expect(result.log).not.toContain("docker image rm");
}));

it("refuses cleanup if a registry digest alias resolves to another image",async()=>fixture(async({execute,directory})=>{
  await writeFile(join(directory,"hail-provider-previous"),rollbackRecord);
  const remote=`ghcr.io/j4crev/hail/provider@${staleDigest}`;
  const data={...staleData,RepoTags:[staleTag,remote]};
  const result=await execute("image-retention --apply",{RETENTION_TAGS:staleTag,RETENTION_INVENTORY:JSON.stringify({[staleTag]:data,[remote]:{Id:digest}})});
  expect(result.exit).toBe(1);expect(result.stderr).toContain("digest alias identity mismatch");expect(result.log).not.toContain("docker image rm");
}));
