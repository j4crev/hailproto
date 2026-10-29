<script lang="ts">
  import CopyButton from "$lib/CopyButton.svelte";
  import {onMount} from "svelte";
  import ProviderStats from "$lib/ProviderStats.svelte";
  import {invalidateAll} from "$app/navigation";
  let {data}=$props();
  let email=$state(""),busy=$state(false),message=$state(""),inviteUrl=$state("");
  let pending=$state<{id:string;email:string|null}|null>(null);
  let ready=$state(false);
  onMount(()=>{ready=true;});
  let savingMode=$state(false),modeMessage=$state("");
  async function setMode(mode:"invite"|"public"){
    if(savingMode||mode===data.signupMode)return;
    savingMode=true;modeMessage="";
    try{
      const response=await fetch("/api/v1/operator/registration",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({mode})});
      if(!response.ok){modeMessage=response.status===403?"Sign in again with your operator passkey to change registration.":"Could not confirm the setting. Refresh and retry.";return;}
      await invalidateAll();modeMessage="Registration setting saved.";
    }catch{modeMessage="Could not confirm the setting. Refresh and retry.";}
    finally{savingMode=false;}
  }
  async function create(event:SubmitEvent){
    event.preventDefault();if(busy)return;
    busy=true;message="";inviteUrl="";
    pending??={id:crypto.randomUUID(),email:email.trim()||null};
    try{
      const response=await fetch("/api/v1/operator/invitations",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(pending)});
      if(!response.ok){
        message=response.status===403?"Sign in again with your operator passkey, then return here.":response.status===429?
          "Invitation limit reached. Please wait before retrying.":response.status===400?"Enter a valid email address.":
          "Delivery is unconfirmed. Retry to check this request; avoid sending a new invitation until you have checked with the recipient.";
        if(response.status===400)pending=null;
        return;
      }
      const result=await response.json();inviteUrl=result.url;
      message=pending.email?"The email service accepted the invitation. This does not confirm inbox delivery.":"Your invitation link is ready. Share it privately.";
      pending=null;email="";await invalidateAll();
    }catch{message="Could not confirm the request. Retry to check the same invitation.";}
    finally{busy=false;}
  }
