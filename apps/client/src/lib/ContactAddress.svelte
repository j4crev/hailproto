<script lang="ts">
  import {connectionAddress,type ConnectionAddress} from "./connection-address.js";
  import {onMount} from "svelte";
  import {identityMemory} from "./identity-memory.js";
  import {ADDRESS_NOTICE_MS,identityNotice,type IdentityHistory} from "./identity-history.js";
  let {owner,did,address}:{owner:string;did:string;address:string|null}=$props();
  let history=$state<IdentityHistory>([]),now=$state(Date.now()),mounted=$state(false);
  const explanationId=$props.id();
  let open=$state(false),left=$state(16),top=$state(16);
  function show(event:Event){
    const rect=(event.currentTarget as HTMLElement).getBoundingClientRect();
    left=Math.max(16,Math.min(rect.left,window.innerWidth-316));
    top=Math.max(16,Math.min(rect.bottom+6,window.innerHeight-260));
    open=true;
  }
  let verified=$state<ConnectionAddress|null>(null);
  let displayAddress=$derived(verified?.address??address);
  let observed=$derived(displayAddress?identityNotice(history,did,displayAddress,now):null);
  let recent=$derived(verified?.changedAt&&verified.previousAddress&&verified.previousAddress!==verified.address&&
    now>=Date.parse(verified.changedAt)&&now-Date.parse(verified.changedAt)<ADDRESS_NOTICE_MS);
  let notice=$derived(observed?.kind==='conflict'?observed:recent?{kind:"changed",text:
    `Their address changed from ${verified?.previousAddress} to ${verified?.address}`} : null);
  $effect(()=>{
    if(!mounted)return;
    const account=owner,peer=did;let disposed=false;verified=null;
    const refresh=()=>connectionAddress(account,peer).then(value=>{if(!disposed&&value!==undefined)verified=value;});
    void refresh();const timer=setInterval(refresh,60_000);
    return()=>{disposed=true;clearInterval(timer);};
  });
  $effect(()=>{
    if(!mounted)return;
    const memory=identityMemory(owner);
    if(displayAddress)memory.observe(did,displayAddress);
    const unsubscribe=memory.subscribe(value=>history=value);
    const refresh=(event:StorageEvent)=>{if(event.key===memory.key||event.key===null)memory.refresh();};
    window.addEventListener("storage",refresh);
    return()=>{unsubscribe();window.removeEventListener("storage",refresh);};
  });
  onMount(()=>{mounted=true;const timer=setInterval(()=>now=Date.now(),60_000);return()=>clearInterval(timer);});
</script>
<span class="contact-address inline-flex items-center gap-[6px] max-w-full min-w-0 align-middle">
  <span class="address" title={`Hail identity: ${did}`}>{displayAddress??did}</span>
  {#if notice}
    <span class="indicator relative shrink-0 z-[2] text-brand-strong font-[400]" class:conflict={notice.kind==='conflict'}>
      <button type="button" aria-label={notice.kind==='conflict'?'Address used by different identities':'Address changed'} aria-describedby={open?explanationId:undefined} aria-expanded={open}
        onmouseenter={show} onmouseleave={()=>open=false} onfocus={show} onblur={()=>open=false}
        onclick={show} onkeydown={event=>{if(event.key==='Escape')open=false;}}>{notice.kind==='conflict'?'!':'↔'}</button>
      {#if open}<span class="explanation block fixed z-[50] w-[min(300px,calc(100vw_-_32px))] box-border p-[12px] [border:1px_solid_var(--color-line)] rounded-[10px] [background:var(--color-surface)] [box-shadow:0_4px_16px_#0002] text-ink text-[12px] leading-[1.6] whitespace-normal" id={explanationId} role="tooltip" style:left={`${left}px`} style:top={`${top}px`}>{notice.text}{#if notice.kind==='conflict'}<span class="identity block mt-[8px] [overflow-wrap:anywhere] text-[11px]">Identity: {did}</span>{/if}</span>{/if}
    </span>
  {/if}
</span>
<style lang="postcss">
  @reference "../app.css";

  .address { @apply [overflow-wrap:anywhere] min-w-0; }
  button {
    @apply grid place-items-center w-[28px] h-[28px] rounded-[50%] cursor-pointer [border:0] text-inherit;
    font: inherit;
    @apply [background:var(--color-brand-soft)] font-[700] [list-style:none];
  }
  button:focus-visible { @apply [outline:2px_solid_currentColor]; @apply [outline-offset:2px]; }
  .conflict { @apply text-warning; }
  .conflict button { @apply [background:var(--color-warning-soft)]; }
</style>
