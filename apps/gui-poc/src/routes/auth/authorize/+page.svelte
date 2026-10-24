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

<section class="hail-card flex max-w-[620px] flex-col items-start gap-4 p-[42px]">
  <p class="m-0 text-[12px] font-extrabold tracking-[.12em] text-[#22714b] uppercase">hailp authorization</p><h1 class="m-0">Connect this command line?</h1>
  {#if details}<p class="m-0 leading-[1.6] text-[#657168]"><strong>hailp</strong> will receive temporary access through <code class="text-[.9em]">{new URL(details.redirectUri).host}</code>.</p>
    <ul class="m-0 pl-[22px] text-[#43544a]">{#each details.scopes as scope}<li>{scope}</li>{/each}</ul>
    <button class="cursor-pointer rounded-[10px] border-0 bg-[#17633f] px-[18px] py-3 [font:inherit] font-[750]! text-white disabled:cursor-wait disabled:opacity-60" onclick={authorize} disabled={busy}>Verify with a passkey and authorize</button>
  {:else if !message}<p class="m-0 leading-[1.6] text-[#657168]">Loading authorization request…</p>{/if}
  {#if message}<p class="m-0 text-[14px] leading-[1.6] text-[#657168]" aria-live="polite">{message}</p>{/if}
</section>
