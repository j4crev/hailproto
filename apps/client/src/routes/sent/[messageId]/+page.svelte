<script lang="ts">
  import QuotedMessage from "$lib/QuotedMessage.svelte";
  import MessageThread from "$lib/MessageThread.svelte";
  import ForwardedPill from "$lib/ForwardedPill.svelte";
  import {forwardedAttribution, messageDisplayContent} from "$lib/messages.js";
  import IdentityDetails from "$lib/IdentityDetails.svelte";
  import DateTime from "$lib/DateTime.svelte";
  import ContactAddress from "$lib/ContactAddress.svelte";
  import DeliveryIcon from "$lib/DeliveryIcon.svelte";
  import {deliveryDescription} from "$lib/delivery-status.js";
  let {data,form}=$props();
  const content = $derived(messageDisplayContent(data.message.blocks));
</script>

<svelte:head><title>Sent message · Haili</title></svelte:head>
<div class="mx-auto max-w-[800px]">
<a class="hail-back" href="/sent">← Sent messages</a>
{#if content.title}<h1 class="reader-title">{content.title}</h1>{:else}<h1 class="sr-only">Sent message</h1>{/if}
<article class="reader-panel overflow-hidden">
  <header class="flex flex-wrap items-center justify-between gap-4 border-0 border-b border-solid border-line pb-5"><div class="grid min-w-0 gap-1"><span class="text-xs text-muted">To</span><strong class="[overflow-wrap:anywhere]"><ContactAddress owner={data.message.sender} did={data.message.recipient} address={data.message.recipientAddress} /></strong><span class="text-xs text-muted"><DateTime value={data.message.createdAt} /></span>{#if data.message.recipientAddress}<IdentityDetails did={data.message.recipient} />{/if}</div><span class="rounded-full bg-canvas px-3 py-1.5 text-xs font-semibold capitalize" aria-label={`Status: ${data.message.state}`}><DeliveryIcon state={data.message.state} /> {data.message.state}</span>{#if forwardedAttribution(data.message.blocks)}<div class="w-full"><ForwardedPill /></div>{/if}</header>
  <section class="grid gap-3 bg-canvas p-5 text-sm text-muted sm:px-7" aria-label="Delivery details"><p class="m-0">{deliveryDescription(data.message)}</p>{#if data.message.state==='indeterminate'}<form method="POST" action="?/retry"><button class="hail-button">Retry submission</button></form>{/if}{#if form?.error}<p class="hail-error" role="alert">{form.error}</p>{/if}</section>
  <div class="reading-body"><QuotedMessage blocks={content.blocks} header={data.message.header}/></div>
</article>

<MessageThread peer={{did:data.message.recipient,address:data.message.recipientAddress}} thread={data.thread} unavailable={data.threadUnavailable} selected={data.message}/>

</div>
