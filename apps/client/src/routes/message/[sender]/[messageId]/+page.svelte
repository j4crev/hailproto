<script lang="ts">
  import {messageDisplayContent} from "$lib/messages.js";
  import {tick} from "svelte";
  import {mailboxRequest} from "$lib/mailbox.js";
  import {goto, invalidateAll} from "$app/navigation";
  import Icon from "$lib/Icon.svelte";
  import DateTime from "$lib/DateTime.svelte";
  import ContactAddress from "$lib/ContactAddress.svelte";
  import MessageActions from "$lib/MessageActions.svelte";
  import Unsubscribe from "$lib/Unsubscribe.svelte";
  import RichText from "$lib/RichText.svelte";
  let { data,form } = $props();
  let opened = '';
  let readError = $state(''), readPending = $state(true);
  $effect(() => {
    const message = data.message, key = `${message.sender}/${message.messageId}`;
    if (message.trashedAt) { readPending = false; return; }
    if (opened === key) return;
    opened = key;
    readError = ''; readPending = true;
    void mailboxRequest(`inbox/${encodeURIComponent(message.sender)}/${encodeURIComponent(message.messageId)}/mark-read`, {})
      .then(() => invalidateAll()).catch(() => { readError = 'Unable to mark this message read. Reload to try again.'; }).finally(() => { readPending = false; });
  });
  let restoring = $state(false), restoreError = $state('');
  async function restore() {
    restoring = true; restoreError = '';
    try {
      const result = await mailboxRequest('trash/restore', {messages: [{sender: data.message.sender, messageId: data.message.messageId}]});
      if (result.restored !== 1) throw new Error('This message could not be restored. It may have expired or already been restored.');
      await goto('/trash', {invalidateAll: true});
    } catch (error) { restoreError = error instanceof Error ? error.message : 'Unable to restore message.'; }
    finally { restoring = false; }
  }
  let replyOpen = $state(false), replyInput = $state<HTMLTextAreaElement>(), replyButton = $state<HTMLButtonElement>();
  $effect(() => {
    // Reset when navigating between messages; reveal submission errors on return.
    data.message.sender; data.message.messageId;
    replyOpen = !!form?.error;
  });
  async function openReply() {
    replyOpen = true;
    await tick();
    replyInput?.focus();
  }
  function cancelReply() {
    replyInput?.form?.reset();
    replyOpen = false;
    replyButton?.focus();
  }
  const content = $derived(messageDisplayContent(data.message.blocks));
</script>

