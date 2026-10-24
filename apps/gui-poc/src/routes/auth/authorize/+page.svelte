<script lang="ts">
  import {onMount} from "svelte";
  import {startAuthentication} from "@simplewebauthn/browser";
  let requestId=$state(""),csrfState=$state(""),code=$state(""),busy=$state(false),message=$state(""),
    details=$state<{clientId:string;redirectUri:string;scopes:string[];expiresAt:string}|null>(null);
  async function json(response:Response){if(!response.ok)throw new Error("Authorization was refused or expired.");return response.json();}
  onMount(async()=>{
    const query=new URLSearchParams(location.search),fragment=new URLSearchParams(location.hash.slice(1));
    requestId=query.get("request")??"";csrfState=query.get("state")??"";code=fragment.get("code")??"";
    history.replaceState(null,"",location.pathname+location.search);
    if(!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(requestId)||!/^[A-Za-z0-9_-]{43}$/.test(csrfState)||!/^hailc_[A-Za-z0-9_-]{43}$/.test(code)){
      message="This authorization request is invalid or incomplete.";return;
    }
    try{details=await json(await fetch("/api/v1/auth/authorization/details",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({requestId,state:csrfState})}));}catch(error){message=error instanceof Error?error.message:"Authorization failed.";}
  });
  async function authorize(){
    busy=true;message="";
    try{
      const start=await json(await fetch("/api/v1/auth/passkeys/authentication/options",{method:"POST"}));
      const response=await startAuthentication({optionsJSON:start.options});
      await json(await fetch("/api/v1/auth/passkeys/authentication",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({challengeId:start.challengeId,response})}));
      const completed=await json(await fetch("/api/v1/auth/authorization/complete",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({requestId,state:csrfState,code})}));location.href=completed.redirectUri;
    }catch(error){message=error instanceof Error?error.message:"Authorization failed.";busy=false;}
  }
</script>

<svelte:head><title>Authorize hailp · Haili</title><meta name="robots" content="noindex, nofollow" /></svelte:head>
<section class="hail-card mx-auto mt-6 flex max-w-[620px] flex-col items-start gap-5 p-6 sm:p-10">
  <p class="hail-eyebrow">hailp authorization</p><h1 class="hail-title">Authorize this command line?</h1>
  {#if details}<p class="m-0 text-sm text-muted [overflow-wrap:anywhere]"><strong>hailp</strong> will receive temporary access through <code>{new URL(details.redirectUri).host}</code>. Approve only a command-line login you started.</p>
    <div class="w-full rounded-xl bg-brand-soft p-4"><h2 class="m-0 mb-2 text-sm">Requested permissions</h2><ul class="m-0 pl-5 text-sm text-brand-strong">{#each details.scopes as scope}<li class="[overflow-wrap:anywhere]">{scope}</li>{/each}</ul><p class="m-0 mt-3 text-xs text-muted">Request expires {new Date(details.expiresAt).toLocaleString()}.</p></div>
    <button class="hail-button max-w-full whitespace-normal" onclick={authorize} disabled={busy}>Verify with a passkey and authorize</button>
  {:else if !message}<p class="m-0 text-sm text-muted">Loading authorization request…</p>{/if}
  {#if message}<p class="hail-error" role="alert">{message}</p>{/if}
</section>
