<script lang="ts">
  import DateTime from "$lib/DateTime.svelte";
  import RichText from "$lib/RichText.svelte";
  let {data}=$props();
</script>

<svelte:head><title>{data.message.title} · Sent · Haili</title></svelte:head>
<a class="hail-back" href="/sent">← Sent messages</a>
<h1 class="sr-only">{data.message.title}</h1>
<article class="hail-card overflow-hidden">
  <header class="border-0 border-b border-solid border-line p-5 text-xs text-muted sm:px-7">{#if data.message.kind === 'category' && data.message.category}
      <div class="mb-3 flex flex-wrap gap-2"><mark class="max-w-full rounded-full bg-brand-soft px-3 py-1.5 text-xs font-semibold text-brand-strong [overflow-wrap:anywhere]">{data.message.category === 'general' ? 'General' : data.message.category}</mark></div>
    {:else if data.message.recipientSummary?.count === 1}
      <p class="m-0 mb-3 text-sm font-semibold text-ink [overflow-wrap:anywhere]">{data.message.recipientSummary.address ?? data.message.recipientSummary.did}</p>
    {:else if data.message.kind === 'connections' && data.message.recipients && data.message.recipients.length > 1}
      <details class="mb-3 text-sm text-ink">
        <summary class="cursor-pointer font-semibold">Recipients ({data.message.recipients.length})</summary>
        <ul class="m-0 mt-2 grid max-h-60 gap-2 overflow-y-auto pl-5" aria-label="Message recipients">
          {#each data.message.recipients as recipient}<li class="[overflow-wrap:anywhere]">{recipient.address ?? recipient.did}</li>{/each}
        </ul>
      </details>
    {/if}
    <DateTime value={data.message.createdAt} /></header>
  <div class="min-h-[220px] px-5 py-8 font-serif text-[18px] leading-[1.7] [overflow-wrap:anywhere] sm:px-7"><RichText blocks={data.message.blocks} header={data.message.header}/></div>
</article>
