<script lang="ts">
  import RichText from "$lib/RichText.svelte";
  import {deliveryDescription,deliveryIcon} from "$lib/delivery-status.js";
  let {data,form}=$props();
  let created=$derived(new Intl.DateTimeFormat(undefined,{dateStyle:"long",timeStyle:"short"}).format(new Date(data.message.createdAt)));
  let icon=$derived(deliveryIcon(data.message.state));
</script>

<svelte:head><title>Sent message · Haili</title></svelte:head>
<a class="hail-back" href="/sent">← Sent messages</a>
<h1 class="sr-only">Sent message</h1>
<article class="hail-card overflow-hidden">
  <header class="flex flex-wrap items-center justify-between gap-4 border-0 border-b border-solid border-line p-5 sm:px-7"><div class="grid min-w-0 gap-1"><span class="text-xs text-muted">To</span><strong class="[overflow-wrap:anywhere]">{data.message.recipientAddress??data.message.recipient}</strong>{#if data.message.recipientAddress}<small class="font-mono text-xs text-muted [overflow-wrap:anywhere]">{data.message.recipient}</small>{/if}</div><span class="rounded-full bg-canvas px-3 py-1.5 text-xs font-semibold capitalize" aria-label={`Status: ${data.message.state}`}><b aria-hidden="true">{icon}</b> {data.message.state}</span></header>
  <section class="grid gap-3 bg-canvas p-5 text-sm text-muted sm:px-7" aria-label="Delivery details"><p class="m-0">{deliveryDescription(data.message)}</p>{#if data.message.state==='indeterminate'}<form method="POST" action="?/retry"><button class="hail-button">Retry submission</button></form>{/if}{#if form?.error}<p class="hail-error" role="alert">{form.error}</p>{/if}</section>
  <div class="min-h-[220px] px-5 py-8 font-serif text-[18px] leading-[1.7] [overflow-wrap:anywhere] sm:px-7"><RichText blocks={data.message.blocks} header={data.message.header}/></div>
  <footer class="flex flex-wrap items-center justify-between gap-3 border-0 border-t border-solid border-line p-5 text-xs text-muted sm:px-7"><time datetime={data.message.createdAt}>{created}</time><details><summary class="cursor-pointer py-2">Message ID</summary><code class="[overflow-wrap:anywhere]">{data.message.messageId}</code></details></footer>
</article>
