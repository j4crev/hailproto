export async function mailboxRequest(path:string,body?:unknown){
  const response=await fetch('/api/v1/account/'+path,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',redirect:'error',
    headers:body===undefined?{}:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30_000)});
  if(!response.ok)throw new Error('The change could not be confirmed. Refresh and try again.');
  return response.json();
}
