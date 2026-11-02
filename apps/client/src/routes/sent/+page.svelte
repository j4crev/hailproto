<script lang="ts">
  import {page} from "$app/state";
  import {onMount} from "svelte";
  import MailboxEmptyState from "$lib/MailboxEmptyState.svelte";
  import MessageListRow from "$lib/MessageListRow.svelte";
  import {showInboxHeaders, loadHeaderPreference} from "$lib/preferences.js";
  let {data}=$props();
  onMount(loadHeaderPreference);
  const audience = (message: {kind: string; category: string | null}) => message.kind === 'category'
    ? message.category === 'general' ? 'General' : message.category ?? 'Message'
    : message.kind === 'connections' ? 'Connections' : 'Message';
</script>

<svelte:head><title>Sent · {page.data.branding?.name ?? "Hail"}</title></svelte:head>
<div class="min-w-0">
  <header class="page-heading"><h1 class="hail-title">Sent</h1></header>
  {#if data.messages.length}
    <section class="compact-list" aria-label="Sent messages">
      {#each data.messages as message}
        <MessageListRow inline muted timestamp={message.createdAt} title={message.title} preview={message.preview} header={$showInboxHeaders ? message.header : null}
          href={`/sent/send/${message.kind}/${message.messageId}`}>
          {#snippet sender()}{#if message.kind === 'category'}<mark class="inline-block max-w-full rounded-full bg-brand-soft px-3 py-1.5 text-xs font-normal text-muted [overflow-wrap:anywhere]">{audience(message)}</mark>{:else if message.recipientSummary}<span class="[overflow-wrap:anywhere]">{message.recipientSummary.count > 1 ? 'Multiple recipients' : message.recipientSummary.address ?? message.recipientSummary.did}</span>{/if}{/snippet}
        </MessageListRow>
      {/each}
    </section>
    {#if data.paged||data.next}<nav aria-label="Sent pages" class="mt-6 flex flex-wrap justify-center gap-3">{#if data.paged}<a class="hail-button-secondary" href="/sent">← Newest messages</a>{/if}{#if data.next}<a class="hail-button-secondary" href={`/sent?after=${encodeURIComponent(data.next)}`}>Older messages →</a>{/if}</nav>{/if}
  {:else}<MailboxEmptyState icon="sent" title="Time to send something" />{/if}
</div>
