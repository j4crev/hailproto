<script lang="ts">
  import Toast from "$lib/Toast.svelte";
  import {onMount} from 'svelte';
  import {goto, invalidateAll} from '$app/navigation';
  import {mailboxRequest} from '$lib/mailbox.js';
  import SelectionActions from '$lib/SelectionActions.svelte';
  import Icon from '$lib/Icon.svelte';

  type Message = {sender: string; messageId: string};
  let {messages, disabled = false, returnTo, onmarkedunread, onremoved, onclear, compact = false, menu = false, onunsubscribe, extraActions = [], locked = $bindable(false)}: {
    messages: Message[];
    extraActions?: {label:string;icon:string;run:()=>void}[];
    disabled?: boolean;
    compact?: boolean; menu?: boolean;
    returnTo?: string;
    onunsubscribe?: () => void;
    onmarkedunread?: () => void | Promise<void>;
    onremoved?: (messages: Message[]) => void;
    onclear?: () => void;
    locked?: boolean;
  } = $props();
  let ready = $state(false), confirming = $state(false), trashEnabled = $state(true), busy = $state(false), error = $state('');
  onMount(() => { ready = true; });
  $effect(() => { locked = busy || confirming; });
  async function markUnread() {
    busy = true; error = '';
    try {
      for (const message of messages) await mailboxRequest(`inbox/${encodeURIComponent(message.sender)}/${encodeURIComponent(message.messageId)}/mark-unread`, {});
      if (onmarkedunread) await onmarkedunread();
      else if (returnTo) await goto(returnTo, {invalidateAll: true});
      else await invalidateAll();
    } catch (e) { error = e instanceof Error ? e.message : 'Unable to mark unread.'; }
    finally { busy = false; }
  }
  async function review() {
    if (busy) return;
    busy = true; error = '';
    try {
      const settings = await mailboxRequest('message-preferences');
      trashEnabled = settings.trashEnabled !== false;
      if (trashEnabled) await remove();
      else confirming = true;
    } catch (e) { error = e instanceof Error ? e.message : 'Unable to load deletion settings.'; }
    finally { busy = false; }
  }
  async function remove() {
    busy = true; error = '';
    const removed: Message[] = [];
    // Keep requests bounded, and retain failed messages for retry.
    for (const message of [...messages]) {
      try {
        await mailboxRequest(`inbox/${encodeURIComponent(message.sender)}/${encodeURIComponent(message.messageId)}/delete`, {});
        removed.push(message);
      } catch { /* Report all failures together after processing the selection. */ }
    }
    const failed = messages.length - removed.length;
    confirming = false;
    if (failed) error = `${failed} ${failed === 1 ? 'message could' : 'messages could'} not be deleted. Try again.`;
    try {
      if (returnTo && !failed) await goto(returnTo, {invalidateAll: true});
      else {
        await invalidateAll();
        onremoved?.(removed);
      }
    } catch { error = 'Unable to refresh messages. Reload the page to check the result.'; }
    finally { busy = false; }
  }
</script>

{#snippet confirmation()}
  {#if confirming}
    <div class="grid gap-3" role="group" aria-label="Confirm deletion">
      <p class="m-0 text-sm">{trashEnabled ? `Move ${messages.length === 1 ? 'this message' : `these ${messages.length} messages`} to Trash? You can restore ${messages.length === 1 ? 'it' : 'them'} for 30 days.` : `Trash is disabled. Permanently delete ${messages.length === 1 ? 'this message' : `these ${messages.length} messages`}? This cannot be undone.`}</p>
      <div class="flex flex-wrap gap-2"><button class="hail-button-secondary" disabled={busy} onclick={remove}>{trashEnabled ? 'Move to Trash' : 'Delete permanently'}</button><button class="hail-button-secondary" disabled={busy} onclick={() => confirming = false}>Cancel</button></div>
    </div>
  {/if}
  {#if error}<Toast message={error} error />{/if}
{/snippet}
{#if compact}
  <div class="inline-actions" class:expanded={confirming || !!error}>
    {#if !confirming}
      {#if menu}
        <details class="action-menu relative">
          <summary class="hail-icon-button compact" aria-label="More message actions" title="More actions"><Icon name="more" /></summary>
          <div class="menu-items">{#if messages.length}<button class="menu-item" type="button" disabled={disabled || busy || !ready} onclick={event => {event.currentTarget.closest('details')?.removeAttribute('open');void markUnread();}}><Icon name="unread" /><span>Mark unread</span></button><button class="menu-item" type="button" disabled={disabled || busy || !ready} onclick={event => {event.currentTarget.closest('details')?.removeAttribute('open');void review();}}><Icon name="trash" /><span>Trash</span></button>{/if}{#if onunsubscribe}<button class="menu-item" type="button" disabled={disabled || busy || !ready} onclick={event => {event.currentTarget.closest('details')?.removeAttribute('open');onunsubscribe?.();}}><Icon name="bell-off" /><span>Unsubscribe</span></button>{/if}{#each extraActions as action}<button class="menu-item" type="button" disabled={disabled || busy || !ready} onclick={event=>{event.currentTarget.closest('details')?.removeAttribute('open');action.run();}}><Icon name={action.icon}/><span>{action.label}</span></button>{/each}</div>
        </details>
      {:else}<button class="hail-icon-button compact" type="button" aria-label="Delete message" title="Delete" disabled={disabled || busy || !ready} onclick={review}><Icon name="trash" /></button>{/if}
    {/if}
    {@render confirmation()}
  </div>
{:else}
  <SelectionActions label="Message actions" count={onclear?messages.length:undefined} {onclear} locked={busy||confirming} {busy}>
    {#snippet actions()}
      {#if !confirming}<button class="hail-icon-button" type="button" aria-label={messages.length === 1 ? 'Delete message' : `Delete ${messages.length} messages`} title="Delete" disabled={disabled || busy || !ready} onclick={review}><Icon name="trash" /></button>{/if}
    {/snippet}
    {@render confirmation()}
  </SelectionActions>
{/if}
<style lang="postcss">
  @reference "../app.css";

  .inline-actions.expanded { @apply basis-[100%]; }
  summary { @apply [list-style:none]; }
  summary::-webkit-details-marker { @apply hidden; }
  .menu-item {
    @apply flex items-center gap-[10px] w-full min-w-[172px] [padding:10px_12px] [border:0] rounded-[6px]
      [background:transparent] text-left text-[16px];
  }
  @media (hover:hover) and (pointer:fine) {
    .menu-item:hover { @apply [background:var(--color-brand-soft)]; }
  }
  .menu-items {
    @apply absolute right-0 top-[100%] z-[5] p-[6px] [background:var(--color-surface)]
      [border:1px_solid_var(--color-line)] rounded-[12px] [box-shadow:0_4px_12px_#0002];
  }
  @media (max-width:900px) {
    :global(.mobile-message-actions) .menu-items { @apply [top:auto] bottom-[calc(100%_+_12px)] max-h-[50dvh] overflow-y-auto text-ink; }
    :global(.mobile-message-actions) .inline-actions.expanded { @apply max-h-[50dvh] overflow-y-auto; }
  }
</style>
