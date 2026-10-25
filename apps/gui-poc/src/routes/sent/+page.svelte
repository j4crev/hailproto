<script lang="ts">
  import {invalidateAll} from "$app/navigation";
  import {deliveryIcon} from "$lib/delivery-status.js";
  let {data}=$props();
  let refreshing=$state(false);
  const date=(value:string)=>new Intl.DateTimeFormat(undefined,{dateStyle:"medium",timeStyle:"short"}).format(new Date(value));
  async function refresh(){refreshing=true;try{await invalidateAll();}finally{refreshing=false;}}
</script>

<svelte:head><title>Sent · Haili</title></svelte:head>
  <header class="mb-8 flex flex-wrap items-start justify-between gap-4"><div class="grid min-w-0 gap-3"><p class="hail-eyebrow">Your outbox</p><h1 class="hail-title">Sent messages</h1><p class="m-0 text-sm text-muted [overflow-wrap:anywhere]">{data.account.address}</p><p class="m-0 text-xs text-muted">Delivery status tells you where a message stands—not whether it was read.</p></div><button class="hail-button-secondary" type="button" onclick={refresh} disabled={refreshing}>{refreshing?'Refreshing…':'Refresh'}</button></header>
  {#if data.messages.length}
    <section class="grid gap-[13px]" aria-label="Sent messages">
      {#each data.messages as message}
        <a class="hail-card grid min-w-0 overflow-hidden text-inherit no-underline hover:border-brand" href={`/sent/${message.messageId}`}>
          <div class="flex flex-wrap items-center justify-between gap-3 px-5 pt-5"><div class="grid min-w-0 gap-1"><strong class="text-sm [overflow-wrap:anywhere]">To {message.recipientAddress??message.recipient}</strong>{#if message.recipientAddress}<small class="font-mono text-xs text-muted [overflow-wrap:anywhere]">{message.recipient}</small>{/if}</div><span class={["rounded-full px-3 py-1.5 text-xs font-semibold capitalize",message.state==='failed'||message.state==='cancelled'?"bg-danger-soft text-danger":message.state==='on-hold'||message.state==='indeterminate'?"bg-warning-soft text-warning":"bg-brand-soft text-brand-strong"]} aria-label={`Status: ${message.state}`} title={message.reason??undefined}><b aria-hidden="true">{deliveryIcon(message.state)}</b> {message.state}</span></div>
          {#if message.header}<img class="mt-3.5 max-h-[220px] w-full object-cover" src={message.header.src} alt={message.header.alt} width={message.header.width} height={message.header.height}/>{/if}
          {#if message.kind==='connection'}<small class="mx-5 mt-3 font-semibold text-brand">Connection message</small>{/if}
          <p class="mx-5 mt-4 mb-3 font-serif text-[17px] leading-relaxed [overflow-wrap:anywhere]">{message.preview}</p><time class="mx-5 mb-5 text-xs text-muted" datetime={message.createdAt}>{date(message.createdAt)}</time>
        </a>
      {/each}
    </section>
    {#if data.paged||data.next}<nav aria-label="Sent pages" class="mt-6 flex flex-wrap justify-center gap-3">{#if data.paged}<a class="hail-button-secondary" href="/sent">← Newest messages</a>{/if}{#if data.next}<a class="hail-button-secondary" href={`/sent?after=${encodeURIComponent(data.next)}`}>Older messages →</a>{/if}</nav>{/if}
  {:else}<section class="hail-card grid justify-items-center gap-3 px-6 py-14 text-center"><h2 class="m-0 text-xl">No sent messages</h2><p class="m-0 text-sm text-muted">Messages you send will appear here, along with their delivery status.</p><a class="hail-button-secondary mt-2" href="/compose">Compose a message →</a></section>{/if}
