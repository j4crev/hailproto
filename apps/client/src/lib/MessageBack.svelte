<script lang="ts">
  import Icon from '$lib/Icon.svelte';
  let {href, label}: {href:string; label:string} = $props();
</script>

<a class="hail-back message-back" {href} aria-label={`Back to ${label}`} title={`Back to ${label}`}><Icon name="arrow-left" size={28} /><span>{label}</span></a>

<style>
  .message-back { gap:8px; }
  @media(max-width:900px) {
    .message-back { position:fixed; z-index:11; left:max(16px, env(safe-area-inset-left)); bottom:calc(12px + env(safe-area-inset-bottom)); display:grid; place-items:center; width:44px; height:44px; margin:0; color:var(--color-ink); text-decoration:none; }
    .message-back span { display:none; }
  }
</style>
