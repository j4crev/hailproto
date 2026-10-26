<script lang="ts">
  import {invalidateAll} from "$app/navigation";
  let {data}=$props();
  let email=$state(""),busy=$state(false),message=$state(""),inviteUrl=$state(""),copied=$state(false);
  let pending=$state<{id:string;email:string|null}|null>(null);
  async function create(event:SubmitEvent){
    event.preventDefault();if(busy)return;
    busy=true;message="";inviteUrl="";copied=false;
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
  async function copy(){try{await navigator.clipboard.writeText(inviteUrl);copied=true;}catch{message="Select and copy the link below.";}}
</script>
<svelte:head><title>Provider invitations · Hail</title><meta name="referrer" content="no-referrer" /></svelte:head>
<div class="dashboard">
  <header class="page-heading"><p class="hail-eyebrow">Provider administration</p><h1 class="hail-title">Invite someone to Hail</h1><p>Manage signup invitations for {data.account.provider}.</p></header>
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
    {#if inviteUrl}<label for="invite-link">Private invitation link</label><textarea id="invite-link" readonly value={inviteUrl} rows="3"></textarea><button class="hail-button-secondary" onclick={copy}>{copied?"Copied":"Copy link"}</button>{/if}
    <p class="hint">Creating invitations requires a passkey login within the last ten minutes. <a href="/auth/login?next=%2Fadmin">Sign in again</a></p>
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
</style>
