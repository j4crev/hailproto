<script lang="ts">
  import {invalidateAll} from "$app/navigation";
  let {data}=$props();
  let refreshing=$state(false);
  const date=(value:string)=>new Intl.DateTimeFormat(undefined,{dateStyle:"medium",timeStyle:"short"}).format(new Date(value));
  const icon=(state:string)=>state==="accepted"?"✓":state==="delivered"?"✉":state==="on-hold"?"…":state==="indeterminate"?"?":"!";
  async function refresh(){refreshing=true;try{await invalidateAll();}finally{refreshing=false;}}
</script>

{#if !data.configured}
  <section class="card notice">Connect the canary to view sent messages.</section>
{:else}
  <section class="heading"><div><p>Sent</p><h1>{data.account.address}</h1><small>{data.account.did}</small></div><div class="actions"><button type="button" onclick={refresh} disabled={refreshing}>{refreshing?'Refreshing…':'Refresh'}</button><a href="/compose">Compose</a></div></section>
  {#if data.messages.length}
    <section class="feed" aria-label="Sent messages">
      {#each data.messages as message}
        <a class="card message" href={`/sent/${message.messageId}`}>
          <div class="meta"><strong>To {message.recipient}</strong><span class:accepted={message.state==='accepted'} class="status" aria-label={`Status: ${message.state}`}><b aria-hidden="true">{icon(message.state)}</b> {message.state}</span></div>
          {#if message.header}<img src={message.header.src} alt={message.header.alt} width={message.header.width} height={message.header.height}/>{/if}
          <p>{message.preview}</p><time datetime={message.createdAt}>{date(message.createdAt)}</time>
        </a>
      {/each}
    </section>
  {:else}<section class="card empty"><h2>No sent messages</h2><p>Messages you send will appear here.</p></section>{/if}
{/if}

<style>
  .heading{display:flex;align-items:end;justify-content:space-between;margin-bottom:24px}.heading p{margin:0 0 7px;color:#22714b;font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase}.heading h1{margin:0 0 5px;font-size:32px}.heading small{color:#748078}.actions{display:flex;gap:8px}.actions button,.actions a{padding:10px 14px;border:0;border-radius:10px;font:inherit;font-size:13px;font-weight:750;text-decoration:none;cursor:pointer}.actions button{background:#e5ece7;color:#28513c}.actions button:disabled{cursor:not-allowed;opacity:.6}.actions a{background:#17633f;color:white}.feed{display:grid;gap:13px}.message{display:grid;overflow:hidden;color:inherit;text-decoration:none}.meta{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 18px 0}.meta strong{overflow:hidden;font-size:14px;text-overflow:ellipsis;white-space:nowrap}.status{color:#202723;font-size:12px;font-weight:750;text-transform:capitalize;white-space:nowrap}.status b{font-size:16px}.status.accepted{color:#168244}.message>img{width:100%;max-height:220px;margin-top:14px;object-fit:cover}.message>p{margin:15px 18px 10px;color:#354139;line-height:1.5}.message time{margin:0 18px 16px;color:#778179;font-size:11px}.empty,.notice{padding:30px;text-align:center}.empty h2{margin-top:0}.empty p,.notice{color:#69756e}@media(max-width:560px){.heading{align-items:flex-start;flex-direction:column;gap:14px}.meta{align-items:flex-start}.meta strong{white-space:normal}}
</style>
