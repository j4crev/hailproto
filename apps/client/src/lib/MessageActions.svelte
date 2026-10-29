<script lang="ts">
  import {onMount} from 'svelte';
  import {goto, invalidateAll} from '$app/navigation';
  import {mailboxRequest} from '$lib/mailbox.js';
  import SelectionActions from '$lib/SelectionActions.svelte';
  import Icon from '$lib/Icon.svelte';

  type Message = {sender: string; messageId: string};
  let {messages, returnTo, onremoved, onclear, compact = false, menu = false, locked = $bindable(false)}: {
    messages: Message[];
    compact?: boolean; menu?: boolean;
    returnTo?: string;
    onremoved?: (messages: Message[]) => void;
    onclear?: () => void;
    locked?: boolean;
  } = $props();
  let ready = $state(false), confirming = $state(false), trashEnabled = $state(true), busy = $state(false), error = $state('');
  onMount(() => { ready = true; });
  $effect(() => { locked = busy || confirming; });
  async function review() {
    busy = true; error = '';
    try {
      const settings = await mailboxRequest('message-preferences');
      trashEnabled = settings.trashEnabled !== false;
      confirming = true;
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
  {#if error}<p class="hail-error" role="alert">{error}</p>{/if}
{/snippet}
{#if compact}
  <div class="inline-actions" class:expanded={confirming || !!error}>
    {#if !confirming}
      {#if menu}
        <details class="action-menu">
          <summary class="hail-icon-button compact" aria-label="More message actions" title="More actions"><Icon name="more" /></summary>
          <div class="menu-items"><button class="menu-item" type="button" disabled={busy || !ready} onclick={event => {event.currentTarget.closest('details')?.removeAttribute('open');void review();}}><Icon name="trash" /><span>Trash</span></button></div>
        </details>
      {:else}<button class="hail-icon-button compact" type="button" aria-label="Delete message" title="Delete" disabled={busy || !ready} onclick={review}><Icon name="trash" /></button>{/if}
    {/if}
    {@render confirmation()}
  </div>
{:else}
  <SelectionActions label="Message actions" count={onclear?messages.length:undefined} {onclear} locked={busy||confirming} {busy}>
    {#snippet actions()}
      {#if !confirming}<button class="hail-icon-button" type="button" aria-label={messages.length === 1 ? 'Delete message' : `Delete ${messages.length} messages`} title="Delete" disabled={busy || !ready} onclick={review}><Icon name="trash" /></button>{/if}
    {/snippet}
    {@render confirmation()}
  </SelectionActions>
{/if}
<style>
  .inline-actions.expanded { flex-basis:100%; }
  .action-menu { position:relative; }
  summary { list-style:none; }
  summary::-webkit-details-marker { display:none; }
  .menu-item { display:flex; align-items:center; gap:10px; width:100%; min-width:120px; padding:10px 12px; border:0; border-radius:6px; background:transparent; text-align:left; font-size:14px; }
  .menu-item:hover { background:var(--color-brand-soft); }
  .menu-items { position:absolute; right:0; top:100%; z-index:5; padding:6px; background:var(--color-surface); border:1px solid var(--color-line); border-radius:12px; box-shadow:0 4px 12px #0002; }
</style>
