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
  {:else if avatar && failedSrc !== avatar.src}<img src={avatar.src} alt="" width={avatar.width} height={avatar.height} bind:this={image} />
  {:else}<span aria-hidden="true">{name.slice(0,2).toUpperCase()}</span>{/if}
{/snippet}
{#if ontoggle}
  <button class="selection-avatar" class:checked={selected} type="button" aria-label={label??`Select ${name}`} aria-pressed={selected} title={label??`Select ${name}`} {disabled} onclick={ontoggle}>{@render picture()}</button>
{:else}<span class="selection-avatar" aria-hidden="true">{@render picture()}</span>{/if}
<style>
  .selection-avatar { position:relative; z-index:1; display:grid; place-items:center; width:40px; height:40px; min-height:40px; flex:0 0 40px; padding:0; overflow:hidden; border:0; border-radius:11px; background:var(--color-brand-soft); color:var(--color-brand); font-size:12px; font-weight:650; }
  .selection-avatar img { width:100%; height:100%; object-fit:cover; }
  .selection-avatar.checked { background:var(--color-brand); color:var(--color-on-brand); }
  @media(max-width:640px) { .selection-avatar { width:44px; height:44px; min-height:44px; flex-basis:44px; } }
</style>
