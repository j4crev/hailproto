<script lang="ts">
  import {onMount} from "svelte";
  import MessageListRow from "$lib/MessageListRow.svelte";
  import SelectionAvatar from "$lib/SelectionAvatar.svelte";
  import {showInboxHeaders, loadHeaderPreference} from "$lib/preferences.js";
  let {data}=$props();
  onMount(loadHeaderPreference);
  const audience = (message: {kind: string; category: string | null}) => message.kind === 'category'
    ? `Category: ${message.category === 'general' ? 'General' : message.category}`
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
          {#snippet leading()}<SelectionAvatar name={audience(message)} />{/snippet}
          {#snippet sender()}{audience(message)}{/snippet}
        </MessageListRow>
      {/each}
    </section>
    {#if data.paged||data.next}<nav aria-label="Sent pages" class="mt-6 flex flex-wrap justify-center gap-3">{#if data.paged}<a class="hail-button-secondary" href="/sent">← Newest messages</a>{/if}{#if data.next}<a class="hail-button-secondary" href={`/sent?after=${encodeURIComponent(data.next)}`}>Older messages →</a>{/if}</nav>{/if}
  {:else}<section class="hail-card grid justify-items-center gap-3 px-6 py-14 text-center"><h2 class="m-0 text-xl">No sent messages</h2><p class="m-0 text-sm text-muted">Messages you send will appear here.</p><a class="hail-button-secondary mt-2" href="/compose">Compose a message →</a></section>{/if}
</div>
