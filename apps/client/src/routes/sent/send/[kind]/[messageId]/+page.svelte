<script lang="ts">
  import ForwardedPill from "$lib/ForwardedPill.svelte";
  import {forwardedAttribution, messageDisplayContent} from "$lib/messages.js";
  import IdentityDetails from "$lib/IdentityDetails.svelte";
  import DateTime from "$lib/DateTime.svelte";
  import RichText from "$lib/RichText.svelte";
  let {data}=$props();
  const content = $derived(messageDisplayContent(data.message.blocks));
</script>

<svelte:head><title>{data.message.title} · Sent · Haili</title></svelte:head>
<div class="mx-auto max-w-[800px]">
<a class="hail-back" href="/sent">← Sent messages</a>
{#if content.title}<h1 class="reader-title">{content.title}</h1>{:else}<h1 class="sr-only">Sent message</h1>{/if}
<article class="reader-panel overflow-hidden">
  <header class="border-0 border-b border-solid border-line pb-5 text-xs text-muted">{#if forwardedAttribution(data.message.blocks)}<div class="mb-3"><ForwardedPill /></div>{/if}{#if !forwardedAttribution(data.message.blocks) && data.message.kind === 'category' && data.message.category}
      <div class="mb-3 flex flex-wrap gap-2"><mark class="max-w-full rounded-full bg-brand-soft px-3 py-1.5 text-xs font-semibold text-brand-strong [overflow-wrap:anywhere]">{data.message.category === 'general' ? 'General' : data.message.category}</mark></div>
    {:else if data.message.recipientSummary?.count === 1}
      <p class="m-0 mb-3 text-sm font-semibold text-ink [overflow-wrap:anywhere]">{data.message.recipientSummary.address ?? data.message.recipientSummary.did}</p>{#if data.message.recipientSummary.did && data.message.recipientSummary.address}<IdentityDetails did={data.message.recipientSummary.did} />{/if}
    {:else if data.message.kind === 'connections' && data.message.recipients && data.message.recipients.length > 1}
      <details class="mb-3 text-sm text-ink">
        <summary class="cursor-pointer font-semibold">Recipients ({data.message.recipients.length})</summary>
        <ul class="m-0 mt-2 grid max-h-60 gap-2 overflow-y-auto pl-5" aria-label="Message recipients">
          {#each data.message.recipients as recipient}<li class="[overflow-wrap:anywhere]">{recipient.address ?? recipient.did}{#if recipient.address}<IdentityDetails did={recipient.did} />{/if}</li>{/each}
        </ul>
      </details>
    {/if}
    <DateTime value={data.message.createdAt} /></header>
  <div class="reading-body"><RichText blocks={content.blocks} header={data.message.header}/></div>
</article>

</div>
