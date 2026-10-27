<script lang="ts">
  import {onMount} from "svelte";
  import {senderQr} from "$lib/permissions.js";
  import {connectionRequest,connectApproval,recoverConnection,ConnectionRequestError,CONNECTION_APPROVAL,type ConnectionList,type ConnectApproval} from "$lib/connections.js";
  import ConnectionApproval from "$lib/ConnectionApproval.svelte";
  let list=$state<ConnectionList|null>(null),prepared=$state<ConnectApproval|null>(null),busy=$state(false),message=$state(""),label=$state(""),expiry=$state("");
  let pendingId=$state<string|null>(null),recoveryNeeded=$state(false);
  let shown=$state<string|null>(null),draft=$state<Record<string,unknown>|null>(null);
  const qr=$derived(shown?senderQr(shown):null);
  const personal=$derived(list?.codes.find(code=>code.personal));
  async function load(){list=await connectionRequest();}
  onMount(()=>{
    try{pendingId=sessionStorage.getItem(CONNECTION_APPROVAL);}catch{/* Storage may be unavailable. */}
    void run(initialize);
    const timer=setInterval(()=>{if(!busy&&!prepared&&!recoveryNeeded&&list?.pendingConnections?.some(p=>!["expired","conflict"].includes(p.state)))void load().catch(()=>{message="Synchronization status is unavailable. Your saved request will keep retrying.";});},3000);
    return()=>clearInterval(timer);
  });
  async function run(action:()=>Promise<void>){if(busy)return;busy=true;message="";try{await action();}catch(error){message=error instanceof Error?error.message:"Connection request failed.";}finally{busy=false;}}
  async function prepare(input:Record<string,unknown>){
    if(!draft)draft={requestId:crypto.randomUUID(),...input};
    prepared=connectApproval(await connectionRequest("prepare",draft));remember(prepared.requestId);
  }
  function remember(id:string|null){pendingId=id;try{if(id)sessionStorage.setItem(CONNECTION_APPROVAL,id);else sessionStorage.removeItem(CONNECTION_APPROVAL);}catch{/* Keep in-page recovery available. */}}
  async function initialize(){
    await load();
    if(pendingId)await check();
  }
  async function check(){
    if(!pendingId)return;
    recoveryNeeded=true;
    try{
      prepared=await recoverConnection(pendingId);recoveryNeeded=false;
      if(prepared.result)await done(prepared.result);
      else message="Review the details and confirm to finish.";
    }catch(error){
      if(error instanceof ConnectionRequestError&&[404,410].includes(error.status))cancel("This review is no longer available. Check your connections before starting again.");
      else {recoveryNeeded=true;message="We couldn’t restore your pending connection change. Please try again.";}
    }
  }
  async function done(result?:NonNullable<ConnectApproval["result"]>){
    // Keep the saved review until the refreshed list is available, so failure is retryable.
    await load();
    if(result?.state!=="connecting")remember(null);
    prepared=null;draft=null;shown=null;recoveryNeeded=false;
    message=result?.state==="connecting"?"Connection saved. Synchronizing with the other provider.":result?.state==="expired"||result?.state==="conflict"?"The connection attempt expired or its reviewed state changed. Review a current code before trying again.":"Saved. Existing subscriptions are unchanged.";
  }
  function cancel(reason=""){prepared=null;draft=null;remember(null);recoveryNeeded=false;message=reason;}

