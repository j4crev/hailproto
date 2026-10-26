<script lang="ts">
  import {onMount} from "svelte";
  import {startAuthentication} from "@simplewebauthn/browser";
  import {APPROVAL_STORAGE,approval,permissionRequest,senderRequest,subscriptionScopeLabel,type SenderReview,type Approval} from "$lib/permissions.js";
  let {data}=$props();
  let sender=$state(""),pinnedDid=$state<string|undefined>(),review=$state<SenderReview|null>(null),prepared=$state<Approval|null>(null);
  let selected=$state<string[]>([]),days=$state(30),busy=$state(false),message=$state("");
  let now=$state(Date.now()),draft:Record<string,unknown>|null=null;
  const date=(value:number)=>new Date(value*1000).toLocaleString();
  onMount(()=>{
    const readRequest=()=>{
      if(prepared||busy){message="Finish or cancel the current review before opening another sender request.";return;}
      try{const request=senderRequest(location.hash);if(request){sender=request.sender;pinnedDid=request.did;review=null;draft=null;}}
      catch(error){message=String(error instanceof Error?error.message:"Invalid sender link");}
    };
    readRequest();window.addEventListener("hashchange",readRequest);
    const timer=setInterval(()=>{now=Date.now();},1000);
    return()=>{clearInterval(timer);window.removeEventListener("hashchange",readRequest);};
  });
  async function run(action:()=>Promise<void>){if(busy)return;busy=true;message="";try{await action();}
    catch(error){message=error instanceof Error?error.message:"Permission request failed. Keep the original approval and retry.";}finally{busy=false;}}
  async function inspect(){
    prepared=null;draft=null;selected=[];
    review=await permissionRequest("review",{sender:sender.trim(),...(pinnedDid?{senderDid:pinnedDid}:{})});
    message="Sender address and signed profile checked. Review what this sender may send to you; this does not verify their real-world identity.";
  }
  async function prepareAllow(){
    if(!review||!selected.length)return;
    if(!draft)draft={requestId:crypto.randomUUID(),action:"allow",sender:review.address,senderDid:review.did,addressDigest:review.addressDigest,
      profileDigest:review.profileDigest,scope:{type:"categories",values:[...selected].sort()},expiresAt:Math.floor(Date.now()/1000)+Number(days)*86400};
    prepared=approval(await permissionRequest("prepare",draft));
    sessionStorage.setItem(APPROVAL_STORAGE,prepared.requestId);
  }
  async function prepareRevoke(permission:{grantId:string;revision:number;digest:string}){
    review=null;draft={requestId:crypto.randomUUID(),action:"revoke",grantId:permission.grantId,revision:permission.revision,digest:permission.digest};
    prepared=approval(await permissionRequest("prepare",draft));sessionStorage.setItem(APPROVAL_STORAGE,prepared.requestId);
  }
  async function check(){
    const id=prepared?.requestId??sessionStorage.getItem(APPROVAL_STORAGE);if(!id){message="No unfinished approval is saved in this tab.";return;}
    prepared=approval(await permissionRequest(id));
    if(prepared.result){sessionStorage.removeItem(APPROVAL_STORAGE);location.href="/permissions";}
    else message=prepared.approved?"Passkey approval was accepted. Retry saving this exact permission; no new authority is needed.":"This exact permission still needs your passkey confirmation.";
  }
  async function confirmPermission(){
    if(!prepared||prepared.permission.grantor!==data.account?.did)return;
    const response=prepared.approved?undefined:await startAuthentication({optionsJSON:prepared.options!});
    prepared=approval(await permissionRequest("commit",{requestId:prepared.requestId,...(response?{response}:{})}));
    if(!prepared.result)throw new Error("Permission not yet confirmed; check its status");
    sessionStorage.removeItem(APPROVAL_STORAGE);location.href="/permissions";
  }
  function cancel(){if(prepared?.approved)return;prepared=null;draft=null;review=null;sessionStorage.removeItem(APPROVAL_STORAGE);}
</script>

