import { privateFile } from "../grant-revocation.js";
import { signPrivatePocCutover } from "../transfer-cutover.js";

const [vault,snapshot,offer,reservation,consent,operation,binding]=Bun.argv.slice(2);
if(!vault||!snapshot||!offer||!reservation||!consent||!operation||!binding||Bun.argv.length!==9) {
  throw new Error("Usage: bun run poc:sign-cutover -- <user-vault> <source-snapshot> <origin-verified-offer> <signed-reservation> <new-consent-json> <new-plc-operation-json> <new-binding.cose>");
}
const read=async(path:string)=>JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await privateFile(path,16384)));
console.info(JSON.stringify(await signPrivatePocCutover(vault,snapshot,await read(offer),await read(reservation),consent,operation,binding)));
