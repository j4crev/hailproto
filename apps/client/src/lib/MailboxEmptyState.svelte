<script lang="ts">
  import Icon from '$lib/Icon.svelte';
  let {icon, title}: {
    icon: string; title: string;
  } = $props();
</script>

<div class="hail-card flex flex-col items-center gap-3 px-6 py-16 text-center">
  <span class="empty-symbol grid place-items-center w-[76px] h-[76px] mb-[14px] [border:10px_solid_var(--color-canvas)] rounded-[26px] [background:var(--color-brand-soft)] text-brand" aria-hidden="true"><Icon name={icon} size={30} /></span>
  <h2 class="m-0 text-xl tracking-tight">{title}</h2>
</div>