</script>
<svelte:head><title>Provider administration · Hail</title><meta name="referrer" content="no-referrer" /></svelte:head>
<div class="dashboard">
  <header class="page-heading"><h1 class="hail-title">Your Hail server</h1><p>Activity and signup invitations for {data.account.provider}.</p></header>
  <section class="hail-card panel" aria-labelledby="registration-heading">
    <h2 id="registration-heading">Registration</h2>
    <div class="registration-setting">
      <label for="public-registration">Public registration</label>
      <input id="public-registration" class="preference-switch" type="checkbox" role="switch"
        aria-describedby="registration-description" checked={data.signupMode==="public"} disabled={!ready||savingMode}
        onchange={event=>{const enabled=event.currentTarget.checked;event.currentTarget.checked=data.signupMode==="public";void setMode(enabled?"public":"invite");}} />
    </div>
    <p id="registration-description">When on, anyone can create an account at this server’s domain. When off, signup requires an invitation.</p>
    <p class="hint">Setups already started can finish within their existing expiry.</p>
    {#if modeMessage}<p role="status">{modeMessage}</p>{/if}
    <p class="hint">Changing registration requires a passkey login within the last ten minutes.</p>
  </section>
  <ProviderStats stats={data.stats} range={data.range} />
  <section class="hail-card panel" aria-labelledby="new-invitation">
    <h2 id="new-invitation">New invitation</h2>
    <p>Invitations are single-use and expire after seven days. They allow signup, not access to an existing account.</p>
    <form onsubmit={create}>
      <label for="invite-email">Email address <span>(optional)</span></label>
      <input id="invite-email" type="email" maxlength="254" autocomplete="off" placeholder="person@example.com" bind:value={email} disabled={busy||pending!==null} />
      <p class="hint">Leave blank to create a link you can share yourself. The link can be used by anyone who receives it.</p>
      <button class="hail-button" disabled={busy}>{busy?"Creating invitation…":pending?"Check / retry invitation":email.trim()?"Send invitation":"Create invitation link"}</button>
    </form>
    {#if pending&&!busy}<button class="hail-button-secondary" onclick={()=>{pending=null;email="";message="The previous invitation may still be delivered. A new request creates a separate invitation.";}}>Start another invitation</button>{/if}
    {#if message}<p role="status">{message}</p>{/if}
    {#if inviteUrl}<label for="invite-link">Private invitation link</label><div class="flex min-w-0 items-start gap-1"><textarea class="min-w-0 flex-1" id="invite-link" readonly value={inviteUrl} rows="3"></textarea><CopyButton value={inviteUrl} label="Copy invitation link" /></div>{/if}
    <p class="hint">Creating invitations requires a passkey login within the last ten minutes. <a href="/?next=%2Fadmin">Sign in again</a></p>
  </section>
  <section class="hail-card panel" aria-labelledby="recent-invitations">
    <h2 id="recent-invitations">Recent invitations</h2><p class="hint">Latest 100 invitations created through this dashboard. “Accepted” means signup has started.</p>
    {#if !data.invitations.length}<p>No invitations yet.</p>{:else}
      <div class="table-scroll"><table><thead><tr><th>Recipient</th><th>Signup</th><th>Delivery</th><th>Expires</th></tr></thead><tbody>
        {#each data.invitations as invitation (invitation.id)}<tr><td>{invitation.email??"Private link"}</td><td>{invitation.status}</td><td>{invitation.delivery==="accepted-by-email-service"?"Email service accepted":invitation.delivery==="unconfirmed"?"Unconfirmed":"Link"}</td><td>{new Date(invitation.expires_at).toISOString().slice(0,10)}</td></tr>{/each}
      </tbody></table></div>
    {/if}
  </section>
</div>
<style>
  .dashboard{max-width:980px;margin:auto}.panel{padding:28px;margin-bottom:24px}h2{margin-top:0;font-size:20px}p{line-height:1.6}form{display:grid;gap:12px;max-width:540px}label{display:block;font-weight:600;margin-bottom:8px}label span,.hint{color:var(--color-muted);font-size:13px}input,textarea{width:100%;padding:12px;border:1px solid var(--color-line);border-radius:10px;background:var(--color-canvas);color:var(--color-ink)}textarea{margin-bottom:12px;overflow-wrap:anywhere}.table-scroll{overflow:auto}table{width:100%;border-collapse:collapse;text-align:left;font-size:13px}th,td{padding:14px 12px;border-bottom:1px solid var(--color-line)}td:first-child{overflow-wrap:anywhere}th{color:var(--color-muted)}
  .registration-setting{display:flex;align-items:center;justify-content:space-between;gap:24px;min-height:44px}
  .registration-setting label{margin:0;cursor:pointer;flex:1;padding:12px 0}
  .preference-switch{appearance:none;position:relative;flex-shrink:0;width:46px;height:28px;padding:0;margin:0;border:1px solid var(--color-muted);border-radius:20px;background:var(--color-line);cursor:pointer;transition:background .15s}
  .preference-switch::before{content:'';position:absolute;width:20px;height:20px;top:3px;left:3px;border-radius:50%;background:var(--color-surface);box-shadow:0 1px 3px #172b2d30;transition:transform .15s}
  .preference-switch:checked{background:var(--color-brand);border-color:var(--color-brand)}
  .preference-switch:checked::before{transform:translateX(18px)}
  .preference-switch:focus-visible{outline:2px solid var(--color-brand);outline-offset:4px}
  .preference-switch:disabled{opacity:.5;cursor:wait}
  @media(prefers-reduced-motion:reduce){.preference-switch,.preference-switch::before{transition:none}}
</style>