<svelte:head><title>Subscriptions · Haili</title><meta name="robots" content="noindex, nofollow" /></svelte:head>
<div class="[&_h2]:m-0 [&_h2]:text-xl [&_h3]:m-0 [&_p]:m-0 [&_code]:text-xs [&_code]:[overflow-wrap:anywhere] [&_button]:self-start [&_button]:max-w-full [&_button]:whitespace-normal">
  <header class="mb-8 grid gap-3"><p class="hail-eyebrow">Your inbox</p><h1 class="hail-title">Subscriptions</h1><p class="max-w-2xl text-sm text-muted">Choose which senders and categories reach your inbox. For two-way messaging, use Connections.</p><p class="text-xs text-muted [overflow-wrap:anywhere]">Managing permissions for <strong>{data.account.address}</strong></p></header>
  {#if message}<p class="mb-5! rounded-xl border border-solid border-line bg-brand-soft p-4 text-sm" role="status">{message}</p>{/if}
  {#if data.account.custodyProfile!=="managed"}<p class="mb-5! rounded-xl bg-warning-soft p-4 text-sm text-warning" role="status">Browser approval currently supports managed accounts only. Your owner-controlled account still uses its existing signer.</p>{/if}
  <div class="grid items-start gap-6 max-w-[860px]">
    <div class="grid min-w-0 gap-6">
      {#if data.account.custodyProfile==="managed"}
        {#if !prepared}
          <section class="hail-card grid min-w-0 gap-4 p-5 sm:p-7"><h2>Allow a sender</h2><p class="text-sm text-muted">Enter a Hail address or scan a sender QR. You’ll review before approving.</p>
            <label class="hail-field">Potential sender's Hail address<input bind:value={sender} maxlength="254" autocomplete="off" placeholder="sender@business.example" oninput={()=>{pinnedDid=undefined;review=null;draft=null;}} /></label>
            {#if pinnedDid}<p class="text-xs text-muted">QR identity pin: <code>{pinnedDid}</code></p>{/if}
            <button class="hail-button justify-self-start" disabled={busy||!sender.trim()} onclick={()=>run(inspect)}>Review sender</button>
            {#if review}
              <div class="grid gap-2 border-0 border-t border-solid border-line pt-5"><h3>{review.displayName}</h3><p class="text-sm [overflow-wrap:anywhere]">{review.address}</p><code class="text-muted">{review.did}</code><p class="text-sm text-muted">Check the address and identity. A sender chooses their own profile name.</p></div>
              {#if review.categories.length}<fieldset class="m-0 grid min-w-0 gap-2 rounded-xl border border-solid border-line p-4"><legend class="px-1 text-sm font-semibold">Categories this sender may send you</legend>{#each review.categories as category}
                <label class="flex min-h-11 flex-wrap items-center gap-2 text-sm"><input type="checkbox" bind:group={selected} value={category.id} disabled={busy} />{category.label} <small class="text-muted">({category.id})</small></label>{#if category.description}<small class="text-muted">{category.description}</small>{/if}{/each}</fieldset>{/if}
              {#if review.offersUncategorized}<p class="text-sm text-muted">This publisher still offers legacy uncategorized delivery. New subscriptions use explicit categories; ask the publisher to enable General if you need it.</p>{/if}
              <label class="hail-field">Permission expires in<select bind:value={days}><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option><option value={365}>1 year</option></select></label>
              <button class="hail-button justify-self-start" disabled={busy||!selected.length} onclick={()=>run(prepareAllow)}>Review permission</button>
            {/if}
          </section>
        {:else}
          <section class="hail-card grid gap-4 border-2 border-brand p-5 sm:p-7" aria-label="Permission confirmation"><p class="hail-eyebrow">Confirm with your passkey</p><h2>{prepared.action==="allow"?"Confirm allowed sender":"Confirm unsubscribe"}</h2>
            <p class="text-sm [overflow-wrap:anywhere]"><strong>{prepared.permission.consent_context.grantee_address}</strong> {prepared.action==="allow"?"will be allowed to send to":"will lose this permission to send to"} <strong>{data.account.address}</strong>.</p>
            <p class="text-sm">Sender identity: <code>{prepared.permission.grantee}</code></p><p class="text-sm">Scope: {subscriptionScopeLabel(prepared.permission.scope[0])}</p><p class="text-sm">Permission expiry: {prepared.permission.expires_at===null?"No expiry":date(prepared.permission.expires_at)}</p>
            <p class="text-sm text-muted">Confirm only if these are the intended sender and permissions. Your provider signs the Grant; your passkey authorizes only this reviewed action. It is not an identity recovery key.</p><p class="text-xs text-muted">Approval expires {new Date(prepared.expiresAt).toLocaleString()}.</p>
            <button class="hail-button justify-self-start" disabled={busy||now>=Date.parse(prepared.expiresAt)} onclick={()=>run(confirmPermission)}>{prepared.approved?"Retry saving approved permission":prepared.action==="allow"?"Allow sender with my passkey":"Unsubscribe with my passkey"}</button>
            <button class="hail-button-secondary justify-self-start" disabled={busy} onclick={()=>run(check)}>Check original approval status</button>{#if !prepared.approved}<button class="hail-button-secondary justify-self-start" disabled={busy} onclick={cancel}>Cancel review</button>{/if}
          </section>
        {/if}
        <button class="hail-button-secondary justify-self-start text-xs" disabled={busy} onclick={()=>run(check)}>Resume unfinished approval</button>
      {/if}
      <section class="grid min-w-0 gap-4" aria-label="Issued permissions"><h2>Your subscriptions</h2><p class="text-sm text-muted">A saved permission may take a moment to reach the sender. Unsubscribing keeps messages already delivered.</p>
        {#if !data.permissions.length}<p class="hail-card p-5 text-sm text-muted">No subscriptions on this page. Add a sender to choose the updates you receive.</p>{/if}
        {#each data.permissions as permission}<article class="hail-card grid min-w-0 gap-3 p-5"><h3 class="text-base [overflow-wrap:anywhere]">{permission.sender}</h3><code class="text-muted">{permission.did}</code><p class="text-sm [overflow-wrap:anywhere]">{subscriptionScopeLabel(permission.scope)} · {permission.status === "revoked" ? "Unsubscribed" : permission.status}{permission.expiresAt!==null?` · expires ${date(permission.expiresAt)}`:" · no expiry"}</p>
          {#if permission.expiresAt!==null&&permission.expiresAt*1000<=now}<p class="text-sm text-warning">Expired; it no longer permits messages.</p>{/if}
          {#if data.account.custodyProfile==="managed"&&permission.status==="active"}<button class="hail-button-secondary justify-self-start" disabled={busy||!!prepared} onclick={()=>run(()=>prepareRevoke(permission))}>Unsubscribe</button>{/if}
        </article>{/each}
        {#if data.next}<a class="hail-button-secondary justify-self-start" href={`/permissions?after=${encodeURIComponent(data.next)}`}>More subscriptions →</a>{/if}
      </section>
    </div>

  </div>
  {#if busy}<p class="mt-5! text-sm text-muted" role="status">Working… keep the original approval open if the response is delayed.</p>{/if}
</div>
