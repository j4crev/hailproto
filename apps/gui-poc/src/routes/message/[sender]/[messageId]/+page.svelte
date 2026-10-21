<script lang="ts">
  import RichText from "$lib/RichText.svelte";
  let { data } = $props();
  let delivered = $derived(new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeStyle: "short" }).format(new Date(data.message.deliveredAt)));
</script>

<a class="back" href="/">← Inbox</a>
<article class="card">
  <header>
    <div class="sender">
      {#if data.avatar}<img class="avatar" src={data.avatar.src} alt="" width={data.avatar.width} height={data.avatar.height} />
      {:else}<span class="avatar fallback" aria-hidden="true">{(data.senderAddress ?? data.message.sender).slice(0, 2).toUpperCase()}</span>{/if}
      <div>
      <span>From</span>
      <strong>{data.senderAddress ?? data.message.sender}</strong>
      {#if data.senderAddress}<small>{data.message.sender}</small>{/if}
      </div>
    </div>
    {#if data.message.category}<mark>{data.message.category}</mark>{/if}
  </header>
  <div class="body">
    <RichText blocks={data.message.blocks} header={data.message.header} />
  </div>
  <footer>
    <time datetime={data.message.deliveredAt}>{delivered}</time>
    <span>{data.message.messageId}</span>
  </footer>
</article>

<style>
  .back { display: inline-block; margin-bottom: 18px; color: #286446; font-size: 14px; font-weight: 700; text-decoration: none; }
  article { overflow: hidden; }
  article header, footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 20px 24px; }
  article header { border-bottom: 1px solid #e7ebe8; }
  .sender { display: flex; min-width: 0; align-items: center; gap: 12px; }.sender div { display: flex; min-width: 0; flex-direction: column; gap: 5px; }
  .avatar { display: grid; width: 42px; flex: 0 0 42px; height: 42px; place-items: center; border-radius: 13px; object-fit: cover; }
  .fallback { background: #dcece2; color: #17633f; font-size: 12px; font-weight: 800; }
  article header span { color: #778179; font-size: 12px; } article header strong,article header small { overflow: hidden; text-overflow: ellipsis; } article header small { color:#778179;font-family:ui-monospace,monospace;font-size:11px; }
  mark { padding: 6px 10px; border-radius: 999px; background: #e5f2e9; color: #286446; font-size: 12px; font-weight: 700; }
  .body { min-height: 220px; padding: 28px 24px; font-family: ui-serif, Georgia, serif; font-size: 18px; line-height: 1.7; }
  footer { border-top: 1px solid #e7ebe8; color: #778179; font-family: ui-monospace, monospace; font-size: 11px; }
  footer span { overflow: hidden; text-overflow: ellipsis; }
  @media (max-width: 560px) { article header, footer, .body { padding-left: 18px; padding-right: 18px; } footer span { display: none; } }
</style>
