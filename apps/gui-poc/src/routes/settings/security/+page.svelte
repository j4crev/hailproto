<script lang="ts">
  import {startAuthentication,startRegistration} from "@simplewebauthn/browser";
  let {data}=$props();
  let busy=$state(false),message=$state(""),label=$state("Backup passkey");
  const date=(value:string)=>new Intl.DateTimeFormat(undefined,{dateStyle:"medium",timeStyle:"short"}).format(new Date(value));
  async function json(response:Response){if(!response.ok)throw new Error(response.status===403?"Verify with a passkey first.":"The provider refused the request.");return response.json();}
  async function verify(){
    busy=true;message="";
    try{
      const start=await json(await fetch("/api/v1/auth/passkeys/authentication/options",{method:"POST"}));
      const response=await startAuthentication({optionsJSON:start.options});
      await json(await fetch("/api/v1/auth/passkeys/authentication",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({challengeId:start.challengeId,response})}));
      location.reload();
    }catch(error){message=error instanceof Error?error.message:"Verification failed.";busy=false;}
  }
  async function add(){
    busy=true;message="";
    try{
      const start=await json(await fetch("/api/v1/auth/passkeys/registration/options",{method:"POST"}));
      const response=await startRegistration({optionsJSON:start.options});
      await json(await fetch("/api/v1/auth/passkeys/registration",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({challengeId:start.challengeId,response,label})}));
      location.reload();
    }catch(error){message=error instanceof Error?error.message:"Passkey creation failed.";busy=false;}
  }
  async function manage(credentialId:string,action:"rename"|"revoke",currentLabel:string){
    const next=action==="rename"?prompt("Passkey label",currentLabel):confirm("Revoke this passkey? Other sessions using it will be signed out.");
    if(next===null||next===false)return;busy=true;message="";
    try{await json(await fetch("/api/v1/auth/passkeys/manage",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify(action==="rename"?{credentialId,label:next}:{credentialId,revoke:true})}));location.reload();}
    catch(error){message=error instanceof Error?error.message:"Passkey update failed.";busy=false;}
  }
  async function revokeSessions(){
    if(!confirm("Sign out every browser and device, including this one?"))return;busy=true;message="";
    try{await json(await fetch("/api/v1/auth/passkeys/sessions/revoke",{method:"POST"}));location.href="/auth/login";}
    catch(error){message=error instanceof Error?error.message:"Session revocation failed.";busy=false;}
  }
</script>

<section class="heading"><div><p class="eyebrow">Account safety</p><h1>Passkeys</h1></div>
  <button class="secondary" onclick={verify} disabled={busy}>Verify to manage</button></section>
<p class="intro">Keep at least two independent passkeys before relying on passwordless recovery.</p>

<section class="list" aria-label="Passkeys">
  {#each data.passkeys as passkey}
    <article class="card key"><div><strong>{passkey.label}</strong><p>{passkey.deviceType==="multiDevice"?"Synced passkey":"Device-bound passkey"}{passkey.backedUp?" · backed up":""}</p>
      <small>Created {date(passkey.createdAt)}{passkey.lastUsedAt?` · used ${date(passkey.lastUsedAt)}`:""}</small></div>
      <div class="actions">{#if passkey.current}<span>Current</span>{/if}<button onclick={()=>manage(passkey.credentialId,"rename",passkey.label)} disabled={busy||!data.recentlyVerified}>Rename</button>
        <button class="danger" onclick={()=>manage(passkey.credentialId,"revoke",passkey.label)} disabled={busy||!data.recentlyVerified||passkey.current||data.passkeys.length===1}>Revoke</button></div></article>
  {/each}
</section>

<section class="card add"><h2>Add a passkey</h2><label>Label <input bind:value={label} maxlength="80" /></label>
  <button onclick={add} disabled={busy||!data.recentlyVerified||!label.trim()}>Add passkey</button>
  {#if !data.recentlyVerified}<small>Verify with your current passkey before making changes.</small>{/if}
  {#if message}<p aria-live="polite">{message}</p>{/if}
</section>

<section class="card add"><h2>Account sessions</h2><p>Sign out every browser and device currently using this account.</p>
  <button class="danger" onclick={revokeSessions} disabled={busy||!data.recentlyVerified}>Sign out everywhere</button>
</section>

<style>
  .heading{display:flex;align-items:end;justify-content:space-between;gap:20px}.eyebrow{margin:0 0 8px;color:#22714b;font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase}h1,h2,p{margin:0}h1{font-size:42px}.intro{margin:12px 0 24px;color:#657168}.list{display:grid;gap:12px}.key{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:20px}.key p,.key small{display:block;margin-top:5px;color:#6b766f}.actions{display:flex;align-items:center;gap:8px}.actions span{color:#22714b;font-size:12px;font-weight:750}.add{display:flex;align-items:flex-start;flex-direction:column;gap:14px;margin-top:22px;padding:24px}label{display:flex;flex-direction:column;gap:6px;font-size:13px;font-weight:700}input{min-width:260px;padding:10px;border:1px solid #cad4cd;border-radius:8px;font:inherit}button{padding:9px 12px;border:0;border-radius:8px;background:#17633f;color:white;font:inherit;font-weight:750;cursor:pointer}button.secondary,.actions button{border:1px solid #cad4cd;background:white;color:#355143}button.danger{color:#9d3232}.add button.danger{background:#9d3232;color:white}button:disabled{cursor:not-allowed;opacity:.45}.add small,.add p{color:#657168}@media(max-width:650px){.heading,.key{align-items:flex-start;flex-direction:column}.actions{flex-wrap:wrap}input{min-width:0;width:100%}}
</style>
