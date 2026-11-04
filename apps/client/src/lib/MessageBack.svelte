<script lang="ts">
  import Icon from '$lib/Icon.svelte';
  let {href, label}: {href:string; label:string} = $props();
</script>

<a class="hail-back message-back gap-[8px] [@media(max-width:900px)]:fixed [@media(max-width:900px)]:z-[11] [@media(max-width:900px)]:left-[max(16px,env(safe-area-inset-left))] [@media(max-width:900px)]:bottom-[calc(12px_+_env(safe-area-inset-bottom))] [@media(max-width:900px)]:grid [@media(max-width:900px)]:place-items-center [@media(max-width:900px)]:w-[44px] [@media(max-width:900px)]:h-[44px] [@media(max-width:900px)]:m-0 [@media(max-width:900px)]:text-ink [@media(max-width:900px)]:[text-decoration:none]" {href} aria-label={`Back to ${label}`} title={`Back to ${label}`}><Icon name="arrow-left" size={28} /><span class="[@media(max-width:900px)]:hidden">{label}</span></a>
