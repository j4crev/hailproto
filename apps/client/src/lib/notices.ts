import {writable} from 'svelte/store';
import type {Snippet} from 'svelte';
export interface Notice {id: symbol; message: string; children?: Snippet; error: boolean;}
export const notices = writable<Notice[]>([]);
export function dismissNotice(id: symbol) { notices.update(items => items.filter(item => item.id !== id)); }
