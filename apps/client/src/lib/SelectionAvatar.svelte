<script lang="ts">
  import Icon from '$lib/Icon.svelte';
  let {name, avatar, selected=false, disabled=false, label, ontoggle}: {
    name:string; avatar?:{src:string;width:number;height:number}|null;
    selected?:boolean; disabled?:boolean; label?:string; ontoggle?:()=>void;
  }=$props();
</script>
{#snippet picture()}
  {#if selected}<Icon name="check" size={24} />
  {:else if avatar}<img src={avatar.src} alt="" width={avatar.width} height={avatar.height} />
  {:else}<span aria-hidden="true">{name.slice(0,2).toUpperCase()}</span>{/if}
{/snippet}
{#if ontoggle}
  <button class="selection-avatar" class:checked={selected} type="button" aria-label={label??`Select ${name}`} aria-pressed={selected} title={label??`Select ${name}`} {disabled} onclick={ontoggle}>{@render picture()}</button>
{:else}<span class="selection-avatar" aria-hidden="true">{@render picture()}</span>{/if}
<style>
  .selection-avatar { position:relative; z-index:1; display:grid; place-items:center; width:44px; height:44px; flex:0 0 44px; padding:0; overflow:hidden; border:0; border-radius:13px; background:var(--color-brand-soft); color:var(--color-brand); font-size:12px; font-weight:800; }
  .selection-avatar img { width:100%; height:100%; object-fit:cover; }
  .selection-avatar.checked { background:var(--color-brand); color:var(--color-on-brand); }
</style>
