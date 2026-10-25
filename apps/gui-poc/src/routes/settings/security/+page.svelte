<script lang="ts">
  import {startAuthentication,startRegistration} from "@simplewebauthn/browser";
  import ConnectionCodes from "$lib/ConnectionCodes.svelte";
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

<svelte:head><title>Security · Haili</title></svelte:head>
<header class="mb-8 flex flex-wrap items-start justify-between gap-4"><div class="grid gap-3"><p class="hail-eyebrow">Account safety</p><h1 class="hail-title">Passkeys &amp; security</h1><p class="m-0 max-w-xl text-sm text-muted">Keep a backup passkey on another device or security key. Passkeys provide account access, not owner recovery authority.</p></div><button class="hail-button-secondary" onclick={verify} disabled={busy}>Verify to manage</button></header>
{#if message}<div class="mb-5"><p class="hail-error" role="alert">{message}</p></div>{/if}
{#if !data.recentlyVerified}<p class="mb-6 rounded-xl border border-solid border-line bg-brand-soft p-4 text-sm text-brand-strong">Verify with your current passkey before adding, renaming or revoking passkeys or signing out other devices.</p>{/if}
<div class="grid items-start gap-6 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
  <div class="grid min-w-0 gap-6">
    <section class="grid gap-4" aria-label="Passkeys"><h2 class="m-0 text-xl">Your passkeys</h2>
      {#each data.passkeys as passkey}<article class="hail-card grid min-w-0 gap-4 p-5"><div class="flex flex-wrap items-center gap-2"><strong class="[overflow-wrap:anywhere]">{passkey.label}</strong>{#if passkey.current}<span class="rounded-full bg-brand-soft px-2.5 py-1 text-xs font-semibold text-brand-strong">Current</span>{/if}</div><p class="m-0 text-sm text-muted">{passkey.deviceType==="multiDevice"?"Synced passkey":"Device-bound passkey"}{passkey.backedUp?" · backed up":""}</p><small class="text-xs text-muted">Created {date(passkey.createdAt)}{passkey.lastUsedAt?` · used ${date(passkey.lastUsedAt)}`:""}</small><div class="flex flex-wrap gap-2"><button class="hail-button-secondary" onclick={()=>manage(passkey.credentialId,"rename",passkey.label)} disabled={busy||!data.recentlyVerified}>Rename</button><button class="hail-button-secondary text-danger" onclick={()=>manage(passkey.credentialId,"revoke",passkey.label)} disabled={busy||!data.recentlyVerified||passkey.current||data.passkeys.length===1}>Revoke</button></div></article>{/each}
    </section>
    <form class="hail-card grid min-w-0 gap-4 p-5 sm:p-7" onsubmit={event=>{event.preventDefault();void add();}}><h2 class="m-0 text-xl">Add a passkey</h2><p class="m-0 text-sm text-muted">Name it so you can recognize the device or security key later.</p><label class="hail-field">Label<input bind:value={label} maxlength="80" required /></label><button class="hail-button justify-self-start" disabled={busy||!data.recentlyVerified||!label.trim()}>Add passkey</button></form>
  </div>
  <aside class="grid min-w-0 gap-6">
    <section class="hail-card grid gap-4 p-5 sm:p-7"><h2 class="m-0 text-xl">Recovery is separate</h2><p class="m-0 text-sm text-muted">Keep your encrypted owner recovery backup and its secret in separate safe places. Synced passkeys can share the same failure point.</p><p class="m-0 text-sm text-muted">Post-signup browser recovery is not available yet. If all passkeys are lost, use the supported owner-authorized <code>hailp</code> recovery flow or contact your provider for guidance. Never send anyone your recovery secret.</p></section>
    <section class="hail-card grid gap-4 p-5 sm:p-7"><h2 class="m-0 text-xl">Account sessions</h2><p class="m-0 text-sm text-muted">Sign out every browser and device currently using this account, including this one.</p><button class="hail-button-secondary justify-self-start border-danger text-danger" onclick={revokeSessions} disabled={busy||!data.recentlyVerified}>Sign out everywhere</button></section>
  </aside>
</div>
<ConnectionCodes />
