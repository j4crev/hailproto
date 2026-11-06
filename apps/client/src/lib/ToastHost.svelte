<script lang="ts">
  import {notices, dismissNotice} from '$lib/notices.js';
  import Icon from '$lib/Icon.svelte';
  // A modal makes nodes outside its subtree inert, even top-layer popovers.
  // Keep the shared stack inside the active dialog so its links and dismiss
  // buttons remain usable, and return it to the layout when the dialog closes.
  function portal(node: HTMLDivElement) {
    const anchor = document.createComment('notifications');
    node.before(anchor);
    const relocate = () => {
      const target = Array.from(document.querySelectorAll('dialog:modal')).at(-1) ?? anchor.parentNode;
      if (!target || node.parentNode === target) return;
      const visible = node.matches(':popover-open');
      if (visible) node.hidePopover();
      target.appendChild(node);
      if (visible) node.showPopover();
    };
    const observer = new MutationObserver(relocate);
    observer.observe(document.body, {subtree: true, childList: true, attributes: true, attributeFilter: ['open']});
    relocate();
    return {destroy() {observer.disconnect(); anchor.remove(); node.remove();}};
  }
  let host = $state<HTMLDivElement>();
  $effect(() => {
    if (!host) return;
    if ($notices.length) host.showPopover(); else host.hidePopover();
  });
</script>
<div use:portal bind:this={host} popover="manual" class="toast-stack" aria-label="Notifications">
  {#each $notices as notice (notice.id)}
    <div class="toast" class:error={notice.error} role={notice.error?'alert':'status'} aria-atomic="true">
      <div>{#if notice.children}{@render notice.children()}{:else}{notice.message}{/if}</div>
      <button class="hail-icon-button" type="button" aria-label="Dismiss notification" onclick={() => dismissNotice(notice.id)}><Icon name="close" /></button>
    </div>
  {/each}
</div>
<style>
  .toast-stack { position: fixed; inset: auto 16px calc(104px + env(safe-area-inset-bottom)); margin: 0 auto; padding: 0; border: 0; width: max-content; max-width: calc(100vw - 32px); max-height: 50dvh; overflow-y: auto; background: transparent; color: var(--color-brand-strong); }
  .toast-stack:popover-open { display: grid; gap: 12px; }
  .toast { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border: 1px solid var(--color-brand); border-radius: 14px; background: var(--color-brand-soft); font-size: 15px; font-weight: 600; max-width: 560px; overflow-wrap: anywhere; box-shadow: 0 8px 28px #0003; }
  .error { border-color: var(--color-danger); background: var(--color-danger-soft); color: var(--color-danger); }
</style>
