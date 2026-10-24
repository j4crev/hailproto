<script lang="ts">
  import RichText from "$lib/RichText.svelte";
  import {deliveryDescription,deliveryIcon} from "$lib/delivery-status.js";
  let {data,form}=$props();
  let created=$derived(new Intl.DateTimeFormat(undefined,{dateStyle:"long",timeStyle:"short"}).format(new Date(data.message.createdAt)));
  let icon=$derived(deliveryIcon(data.message.state));
</script>

<a class="mb-[18px] inline-block text-[14px] font-bold text-[#286446] no-underline" href="/sent">← Sent</a>
<article class="hail-card overflow-hidden">
  <header class="flex items-center justify-between gap-4 border-0 border-b border-solid border-[#e7ebe8] px-6 py-5 max-[560px]:px-[18px]"><div class="flex min-w-0 flex-col gap-[5px]"><span class="text-[12px] text-[#778179]">To</span><strong class="overflow-hidden text-ellipsis">{data.message.recipientAddress??data.message.recipient}</strong>{#if data.message.recipientAddress}<small class="overflow-hidden font-mono text-[11px] text-ellipsis text-[#778179]">{data.message.recipient}</small>{/if}</div><span class={["text-[12px] font-[750] capitalize whitespace-nowrap",data.message.state==='accepted'?"text-[#168244]":"text-[#202723]"]} aria-label={`Status: ${data.message.state}`}><b class="text-[17px]" aria-hidden="true">{icon}</b> {data.message.state}</span></header>
  <section class="flex items-center justify-between gap-4 bg-[#f1f5f2] px-6 py-3.5 text-[13px] text-[#4b5b52] max-[560px]:flex-col max-[560px]:items-start"><p class="m-0">{deliveryDescription(data.message)}</p>{#if data.message.state==='indeterminate'}<form method="POST" action="?/retry"><button class="cursor-pointer rounded-lg border-0 bg-[#17633f] px-[11px] py-2 font-[750] whitespace-nowrap text-white">Retry submission</button></form>{/if}{#if form?.error}<p class="m-0 text-[#852f28]" role="alert">{form.error}</p>{/if}</section>
  <div class="min-h-[220px] px-6 py-7 font-serif text-[18px] leading-[1.7] max-[560px]:px-[18px]"><RichText blocks={data.message.blocks} header={data.message.header}/></div>
  <footer class="flex items-center justify-between gap-4 border-0 border-t border-solid border-[#e7ebe8] px-6 py-5 font-mono text-[11px] text-[#778179] max-[560px]:px-[18px]"><time datetime={data.message.createdAt}>{created}</time><span class="overflow-hidden text-ellipsis max-[560px]:hidden">{data.message.messageId}</span></footer>
</article>
