#!/bin/sh
# Read-only transport/authentication probe using the running provider's settings.
# Empty requests cannot enroll identities; never print the service token.
exec docker exec hail-public-provider-provider-1 bun --eval '
const origin=process.env.SIGNUP_MONITOR_API_ORIGIN;
const token=process.env.SIGNUP_MONITOR_TOKEN;
if(origin!=="https://enroll.plcmonitor.us"||!token)throw new Error("Unexpected monitor configuration");
for(const [authenticated,expected] of [[false,401],[true,400]]){
  const headers=new Headers({"Content-Type":"application/json"});
  if(authenticated)headers.set("Authorization","Bearer "+token);
  const response=await fetch(origin+"/api/v1/onboarding",{
    method:"POST",headers,body:"{}",redirect:"error",signal:AbortSignal.timeout(15000)
  });
  await response.body?.cancel();
  console.log((authenticated?"With token: ":"Without token: ")+response.status);
  if(response.status!==expected)process.exit(1);
}'
