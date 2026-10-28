<script lang="ts">
  import DateTime from "$lib/DateTime.svelte";
  import ContactAddress from "$lib/ContactAddress.svelte";
  import RichText from "$lib/RichText.svelte";
  import DeliveryIcon from "$lib/DeliveryIcon.svelte";
  import {deliveryDescription} from "$lib/delivery-status.js";
  let {data,form}=$props();
</script>

<svelte:head><title>Sent message · Haili</title></svelte:head>
<a class="hail-back" href="/sent">← Sent messages</a>
<h1 class="sr-only">Sent message</h1>
<article class="hail-card overflow-hidden">
  <header class="flex flex-wrap items-center justify-between gap-4 border-0 border-b border-solid border-line p-5 sm:px-7"><div class="grid min-w-0 gap-1"><span class="text-xs text-muted">To</span><strong class="[overflow-wrap:anywhere]"><ContactAddress owner={data.message.sender} did={data.message.recipient} address={data.message.recipientAddress} /></strong><span class="text-xs text-muted"><DateTime value={data.message.createdAt} /></span>{#if data.message.recipientAddress}<small class="font-mono text-[11px] text-muted [overflow-wrap:anywhere] sm:text-xs">{data.message.recipient}</small>{/if}</div><span class="rounded-full bg-canvas px-3 py-1.5 text-xs font-semibold capitalize" aria-label={`Status: ${data.message.state}`}><DeliveryIcon state={data.message.state} /> {data.message.state}</span></header>
  <section class="grid gap-3 bg-canvas p-5 text-sm text-muted sm:px-7" aria-label="Delivery details"><p class="m-0">{deliveryDescription(data.message)}</p>{#if data.message.state==='indeterminate'}<form method="POST" action="?/retry"><button class="hail-button">Retry submission</button></form>{/if}{#if form?.error}<p class="hail-error" role="alert">{form.error}</p>{/if}</section>
  <div class="min-h-[220px] px-5 py-8 font-serif text-[18px] leading-[1.7] [overflow-wrap:anywhere] sm:px-7"><RichText blocks={data.message.blocks} header={data.message.header}/></div>
</article>
