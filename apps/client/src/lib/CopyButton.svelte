<script lang="ts">
  import Icon from "$lib/Icon.svelte";
  let {value, label = "Copy link"}: {value: string; label?: string} = $props();
  let copied = $state(false), error = $state(""), busy = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    value;
    copied = false; error = "";
    return () => clearTimeout(timer);
  });
  async function copy() {
    if (busy) return;
    const current = value;
    busy = true; copied = false; error = ""; clearTimeout(timer);
    try {
      await navigator.clipboard.writeText(current);
      if (value === current) {
        copied = true;
        timer = setTimeout(() => {copied = false;}, 2000);
      }
    } catch {
      if (value === current) error = "Couldn’t copy. Select and copy the text instead.";
    } finally {busy = false;}
  }
</script>
<span class="copy-control relative inline-flex items-center shrink-0">
  <button class="hail-icon-button" class:copied type="button" aria-label={label} disabled={busy || !value} onclick={copy}>
    <Icon name={copied ? 'check' : 'copy'} size={18} />
  </button>
  <span class="copy-tooltip" aria-hidden="true">{copied ? 'Copied' : label}</span>
  <span class="sr-only" role="status">{copied ? 'Copied to clipboard.' : ''}</span>
  {#if error}<span class="copy-error absolute z-[20] right-0 top-[100%] w-[220px] max-w-[70vw] p-[8px] [border:1px_solid_var(--color-line)] rounded-[6px] [background:var(--color-surface)] text-danger text-[12px]" role="status">{error}</span>{/if}
</span>
<style lang="postcss">
  @reference "../app.css";

  button { @apply text-muted; }
  button.copied { @apply text-brand-strong; }
  .copy-tooltip {
    @apply absolute z-[20] right-0 bottom-[100%] [padding:5px_8px] [border:1px_solid_var(--color-line)] rounded-[6px]
      [background:var(--color-surface)] text-ink text-[12px] whitespace-nowrap pointer-events-none invisible;
  }
  button:focus-visible + .copy-tooltip { @apply visible; }
  @media (hover:hover) {
    button:hover + .copy-tooltip { @apply visible; }
  }
</style>
