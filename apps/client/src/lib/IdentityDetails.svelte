<script lang="ts">
  let {did}: {did: string} = $props();
</script>

<span class="identity-details"><code>{did}</code></span>

<style>
  .identity-details { display:block; min-width:0; color:var(--color-muted); font-size:12px; font-weight:400; overflow-wrap:anywhere; }
  code { font-family:var(--font-mono); user-select:all; }
</style>
