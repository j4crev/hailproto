<script lang="ts">
  import {invalidateAll} from "$app/navigation";
  import {deliveryIcon} from "$lib/delivery-status.js";
  let {data}=$props();
  let refreshing=$state(false);
  const date=(value:string)=>new Intl.DateTimeFormat(undefined,{dateStyle:"medium",timeStyle:"short"}).format(new Date(value));
  async function refresh(){refreshing=true;try{await invalidateAll();}finally{refreshing=false;}}
</script>

{#if !data.configured}
  <section class="hail-card p-[30px] text-center text-[#69756e]">Connect the canary to view sent messages.</section>
{:else}
  <section class="mb-6 flex items-end justify-between max-[560px]:flex-col max-[560px]:items-start max-[560px]:gap-3.5"><div><p class="m-0 mb-[7px] text-[12px] font-extrabold tracking-[.12em] text-[#22714b] uppercase">Sent</p><h1 class="m-0 mb-[5px] text-[32px]">{data.account.address}</h1><small class="text-[#748078]">{data.account.did}</small></div><div class="flex gap-2"><button class="cursor-pointer rounded-[10px] border-0 bg-[#e5ece7] px-3.5 py-2.5 [font:inherit] text-[13px]! font-[750]! text-[#28513c] disabled:cursor-not-allowed disabled:opacity-60" type="button" onclick={refresh} disabled={refreshing}>{refreshing?'Refreshing…':'Refresh'}</button><a class="cursor-pointer rounded-[10px] border-0 bg-[#17633f] px-3.5 py-2.5 [font:inherit] text-[13px]! font-[750]! text-white no-underline" href="/compose">Compose</a></div></section>
  {#if data.messages.length}
    <section class="grid gap-[13px]" aria-label="Sent messages">
      {#each data.messages as message}
        <a class="hail-card grid overflow-hidden text-inherit no-underline" href={`/sent/${message.messageId}`}>
          <div class="flex items-center justify-between gap-3 px-[18px] pt-4 max-[560px]:items-start"><div class="flex min-w-0 flex-col gap-[3px]"><strong class="truncate text-[14px] max-[560px]:whitespace-normal">To {message.recipientAddress??message.recipient}</strong>{#if message.recipientAddress}<small class="truncate font-mono text-[11px] text-[#778179]">{message.recipient}</small>{/if}</div><span class={["text-[12px] font-[750] capitalize whitespace-nowrap",message.state==='accepted'?"text-[#168244]":"text-[#202723]"]} aria-label={`Status: ${message.state}`} title={message.reason??undefined}><b class="text-[16px]" aria-hidden="true">{deliveryIcon(message.state)}</b> {message.state}</span></div>
          {#if message.header}<img class="mt-3.5 max-h-[220px] w-full object-cover" src={message.header.src} alt={message.header.alt} width={message.header.width} height={message.header.height}/>{/if}
          <p class="mx-[18px] mt-[15px] mb-2.5 leading-[1.5] text-[#354139]">{message.preview}</p><time class="mx-[18px] mb-4 text-[11px] text-[#778179]" datetime={message.createdAt}>{date(message.createdAt)}</time>
        </a>
      {/each}
    </section>
    {#if data.paged||data.next}<nav class="mt-[18px] flex justify-center gap-[22px] [&_a]:text-[13px] [&_a]:font-[750] [&_a]:text-[#286446] [&_a]:no-underline">{#if data.paged}<a href="/sent">← Newest messages</a>{/if}{#if data.next}<a href={`/sent?after=${encodeURIComponent(data.next)}`}>Older messages →</a>{/if}</nav>{/if}
  {:else}<section class="hail-card p-[30px] text-center"><h2 class="mt-0">No sent messages</h2><p class="text-[#69756e]">Messages you send will appear here.</p></section>{/if}
{/if}
