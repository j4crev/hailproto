<script lang="ts">
  import { onMount } from "svelte";
  let { data } = $props();
  let showHeaders = $state(true);
  const date = (value: string) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  onMount(() => { showHeaders = localStorage.getItem("hail.gui.showInboxHeaders") !== "false"; });
  function toggleHeaders(event: Event) {
    showHeaders = (event.currentTarget as HTMLInputElement).checked;
    localStorage.setItem("hail.gui.showInboxHeaders", String(showHeaders));
  }
</script>

{#if !data.configured}
  <section class="card setup">
    <p class="eyebrow">Signed out</p>
    <h1>Connect your Hail account</h1>
    <p><a class="sign-in" href="/auth/login">Sign in with a passkey</a></p>
  </section>
{:else}
  <section class="account">
    <div>
      <p class="eyebrow">Inbox</p>
      <h1>{data.account.address}</h1>
      <p class="did">{data.account.did}</p>
    </div>
    <span class="custody">{data.account.custodyProfile}</span>
    <form method="POST" action="/auth/logout"><button class="sign-out">Sign out</button></form>
  </section>

  <section class="feed-tools" aria-label="Inbox preferences">
    <div><strong>Message feed</strong><small>Bundled images never contact the sender.</small></div>
    <label><input type="checkbox" checked={showHeaders} onchange={toggleHeaders} /> Show headers</label>
  </section>

  <section class="inbox" aria-label="Messages">
    {#if data.messages.length === 0}
      <div class="empty"><strong>No messages yet</strong><span>Delivered Hail messages will appear here.</span></div>
    {:else}
      {#each data.messages as message}
        <a class="card message" href={`/message/${encodeURIComponent(message.sender)}/${message.messageId}`}>
          <span class="meta">
            {#if message.avatar}<img class="avatar" src={message.avatar.src} alt="" width={message.avatar.width} height={message.avatar.height} />
            {:else}<span class="avatar fallback" aria-hidden="true">{(message.senderAddress ?? message.sender).slice(0, 2).toUpperCase()}</span>{/if}
            <span class="sender"><strong>{message.senderAddress ?? message.sender}</strong>{#if message.senderAddress}<small>{message.sender}</small>{/if}<time datetime={message.deliveredAt}>{date(message.deliveredAt)}</time></span>
          </span>
          {#if showHeaders && message.header}
            <img class="header-image" src={message.header.src} alt={message.header.alt} width={message.header.width} height={message.header.height} />
          {/if}
          <span class="summary">{message.preview}</span>
        </a>
      {/each}
    {/if}
  </section>
  {#if data.paged||data.next}<nav class="pages">{#if data.paged}<a href="/">← Newest messages</a>{/if}{#if data.next}<a href={`/?after=${encodeURIComponent(data.next)}`}>Older messages →</a>{/if}</nav>{/if}
{/if}

<style>
  .eyebrow { margin: 0 0 8px; color: #22714b; font-size: 12px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
  h1 { margin: 0; font-size: clamp(28px, 6vw, 42px); letter-spacing: -.035em; }
  .account { display: flex; align-items: end; justify-content: space-between; margin-bottom: 24px; }
  .did { margin: 8px 0 0; color: #6b766f; font-family: ui-monospace, monospace; font-size: 12px; }
  .custody { padding: 8px 12px; border-radius: 999px; background: #e2f1e8; color: #24573c; font-size: 12px; font-weight: 700; }
  .feed-tools { display: flex; align-items: center; justify-content: space-between; gap: 18px; margin-bottom: 14px; }
  .feed-tools div { display: flex; flex-direction: column; gap: 3px; }.feed-tools small { color: #758078; }
  .feed-tools label { display: flex; align-items: center; gap: 8px; color: #526058; font-size: 13px; font-weight: 700; white-space: nowrap; }
  .feed-tools input { width: 17px; height: 17px; accent-color: #17633f; }
  .inbox { display: grid; gap: 18px; }
  .message { display: flex; overflow: hidden; flex-direction: column; text-decoration: none; transition: transform .15s ease, box-shadow .15s ease; }
  .message:hover { transform: translateY(-1px); box-shadow: 0 14px 36px rgba(21, 50, 35, .09); }
  .meta { display: flex; align-items: center; gap: 12px; padding: 16px 18px; }
  .avatar { display: grid; width: 42px; flex: 0 0 42px; height: 42px; place-items: center; border-radius: 13px; object-fit: cover; }
  .fallback { background: #dcece2; color: #17633f; font-size: 12px; font-weight: 800; }
  .sender { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 3px; }.sender strong,.sender small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.sender strong { font-size: 14px; }.sender small { color:#778179;font-family:ui-monospace,monospace;font-size:11px; }
  time { color: #758078; font-size: 11px; }
  .header-image { display: block; width: 100%; height: auto; max-height: 320px; border-block: 1px solid #e4e9e5; object-fit: cover; }
  .summary { padding: 16px 18px 18px; color: #4f5d55; font-family: ui-serif, Georgia, serif; font-size: 16px; line-height: 1.5; }
  .empty, .setup { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; padding: 42px; }
  .pages { display:flex;justify-content:center;gap:22px;margin-top:18px; }.pages a { color:#286446;font-size:13px;font-weight:750;text-decoration:none; }
  .empty span, .setup > p:last-child { color: #657168; }
  .setup { max-width: 620px; }.setup h1 { margin-bottom: 8px; }.setup p { line-height: 1.65; }
  .sign-in { display:inline-block;padding:10px 14px;border-radius:9px;background:#17633f;color:white;font-weight:750;text-decoration:none; }
  .sign-out { padding:8px 11px;border:1px solid #cad4cd;border-radius:8px;background:white;color:#526058;font:inherit;font-size:12px;font-weight:700;cursor:pointer; }
  @media (max-width: 600px) { .account { align-items: flex-start; flex-direction: column; gap: 16px; } .feed-tools { align-items: flex-start; flex-direction: column; } }
</style>