<svelte:head><title>Message · Haili</title></svelte:head>
<div class="message-detail mx-auto max-w-[860px]">
<a class="hail-back" href={data.message.trashedAt?'/trash':data.message.kind==='connection'?'/?view=connections':'/'}>← {data.message.trashedAt?'Trash':data.message.kind==='connection'?'Messages':'Inbox'}</a>
{#if content.title}<h1 class="mb-5 mt-0 text-2xl font-semibold leading-tight [overflow-wrap:anywhere] sm:text-3xl">{content.title}</h1>{:else}<h1 class="sr-only">Received message</h1>{/if}
{#if restoreError}<p class="hail-error" role="alert">{restoreError}</p>{/if}
{#if readError}<p class="hail-error" role="alert">{readError}</p>{/if}
<article class="hail-card overflow-hidden">
  <header class="flex flex-wrap items-center justify-between gap-4 border-0 border-b border-solid border-line p-5 sm:px-7">
    <div class="flex min-w-0 items-center gap-3">
      {#if data.avatar}<img class="grid size-[42px] flex-[0_0_42px] place-items-center rounded-[13px] object-cover" src={data.avatar.src} alt="" width={data.avatar.width} height={data.avatar.height} />
      {:else}<span class="grid size-[42px] flex-[0_0_42px] place-items-center rounded-[13px] bg-brand-soft text-xs font-bold text-brand" aria-hidden="true">{(data.message.senderAddress ?? data.message.sender).slice(0, 2).toUpperCase()}</span>{/if}
      <div class="flex min-w-0 flex-col gap-[5px]">
      <strong class="[overflow-wrap:anywhere]"><ContactAddress owner={data.account.did} did={data.message.sender} address={data.message.senderAddress} /></strong>
      <span class="text-xs text-muted"><DateTime value={data.message.deliveredAt} /></span>
      {#if data.message.senderAddress}<small class="font-mono text-[11px] text-muted [overflow-wrap:anywhere] sm:text-xs">{data.message.sender}</small>{/if}
      </div>
    </div>
    <div class="flex w-full min-w-0 flex-wrap items-center gap-3">
      {#if data.message.kind!=='connection' && data.message.category}<mark class="max-w-full rounded-full bg-brand-soft px-3 py-1.5 text-xs font-semibold text-brand-strong [overflow-wrap:anywhere]">{data.message.category==='general'?'General':data.message.category}</mark>{/if}
      <div class="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2 [&>section]:w-full [&>p]:w-full">
        {#if data.message.trashedAt}
          <button class="hail-button-secondary" disabled={restoring} onclick={restore}>Restore</button>
        {:else}
        {#if data.message.kind !== 'connection' && data.account.custodyProfile === 'managed' && data.subscription}
          {#key `${data.subscription.grantId}:${data.subscription.revision}`}<Unsubscribe compact subscription={data.subscription} owner={data.account.did} />{/key}
        {/if}
        {#if data.message.connection?.active}<a class="hail-icon-button compact" aria-label="Reply" title="Reply" href={`/compose?audience=connections&connection=${data.message.connection.id}`}><Icon name="reply" /></a>
        {:else if data.message.kind !== 'connection'}<button disabled={!data.canReply} bind:this={replyButton} class="hail-icon-button compact" type="button" aria-label="Reply" title="Reply" aria-expanded={replyOpen} aria-controls="subscription-reply" onclick={openReply}><Icon name="reply" /></button>{/if}
        <MessageActions compact menu disabled={readPending} messages={[data.message]} returnTo={data.message.kind==='connection'?'/?view=connections':'/'} />
        {/if}
      </div>
      {#if !data.message.trashedAt && data.message.kind !== 'connection' && data.account.custodyProfile === 'managed'}
        {#if data.subscriptionUnavailable}<p class="w-full text-sm text-muted" role="status">Couldn’t check your subscription. Reload this message to try again.</p>
        {:else if !data.subscription}<p class="w-full text-sm text-muted">You have no active subscription to this sender. This saved message remains available.</p>{/if}
      {/if}
    </div>
  </header>
  <div class="min-h-[220px] px-5 py-8 font-serif text-[18px] leading-[1.7] [overflow-wrap:anywhere] sm:px-7">
    <RichText blocks={content.blocks} header={data.message.header} />
  </div>
</article>
{#if !data.message.trashedAt}
{#if data.message.kind==='connection' && !data.message.connection?.active}<p class="mt-5 rounded-xl bg-warning-soft p-4 text-sm text-warning">This connection is no longer active. Existing delivered messages remain readable.</p>
{:else if data.message.kind!=='connection' && data.canReply}
  {#if replyOpen}
  <form id="subscription-reply" class="hail-card mt-6 grid gap-4 p-5 sm:p-7" method="POST" action="?/reply">
    <label class="hail-field">Reply<textarea bind:this={replyInput} class="resize-y" name="text" rows="5" maxlength="65536" required></textarea></label>
    <p class="m-0 text-xs text-muted">This invitation currently allows one reply before <DateTime value={data.message.replyUntil!*1000} />.</p>
    <label class="flex min-h-11 items-center gap-3 text-sm"><input name="allowReply" type="checkbox" value="yes" /> Allow one reply for 7 days</label>
    <div class="flex flex-wrap gap-3"><button class="hail-button" type="submit">Send reply</button><button class="hail-button-secondary" type="button" onclick={cancelReply}>Cancel</button></div>
    {#if form?.error}<p class="hail-error" role="alert">{form.error}</p>{/if}
  </form>
  {/if}
{:else if data.message.replyUntil}
  <p class="mt-5 rounded-xl bg-warning-soft p-4 text-sm text-warning">This reply invitation has expired or was already used.</p>
{/if}

{/if}
</div>
