<script lang="ts">
  import DateTime from './DateTime.svelte';
  import {messageHref,type MessageThread} from './threads.js';
  let {thread,selected,peer=null,unavailable=false}:{thread:MessageThread|null;selected:{sender:string;messageId:string};peer?:{did:string;address:string|null}|null;unavailable?:boolean}=$props();
</script>
{#if unavailable}<p class="text-sm text-muted" role="status">Conversation unavailable. Reload to try again.</p>{/if}
{#if thread && (thread.messages.length>1 || thread.messages.some(m=>m.inReplyTo))}
  <section class="hail-card mt-6 p-5" aria-label="Conversation">
    <h2 class="m-0 mb-4 text-base font-semibold">Conversation</h2>
    <ol class="m-0 grid list-none gap-3 p-0">
      {#each thread.messages as message (message.sender+message.messageId)}
        {@const current=message.sender===selected.sender&&message.messageId===selected.messageId}
        <li class={['rounded-lg border border-solid p-3',current?'border-brand bg-brand-soft':'border-line']}>
          <a class="text-sm font-semibold [overflow-wrap:anywhere]" href={messageHref(message)} aria-current={current?'page':undefined}>{message.sent?'You':(peer?.did===message.sender?peer.address:null)??message.sender} · <DateTime value={message.createdAt}/></a>
          <p class="mb-0 mt-2 whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{message.preview}</p>
          {#if message.inReplyTo}
            {#if message.parentAvailable}
              {@const parent=thread.messages.find(m=>m.sender===message.inReplyTo?.sender&&m.messageId===message.inReplyTo?.messageId)}
              {#if parent}<a class="mt-2 inline-block text-xs text-brand" href={messageHref(parent)}>View original</a>{/if}
            {:else if !thread.truncated}<p class="mb-0 text-xs text-muted">Original unavailable</p>{/if}
          {/if}
        </li>
      {/each}
    </ol>
    {#if thread.truncated}<p class="mb-0 text-xs text-muted">Showing part of this conversation. Open a message to explore nearby replies.</p>{/if}
  </section>
{/if}
