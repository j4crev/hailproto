<script lang="ts">
  import DateTime from "$lib/DateTime.svelte";
  import {invalidateAll} from "$app/navigation";
  let {data}=$props();
  let refreshing=$state(false);
  async function refresh(){refreshing=true;try{await invalidateAll();}finally{refreshing=false;}}
</script>

<svelte:head><title>Sent · Haili</title></svelte:head>
  <header class="mb-8 flex flex-wrap items-start justify-between gap-4"><div class="grid min-w-0 gap-3"><h1 class="hail-title">Sent messages</h1></div><button class="hail-button-secondary" type="button" onclick={refresh} disabled={refreshing}>{refreshing?'Refreshing…':'Refresh'}</button></header>
  {#if data.messages.length}
    <section class="grid gap-[13px]" aria-label="Sent messages">
      {#each data.messages as message}
        <a class="hail-card grid min-w-0 overflow-hidden text-inherit no-underline hover:border-brand" href={`/sent/send/${message.kind}/${message.messageId}`}>
          <div class="grid min-w-0 gap-2 px-5 pt-5"><h2 class="m-0 text-lg [overflow-wrap:anywhere]">{message.title}</h2><small class="text-muted">{message.kind==='category'?`Category: ${message.category}`:message.kind==='connections'?'Connections':'Message'}</small></div>
          {#if message.header}<img class="mt-3.5 max-h-[220px] w-full object-cover" src={message.header.src} alt={message.header.alt} width={message.header.width} height={message.header.height}/>{/if}
          <p class="mx-5 mt-4 mb-3 font-serif text-[17px] leading-relaxed [overflow-wrap:anywhere]">{message.preview}</p><span class="mx-5 mb-5 text-xs text-muted"><DateTime format="list" value={message.createdAt} /></span>
        </a>
      {/each}
    </section>
    {#if data.paged||data.next}<nav aria-label="Sent pages" class="mt-6 flex flex-wrap justify-center gap-3">{#if data.paged}<a class="hail-button-secondary" href="/sent">← Newest messages</a>{/if}{#if data.next}<a class="hail-button-secondary" href={`/sent?after=${encodeURIComponent(data.next)}`}>Older messages →</a>{/if}</nav>{/if}
  {:else}<section class="hail-card grid justify-items-center gap-3 px-6 py-14 text-center"><h2 class="m-0 text-xl">No sent messages</h2><p class="m-0 text-sm text-muted">Messages you send will appear here.</p><a class="hail-button-secondary mt-2" href="/compose">Compose a message →</a></section>{/if}