</script>
{#snippet shareCode(link:string,id:string)}
  {#if qr}<div id={`connection-code-${id}`} class="grid min-w-0 gap-4" aria-label="Share connection code"><svg class="w-full max-w-72 bg-white" viewBox={`0 0 ${qr.size} ${qr.size}`} role="img" aria-label="Connection QR code"><path d={qr.path} fill="black" /></svg><label class="hail-field">Connection link<input readonly value={link} onclick={event=>event.currentTarget.select()} /></label><button class="hail-button-secondary justify-self-start" onclick={()=>run(async()=>{await navigator.clipboard.writeText(link);message="Link copied.";})}>Copy link</button></div>{/if}
{/snippet}
{#if list}
  <section class="mt-8 grid gap-5" aria-label="Connection codes">
    <header class="grid gap-2"><p class="hail-eyebrow">Personal connections</p><h2 class="m-0 text-2xl">Connect with me</h2></header>
    {#if message}<p class="hail-error" role="status">{message}</p>{/if}
    {#if recoveryNeeded}
      {#if busy}<p class="text-sm text-muted" role="status">Checking your connection change…</p>
      {:else}<button class="hail-button-secondary justify-self-start" onclick={()=>run(check)}>Try again</button>{/if}
    {:else if prepared}<ConnectionApproval approval={prepared} oncomplete={done} oncancel={cancel} />
    {:else}
      <section class="hail-card grid min-w-0 gap-4 p-5" aria-label="Your personal code"><h3 class="m-0 text-xl">Share your personal code</h3><p class="m-0 text-sm text-muted">No automatic expiry. Replace if shared unintentionally. Allows immediate connection to you for anyone who scans or uses it.</p>
        {#if personal}<div class="flex flex-wrap gap-2"><button class="hail-button" aria-expanded={shown===personal.link} aria-controls={`connection-code-${personal.id}`} onclick={()=>shown=shown===personal.link?null:personal.link}>{shown===personal.link?"Hide QR & link":"Show QR & link"}</button><button class="hail-button-secondary" disabled={busy} onclick={()=>run(()=>prepare({action:"replace",id:personal.id}))}>Replace</button><button class="hail-button-secondary" disabled={busy} onclick={()=>run(()=>prepare({action:"revoke",id:personal.id}))}>Revoke</button></div>
          {#if shown===personal.link}{@render shareCode(personal.link,personal.id)}{/if}
        {:else}<button class="hail-button justify-self-start" disabled={busy} onclick={()=>run(()=>prepare({action:"create",personal:true,label:"Personal code",expiresAt:null}))}>Create my personal code</button>{/if}
      </section>
      <form class="hail-card grid gap-4 p-5" onsubmit={event=>{event.preventDefault();void run(()=>prepare({action:"create",personal:false,label:label.trim(),expiresAt:Math.floor(new Date(expiry).getTime()/1000)}));}}>
        <h3 class="m-0 text-xl">Create an expiring connect link</h3><p class="m-0 text-sm text-muted">Separate from your personal code. Expiry stops new connections; established connections remain.</p>
        <label class="hail-field">Private label<input bind:value={label} maxlength="80" required placeholder="Conference, website, or friend" disabled={busy||draft!==null} /></label>
        <label class="hail-field">Expires (your local time)<input type="datetime-local" bind:value={expiry} required disabled={busy||draft!==null} /></label>
        <p class="m-0 text-sm">Public sharing lets any authenticated holder connect with you.</p>
        <button class="hail-button justify-self-start" disabled={busy}>Review</button>
      </form>
      {#each list.codes.filter(code=>!code.personal) as code}<article class="hail-card grid min-w-0 gap-3 p-5"><strong>{code.label}</strong><p class="m-0 text-sm text-muted">Expires {new Date(code.expiresAt!*1000).toLocaleString()}</p><div class="flex flex-wrap gap-2"><button class="hail-button-secondary" aria-expanded={shown===code.link} aria-controls={`connection-code-${code.id}`} onclick={()=>shown=shown===code.link?null:code.link}>{shown===code.link?"Hide QR & link":"Show QR & link"}</button><button class="hail-button-secondary" disabled={busy} onclick={()=>run(()=>prepare({action:"revoke",id:code.id}))}>Revoke</button></div>{#if shown===code.link}{@render shareCode(code.link,code.id)}{/if}</article>{/each}
      {#if draft&&!prepared}<button class="hail-button-secondary justify-self-start" onclick={()=>cancel()}>Discard unsaved review</button>{/if}
    {/if}
    <section class="grid gap-4" aria-label="Your connections"><h3 class="m-0 text-xl">Your connections</h3>{#if !list.connections.length}<p class="m-0 text-sm text-muted">No connections yet. Share a code or scan someone else's.</p>{/if}
      {#each list.connections as connection}<article class="hail-card grid min-w-0 gap-3 p-5"><strong class="[overflow-wrap:anywhere]">{connection.address}</strong><code class="text-xs [overflow-wrap:anywhere]">{connection.did}</code><div class="flex flex-wrap gap-2"><a class="hail-button-secondary" href={`/compose?audience=connections&connection=${connection.id}`}>Message</a><button class="hail-button-secondary" disabled={busy||prepared!==null||recoveryNeeded} onclick={()=>run(()=>prepare({action:"disconnect",connectionId:connection.id}))}>Disconnect</button></div></article>{/each}
    </section>
    {#if list.pendingConnections?.length}<section class="grid gap-3" aria-label="Connection synchronization"><h3 class="m-0 text-xl">Synchronizing with other providers</h3>{#each list.pendingConnections as pending}<article class="hail-card grid min-w-0 gap-2 p-5"><strong class="[overflow-wrap:anywhere]">{pending.address}</strong><p class="m-0 text-sm text-muted">{pending.state==="expired"?"This connection attempt expired. Open a current code to review and try again.":pending.state==="conflict"?"This attempt could not be confirmed because the reviewed identity or relationship changed. Review a current code before trying again.":pending.kind==="disconnect"?"Disconnected here. Notifying the other provider; automatic retries continue if it is offline.":pending.state==="active"?"Connected here. Updating the other provider's view; automatic retries continue if it is offline.":"Your connection approval is saved. Awaiting verified confirmation from both providers; no additional acceptance is needed."}</p></article>{/each}</section>{/if}
  </section>
{:else if message}<section class="mt-8 grid gap-4" aria-label="Connection codes unavailable"><p class="hail-error" role="status">{message}</p><button class="hail-button-secondary justify-self-start" disabled={busy} onclick={()=>run(initialize)}>Retry loading connection codes</button></section>{:else}<p class="text-sm text-muted" role="status">Loading connections…</p>{/if}
