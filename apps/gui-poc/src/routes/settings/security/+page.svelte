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

<section class="flex items-end justify-between gap-5 max-[650px]:flex-col max-[650px]:items-start"><div><p class="m-0 mb-2 text-[12px] font-extrabold tracking-[.12em] text-[#22714b] uppercase">Account safety</p><h1 class="m-0 text-[42px]">Passkeys</h1></div>
  <button class="cursor-pointer rounded-lg border border-solid border-[#cad4cd] bg-white px-3 py-[9px] [font:inherit] font-[750]! text-[#355143] disabled:cursor-not-allowed disabled:opacity-45" onclick={verify} disabled={busy}>Verify to manage</button></section>
<p class="mt-3 mb-6 text-[#657168]">Keep at least two independent passkeys before relying on passwordless recovery.</p>

<section class="grid gap-3" aria-label="Passkeys">
  {#each data.passkeys as passkey}
    <article class="hail-card flex items-center justify-between gap-[18px] p-5 max-[650px]:flex-col max-[650px]:items-start"><div><strong>{passkey.label}</strong><p class="m-0 mt-[5px] block text-[#6b766f]">{passkey.deviceType==="multiDevice"?"Synced passkey":"Device-bound passkey"}{passkey.backedUp?" · backed up":""}</p>
      <small class="mt-[5px] block text-[#6b766f]">Created {date(passkey.createdAt)}{passkey.lastUsedAt?` · used ${date(passkey.lastUsedAt)}`:""}</small></div>
      <div class="flex items-center gap-2 max-[650px]:flex-wrap">{#if passkey.current}<span class="text-[12px] font-[750] text-[#22714b]">Current</span>{/if}<button class="cursor-pointer rounded-lg border border-solid border-[#cad4cd] bg-white px-3 py-[9px] [font:inherit] font-[750]! text-[#355143] disabled:cursor-not-allowed disabled:opacity-45" onclick={()=>manage(passkey.credentialId,"rename",passkey.label)} disabled={busy||!data.recentlyVerified}>Rename</button>
        <button class="cursor-pointer rounded-lg border border-solid border-[#cad4cd] bg-white px-3 py-[9px] [font:inherit] font-[750]! text-[#9d3232] disabled:cursor-not-allowed disabled:opacity-45" onclick={()=>manage(passkey.credentialId,"revoke",passkey.label)} disabled={busy||!data.recentlyVerified||passkey.current||data.passkeys.length===1}>Revoke</button></div></article>
  {/each}
</section>

<section class="hail-card mt-[22px] flex flex-col items-start gap-3.5 p-6 [&_small]:text-[#657168] [&_p]:m-0 [&_p]:text-[#657168]"><h2 class="m-0">Add a passkey</h2><label class="flex flex-col gap-1.5 text-[13px] font-bold">Label <input class="min-w-[260px] rounded-lg border border-solid border-[#cad4cd] p-2.5 [font:inherit] max-[650px]:min-w-0 max-[650px]:w-full" bind:value={label} maxlength="80" /></label>
  <button class="cursor-pointer rounded-lg border-0 bg-[#17633f] px-3 py-[9px] [font:inherit] font-[750]! text-white disabled:cursor-not-allowed disabled:opacity-45" onclick={add} disabled={busy||!data.recentlyVerified||!label.trim()}>Add passkey</button>
  {#if !data.recentlyVerified}<small>Verify with your current passkey before making changes.</small>{/if}
  {#if message}<p aria-live="polite">{message}</p>{/if}
</section>

<section class="hail-card mt-[22px] flex flex-col items-start gap-3.5 p-6"><h2 class="m-0">Account sessions</h2><p class="m-0 text-[#657168]">Sign out every browser and device currently using this account.</p>
  <button class="cursor-pointer rounded-lg border-0 bg-[#9d3232] px-3 py-[9px] [font:inherit] font-[750]! text-white disabled:cursor-not-allowed disabled:opacity-45" onclick={revokeSessions} disabled={busy||!data.recentlyVerified}>Sign out everywhere</button>
</section>
