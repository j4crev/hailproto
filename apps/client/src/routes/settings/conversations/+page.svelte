<script lang="ts">
  import {invalidateAll} from "$app/navigation";
  import {connectionRequest} from "$lib/connections.js";
  let {data}=$props();
  let saving=$state(false),status=$state(""),error=$state("");
  async function save(input:{allowIntroductions:boolean}|{connectionId:string;epoch:number;override:boolean|null}){
    saving=true;status="";error="";
    try{
      await connectionRequest("conversation-preferences",input);
      await invalidateAll();
      status="Conversation preference saved.";
    }catch(e){error=e instanceof Error?e.message:"Unable to save. Reload to check your current preference.";}
    finally{saving=false;}
  }
</script>
<svelte:head><title>Shared conversations · Haili</title></svelte:head>
<div class="mx-auto max-w-[860px]">
  <header class="page-heading"><h1 class="hail-title">Shared conversations</h1></header>
  <p><a href="/settings">Settings</a> · <a href="/connections">Connections</a></p>
  <section class="hail-card grid gap-6 p-6 sm:p-8" aria-label="Shared conversation preferences" aria-busy={saving}>
    <p class="m-0 text-sm text-muted">Choose who may introduce you to shared conversations with other people. Introductions are allowed by default. These settings apply to new introductions and expired-conversation revival; leave a conversation to stop its messages.</p>
    <label class="hail-field" for="introductions"><span>Allow shared conversations started by my connections</span>
      <select id="introductions" value={String(data.preferences.allowIntroductions)} disabled={saving}
        onchange={event=>{const allowed=event.currentTarget.value==="true";event.currentTarget.value=String(data.preferences.allowIntroductions);void save({allowIntroductions:allowed});}}>
        <option value="false">Don’t allow</option><option value="true">Allow</option>
      </select>
    </label>
    <p class="m-0 text-sm text-muted">Allowing introductions means you can receive messages automatically from everyone in those shared conversations, including people who aren’t your connections. Participants can see who is in the conversation. This does not give them permission to message you privately.</p>
    {#if !data.preferences.configured}<p class="m-0 text-sm text-muted">On by default. You can turn it off for everyone or choose individual connections below.</p>{/if}
    <p class="m-0 text-sm text-muted">These settings control new introductions and revival after expiry. Leaving a conversation will be a separate action.</p>
    <div class="grid gap-4 border-0 border-t border-solid border-line pt-6">
      <h2 class="m-0 text-base">Per-connection choices</h2>
      <p class="m-0 text-sm text-muted">An individual choice overrides your global setting for this connection. Reconnecting uses your global setting until you choose again.</p>
      {#each data.preferences.connections as connection (connection.connectionId)}
        <label class="hail-field" for={'introduction-'+connection.connectionId}>
          <span class="break-words">{connection.address}</span>
          <select id={'introduction-'+connection.connectionId} value={connection.override===null?'inherit':String(connection.override)} disabled={saving}
            onchange={event=>{const value=event.currentTarget.value;event.currentTarget.value=connection.override===null?'inherit':String(connection.override);void save({connectionId:connection.connectionId,epoch:connection.epoch,override:value==='inherit'?null:value==='true'});}}>
            <option value="inherit">Use global setting ({data.preferences.allowIntroductions?'Allow':'Don’t allow'})</option>
            <option value="true">Allow</option><option value="false">Don’t allow</option>
          </select>
        </label>
      {:else}<p class="m-0 text-sm text-muted">No active connections to customize.</p>{/each}
      {#if data.preferences.truncated}<p class="m-0 text-sm text-muted">Showing the first 200 connections. Other connections retain their saved choices or use the global setting.</p>{/if}
    </div>
    {#if status}<p role="status" class="m-0 text-sm">{status}</p>{/if}
    {#if error}<p role="alert" class="m-0 text-sm">{error}</p>{/if}
  </section>
</div>
