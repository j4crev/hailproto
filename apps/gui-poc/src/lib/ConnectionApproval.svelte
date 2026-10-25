<script lang="ts">
  import {startAuthentication} from "@simplewebauthn/browser";
  import {connectApproval,connectionRequest,CONNECTION_APPROVAL,type ConnectApproval} from "$lib/connections.js";
  let {approval,oncomplete,oncancel}:{approval:ConnectApproval;oncomplete:(result:NonNullable<ConnectApproval["result"]>)=>void|Promise<void>;oncancel:()=>void}=$props();
  let busy=$state(false),message=$state("");
  async function run(commit:boolean){
    busy=true;message="";
    try{
      let next=connectApproval(await connectionRequest(approval.requestId));
      if(commit&&!next.result){if(!next.options)throw new Error("This approval expired. Cancel and review again.");
        const response=await startAuthentication({optionsJSON:next.options});
        next=connectApproval(await connectionRequest("commit",{requestId:next.requestId,response}));}
      approval=next;
      if(next.result){sessionStorage.removeItem(CONNECTION_APPROVAL);await oncomplete(next.result);}
      else message="Not committed. This exact review still needs passkey confirmation.";
    }catch(error){message=error instanceof Error?error.message:"Connection not confirmed. Check this approval before retrying.";}
    finally{busy=false;}
  }
</script>
<section class="hail-card grid gap-4 border-2 border-brand p-5" aria-label="Connection action confirmation">
  <h2 class="m-0 text-xl">Confirm {approval.action==="create"?"new connection code":approval.action==="replace"?"personal code replacement":approval.action==="revoke"?"code revocation":approval.action==="disconnect"?"disconnect":"connection"}</h2>
  {#if approval.action==="connect"}<p class="m-0 text-sm [overflow-wrap:anywhere]">Connect with <strong>{approval.review.address}</strong><br /><code>{approval.review.did}</code></p>
  {:else if approval.action==="create"}<p class="m-0 text-sm">{approval.review.label} · {approval.review.expiresAt===null?"No automatic expiry":`Expires ${new Date(approval.review.expiresAt*1000).toLocaleString()}`}</p>
  {:else}<p class="m-0 text-sm [overflow-wrap:anywhere]">Reviewed identifier: <code>{approval.review.connectionId??approval.review.id}</code></p>{/if}
  {#if approval.action==="create"||approval.action==="replace"}<p class="m-0 text-sm">Anyone signed in to this provider who has this link or QR can connect before it expires, without another approval from you. Share only where you intend. Existing connections are unaffected by code replacement or revocation.</p>{/if}
  {#if approval.action==="connect"}<p class="m-0 text-sm">Both accounts will be connected immediately. This does not subscribe either of you. Direct connection messaging is not enabled in this preview.</p>{/if}
  {#if approval.action==="disconnect"}<p class="m-0 text-sm">This ends the connection, not any subscriptions. Earlier codes cannot reconnect this pair; a new or replaced code is required.</p>{/if}
  <p class="m-0 text-xs text-muted">Your passkey approves only this action. Approval expires {new Date(approval.expiresAt).toLocaleString()}.</p>
  <p class="m-0 text-sm text-muted">Preview limitation: retained consent cannot yet be exported. Using this preview blocks provider transfers and custody changes, even after revoking codes or disconnecting, until portability support is implemented.</p>
  {#if message}<p class="hail-error" role="status">{message}</p>{/if}
  <div class="flex flex-wrap gap-2"><button class="hail-button" disabled={busy} onclick={()=>run(true)}>Confirm with passkey</button><button class="hail-button-secondary" disabled={busy} onclick={()=>run(false)}>Check original status</button><button class="hail-button-secondary" disabled={busy} onclick={oncancel}>Cancel review</button></div>
</section>
