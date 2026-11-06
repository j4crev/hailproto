<script lang="ts">
  import {onMount, type Snippet} from 'svelte';
  import Icon from '$lib/Icon.svelte';
  let {open = $bindable(false), title, children, disabled = false}: {open?: boolean; title: string; children: Snippet; disabled?: boolean} = $props();
  let mobile = $state(false), dialog = $state<HTMLDialogElement>();
  onMount(() => {
    const query = matchMedia('(max-width: 900px)');
    const update = () => mobile = query.matches;
    update(); query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  });
  $effect(() => {
    if (!dialog) return;
    if (open && mobile) dialog.showModal(); else dialog.close();
  });
  $effect(() => {
    if (!open || !mobile) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  });
</script>
{#if mobile}
  <dialog bind:this={dialog} class="mobile-sheet" aria-label={title}
    oncancel={event => {if (disabled) event.preventDefault(); else open = false;}}
    onclose={() => {if (!dialog?.open) open = false;}}
    onclick={event => {if (event.target === dialog && !disabled) open = false;}}>
    <div class="grid min-w-0 gap-4">
      <header class="flex items-center justify-between gap-3"><h2 class="m-0 text-xl">{title}</h2><button type="button" class="hail-icon-button" aria-label="Close" {disabled} onclick={() => open = false}><Icon name="close" /></button></header>
      {@render children()}
    </div>
  </dialog>
{:else}
  {@render children()}
{/if}
<style>
  .mobile-sheet { position: fixed; inset: auto 0 0; margin: 0; width: 100%; max-width: none; max-height: 88dvh; overflow-y: auto; overscroll-behavior: contain; padding: 20px 20px calc(24px + env(safe-area-inset-bottom)); border: 1px solid var(--color-line); border-radius: 20px 20px 0 0; background: var(--color-surface); color: var(--color-ink); }
  .mobile-sheet[open] { animation: slide-up .2s ease-out; }
  .mobile-sheet::backdrop { background: #0006; }
  @keyframes slide-up { from { transform: translateY(100%); } to { transform: translateY(0); } }
</style>
