import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {get} from 'svelte/store';
const request=vi.hoisted(()=>vi.fn());
vi.mock('./mailbox.js',()=>({mailboxRequest:request}));
let preferences:typeof import('./preferences.js');
let cache:Map<string,string>;
beforeEach(async()=>{
  vi.resetModules();request.mockReset();cache=new Map();
  vi.stubGlobal('document',{documentElement:{dataset:{}}});
  vi.stubGlobal('localStorage',{getItem:(key:string)=>cache.get(key)??null,setItem:(key:string,value:string)=>cache.set(key,value)});
  preferences=await import('./preferences.js');
});
afterEach(()=>vi.unstubAllGlobals());
it('imports legacy choices only for an unset account and accepts the server result',async()=>{
  cache.set(preferences.THEME_PREFERENCE,'dark');cache.set(preferences.HEADER_PREFERENCE,'false');
  request.mockResolvedValueOnce({theme:null,showHeaderImages:null}).mockResolvedValueOnce({theme:'light',showHeaderImages:false});
  await preferences.syncAccountPreferences('alice');
  expect(request).toHaveBeenLastCalledWith('message-preferences',{theme:'dark',showHeaderImages:false,initialize:true});
  expect(get(preferences.themePreference)).toBe('light');
  expect(get(preferences.showInboxHeaders)).toBe(false);
});
it('loads account values on a fresh browser and refreshes changes from another device',async()=>{
  request.mockResolvedValueOnce({theme:'dark',showHeaderImages:false}).mockResolvedValueOnce({theme:'light',showHeaderImages:true});
  await preferences.syncAccountPreferences('alice');
  expect(cache.get(preferences.THEME_PREFERENCE)).toBe('dark');
  await preferences.syncAccountPreferences('alice');
  expect(get(preferences.themePreference)).toBe('light');
  expect(get(preferences.showInboxHeaders)).toBe(true);
  expect(request).toHaveBeenCalledTimes(2);
});
it('does not import another account’s cached choices',async()=>{
  cache.set('hail.gui.preferencesAccount','alice');cache.set(preferences.THEME_PREFERENCE,'dark');
  request.mockResolvedValueOnce({theme:null,showHeaderImages:null}).mockResolvedValueOnce({theme:'system',showHeaderImages:true});
  await preferences.syncAccountPreferences('bob');
  expect(request).toHaveBeenLastCalledWith('message-preferences',{theme:'system',showHeaderImages:true,initialize:true});
});
it('saves to the account even when browser storage is blocked',async()=>{
  vi.stubGlobal('localStorage',{getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}});
  request.mockResolvedValue({theme:'dark',showHeaderImages:false});
  await preferences.syncAccountPreferences('alice');
  await preferences.saveAccountPreferences({theme:'dark'});
  preferences.loadHeaderPreference();
  expect(get(preferences.themePreference)).toBe('dark');
  expect(get(preferences.showInboxHeaders)).toBe(false);
});
it('keeps confirmed preferences when a save fails',async()=>{
  request.mockResolvedValueOnce({theme:'dark',showHeaderImages:true}).mockRejectedValueOnce(Error('offline'));
  await preferences.syncAccountPreferences('alice');
  await expect(preferences.saveAccountPreferences({theme:'light'})).rejects.toThrow('offline');
  expect(get(preferences.themePreference)).toBe('dark');
});
it('ignores a stale refresh after a save',async()=>{
  let resolve!:(value:unknown)=>void;
  request.mockReturnValueOnce(new Promise(r=>{resolve=r;})).mockResolvedValueOnce({theme:'light',showHeaderImages:false});
  const syncing=preferences.syncAccountPreferences('alice');
  await preferences.saveAccountPreferences({theme:'light'});
  resolve({theme:'dark',showHeaderImages:true});await syncing;
  expect(get(preferences.themePreference)).toBe('light');
});
it('deduplicates simultaneous loads and ignores responses after logout',async()=>{
  let resolve!:(value:unknown)=>void;
  request.mockReturnValue(new Promise(r=>{resolve=r;}));
  const first=preferences.syncAccountPreferences('alice');
  expect(preferences.syncAccountPreferences('alice')).toBe(first);
  preferences.clearPreferenceAccount();resolve({theme:'dark',showHeaderImages:false});await first;
  expect(get(preferences.themePreference)).toBe('system');
});
