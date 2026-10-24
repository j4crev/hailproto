<script lang="ts">
  import {onMount} from "svelte";
  import {startAuthentication} from "@simplewebauthn/browser";
  import {APPROVAL_STORAGE,approval,permissionRequest,senderLink,senderRequest,senderQr,type SenderReview,type Approval} from "$lib/permissions.js";
  let {data}=$props();
  let sender=$state(""),pinnedDid=$state<string|undefined>(),review=$state<SenderReview|null>(null),prepared=$state<Approval|null>(null);
  let selected=$state<string[]>([]),uncategorized=$state(false),days=$state(30),busy=$state(false),message=$state(""),showQr=$state(false);
  let now=$state(Date.now()),draft:Record<string,unknown>|null=null;
  const date=(value:number)=>new Date(value*1000).toLocaleString();
  const share=$derived(data.configured?senderLink(data.origin,data.account.address,data.account.did):"");
  const qr=$derived(showQr&&share?senderQr(share):null);
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
  async function signIn(){
    const options=await fetch("/api/v1/auth/passkeys/authentication/options",{method:"POST",redirect:"error"});
    if(!options.ok)throw new Error("Sign-in could not start");const start=await options.json();
    const response=await startAuthentication({optionsJSON:start.options});
    const result=await fetch("/api/v1/auth/passkeys/authentication",{method:"POST",headers:{"Content-Type":"application/json"},redirect:"error",
      body:JSON.stringify({challengeId:start.challengeId,response})});
    if(!result.ok)throw new Error("Sign-in was refused");location.reload();
  }
  async function inspect(){
    prepared=null;draft=null;selected=[];uncategorized=false;
    review=await permissionRequest("review",{sender:sender.trim(),...(pinnedDid?{senderDid:pinnedDid}:{})});
    message="Sender address and signed profile checked. Review what this sender may send to you; this does not verify their real-world identity.";
  }
  async function prepareAllow(){
    if(!review||(!uncategorized&&!selected.length))return;
    if(!draft)draft={requestId:crypto.randomUUID(),action:"allow",sender:review.address,senderDid:review.did,addressDigest:review.addressDigest,
      profileDigest:review.profileDigest,scope:uncategorized?{type:"uncategorized"}:{type:"categories",values:[...selected].sort()},expiresAt:Math.floor(Date.now()/1000)+Number(days)*86400};
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

<svelte:head><title>Allowed senders · Hail</title><meta name="robots" content="noindex, nofollow" /></svelte:head>
<div class="[&_h1]:m-0 [&_h1]:text-[32px] [&_h2]:m-0 [&_h3]:m-0 [&_p]:m-0 [&_p]:leading-[1.6]
  [&_label]:flex [&_label]:flex-col [&_label]:gap-1.5 [&_label]:leading-[1.6]
  [&_input:not([type=checkbox])]:w-full [&_input:not([type=checkbox])]:p-2.5 [&_input:not([type=checkbox])]:border
  [&_input:not([type=checkbox])]:border-solid [&_input:not([type=checkbox])]:border-[#cad4cd]
  [&_input:not([type=checkbox])]:rounded-md [&_input:not([type=checkbox])]:[font:inherit]
  [&_select]:w-full [&_select]:p-2.5 [&_select]:border [&_select]:border-solid [&_select]:border-[#cad4cd] [&_select]:rounded-md [&_select]:[font:inherit]
  [&_button]:self-start [&_button]:px-3.5 [&_button]:py-2.5 [&_button]:[font:inherit] [&_button]:cursor-pointer
  [&_button:disabled]:opacity-60 [&_button:disabled]:cursor-not-allowed
  [&_code]:[overflow-wrap:anywhere] [&_code]:[word-break:break-word] [&_code]:text-[12px]
  [&_svg]:max-w-full [&_svg]:h-auto [&_fieldset]:border [&_fieldset]:border-solid [&_fieldset]:border-[#cad4cd]
  [&_fieldset]:flex [&_fieldset]:flex-col [&_fieldset]:gap-2 [&_small]:text-[#526058]">
<section class="mb-5 flex flex-col gap-3.5"><h1>Allowed senders</h1><p>You decide who may send to your inbox. Permission is one-way; it does not let you send to them.</p></section>
{#if message}<p class="sticky top-2.5 z-1 rounded-lg border border-solid border-[#8ab38a] bg-[#eef8ed] p-4" role="status">{message}</p>{/if}
{#if !data.configured}
  <section class="hail-card mb-5 flex flex-col gap-3.5 p-[22px]"><h2>Sign in to review a sender</h2><p>Scanning a QR code grants nothing. Sign in to your own account, then review and confirm.</p>
    {#if sender}<p>Requested sender: {sender}</p>{/if}<button disabled={busy} onclick={()=>run(signIn)}>Sign in with a passkey</button></section>
{:else}
  <p>Managing permissions for <strong>{data.account.address}</strong></p>
  {#if data.account.custodyProfile!=="managed"}<p role="status">Browser approval currently supports managed accounts only. Your owner-controlled account still uses its existing signer.</p>{/if}
  {#if data.account.custodyProfile==="managed"}
    {#if !prepared}
      <section class="hail-card mb-5 flex flex-col gap-3.5 p-[22px]"><h2>Allow a sender</h2><p>Enter their Hail address, or scan their sender QR with your phone's normal camera to open this screen. Nothing is approved automatically.</p>
        <label>Potential sender's Hail address<input bind:value={sender} maxlength="254" autocomplete="off" placeholder="canary-prov@haili.app"
          oninput={()=>{pinnedDid=undefined;review=null;draft=null;}} /></label>
        {#if pinnedDid}<p>QR identity pin: <code>{pinnedDid}</code></p>{/if}
        <button disabled={busy||!sender.trim()} onclick={()=>run(inspect)}>Review sender</button>
        {#if review}
          <h3>{review.displayName}</h3><p>{review.address}</p><code>{review.did}</code>
          <p>The profile name is chosen by the sender. Check the address and identity with the person or organization you intended.</p>
          {#if review.categories.length}<fieldset><legend>Categories this sender may send you</legend>{#each review.categories as category}
            <label class="flex-row! flex-wrap items-center"><input type="checkbox" bind:group={selected} value={category.id} disabled={uncategorized||busy} />{category.label} <small>({category.id})</small></label>
            {#if category.description}<small>{category.description}</small>{/if}{/each}</fieldset>{/if}
          {#if review.offersUncategorized}<label class="flex-row! flex-wrap items-center"><input type="checkbox" bind:checked={uncategorized} /> Allow uncategorized messages instead</label>{/if}
          <label>Permission expires in<select bind:value={days}><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option><option value={365}>1 year</option></select></label>
          <button disabled={busy||(!uncategorized&&!selected.length)} onclick={()=>run(prepareAllow)}>Review permission before approving</button>
        {/if}
      </section>
    {:else}
      <section class="hail-card mb-5 flex flex-col gap-3.5 border-2 border-solid border-[#17633f] p-[22px]"><h2>{prepared.action==="allow"?"Confirm allowed sender":"Confirm revocation"}</h2>
        <p><strong>{prepared.permission.consent_context.grantee_address}</strong> {prepared.action==="allow"?"will be allowed to send to":"will lose this permission to send to"} <strong>{data.account.address}</strong>.</p>
        <p>Sender identity: <code>{prepared.permission.grantee}</code></p>
        <p>Scope: {prepared.permission.scope[0]?.type==="categories"?prepared.permission.scope[0].values.join(", "):"Uncategorized messages"}</p>
        <p>Permission expiry: {prepared.permission.expires_at===null?"No expiry":date(prepared.permission.expires_at)}</p>
        <p>Confirm only if these are the intended sender and permissions. Your provider signs the Grant; your passkey authorizes only this reviewed action. It is not an identity recovery key.</p>
        <p>Approval expires {new Date(prepared.expiresAt).toLocaleString()}.</p>
        <button disabled={busy||now>=Date.parse(prepared.expiresAt)} onclick={()=>run(confirmPermission)}>{prepared.approved?"Retry saving approved permission":prepared.action==="allow"?"Allow sender with my passkey":"Revoke sender with my passkey"}</button>
        <button disabled={busy} onclick={()=>run(check)}>Check original approval status</button>
        {#if !prepared.approved}<button disabled={busy} onclick={cancel}>Cancel review</button>{/if}
      </section>
    {/if}
    <button disabled={busy} onclick={()=>run(check)}>Continue an interrupted approval in this tab</button>
  {/if}
  <section class="mb-5 flex flex-col gap-3.5 p-[22px]"><h2>Permissions you issued</h2>
    <p>A saved permission may take a moment to reach the sender. Revocation does not delete messages already delivered.</p>
    {#if !data.permissions.length}<p>No permissions on this page. Allowing a sender does not share past messages or permit them to send as you.</p>{/if}
    {#each data.permissions as permission}<article class="hail-card flex flex-col gap-2.5 p-[18px]"><h3>{permission.sender}</h3><code>{permission.did}</code>
      <p>{permission.scope?.type==="categories"?permission.scope.values.join(", "):"Uncategorized"} · {permission.status}{permission.expiresAt!==null?` · expires ${date(permission.expiresAt)}`:" · no expiry"}</p>
      {#if permission.expiresAt!==null&&permission.expiresAt*1000<=now}<p>Expired; it no longer permits messages.</p>{/if}
      {#if data.account.custodyProfile==="managed"&&permission.status==="active"}<button disabled={busy||!!prepared} onclick={()=>run(()=>prepareRevoke(permission))}>Review revocation</button>{/if}
    </article>{/each}
    {#if data.next}<a href={`/permissions?after=${encodeURIComponent(data.next)}`}>More permissions →</a>{/if}
  </section>
  <section class="hail-card mb-5 flex flex-col gap-3.5 p-[22px]"><h2>Share your sender QR</h2><p>Let another person choose whether you may send to them. This link contains only your public address and identity—not a credential. You need a published Sender Profile before someone can approve your categories.</p>
    <button onclick={()=>{showQr=!showQr;}}>{showQr?"Hide QR":"Show my sender QR"}</button>
    {#if qr}<svg viewBox={`0 0 ${qr.size} ${qr.size}`} width="256" height="256" role="img" aria-label={`Sender request QR for ${data.account.address}`} shape-rendering="crispEdges"><rect width="100%" height="100%" fill="white" /><path d={qr.path} fill="black" /></svg>
      <a class="[overflow-wrap:anywhere] [word-break:break-word]" href={share}>{share}</a>{/if}
  </section>
{/if}
{#if busy}<p role="status">Working… keep the original approval open if the response is delayed.</p>{/if}
</div>
