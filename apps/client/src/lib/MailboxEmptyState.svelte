<script lang="ts">
  import Icon from '$lib/Icon.svelte';
  let {icon, title}: {
    icon: string; title: string;
  } = $props();
</script>

<div class="hail-card flex flex-col items-center gap-3 px-6 py-16 text-center">
  <span class="empty-symbol" aria-hidden="true"><Icon name={icon} size={30} /></span>
  <h2 class="m-0 text-xl tracking-tight">{title}</h2>
</div>

<style>
  .empty-symbol { display:grid; place-items:center; width:76px; height:76px; margin-bottom:14px; border:10px solid var(--color-canvas); border-radius:26px; background:var(--color-brand-soft); color:var(--color-brand); }
</style>
