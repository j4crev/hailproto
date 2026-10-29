<script lang="ts">
  import DateTime from "$lib/DateTime.svelte";
  import RichText from "$lib/RichText.svelte";
  let {data}=$props();
</script>

<svelte:head><title>{data.message.title} · Sent · Haili</title></svelte:head>
<a class="hail-back" href="/sent">← Sent messages</a>
<h1 class="sr-only">{data.message.title}</h1>
<article class="hail-card overflow-hidden">
  <header class="border-0 border-b border-solid border-line p-5 text-xs text-muted sm:px-7">{#if data.message.kind === 'connections' && data.message.recipients}
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
