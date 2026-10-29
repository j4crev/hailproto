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
<span class="copy-control">
  <button class="hail-icon-button" class:copied type="button" aria-label={label} disabled={busy || !value} onclick={copy}>
    <Icon name={copied ? 'check' : 'copy'} size={18} />
  </button>
  <span class="copy-tooltip" aria-hidden="true">{copied ? 'Copied' : label}</span>
  <span class="sr-only" role="status">{copied ? 'Copied to clipboard.' : ''}</span>
  {#if error}<span class="copy-error" role="status">{error}</span>{/if}
</span>
<style>
  .copy-control { position:relative; display:inline-flex; align-items:center; flex-shrink:0; }
  button { color:var(--color-muted); }
  button.copied { color:var(--color-brand-strong); }
  .copy-tooltip { position:absolute; z-index:20; right:0; bottom:100%; padding:5px 8px; border:1px solid var(--color-line); border-radius:6px; background:var(--color-surface); color:var(--color-ink); font-size:12px; white-space:nowrap; pointer-events:none; visibility:hidden; }
  button:focus-visible + .copy-tooltip { visibility:visible; }
  @media(hover:hover) { button:hover + .copy-tooltip { visibility:visible; } }
  .copy-error { position:absolute; z-index:20; right:0; top:100%; width:220px; max-width:70vw; padding:8px; border:1px solid var(--color-line); border-radius:6px; background:var(--color-surface); color:var(--color-danger); font-size:12px; }
</style>
