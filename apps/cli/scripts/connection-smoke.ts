/** Deterministic process-level proof against a fresh `eval:agents serve` fixture.
 * Uses disposable alice/bob accounts; do not run in an actual agent trial.
 */
import assert from "node:assert/strict";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SQL } from "bun";
import { ProviderDatabase } from "../../server/src/db/database.js";

const directory = resolve(Bun.argv[2] ?? "");
const run = await Bun.file(join(directory,"run.json")).json();
const sql = new SQL(run.databaseUrl);
const roots = Object.fromEntries(["alice","bob"].map(actor=>[actor,join(directory,"actors",actor)])) as Record<"alice"|"bob",string>;
async function cli(actor:"alice"|"bob", args:string[], unlock=false, expected=0) {
  const child=Bun.spawn([join(roots[actor],"hailp"),...args],{stdin:"pipe",stdout:"pipe",stderr:"pipe"});
  if(unlock)child.stdin.write(await readFile(join(roots[actor],"recovery.txt"),"utf8"));
  child.stdin.end();
  const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  assert.equal(exit,expected,`${actor} ${args.slice(0,2).join(" ")}: ${stderr}`);
  return JSON.parse(expected===0?stdout:stderr.trim().split("\n").at(-1)!);
}
const accounts:Record<string,any>={};
try {
  assert.equal((await sql`SELECT count(*)::int AS n FROM provider_accounts`)[0].n,0,"Smoke requires a fresh disposable fixture");
  // The expanded schema can roll back before any new approval exists.
  const connection=await sql.reserve();
  try{await connection.unsafe(await Bun.file(new URL("../../server/migrations/rollback/0083_connection_cli_approvals.sql",import.meta.url)).text());
  } finally {connection.release();}
  const migrated=new ProviderDatabase(run.databaseUrl);try{await migrated.migrate();}finally{await migrated.close();}
  for(const actor of ["alice","bob"] as const){
    const root=roots[actor];
    await cli(actor,["vault","create","--vault",join(root,"vault.json"),"--recovery-file",join(root,"recovery.txt")]);
    for(const file of ["vault.json","recovery.txt"])await copyFile(join(root,file),join(root,"backup",file));
    await cli(actor,["vault","verify","--vault",join(root,"backup/vault.json"),"--expected-did","unbound"],true);
    await cli(actor,["account","create","--provider",run.provider,"--address",`${actor}@source.example.com`,"--custody","owner-controlled",
      "--vault",join(root,"vault.json"),"--state",join(root,"signup.json"),"--credentials",join(root,"credential.json"),"--backup-verified"],true);
    accounts[actor]=await cli(actor,["account","show"]);
  }
  const invite=["connection","invite","--label","CLI proof","--expires-at",String(Math.floor(Date.now()/1000)+3600),
    "--vault",join(roots.alice,"vault.json"),"--state",join(roots.alice,"invite.json"),"--output",join(roots.alice,"invitation.json")];
  await writeFile(join(directory,"lose-response.json"),JSON.stringify({path:"/api/v1/account/connections/cli-commit"}),{mode:0o600});
  assert.equal((await cli("alice",invite,true,1)).error.code,"HTTP_503");
  const signature=await readFile(join(roots.alice,"invite.json.cose"));
  const invitation=await cli("alice",invite);
  assert.deepEqual(await readFile(join(roots.alice,"invite.json.cose")),signature);
  assert.equal((await sql`SELECT count(*)::int AS n FROM connection_invitations`)[0].n,1);
  const changed=[...invite];changed[changed.indexOf("--label")+1]="Different intent";
  assert.equal((await cli("alice",changed,false,1)).error.code,"CLIENT_ERROR");
  await copyFile(join(roots.alice,"invitation.json"),join(roots.bob,"peer-invitation.json"));
  const accept=["connection","accept","--file",join(roots.bob,"peer-invitation.json"),"--expected-did",accounts.alice.did,
    "--vault",join(roots.bob,"vault.json"),"--state",join(roots.bob,"accept.json")];
  const wrong=[...accept];wrong[wrong.indexOf("--expected-did")+1]=accounts.bob.did;
  assert.equal((await cli("bob",wrong,false,1)).error.code,"CLIENT_ERROR");
  await writeFile(join(directory,"lose-response.json"),JSON.stringify({path:"/api/v1/account/connections/cli-commit"}),{mode:0o600});
  assert.equal((await cli("bob",accept,true,1)).error.code,"HTTP_503");
  await cli("bob",accept);
  let active:any;
  for(let attempt=0;attempt<12;attempt++){
    active=await cli("bob",["connection","status","--state",join(roots.bob,"accept.json")]);
    if(active.state==="active")break;
    await Bun.sleep(250);
  }
  assert.equal(active.state,"active");
  for(const actor of ["alice","bob"] as const){
    const list=await cli(actor,["connection","list"]);
    assert.equal(list.connections.length,1);assert.equal(list.connections[0].id,active.connectionId);assert.equal(list.connections[0].epoch,1);
  }
  assert.equal((await sql`SELECT count(*)::int AS n FROM connection_approvals WHERE api_credential_id IS NOT NULL`)[0].n,2);
  // No schema rollback may erase retained CLI consent.
  const blockedRollback=await sql.reserve();
  try{await assert.rejects(blockedRollback.unsafe(await Bun.file(new URL("../../server/migrations/rollback/0083_connection_cli_approvals.sql",import.meta.url)).text()),/Retained CLI/);}
  finally{await blockedRollback`ROLLBACK`;blockedRollback.release();}
  for(const [actor,peer] of [["alice","bob"],["bob","alice"]] as const){
    const text=`Connection challenge ${actor} to ${peer}`;
    await writeFile(join(roots[actor],"message.txt"),text,{mode:0o600});
    const send=["connection","send",active.connectionId,"--file",join(roots[actor],"message.txt"),"--state",join(roots[actor],"send.json")];
    await writeFile(join(directory,"lose-response.json"),JSON.stringify({path:"/api/v1/account/messages"}),{mode:0o600});
    assert.equal((await cli(actor,send,false,1)).error.code,"HTTP_503");
    const sent=await cli(actor,send);
    const delivered=await cli(actor,["message","status",sent.messageId,"--wait","10","--interval","1"]);
    assert.equal(delivered.state,"delivered");
    const received=await cli(peer,["inbox","show",accounts[actor].did,sent.messageId]);
    assert.ok(JSON.stringify(received.body).includes(text));
    assert.equal((await sql`SELECT count(*)::int AS n FROM sent_envelopes WHERE sender_did=${accounts[actor].did}`)[0].n,1);
    await writeFile(join(roots[actor],"message.txt"),"changed content",{mode:0o600});
    assert.equal((await cli(actor,send,false,1)).error.code,"CLIENT_ERROR");
    await writeFile(join(roots[actor],"message.txt"),text,{mode:0o600});
  }
  await cli("alice",["connection","remove",active.connectionId]);
  await writeFile(join(roots.bob,"after-removal.txt"),"Must not send",{mode:0o600});
  await cli("bob",["connection","send",active.connectionId,"--file",join(roots.bob,"after-removal.txt"),"--state",join(roots.bob,"after-removal.json")],false,1);
  console.info("Connection smoke passed: owner consent, exact retries after lost commit/send responses, mutual delivery, changed-input rejection, removal cutoff, migration rollback guards.");
} finally {await sql.close();}
