<script lang="ts">
  import ListDate from "$lib/ListDate.svelte";
  import IdentityWarning from "$lib/IdentityWarning.svelte";
  import {identityMemory} from "$lib/identity-memory.js";
  import {identityAcknowledgmentKey,conflictingIdentities,type IdentityHistory} from "$lib/identity-history.js";
  import ContactAddress from "$lib/ContactAddress.svelte";
  import {afterNavigate,invalidateAll} from "$app/navigation";
  import {onMount,tick} from "svelte";
  import {startAuthentication} from "@simplewebauthn/browser";
  import {APPROVAL_STORAGE,approval,permissionRequest,recoverPermission,PermissionRequestError,senderRequest,subscriptionScopeLabel,type SenderReview,type Approval} from "$lib/permissions.js";
  import SelectionAvatar from "$lib/SelectionAvatar.svelte";
  import SelectionActions from "$lib/SelectionActions.svelte";
  let {data}=$props();
  let selectedSubscriptions=$state<string[]>([]);
  let confirmation=$state<HTMLElement>();
  let selectedPermissions=$derived(data.permissions.filter(permission=>permission.status==="active"&&selectedSubscriptions.includes(permission.grantId)));
  afterNavigate(({from,to})=>{if(from?.url.pathname!==to?.url.pathname||from?.url.search!==to?.url.search){selectedSubscriptions=[];}});
  function toggleSubscription(id:string){selectedSubscriptions=selectedSubscriptions.includes(id)?selectedSubscriptions.filter(value=>value!==id):[...selectedSubscriptions,id];}
  async function unsubscribeSelected(){
    if(!selectedPermissions.length)return;
    review=null;
    draft={requestId:crypto.randomUUID(),action:"revoke",grants:selectedPermissions.map(({grantId,revision,digest})=>({grantId,revision,digest}))};
    prepared=approval(await permissionRequest("prepare",draft));remember(prepared.requestId);
    await tick();confirmation?.scrollIntoView({block:"center"});
  }
  let sender=$state(""),pinnedDid=$state<string|undefined>(),review=$state<SenderReview|null>(null),prepared=$state<Approval|null>(null);
  let acknowledgedIdentity=$state("");
  let knownIdentities=$state<IdentityHistory>([]);
  let identityMounted=$state(false);
  onMount(()=>{identityMounted=true;});
  $effect(()=>{if(identityMounted)return identityMemory(data.account.did).subscribe(value=>knownIdentities=value);});
  let identityConflicts=$derived(prepared?.action==="allow"?conflictingIdentities(knownIdentities,prepared.permission.grantee,prepared.permission.consent_context.grantee_address,prepared.previousDids??[]):[]);
  let identityKey=$derived(prepared?identityAcknowledgmentKey(prepared.requestId,prepared.permission.grantee,prepared.permission.consent_context.grantee_address,identityConflicts):"");
  let identityReady=$derived(!identityConflicts.length||acknowledgedIdentity===identityKey);
  let selected=$state<string[]>([]),days=$state<number|null>(null),busy=$state(false),message=$state("");
  let pendingId=$state<string|null>(null),recoveryNeeded=$state(false);
  let now=$state(Date.now()),draft:Record<string,unknown>|null=null;
  let selectionLocked=$derived(busy||!!prepared||recoveryNeeded);
  const date=(value:number)=>new Date(value*1000).toLocaleString();
  onMount(()=>{
    const readRequest=()=>{
      if(prepared||busy||recoveryNeeded){message="Finish or cancel the current review before opening another sender request.";return;}
      try{const request=senderRequest(location.hash);if(request){sender=request.sender;pinnedDid=request.did;review=null;draft=null;}}
      catch(error){message=String(error instanceof Error?error.message:"Invalid sender link");}
    };
    readRequest();
    if(data.account.custodyProfile==="managed"){
      try{pendingId=sessionStorage.getItem(APPROVAL_STORAGE);}catch{/* Storage may be unavailable. */}
      if(pendingId)void run(recover);
    }
    window.addEventListener("hashchange",readRequest);
    const timer=setInterval(()=>{now=Date.now();},1000);
    return()=>{clearInterval(timer);window.removeEventListener("hashchange",readRequest);};
  });
  async function run(action:()=>Promise<void>){if(busy)return;busy=true;message="";try{await action();}
    catch(error){message=error instanceof Error?error.message:"Unable to update your subscriptions. Please try again.";}finally{busy=false;}}
  async function inspect(){
    prepared=null;draft=null;selected=[];
    review=await permissionRequest("review",{sender:sender.trim(),...(pinnedDid?{senderDid:pinnedDid}:{})});
    message="Sender address and signed profile checked. Review what this sender may send to you; this does not verify their real-world identity.";
  }
  async function prepareAllow(){
    if(!review||!selected.length)return;
    if(!draft)draft={requestId:crypto.randomUUID(),action:"allow",sender:review.address,senderDid:review.did,addressDigest:review.addressDigest,
      profileDigest:review.profileDigest,scope:{type:"categories",values:[...selected].sort()},expiresAt:days===null?null:Math.floor(Date.now()/1000)+Number(days)*86400};
    prepared=approval(await permissionRequest("prepare",draft));
    remember(prepared.requestId);
  }
  function remember(id:string|null){
    pendingId=id;
    try{if(id)sessionStorage.setItem(APPROVAL_STORAGE,id);else sessionStorage.removeItem(APPROVAL_STORAGE);}catch{/* Recovery still works in this page when storage is blocked. */}
  }
  async function complete(){
    const completed=prepared!;
    remember(null);prepared=null;draft=null;review=null;recoveryNeeded=false;
    if(completed.result&&"items" in completed.result){
      const succeeded=completed.result.items.filter(item=>item.result).map(item=>item.grantId);
      const failed=completed.result.items.filter(item=>!item.result);
      selectedSubscriptions=[...new Set([...selectedSubscriptions.filter(id=>!succeeded.includes(id)),...failed.map(item=>item.grantId)])];
      message=`Unsubscribed from ${succeeded.length} ${succeeded.length===1?"subscription":"subscriptions"}.`;
      if(failed.length)message+=` ${failed.length} ${failed.length===1?"subscription changed":"subscriptions changed"} since review. Review the remaining selection to try again.`;
    }else{
      if(completed.action==="revoke")selectedSubscriptions=selectedSubscriptions.filter(id=>id!==completed.permission.grant_id);
      message=completed.action==="revoke"?"Unsubscribed.":"Sender allowed.";
    }
    try{await invalidateAll();}catch{message+=" Refresh the page to update your subscription list.";}
  }
  async function recover(){
    const id=prepared?.requestId??pendingId;if(!id)return;
    recoveryNeeded=true;
    try{
      prepared=await recoverPermission(id,data.account.did);
      recoveryNeeded=false;
      if(prepared.result)await complete();
      else message="Review the details and confirm with your passkey to finish.";
    }catch(error){
      if(error instanceof PermissionRequestError&&(error.status===404||error.status===410)){
        remember(null);prepared=null;draft=null;review=null;recoveryNeeded=false;
        message="This review is no longer available. Check your subscriptions before starting again.";
        try{await invalidateAll();}catch{message+=" Refresh the page to update the list.";}
      }else message=prepared?.action&&prepared.action!=="allow"?"We couldn’t confirm whether you’ve been unsubscribed.":"We couldn’t confirm whether your subscription change was saved.";
    }
  }
  async function confirmPermission(){
    if(!prepared||prepared.permission.grantor!==data.account?.did||!identityReady)return;
    if(prepared.approved){await recover();return;}
    // Refresh conflict evidence immediately before asking for a passkey, including
    // approvals restored from a previous tab/session.
    const requestId=prepared.requestId;
    const current=approval(await permissionRequest(requestId));
    if(current.requestId!==requestId||current.permission.grantor!==data.account.did)throw new Error("Subscription account mismatch");
    prepared=current;
    if(current.approved){await recover();return;}
    if(!identityReady){message="Check and acknowledge this different identity before confirming.";return;}
    // Keep passkey cancellation separate from an uncertain server response.
    let response;
    try{response=await startAuthentication({optionsJSON:prepared.options!});}
    catch{message="Passkey confirmation wasn’t completed. You can try again or cancel.";return;}
    try{
      prepared=approval(await permissionRequest("commit",{requestId:prepared.requestId,response}));
      if(!prepared.result)throw new Error("Subscription change is still being saved");
    }catch{await recover();return;}
    await complete();
  }
  function cancel(){if(busy||recoveryNeeded||prepared?.approved)return;prepared=null;draft=null;review=null;remember(null);message="";}

