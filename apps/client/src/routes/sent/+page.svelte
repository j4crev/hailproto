<script lang="ts">
  import MailboxCleanup from "$lib/MailboxCleanup.svelte";
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
<div class="min-w-0 pb-28 min-[901px]:pb-0">
  <MailboxCleanup folder="Sent" trashEnabled={data.trashEnabled} empty={!data.messages.length&&!data.paged} />
  {#if data.messages.length}
    <section class="compact-list" aria-label="Sent messages">
      {#each data.messages as message}
        <MessageListRow inline muted timestamp={message.createdAt} title={message.title} preview={message.preview} header={$showInboxHeaders ? message.header : null}
          href={`/sent/send/${message.kind}/${message.messageId}`}>
          {#snippet leading()}<span class="sent-avatar" aria-hidden="true">{Array.from(data.account.address)[0]?.toUpperCase()}</span>{/snippet}
          {#snippet sender()}{#if message.kind === 'category'}<span class="[overflow-wrap:anywhere]">{audience(message)}</span>{:else if message.recipientSummary}<span class="[overflow-wrap:anywhere]">{message.recipientSummary.count > 1 ? 'Multiple recipients' : message.recipientSummary.address ?? message.recipientSummary.did}</span>{/if}{/snippet}
        </MessageListRow>
      {/each}
    </section>
    {#if data.paged||data.next}<nav aria-label="Sent pages" class="mt-6 flex flex-wrap justify-center gap-3">{#if data.paged}<a class="hail-button-secondary" href="/sent">← Newest messages</a>{/if}{#if data.next}<a class="hail-button-secondary" href={`/sent?after=${encodeURIComponent(data.next)}`}>Older messages →</a>{/if}</nav>{/if}
  {:else}<MailboxEmptyState icon="sent" title="Message in a bottle?" />{/if}
</div>

<style>
  .sent-avatar { display:grid; place-items:center; width:40px; height:40px; border-radius:50%; background:var(--color-brand); color:var(--color-on-brand); font-size:14px; font-weight:650; }
  @media(max-width:640px) { .sent-avatar { width:44px; height:44px; } }
</style>
