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
<section class="heading"><h1>Allowed senders</h1><p>You decide who may send to your inbox. Permission is one-way; it does not let you send to them.</p></section>
{#if message}<p class="message" role="status">{message}</p>{/if}
{#if !data.configured}
  <section class="card panel"><h2>Sign in to review a sender</h2><p>Scanning a QR code grants nothing. Sign in to your own account, then review and confirm.</p>
    {#if sender}<p>Requested sender: {sender}</p>{/if}<button disabled={busy} onclick={()=>run(signIn)}>Sign in with a passkey</button></section>
{:else}
  <p>Managing permissions for <strong>{data.account.address}</strong></p>
  {#if data.account.custodyProfile!=="managed"}<p role="status">Browser approval currently supports managed accounts only. Your owner-controlled account still uses its existing signer.</p>{/if}
  {#if data.account.custodyProfile==="managed"}
    {#if !prepared}
      <section class="card panel"><h2>Allow a sender</h2><p>Enter their Hail address, or scan their sender QR with your phone's normal camera to open this screen. Nothing is approved automatically.</p>
        <label>Potential sender's Hail address<input bind:value={sender} maxlength="254" autocomplete="off" placeholder="canary-prov@haili.app"
          oninput={()=>{pinnedDid=undefined;review=null;draft=null;}} /></label>
        {#if pinnedDid}<p>QR identity pin: <code>{pinnedDid}</code></p>{/if}
        <button disabled={busy||!sender.trim()} onclick={()=>run(inspect)}>Review sender</button>
        {#if review}
          <h3>{review.displayName}</h3><p>{review.address}</p><code>{review.did}</code>
          <p>The profile name is chosen by the sender. Check the address and identity with the person or organization you intended.</p>
          {#if review.categories.length}<fieldset><legend>Categories this sender may send you</legend>{#each review.categories as category}
            <label class="choice"><input type="checkbox" bind:group={selected} value={category.id} disabled={uncategorized||busy} />{category.label} <small>({category.id})</small></label>
            {#if category.description}<small>{category.description}</small>{/if}{/each}</fieldset>{/if}
          {#if review.offersUncategorized}<label class="choice"><input type="checkbox" bind:checked={uncategorized} /> Allow uncategorized messages instead</label>{/if}
          <label>Permission expires in<select bind:value={days}><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option><option value={365}>1 year</option></select></label>
          <button disabled={busy||(!uncategorized&&!selected.length)} onclick={()=>run(prepareAllow)}>Review permission before approving</button>
        {/if}
      </section>
    {:else}
      <section class="card panel review"><h2>{prepared.action==="allow"?"Confirm allowed sender":"Confirm revocation"}</h2>
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
  <section class="panel"><h2>Permissions you issued</h2>
    <p>A saved permission may take a moment to reach the sender. Revocation does not delete messages already delivered.</p>
    {#if !data.permissions.length}<p>No permissions on this page. Allowing a sender does not share past messages or permit them to send as you.</p>{/if}
    {#each data.permissions as permission}<article class="card permission"><h3>{permission.sender}</h3><code>{permission.did}</code>
      <p>{permission.scope?.type==="categories"?permission.scope.values.join(", "):"Uncategorized"} · {permission.status}{permission.expiresAt!==null?` · expires ${date(permission.expiresAt)}`:" · no expiry"}</p>
      {#if permission.expiresAt!==null&&permission.expiresAt*1000<=now}<p>Expired; it no longer permits messages.</p>{/if}
      {#if data.account.custodyProfile==="managed"&&permission.status==="active"}<button disabled={busy||!!prepared} onclick={()=>run(()=>prepareRevoke(permission))}>Review revocation</button>{/if}
    </article>{/each}
    {#if data.next}<a href={`/permissions?after=${encodeURIComponent(data.next)}`}>More permissions →</a>{/if}
  </section>
  <section class="card panel"><h2>Share your sender QR</h2><p>Let another person choose whether you may send to them. This link contains only your public address and identity—not a credential. You need a published Sender Profile before someone can approve your categories.</p>
    <button onclick={()=>{showQr=!showQr;}}>{showQr?"Hide QR":"Show my sender QR"}</button>
    {#if qr}<svg viewBox={`0 0 ${qr.size} ${qr.size}`} width="256" height="256" role="img" aria-label={`Sender request QR for ${data.account.address}`} shape-rendering="crispEdges"><rect width="100%" height="100%" fill="white" /><path d={qr.path} fill="black" /></svg>
      <a class="share" href={share}>{share}</a>{/if}
  </section>
{/if}
{#if busy}<p role="status">Working… keep the original approval open if the response is delayed.</p>{/if}
<style>
  .heading,.panel{display:flex;flex-direction:column;gap:14px;margin-bottom:20px}.panel{padding:22px}.heading h1,h2,h3,p{margin:0}p,label{line-height:1.6}h1{font-size:32px}label{display:flex;flex-direction:column;gap:6px}.choice{flex-direction:row;align-items:center;flex-wrap:wrap}input:not([type=checkbox]),select{width:100%;padding:10px;border:1px solid #cad4cd;border-radius:6px;font:inherit}button{align-self:flex-start;padding:10px 14px;font:inherit;cursor:pointer}button:disabled{opacity:.6;cursor:not-allowed}.permission{display:flex;flex-direction:column;gap:10px;padding:18px}code,.share{overflow-wrap:anywhere;word-break:break-word}code{font-size:12px}svg{max-width:100%;height:auto}.review{border:2px solid #17633f}.message{position:sticky;top:10px;z-index:1;padding:16px;background:#eef8ed;border:1px solid #8ab38a;border-radius:8px}fieldset{border:1px solid #cad4cd;display:flex;flex-direction:column;gap:8px}small{color:#526058}
</style>
