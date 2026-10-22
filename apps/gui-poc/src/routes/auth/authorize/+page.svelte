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

<section class="card authorize"><p class="eyebrow">hailp authorization</p><h1>Connect this command line?</h1>
  {#if details}<p><strong>hailp</strong> will receive temporary access through <code>{new URL(details.redirectUri).host}</code>.</p>
    <ul>{#each details.scopes as scope}<li>{scope}</li>{/each}</ul>
    <button onclick={authorize} disabled={busy}>Verify with a passkey and authorize</button>
  {:else if !message}<p>Loading authorization request…</p>{/if}
  {#if message}<p class="status" aria-live="polite">{message}</p>{/if}
</section>

<style>
  .authorize{display:flex;max-width:620px;flex-direction:column;align-items:flex-start;gap:16px;padding:42px}.eyebrow{margin:0;color:#22714b;font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase}h1,p,ul{margin:0}.authorize>p:not(.eyebrow){color:#657168;line-height:1.6}ul{padding-left:22px;color:#43544a}code{font-size:.9em}button{padding:12px 18px;border:0;border-radius:10px;background:#17633f;color:white;font:inherit;font-weight:750;cursor:pointer}button:disabled{cursor:wait;opacity:.6}.status{font-size:14px}
</style>
