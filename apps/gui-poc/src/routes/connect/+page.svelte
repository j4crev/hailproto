<script lang="ts">
  import {onMount} from "svelte";
  import {connectionCode,connectionHomeLink,connectionRequest,connectApproval,CONNECTION_CODE,CONNECTION_APPROVAL,type ConnectCode,type ConnectReview,type ConnectApproval} from "$lib/connections.js";
  import ConnectionApproval from "$lib/ConnectionApproval.svelte";
  let {data}=$props();
  let code=$state<ConnectCode|null>(null),review=$state<ConnectReview|null>(null),prepared=$state<ConnectApproval|null>(null),message=$state(""),busy=$state(false),connected=$state(false);
  let draft:Record<string,unknown>|null=null;
  let homeProvider=$state(""),ready=$state(false),pendingRequest=$state<string|null>(null);
  function useHomeProvider(){if(!code)return;try{location.href=connectionHomeLink(homeProvider.trim(),code);}catch(error){message=error instanceof Error?error.message:"Invalid provider.";}}
  onMount(()=>{
    ready=true;
    const readCode=()=>{
      const hash=location.hash;if(hash)history.replaceState(null,"","/connect");
      if(prepared||pendingRequest||busy){message="Finish the current connection review before opening another code.";return;}
      try{
        if(hash){const parsed=connectionCode(hash);sessionStorage.setItem(CONNECTION_CODE,JSON.stringify(parsed));code=parsed;connected=false;review=null;draft=null;message="";}
        else {const saved=sessionStorage.getItem(CONNECTION_CODE);if(saved){const parsed=JSON.parse(saved);code=connectionCode(new URLSearchParams(parsed).toString());}}
      }catch(error){code=null;review=null;sessionStorage.removeItem(CONNECTION_CODE);message=error instanceof Error?error.message:"Invalid code.";}
    };
    readCode();window.addEventListener("hashchange",readCode);
    const timer=setInterval(()=>{if(pendingRequest&&!busy)void run(check);},3000);
    return()=>{clearInterval(timer);window.removeEventListener("hashchange",readCode);};
  });
  async function run(action:()=>Promise<void>){busy=true;message="";try{await action();}catch(error){message=error instanceof Error?error.message:"Connection not confirmed.";}finally{busy=false;}}
  async function inspect(){if(code)review=await connectionRequest("review",code);}
  async function prepare(){if(!code||!review)return;if(!draft)draft={requestId:crypto.randomUUID(),action:"connect",...code};
    prepared=connectApproval(await connectionRequest("prepare",draft));sessionStorage.setItem(CONNECTION_APPROVAL,prepared.requestId);}
  async function done(result:NonNullable<ConnectApproval["result"]>){
    if(result.state==="connecting"){pendingRequest=prepared?.requestId??sessionStorage.getItem(CONNECTION_APPROVAL);prepared=null;message="Your approval is saved. Synchronizing with the other provider.";return;}
    pendingRequest=null;
    if(result.state==="expired"||result.state==="conflict"){prepared=null;draft=null;review=null;sessionStorage.removeItem(CONNECTION_APPROVAL);message="This attempt expired or its reviewed identity/connection state changed. Review a current code before trying again.";return;}
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
  {#if pendingRequest}<p class="hail-card p-5 text-sm" role="status">Connecting across providers. Your saved request is retried automatically, even if you close this tab. You can also check synchronization on <a href="/settings/security">Security</a>.</p>{/if}
  {#if connected}<section class="hail-card grid gap-4 p-5"><h2 class="m-0 text-xl">Connection saved</h2><p class="m-0 text-sm">You can see it on Security and choose it in Compose for personal messages. Subscriptions are unchanged.</p><a class="hail-button justify-self-start" href="/settings/security">View connections</a></section>
  {:else if !data.signedIn}<section class="hail-card grid gap-4 p-5"><p class="m-0 text-sm">Sign in to this provider to review this code. It grants no account access. Your code stays in this tab, not the login URL.</p><a class="hail-button justify-self-start" href="/auth/login?next=%2Fconnect">Sign in to review</a></section>
  {:else if prepared}<ConnectionApproval approval={prepared} oncomplete={done} oncancel={cancel} />
  {:else}
    <section class="hail-card grid gap-4 p-5"><p class="m-0 text-sm">Signed in as <strong>{data.address}</strong>.</p>
      {#if code}<button class="hail-button justify-self-start" disabled={busy} onclick={()=>run(inspect)}>Review connection code</button>
      {:else}<p class="m-0 text-sm">Scan a connection QR or open a shared connect link to begin.</p>{/if}
      {#if review}<h2 class="m-0 text-xl [overflow-wrap:anywhere]">{review.address}</h2><code class="text-xs [overflow-wrap:anywhere]">{review.did}</code><p class="m-0 text-sm">{review.expiresAt===null?"No automatic code expiry":`Code expires ${new Date(review.expiresAt*1000).toLocaleString()}`}. Check this identity with the person you intended.</p>
        {#if review.admissionSupported===false}<p class="m-0 text-sm">This provider verified the other provider's signed invitation and identity. Cross-provider connection activation is not enabled yet. You are not connected; no request or permission was created.</p>
        {:else}<p class="m-0 text-sm">Your confirmation connects both accounts for personal messages without another approval from them. Cross-provider verification may take time and is retried automatically. Owner-controlled accounts sign consent locally. Subscriptions are independent.</p><button class="hail-button justify-self-start" disabled={busy||pendingRequest!==null} onclick={()=>run(prepare)}>Review before connecting</button>{/if}
      {/if}
      <button class="hail-button-secondary justify-self-start" disabled={busy||!ready} onclick={()=>run(check)}>Continue interrupted review</button>
    </section>
  {/if}
  {#if code&&!connected}<form class="hail-card grid gap-4 p-5" onsubmit={event=>{event.preventDefault();useHomeProvider();}}><h2 class="m-0 text-xl">Use your own Hail provider</h2><p class="m-0 text-sm">If your account is elsewhere, open this code there to review and confirm it. Enter only a provider you trust: it will receive this connection code, not your account credentials. Both providers must support the connection handshake.</p><label class="hail-field">Your provider's HTTPS origin<input type="url" required bind:value={homeProvider} placeholder="https://your-provider.example" /></label><button class="hail-button-secondary justify-self-start" disabled={busy||pendingRequest!==null}>Open code on my provider</button></form>{/if}
</div>
