<script lang="ts">
  import {onMount} from 'svelte';
  import {goto, invalidateAll} from '$app/navigation';
  import {mailboxRequest} from '$lib/mailbox.js';
  import Icon from '$lib/Icon.svelte';

  type Message = {sender: string; messageId: string};
  let {messages, returnTo, onremoved, onclear, locked = $bindable(false)}: {
    messages: Message[];
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

<section class="message-actions" aria-label="Message actions" aria-busy={busy}>
  <div class="action-row">
    <span class="action-count" role="status">{onclear ? `${messages.length} selected` : 'Message actions'}</span>
    {#if !confirming}
      <button class="hail-button-secondary" type="button" aria-label={messages.length === 1 ? 'Delete message' : `Delete ${messages.length} messages`} title="Delete" disabled={busy || !ready} onclick={review}><Icon name="trash" /></button>
    {/if}
    {#if onclear}<button class="hail-button-secondary" type="button" aria-label="Clear selection" title="Clear selection" disabled={busy || confirming} onclick={onclear}><Icon name="close" /></button>{/if}
  </div>
  {#if confirming}
    <p class="m-0 text-sm">{trashEnabled ? `Move ${messages.length === 1 ? 'this message' : `these ${messages.length} messages`} to Trash? You can restore ${messages.length === 1 ? 'it' : 'them'} for 30 days.` : `Trash is disabled. Permanently delete ${messages.length === 1 ? 'this message' : `these ${messages.length} messages`}? This cannot be undone.`}</p>
    <div class="flex flex-wrap gap-2"><button class="hail-button-secondary" disabled={busy} onclick={remove}>{trashEnabled ? 'Move to Trash' : 'Delete permanently'}</button><button class="hail-button-secondary" disabled={busy} onclick={() => confirming = false}>Cancel</button></div>
  {/if}
  {#if error}<p class="hail-error" role="alert">{error}</p>{/if}
</section>

<style>
  .message-actions { position:sticky; top:16px; z-index:5; display:grid; gap:12px; margin-bottom:20px; padding:12px 16px; border:1px solid var(--color-line); border-radius:14px; background:var(--color-surface); box-shadow:0 4px 20px #172b2d0d; }
  .action-row { display:flex; align-items:center; gap:8px; }
  .action-count { flex:1; font-size:14px; font-weight:600; }
  @media(max-width:900px) {
    .message-actions { position:fixed; inset:auto 0 0; z-index:11; margin:0; border-radius:16px 16px 0 0; padding:12px max(18px, env(safe-area-inset-right)) max(12px, env(safe-area-inset-bottom)) max(18px, env(safe-area-inset-left)); max-height:50dvh; overflow-y:auto; }
  }
</style>
