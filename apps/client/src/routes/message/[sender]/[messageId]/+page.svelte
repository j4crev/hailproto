<script lang="ts">
  import DeleteMessage from "$lib/DeleteMessage.svelte";
  import Unsubscribe from "$lib/Unsubscribe.svelte";
  import RichText from "$lib/RichText.svelte";
  let { data,form } = $props();
  let delivered = $derived(new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeStyle: "short" }).format(new Date(data.message.deliveredAt)));
</script>

<svelte:head><title>Message · Haili</title></svelte:head>
<div class="mx-auto max-w-[860px]">
<a class="hail-back" href={data.message.kind==='connection'?'/?view=connections':'/'}>← {data.message.kind==='connection'?'Messages':'Inbox'}</a>
<h1 class="sr-only">Received message</h1>
<div class="mb-5"><DeleteMessage sender={data.message.sender} messageId={data.message.messageId} returnTo={data.message.kind==='connection'?'/?view=connections':'/'} /></div>
<article class="hail-card overflow-hidden">
  <header class="flex flex-wrap items-center justify-between gap-4 border-0 border-b border-solid border-line p-5 sm:px-7">
    <div class="flex min-w-0 items-center gap-3">
      {#if data.avatar}<img class="grid size-[42px] flex-[0_0_42px] place-items-center rounded-[13px] object-cover" src={data.avatar.src} alt="" width={data.avatar.width} height={data.avatar.height} />
      {:else}<span class="grid size-[42px] flex-[0_0_42px] place-items-center rounded-[13px] bg-brand-soft text-xs font-bold text-brand" aria-hidden="true">{(data.message.senderAddress ?? data.message.sender).slice(0, 2).toUpperCase()}</span>{/if}
      <div class="flex min-w-0 flex-col gap-[5px]">
      <span class="text-xs text-muted">From</span>
      <strong class="[overflow-wrap:anywhere]">{data.message.senderAddress ?? data.message.sender}</strong>
      {#if data.message.senderAddress}<small class="font-mono text-xs text-muted [overflow-wrap:anywhere]">{data.message.sender}</small>{/if}
      </div>
    </div>
    {#if data.message.kind==='connection'}<mark class="rounded-full bg-brand-soft px-3 py-1.5 text-xs font-semibold text-brand-strong">Connection</mark>{:else if data.message.category}<mark class="max-w-full rounded-full bg-brand-soft px-3 py-1.5 text-xs font-semibold text-brand-strong [overflow-wrap:anywhere]">{data.message.category==='general'?'General':data.message.category}</mark>{/if}
    {#if data.message.kind !== 'connection'}
      <section class="grid w-full min-w-0 justify-items-end gap-3 [&>p]:w-full [&>section]:w-full" aria-label="Sender subscription">
        {#if data.account.custodyProfile !== 'managed'}<p class="text-sm text-muted">Unsubscribing from this owner-controlled account requires your existing signer.</p>
        {:else if data.subscriptionUnavailable}<p class="text-sm text-muted" role="status">Couldn’t check your subscription. Reload this message to try again.</p>
        {:else if data.subscription}{#key `${data.subscription.grantId}:${data.subscription.revision}`}<Unsubscribe subscription={data.subscription} owner={data.account.did} />{/key}
        {:else}<p class="text-sm text-muted">You have no active subscription to this sender. This saved message remains available.</p>{/if}
      </section>
    {/if}
  </header>
  <div class="min-h-[220px] px-5 py-8 font-serif text-[18px] leading-[1.7] [overflow-wrap:anywhere] sm:px-7">
    <RichText blocks={data.message.blocks} header={data.message.header} />
  </div>
  <footer class="flex flex-wrap items-center justify-between gap-3 border-0 border-t border-solid border-line p-5 text-xs text-muted sm:px-7">
    <time datetime={data.message.deliveredAt}>{delivered}</time>
    <details><summary class="cursor-pointer py-2">Message ID</summary><code class="[overflow-wrap:anywhere]">{data.message.messageId}</code></details>
  </footer>
</article>
{#if data.message.connection?.active}<a class="hail-button mt-6" href={`/compose?audience=connections&connection=${data.message.connection.id}`}>Message this connection →</a>
{:else if data.message.kind==='connection'}<p class="mt-5 rounded-xl bg-warning-soft p-4 text-sm text-warning">This connection is no longer active. Existing delivered messages remain readable.</p>
{:else if data.canReply}
  <form class="hail-card mt-6 grid gap-4 p-5 sm:p-7" method="POST" action="?/reply">
    <label class="hail-field">Reply<textarea class="resize-y" name="text" rows="5" maxlength="65536" required></textarea></label>
    <p class="m-0 text-xs text-muted">This invitation currently allows one reply before {new Date(data.message.replyUntil!*1000).toLocaleString()}.</p>
    <label class="flex min-h-11 items-center gap-3 text-sm"><input name="allowReply" type="checkbox" value="yes" /> Allow one reply for 7 days</label>
    <button class="hail-button justify-self-start">Send reply</button>
    {#if form?.error}<p class="hail-error" role="alert">{form.error}</p>{/if}
  </form>
{:else if data.message.replyUntil}
  <p class="mt-5 rounded-xl bg-warning-soft p-4 text-sm text-warning">This reply invitation has expired or was already used.</p>
{/if}

</div>
