<script lang="ts">
  import {onMount} from "svelte";
  import {senderQr} from "$lib/permissions.js";
  import {connectionRequest,connectApproval,ConnectionRequestError,CONNECTION_APPROVAL,type ConnectionList,type ConnectApproval} from "$lib/connections.js";
  import ConnectionApproval from "$lib/ConnectionApproval.svelte";
  let list=$state<ConnectionList|null>(null),prepared=$state<ConnectApproval|null>(null),busy=$state(false),message=$state(""),label=$state(""),expiry=$state("");
  let shown=$state<string|null>(null),draft=$state<Record<string,unknown>|null>(null);
  const qr=$derived(shown?senderQr(shown):null);
  const personal=$derived(list?.codes.find(code=>code.personal));
  async function load(){list=await connectionRequest();}
  onMount(()=>{void load().catch(error=>{if(!(error instanceof ConnectionRequestError&&[403,404].includes(error.status)))message="Connection codes could not be loaded. Retry without creating a new code.";});});
  async function run(action:()=>Promise<void>){if(busy)return;busy=true;message="";try{await action();}catch(error){message=error instanceof Error?error.message:"Connection request failed.";}finally{busy=false;}}
  async function prepare(input:Record<string,unknown>){
    if(!draft)draft={requestId:crypto.randomUUID(),...input};
    prepared=connectApproval(await connectionRequest("prepare",draft));sessionStorage.setItem(CONNECTION_APPROVAL,prepared.requestId);
  }
  async function check(){const id=sessionStorage.getItem(CONNECTION_APPROVAL);if(!id){message="No interrupted review in this tab.";return;}
    prepared=connectApproval(await connectionRequest(id));if(prepared.result)await done();}
  async function done(){prepared=null;draft=null;shown=null;await load();message="Saved. Existing subscriptions are unchanged.";}
  function cancel(){prepared=null;draft=null;sessionStorage.removeItem(CONNECTION_APPROVAL);}
</script>
{#if list}
  <section class="mt-8 grid gap-5" aria-label="Connection codes">
    <header class="grid gap-2"><p class="hail-eyebrow">Personal connections · preview</p><h2 class="m-0 text-2xl">Connect with me</h2><p class="m-0 text-sm text-muted">Managed accounts on this provider only. No invitations inbox, no subscriptions, and no direct connection messaging yet. Transfer is unavailable while retained preview consent needs portability support.</p></header>
    {#if message}<p class="hail-error" role="status">{message}</p>{/if}
    {#if prepared}<ConnectionApproval approval={prepared} oncomplete={done} oncancel={cancel} />
    {:else}
      <section class="hail-card grid gap-4 p-5"><h3 class="m-0 text-xl">Your personal code</h3><p class="m-0 text-sm text-muted">No automatic expiry. Replace it if shared unintentionally. Anyone signed in here who holds it can connect without another approval.</p>
        {#if personal}<div class="flex flex-wrap gap-2"><button class="hail-button" onclick={()=>shown=personal.link}>Show my QR &amp; link</button><button class="hail-button-secondary" disabled={busy} onclick={()=>run(()=>prepare({action:"replace",id:personal.id}))}>Replace personal code</button><button class="hail-button-secondary" disabled={busy} onclick={()=>run(()=>prepare({action:"revoke",id:personal.id}))}>Revoke</button></div>
        {:else}<button class="hail-button justify-self-start" disabled={busy} onclick={()=>run(()=>prepare({action:"create",personal:true,label:"Personal code",expiresAt:null}))}>Create my personal code</button>{/if}
      </section>
      <form class="hail-card grid gap-4 p-5" onsubmit={event=>{event.preventDefault();void run(()=>prepare({action:"create",personal:false,label:label.trim(),expiresAt:Math.floor(new Date(expiry).getTime()/1000)}));}}>
        <h3 class="m-0 text-xl">Create an expiring connect link</h3><p class="m-0 text-sm text-muted">Separate from your personal code. Expiry stops new connections; established connections remain.</p>
        <label class="hail-field">Private label<input bind:value={label} maxlength="80" required placeholder="Conference, website, or friend" disabled={busy||draft!==null} /></label>
        <label class="hail-field">Expires (your local time)<input type="datetime-local" bind:value={expiry} required disabled={busy||draft!==null} /></label>
        <p class="m-0 text-sm">Public sharing lets any authenticated holder connect. You will not approve each person again.</p>
        <button class="hail-button justify-self-start" disabled={busy}>Review new link</button>
      </form>
      {#each list.codes.filter(code=>!code.personal) as code}<article class="hail-card grid gap-3 p-5"><strong>{code.label}</strong><p class="m-0 text-sm text-muted">Expires {new Date(code.expiresAt!*1000).toLocaleString()}</p><div class="flex flex-wrap gap-2"><button class="hail-button-secondary" onclick={()=>shown=code.link}>Show QR &amp; link</button><button class="hail-button-secondary" disabled={busy} onclick={()=>run(()=>prepare({action:"revoke",id:code.id}))}>Revoke</button></div></article>{/each}
      <button class="hail-button-secondary justify-self-start" disabled={busy} onclick={()=>run(check)}>Continue interrupted review</button>
      {#if draft&&!prepared}<button class="hail-button-secondary justify-self-start" onclick={cancel}>Discard unsaved review</button>{/if}
    {/if}
    {#if shown&&qr}<section class="hail-card grid min-w-0 gap-4 p-5" aria-label="Share connection code"><h3 class="m-0 text-xl">Scan to connect</h3><svg class="w-full max-w-72 bg-white" viewBox={`0 0 ${qr.size} ${qr.size}`} role="img" aria-label="Connection QR code"><path d={qr.path} fill="black" /></svg><label class="hail-field">Connection link<input readonly value={shown} onclick={event=>event.currentTarget.select()} /></label><button class="hail-button-secondary justify-self-start" onclick={()=>run(async()=>{await navigator.clipboard.writeText(shown!);message="Link copied.";})}>Copy link</button><button class="hail-button-secondary justify-self-start" onclick={()=>shown=null}>Hide code</button></section>{/if}
    <section class="grid gap-4" aria-label="Your connections"><h3 class="m-0 text-xl">Your connections</h3>{#if !list.connections.length}<p class="m-0 text-sm text-muted">No connections yet. Share a code or scan someone else's.</p>{/if}
      {#each list.connections as connection}<article class="hail-card grid min-w-0 gap-3 p-5"><strong class="[overflow-wrap:anywhere]">{connection.address}</strong><code class="text-xs [overflow-wrap:anywhere]">{connection.did}</code><button class="hail-button-secondary justify-self-start" disabled={busy||prepared!==null} onclick={()=>run(()=>prepare({action:"disconnect",connectionId:connection.id}))}>Disconnect</button></article>{/each}
    </section>
  </section>
{:else if message}<section class="mt-8 grid gap-4" aria-label="Connection codes unavailable"><p class="hail-error" role="status">{message}</p><button class="hail-button-secondary justify-self-start" disabled={busy} onclick={()=>run(load)}>Retry loading connection codes</button></section>{/if}
