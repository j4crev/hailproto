<script lang="ts">
  import {onMount} from "svelte";
  import {connectionCode,connectionRequest,connectApproval,CONNECTION_CODE,CONNECTION_APPROVAL,type ConnectCode,type ConnectReview,type ConnectApproval} from "$lib/connections.js";
  import ConnectionApproval from "$lib/ConnectionApproval.svelte";
  let {data}=$props();
  let code=$state<ConnectCode|null>(null),review=$state<ConnectReview|null>(null),prepared=$state<ConnectApproval|null>(null),message=$state(""),busy=$state(false),connected=$state(false);
  let draft:Record<string,unknown>|null=null;
  onMount(()=>{
    try{
      if(location.hash){const parsed=connectionCode(location.hash);sessionStorage.setItem(CONNECTION_CODE,JSON.stringify(parsed));history.replaceState(null,"","/connect");code=parsed;}
      else {const saved=sessionStorage.getItem(CONNECTION_CODE);if(saved){const parsed=JSON.parse(saved);code=connectionCode(new URLSearchParams(parsed).toString());}}
    }catch(error){history.replaceState(null,"","/connect");sessionStorage.removeItem(CONNECTION_CODE);message=error instanceof Error?error.message:"Invalid code.";}
  });
  async function run(action:()=>Promise<void>){busy=true;message="";try{await action();}catch(error){message=error instanceof Error?error.message:"Connection not confirmed.";}finally{busy=false;}}
  async function inspect(){if(code)review=await connectionRequest("review",code);}
  async function prepare(){if(!code||!review)return;if(!draft)draft={requestId:crypto.randomUUID(),action:"connect",...code};
    prepared=connectApproval(await connectionRequest("prepare",draft));sessionStorage.setItem(CONNECTION_APPROVAL,prepared.requestId);}
  async function done(result:NonNullable<ConnectApproval["result"]>){
    const current=await connectionRequest();
    if(!current.connections.some((c:{id:string})=>c.id===result.connectionId)){message="This attempt was saved previously, but that connection is no longer active. It was not reopened.";prepared=null;return;}
    prepared=null;connected=true;draft=null;sessionStorage.removeItem(CONNECTION_CODE);sessionStorage.removeItem(CONNECTION_APPROVAL);
  }
  async function check(){const id=sessionStorage.getItem(CONNECTION_APPROVAL);if(!id){message="No interrupted review in this tab.";return;}
    const saved=connectApproval(await connectionRequest(id));if(saved.action!=="connect")throw new Error("Continue this code-management review on Security.");
    prepared=saved;if(prepared.result)await done(prepared.result);}
  function cancel(){prepared=null;draft=null;sessionStorage.removeItem(CONNECTION_APPROVAL);}
</script>
<svelte:head><title>Connect · Haili</title><meta name="robots" content="noindex, nofollow" /></svelte:head>
<div class="mx-auto grid max-w-2xl gap-5">
  <header class="grid gap-3"><p class="hail-eyebrow">Personal connections</p><h1 class="hail-title">Connect with someone</h1><p class="m-0 text-sm text-muted">Review the identity before confirming. A connection is separate from a subscription.</p></header>
  {#if message}<p class="hail-error" role="alert">{message}</p>{/if}
  {#if connected}<section class="hail-card grid gap-4 p-5"><h2 class="m-0 text-xl">Connection saved</h2><p class="m-0 text-sm">You can see it on Security. Direct connection messaging is not enabled in this preview.</p><a class="hail-button justify-self-start" href="/settings/security">View connections</a></section>
  {:else if !data.signedIn}<section class="hail-card grid gap-4 p-5"><p class="m-0 text-sm">Sign in to this provider to review this code. It grants no account access. Your code stays in this tab, not the login URL.</p><a class="hail-button justify-self-start" href="/auth/login?next=%2Fconnect">Sign in to review</a></section>
  {:else if prepared}<ConnectionApproval approval={prepared} oncomplete={done} oncancel={cancel} />
  {:else}
    <section class="hail-card grid gap-4 p-5"><p class="m-0 text-sm">Signed in as <strong>{data.address}</strong>.</p>
      {#if code}<button class="hail-button justify-self-start" disabled={busy} onclick={()=>run(inspect)}>Review connection code</button>
      {:else}<p class="m-0 text-sm">Scan a connection QR or open a shared connect link to begin.</p>{/if}
      {#if review}<h2 class="m-0 text-xl [overflow-wrap:anywhere]">{review.address}</h2><code class="text-xs [overflow-wrap:anywhere]">{review.did}</code><p class="m-0 text-sm">{review.expiresAt===null?"No automatic code expiry":`Code expires ${new Date(review.expiresAt*1000).toLocaleString()}`}. Check this identity with the person you intended.</p><p class="m-0 text-sm">Your confirmation connects both accounts immediately without another approval from them. Managed accounts on this provider only; no direct messaging yet.</p><button class="hail-button justify-self-start" disabled={busy} onclick={()=>run(prepare)}>Review before connecting</button>{/if}
      <button class="hail-button-secondary justify-self-start" disabled={busy} onclick={()=>run(check)}>Continue interrupted review</button>
    </section>
  {/if}
</div>