</script>

<svelte:head><title>Subscriptions · Haili</title><meta name="robots" content="noindex, nofollow" /></svelte:head>
<div class:has-selection={selectedPermissions.length>0} class="[&_h2]:m-0 [&_h2]:text-xl [&_h3]:m-0 [&_p]:m-0 [&_code]:text-xs [&_code]:[overflow-wrap:anywhere] [&_button]:self-start [&_button]:max-w-full [&_button]:whitespace-normal">
  <header class="mb-8 grid gap-3"><p class="hail-eyebrow">Your inbox</p><h1 class="hail-title">Subscriptions</h1><p class="max-w-2xl text-sm text-muted">Choose which senders and categories reach your inbox. For two-way messaging, use Connections.</p><p class="text-xs text-muted [overflow-wrap:anywhere]">Managing permissions for <strong>{data.account.address}</strong></p></header>
  {#if message}<p class="mb-5! rounded-xl border border-solid border-line bg-brand-soft p-4 text-sm" role="status">{message}</p>{/if}
  {#if data.account.custodyProfile!=="managed"}<p class="mb-5! rounded-xl bg-warning-soft p-4 text-sm text-warning" role="status">Browser approval currently supports managed accounts only. Your owner-controlled account still uses its existing signer.</p>{/if}
  <div class="grid items-start gap-6 max-w-[860px]">
    <div class="grid min-w-0 gap-6">
      {#if data.account.custodyProfile==="managed"}
        {#if !prepared&&!recoveryNeeded}
          <section class="hail-card grid min-w-0 gap-4 p-5 sm:p-7"><h2>Allow a sender</h2><p class="text-sm text-muted">Enter a Hail address or scan a sender QR. You’ll review before approving.</p>
            <label class="hail-field">Potential sender's Hail address<input bind:value={sender} maxlength="254" autocomplete="off" placeholder="sender@business.example" oninput={()=>{pinnedDid=undefined;review=null;draft=null;}} /></label>
            {#if pinnedDid}<p class="text-xs text-muted">QR identity pin: <code>{pinnedDid}</code></p>{/if}
            <button class="hail-button justify-self-start" disabled={busy||!sender.trim()} onclick={()=>run(inspect)}>Review sender</button>
            {#if review}
              <div class="grid gap-2 border-0 border-t border-solid border-line pt-5"><h3>{review.displayName}</h3><p class="text-sm [overflow-wrap:anywhere]">{review.address}</p><code class="text-muted">{review.did}</code><p class="text-sm text-muted">Check the address and identity. A sender chooses their own profile name.</p></div>
              <IdentityWarning address={review.address} did={review.did} previousDids={conflictingIdentities(knownIdentities,review.did,review.address,review.previousDids??[])} />
              {#if review.categories.length}<fieldset class="m-0 grid min-w-0 gap-2 rounded-xl border border-solid border-line p-4"><legend class="px-1 text-sm font-semibold">Categories this sender may send you</legend>{#each review.categories as category}
                <label class="flex min-h-11 flex-wrap items-center gap-2 text-sm"><input type="checkbox" bind:group={selected} value={category.id} disabled={busy} />{category.label} <small class="text-muted">({category.id})</small></label>{#if category.description}<small class="text-muted">{category.description}</small>{/if}{/each}</fieldset>{/if}
              {#if review.offersUncategorized}<p class="text-sm text-muted">This publisher still offers legacy uncategorized delivery. New subscriptions use explicit categories; ask the publisher to enable General if you need it.</p>{/if}
              <label class="hail-field">Subscription duration<select bind:value={days}><option value={null}>Until I unsubscribe</option><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option><option value={365}>1 year</option></select></label>
              <button class="hail-button justify-self-start" disabled={busy||!selected.length} onclick={()=>run(prepareAllow)}>Review permission</button>
            {/if}
          </section>
        {:else if prepared}
          <section class="hail-card grid gap-4 border-2 border-brand p-5 sm:p-7" aria-label="Permission confirmation" bind:this={confirmation}><p class="hail-eyebrow">Confirm with your passkey</p><h2>{prepared.action==="allow"?"Confirm allowed sender":"Confirm unsubscribe"}</h2>
            {#if prepared.permissions}
              <p class="text-sm">Unsubscribe from {prepared.permissions.length} {prepared.permissions.length===1?"subscription":"subscriptions"}? One passkey confirmation applies to everything listed below. Your past messages are kept.</p>
              <ul class="m-0 grid max-h-[35dvh] gap-3 overflow-y-auto pl-5" aria-label="Subscriptions to unsubscribe">
                {#each prepared.permissions as permission (permission.grant_id)}
                  <li class="text-sm [overflow-wrap:anywhere]"><strong>{permission.consent_context.grantee_address}</strong><br />{subscriptionScopeLabel(permission.scope[0])}<details><summary class="cursor-pointer text-xs text-muted">Sender identity</summary><code>{permission.grantee}</code></details></li>
                {/each}
              </ul>
            {:else}
              <p class="text-sm [overflow-wrap:anywhere]"><strong>{prepared.permission.consent_context.grantee_address}</strong> {prepared.action==="allow"?"will be allowed to send to":"will lose this permission to send to"} <strong>{data.account.address}</strong>.</p>
              <p class="text-sm">Sender identity: <code>{prepared.permission.grantee}</code></p><p class="text-sm">Scope: {subscriptionScopeLabel(prepared.permission.scope[0])}</p><p class="text-sm">Permission expiry: {prepared.permission.expires_at===null?"Ongoing — until you unsubscribe":date(prepared.permission.expires_at)}</p>
            {/if}
            {#if identityConflicts.length}<IdentityWarning address={prepared.permission.consent_context.grantee_address} did={prepared.permission.grantee} previousDids={identityConflicts} /><label class="flex min-h-11 items-start gap-3 text-sm"><input type="checkbox" checked={acknowledgedIdentity===identityKey} onchange={event=>acknowledgedIdentity=event.currentTarget.checked?identityKey:""} />I checked this different identity through a trusted channel and want to allow it.</label>{/if}
            <p class="text-sm text-muted">Confirm only if these are the intended sender and permissions. Your provider signs the Grant; your passkey authorizes only this reviewed action. It is not an identity recovery key.</p><p class="text-xs text-muted">Approval expires {new Date(prepared.expiresAt).toLocaleString()}.</p>
            {#if !recoveryNeeded}
              <button class="hail-button justify-self-start" disabled={busy||!identityReady||now>=Date.parse(prepared.expiresAt)} onclick={()=>run(confirmPermission)}>{prepared.action==="allow"?"Allow sender with my passkey":prepared.permissions?"Unsubscribe with my passkey":"Confirm"}</button>
              {#if now>=Date.parse(prepared.expiresAt)}<p class="text-sm text-muted">This review expired. Cancel and start again.</p>{/if}
              {#if !prepared.approved}<button class="hail-button-secondary justify-self-start" disabled={busy} onclick={cancel}>Cancel</button>{/if}
            {/if}
          </section>
        {/if}
        {#if recoveryNeeded&&!busy}<button class="hail-button-secondary justify-self-start" onclick={()=>run(recover)}>Try again</button>{/if}
      {/if}
      <section class="grid min-w-0 gap-4" aria-label="Issued permissions"><h2>Your subscriptions</h2><p class="text-sm text-muted">A saved permission may take a moment to reach the sender. Unsubscribing keeps messages already delivered.</p>
        {#if !data.permissions.length}<p class="hail-card p-5 text-sm text-muted">No subscriptions on this page. Add a sender to choose the updates you receive.</p>{/if}
        {#if selectedPermissions.length}
          <SelectionActions label="Subscription actions" count={selectedPermissions.length} locked={selectionLocked} onclear={()=>selectedSubscriptions=[]}>
            {#snippet actions()}<button class="hail-button-secondary" disabled={selectionLocked} onclick={()=>run(unsubscribeSelected)}>Unsubscribe</button>{/snippet}
          </SelectionActions>
        {/if}
        <div class="compact-list">
        {#each data.permissions as permission (permission.grantId)}<article class="list-row contact-row" class:is-selected={selectedSubscriptions.includes(permission.grantId)&&permission.status==="active"}>
            <SelectionAvatar name={permission.sender} avatar={permission.avatar} selected={permission.status==="active"&&selectedSubscriptions.includes(permission.grantId)} disabled={selectionLocked} label={`Select subscription to ${permission.sender}: ${subscriptionScopeLabel(permission.scope)}`} ontoggle={data.account.custodyProfile==="managed"&&permission.status==="active"?()=>toggleSubscription(permission.grantId):undefined} />
            <div class="contact-copy"><h3><ContactAddress owner={data.account.did} did={permission.did} address={permission.sender} /></h3>
          <code class="contact-identity" title={permission.did}>{permission.did}</code><p>{subscriptionScopeLabel(permission.scope)} · {permission.status === "revoked" ? "Unsubscribed" : permission.status}{#if permission.expiresAt!==null}{" · expires "}<ListDate value={permission.expiresAt*1000} />{:else}{" · ongoing until you unsubscribe"}{/if}</p>
          {#if permission.expiresAt!==null&&permission.expiresAt*1000<=now}<p class="text-sm text-warning">Expired; it no longer permits messages.</p>{/if}
          </div>
        </article>{/each}
        </div>
        {#if data.next}<a class="hail-button-secondary justify-self-start" href={`/permissions?after=${encodeURIComponent(data.next)}`}>More subscriptions →</a>{/if}
      </section>
    </div>

  </div>
  {#if busy}<p class="mt-5! text-sm text-muted" role="status">Updating your subscriptions…</p>{/if}
</div>

<style>
  @media(max-width:900px) { .has-selection { padding-bottom:180px; } }
</style>
