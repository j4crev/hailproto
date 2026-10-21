<script lang="ts">
  import RichText from "$lib/RichText.svelte";
  let { data,form } = $props();
  let delivered = $derived(new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeStyle: "short" }).format(new Date(data.message.deliveredAt)));
</script>

<a class="back" href="/">← Inbox</a>
<article class="card">
  <header>
    <div class="sender">
      {#if data.avatar}<img class="avatar" src={data.avatar.src} alt="" width={data.avatar.width} height={data.avatar.height} />
      {:else}<span class="avatar fallback" aria-hidden="true">{(data.message.senderAddress ?? data.message.sender).slice(0, 2).toUpperCase()}</span>{/if}
      <div>
      <span>From</span>
      <strong>{data.message.senderAddress ?? data.message.sender}</strong>
      {#if data.message.senderAddress}<small>{data.message.sender}</small>{/if}
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
{#if data.canReply}
  <form class="card reply" method="POST" action="?/reply">
    <label>Reply<textarea name="text" rows="5" maxlength="65536" required></textarea></label>
    <label class="check"><input name="allowReply" type="checkbox" value="yes" /> Allow one reply for 7 days</label>
    <button>Send reply</button>
    {#if form?.error}<p role="alert">{form.error}</p>{/if}
  </form>
{:else if data.message.replyUntil}
  <p class="expired">This reply invitation has expired or was already used.</p>
{/if}

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
  .reply{display:grid;gap:14px;margin-top:18px;padding:22px}.reply label{display:grid;gap:7px;color:#3d4c43;font-size:13px;font-weight:750}.reply textarea{width:100%;padding:11px 12px;border:1px solid #ccd5cf;border-radius:10px;font:inherit;resize:vertical}.reply .check{display:flex;align-items:center;gap:8px}.reply .check input{width:auto}.reply button{justify-self:start;padding:10px 15px;border:0;border-radius:10px;background:#17633f;color:white;font-weight:750;cursor:pointer}.reply p,.expired{color:#852f28;font-size:13px}.expired{margin-top:16px}
  @media (max-width: 560px) { article header, footer, .body { padding-left: 18px; padding-right: 18px; } footer span { display: none; } }
</style>
