<script lang="ts">
  import {onMount} from "svelte";
  import MessageListRow from "$lib/MessageListRow.svelte";
  import {showInboxHeaders, loadHeaderPreference} from "$lib/preferences.js";
  let {data}=$props();
  onMount(loadHeaderPreference);
  const audience = (message: {kind: string; category: string | null}) => message.kind === 'category'
    ? message.category === 'general' ? 'General' : message.category ?? 'Message'
    : message.kind === 'connections' ? 'Connections' : 'Message';
</script>

<svelte:head><title>Sent · Haili</title></svelte:head>
<div class="mx-auto max-w-[860px]">
  <header class="page-heading"><h1 class="hail-title">Sent</h1></header>
  {#if data.messages.length}
    <section class="compact-list" aria-label="Sent messages">
      {#each data.messages as message}
        <MessageListRow timestamp={message.createdAt} title={message.title} preview={message.preview} header={$showInboxHeaders ? message.header : null}
          href={`/sent/send/${message.kind}/${message.messageId}`}>
          {#snippet sender()}{#if message.kind === 'category'}<mark class="inline-block max-w-full rounded-full bg-brand-soft px-3 py-1.5 text-xs font-semibold text-brand-strong [overflow-wrap:anywhere]">{audience(message)}</mark>{:else if message.recipientSummary}<span class="[overflow-wrap:anywhere]">{message.recipientSummary.count > 1 ? 'Multiple recipients' : message.recipientSummary.address ?? message.recipientSummary.did}</span>{/if}{/snippet}
        </MessageListRow>
      {/each}
    </section>
    {#if data.paged||data.next}<nav aria-label="Sent pages" class="mt-6 flex flex-wrap justify-center gap-3">{#if data.paged}<a class="hail-button-secondary" href="/sent">← Newest messages</a>{/if}{#if data.next}<a class="hail-button-secondary" href={`/sent?after=${encodeURIComponent(data.next)}`}>Older messages →</a>{/if}</nav>{/if}
  {:else}<section class="hail-card grid justify-items-center gap-3 px-6 py-14 text-center"><h2 class="m-0 text-xl">No sent messages</h2><p class="m-0 text-sm text-muted">Messages you send will appear here.</p><a class="hail-button-secondary mt-2" href="/compose">Compose a message →</a></section>{/if}
</div>
