<script lang="ts">
  import Icon from '$lib/Icon.svelte';
  let {name, avatar, selected=false, disabled=false, label, ontoggle}: {
    name:string; avatar?:{src:string;width:number;height:number}|null;
    selected?:boolean; disabled?:boolean; label?:string; ontoggle?:()=>void;
  }=$props();
  let failedSrc = $state(''), image = $state<HTMLImageElement>();
  $effect(() => {
    const element=image, src=avatar?.src;
    if (!element || !src) return;
    const failed=()=>{failedSrc=src;};
    element.addEventListener('error',failed);
    if(element.complete && !element.naturalWidth)failed();
    return ()=>element.removeEventListener('error',failed);
  });
</script>
{#snippet picture()}
  {#if selected}<Icon name="check" size={24} />
  {:else if avatar && failedSrc !== avatar.src}<img class="w-full h-full object-cover" src={avatar.src} alt="" width={avatar.width} height={avatar.height} bind:this={image} />
  {:else}<span aria-hidden="true">{name.slice(0,2).toUpperCase()}</span>{/if}
{/snippet}
{#if ontoggle}
  <button class="selection-avatar relative z-[1] grid place-items-center w-[40px] h-[40px] min-h-[40px] [flex:0_0_40px] p-0 overflow-hidden [border:0] rounded-[50%] [background:var(--color-brand-soft)] text-brand text-[12px] font-[650] [&.checked]:[background:var(--color-brand)] [&.checked]:text-on-brand [@media(max-width:640px)]:w-[44px] [@media(max-width:640px)]:h-[44px] [@media(max-width:640px)]:min-h-[44px] [@media(max-width:640px)]:basis-[44px]" class:checked={selected} type="button" aria-label={label??`Select ${name}`} aria-pressed={selected} title={label??`Select ${name}`} {disabled} onclick={ontoggle}>{@render picture()}</button>
{:else}<span class="selection-avatar relative z-[1] grid place-items-center w-[40px] h-[40px] min-h-[40px] [flex:0_0_40px] p-0 overflow-hidden [border:0] rounded-[50%] [background:var(--color-brand-soft)] text-brand text-[12px] font-[650] [&.checked]:[background:var(--color-brand)] [&.checked]:text-on-brand [@media(max-width:640px)]:w-[44px] [@media(max-width:640px)]:h-[44px] [@media(max-width:640px)]:min-h-[44px] [@media(max-width:640px)]:basis-[44px]" aria-hidden="true">{@render picture()}</span>{/if}
