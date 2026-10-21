<script lang="ts">
  let { data } = $props();
  const date = (value: string) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
</script>

{#if !data.configured}
  <section class="card setup">
    <p class="eyebrow">Setup required</p>
    <h1>Connect the canary</h1>
    <p>Set <code>HAIL_GUI_CREDENTIAL_FILE</code> to a credential for <strong>canary@haili.app</strong>, then restart the app.</p>
  </section>
{:else}
  <section class="account">
    <div>
      <p class="eyebrow">Inbox</p>
      <h1>{data.account.address}</h1>
      <p class="did">{data.account.did}</p>
    </div>
    <span class="custody">{data.account.custodyProfile}</span>
  </section>

  <section class="card inbox" aria-label="Messages">
    {#if data.messages.length === 0}
      <div class="empty"><strong>No messages yet</strong><span>Delivered Hail messages will appear here.</span></div>
    {:else}
      {#each data.messages as message}
        <a class="message" href={`/message/${encodeURIComponent(message.sender)}/${message.messageId}`}>
          <span class="avatar" aria-hidden="true">{(message.senderAddress ?? message.sender).slice(0, 2).toUpperCase()}</span>
          <span class="summary"><strong>{message.senderAddress ?? message.sender}</strong><small>{message.preview}</small></span>
          <time datetime={message.deliveredAt}>{date(message.deliveredAt)}</time>
        </a>
      {/each}
    {/if}
  </section>
{/if}

<style>
  .eyebrow { margin: 0 0 8px; color: #22714b; font-size: 12px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
  h1 { margin: 0; font-size: clamp(28px, 6vw, 42px); letter-spacing: -.035em; }
  .account { display: flex; align-items: end; justify-content: space-between; margin-bottom: 24px; }
  .did { margin: 8px 0 0; color: #6b766f; font-family: ui-monospace, monospace; font-size: 12px; }
  .custody { padding: 8px 12px; border-radius: 999px; background: #e2f1e8; color: #24573c; font-size: 12px; font-weight: 700; }
  .inbox { overflow: hidden; }
  .message { display: flex; align-items: center; gap: 14px; padding: 18px 20px; text-decoration: none; }
  .message + .message { border-top: 1px solid #e8ece8; }
  .message:hover { background: #f9fbf9; }
  .avatar { display: grid; flex: 0 0 42px; height: 42px; place-items: center; border-radius: 13px; background: #dcece2; color: #17633f; font-size: 12px; font-weight: 800; }
  .summary { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 4px; }
  .summary strong, .summary small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .summary strong { font-size: 14px; }.summary small, time { color: #758078; font-size: 12px; }
  .empty, .setup { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; padding: 42px; }
  .empty span, .setup > p:last-child { color: #657168; }
  .setup { max-width: 620px; }.setup h1 { margin-bottom: 8px; }.setup p { line-height: 1.65; }
  code { padding: 2px 6px; border-radius: 6px; background: #edf0ed; font-size: 13px; }
  @media (max-width: 600px) { .account { align-items: flex-start; flex-direction: column; gap: 16px; } time { display: none; } .message { padding: 16px; } }
</style>
