<script lang="ts">
  import QuotedMessage from "$lib/QuotedMessage.svelte";
  import MessageThread from "$lib/MessageThread.svelte";
  import {replyExcerpt} from "$lib/reply.js";
  import {forwardHref} from "$lib/forward.js";
  import ForwardedPill from "$lib/ForwardedPill.svelte";
  import {forwardedAttribution, messageDisplayContent} from "$lib/messages.js";
  import {tick} from "svelte";
  import {mailboxRequest} from "$lib/mailbox.js";
  import {goto, invalidate} from "$app/navigation";
  import Icon from "$lib/Icon.svelte";
  import DateTime from "$lib/DateTime.svelte";
  import ContactAddress from "$lib/ContactAddress.svelte";
  import MessageActions from "$lib/MessageActions.svelte";
  import Unsubscribe from "$lib/Unsubscribe.svelte";
  let { data,form } = $props();
  let opened = '';
  let failedAvatar = $state(''), avatarImage = $state<HTMLImageElement>();
  $effect(() => {
    const element=avatarImage, src=data.avatar?.src;
    if (!element || !src) return;
    const failed=()=>{failedAvatar=src;};
    element.addEventListener('error',failed);
    if(element.complete && !element.naturalWidth)failed();
    return ()=>element.removeEventListener('error',failed);
  });
  let unsubscribe = $state<Unsubscribe>(), unsubscribed = $state(false);
  $effect(() => { data.message.sender; data.message.messageId; unsubscribed = false; });
  const canUnsubscribe = $derived(data.message.kind !== 'connection' && data.account.custodyProfile === 'managed' && !!data.subscription && !unsubscribed);
  let readError = $state(''), readPending = $state(true);
  $effect(() => {
    const message = data.message, key = `${message.sender}/${message.messageId}`;
    if (message.trashedAt) { readPending = false; return; }
    if (opened === key) return;
    opened = key;
    readError = ''; readPending = true;
    void mailboxRequest(`inbox/${encodeURIComponent(message.sender)}/${encodeURIComponent(message.messageId)}/mark-read`, {})
      .then(() => invalidate('hail:mailbox')).catch(() => { readError = 'Unable to mark this message read. Reload to try again.'; }).finally(() => { readPending = false; });
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
      {#if data.avatar && failedAvatar !== data.avatar.src}<img class="grid size-[42px] flex-[0_0_42px] place-items-center rounded-[13px] object-cover" src={data.avatar.src} bind:this={avatarImage} alt="" width={data.avatar.width} height={data.avatar.height} />
      {:else}<span class="grid size-[42px] flex-[0_0_42px] place-items-center rounded-[13px] bg-brand-soft text-xs font-bold text-brand" aria-hidden="true">{(data.message.senderAddress ?? data.message.sender).slice(0, 2).toUpperCase()}</span>{/if}
      <div class="flex min-w-0 flex-col gap-[5px]">
      <strong class="[overflow-wrap:anywhere]"><ContactAddress owner={data.account.did} did={data.message.sender} address={data.message.senderAddress} /></strong>
      <span class="text-xs text-muted"><DateTime value={data.message.deliveredAt} /></span>
      {#if data.message.senderAddress}<small class="font-mono text-[11px] text-muted [overflow-wrap:anywhere] sm:text-xs">{data.message.sender}</small>{/if}
      </div>
    </div>
    <div class="flex w-full min-w-0 flex-wrap items-center gap-1">
      {#if forwardedAttribution(data.message.blocks)}<ForwardedPill />
      {:else if data.message.kind!=='connection' && data.message.category}<mark class="max-w-full rounded-full bg-brand-soft px-2 py-1.5 text-xs font-semibold text-brand-strong [overflow-wrap:anywhere]">{data.message.category==='general'?'General':data.message.category}</mark>{/if}
      <div class="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-0.5 [&>section]:w-full [&>p]:w-full">
        {#if data.message.trashedAt}
          <button class="hail-button-secondary" disabled={restoring} onclick={restore}>Restore</button>
        {:else}
        <button disabled={!data.canReply} bind:this={replyButton} class="hail-icon-button compact" type="button" aria-label="Reply" title="Reply" aria-expanded={replyOpen} aria-controls="message-reply" onclick={openReply}><Icon name="reply" /></button>
        <a class="hail-icon-button compact" aria-label="Forward" title="Forward" href={forwardHref(data.message)}><Icon name="forward" /></a>
        <MessageActions compact menu onunsubscribe={canUnsubscribe ? () => { void unsubscribe?.open(); } : undefined} disabled={readPending} messages={[data.message]} returnTo={data.message.kind==='connection'?'/?view=connections':'/'} />
        {/if}
      </div>
      {#if !data.message.trashedAt && data.message.kind !== 'connection' && data.account.custodyProfile === 'managed' && data.subscription}
        <div class="w-full empty:hidden">{#key `${data.message.messageId}:${data.subscription.grantId}:${data.subscription.revision}`}<Unsubscribe bind:this={unsubscribe} hideTrigger subscription={data.subscription} owner={data.account.did} ondone={() => { unsubscribed = true; }} />{/key}</div>
      {/if}
      {#if !data.message.trashedAt && data.message.kind !== 'connection' && data.account.custodyProfile === 'managed'}
        {#if data.subscriptionUnavailable}<p class="w-full text-sm text-muted" role="status">Couldn’t check your subscription. Reload this message to try again.</p>
        {:else if !data.subscription}<p class="w-full text-sm text-muted">You have no active subscription to this sender. This saved message remains available.</p>{/if}
      {/if}
    </div>
  </header>
  <div class="min-h-[220px] px-5 py-8 font-serif text-[18px] leading-[1.7] [overflow-wrap:anywhere] sm:px-7">
    <QuotedMessage blocks={content.blocks} header={data.message.header} />
  </div>
</article>
{#if !data.message.trashedAt}
{#if data.message.kind==='connection' && !data.message.connection?.active}<p class="mt-5 rounded-xl bg-warning-soft p-4 text-sm text-warning">This connection is no longer active. Existing delivered messages remain readable.</p>
{:else if data.canReply}
  {#if replyOpen}
  <form id="message-reply" class="hail-card mt-6 grid gap-4 p-5 sm:p-7" method="POST" action="?/reply">
    <input type="hidden" name="messageId" value={form?.messageId??data.newReplyId}/>
    <input type="hidden" name="replyUntil" value={form?.replyUntil??data.newReplyUntil}/>
    <label class="hail-field">Reply<textarea bind:this={replyInput} class="resize-y" name="text" rows="5" maxlength="65536" required value={form?.text??""}></textarea></label>
    <details><summary class="cursor-pointer text-sm text-muted">Quoted message from {data.message.senderAddress??data.message.sender}</summary><blockquote class="ml-0 whitespace-pre-wrap border-0 border-l-2 border-solid border-brand pl-4 text-sm text-muted">{replyExcerpt(data.message)}</blockquote></details>
    {#if data.message.kind!=='connection'}<p class="m-0 text-xs text-muted">This invitation currently allows one reply before <DateTime value={data.message.replyUntil!*1000} />.</p>
    <label class="flex min-h-11 items-center gap-3 text-sm"><input name="allowReply" type="checkbox" value="yes" checked={form?.allowReply??false} /> Allow one reply for 7 days</label>{/if}
    <div class="flex flex-wrap gap-3"><button class="hail-button" type="submit">Send reply</button><button class="hail-button-secondary" type="button" onclick={cancelReply}>Cancel</button></div>

  </form>
  {/if}
{:else if data.message.replyUntil}
  <p class="mt-5 rounded-xl bg-warning-soft p-4 text-sm text-warning">This reply invitation has expired or was already used.</p>
{/if}

{/if}
{#if form?.error}<p class="hail-error" role="alert">{form.error} {#if form.messageId}<a href={`/sent/${form.messageId}`}>Check sent status</a>{/if}</p>{/if}
<MessageThread thread={data.thread} unavailable={data.threadUnavailable} selected={data.message}/>
</div>
