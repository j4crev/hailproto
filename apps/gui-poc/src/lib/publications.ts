const ID=/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CATEGORY=/^[a-z0-9][a-z0-9._-]{0,63}$/;
const count=(value:unknown,max=10000)=>Number.isSafeInteger(value)&&Number(value)>=0&&Number(value)<=max;
export interface PublicationStatus {
  publicationId:string;category:string|null;kind?:"connections";total:number;state:"publishing"|"cancelling"|"cancelled"|"finished";
  counts:Record<"pending"|"submitted"|"blocked"|"cancelled"|"expired"|"indeterminate",number>;
  delivery:Record<"accepted"|"delivered"|"on-hold"|"failed"|"cancelled"|"indeterminate",number>;
  createdAt:string;expiresAt:string;
  targets:{messageId:string;recipient:string;state:string;delivery:string|null}[];
}
export function publicationAudiences(value:any):{maxRecipients:number;categories:{category:string;subscribers:number}[]}{
  if(!value||!count(value.maxRecipients)||value.maxRecipients<1||!Array.isArray(value.categories)||value.categories.length>1000||
    value.categories.some((row:any)=>!row||typeof row.category!=="string"||!CATEGORY.test(row.category)||!count(row.subscribers)||row.subscribers<1)||
    new Set(value.categories.map((row:any)=>row.category)).size!==value.categories.length)throw new Error("Invalid publication audiences");
  return {maxRecipients:value.maxRecipients,categories:value.categories.map((row:any)=>({category:row.category,subscribers:row.subscribers}))};
}
export function publicationStatus(value:any,kind:"category"|"connections"="category"):PublicationStatus{
  const keys=["pending","submitted","blocked","cancelled","expired","indeterminate"],delivery=["accepted","delivered","on-hold","failed","cancelled","indeterminate"];
  if(!value||typeof value.publicationId!=="string"||!ID.test(value.publicationId)||(kind==="category"?typeof value.category!=="string"||!CATEGORY.test(value.category):value.category!==null||value.kind!=="connections")||
    !count(value.total)||value.total<1||!["publishing","cancelling","cancelled","finished"].includes(value.state)||
    !value.counts||Object.keys(value.counts).length!==keys.length||keys.some(key=>!count(value.counts[key],value.total))||
    keys.reduce((sum,key)=>sum+value.counts[key],0)!==value.total||!value.delivery||Object.keys(value.delivery).length!==delivery.length||
    delivery.some(key=>!count(value.delivery[key],value.total))||delivery.reduce((sum,key)=>sum+value.delivery[key],0)>value.total||
    !Array.isArray(value.targets)||value.targets.length!==value.total||value.targets.some((row:any)=>!row||typeof row.messageId!=="string"||!ID.test(row.messageId)||
      typeof row.recipient!=="string"||!/^did:plc:[a-z2-7]{24}$/.test(row.recipient)||!keys.includes(row.state)||row.delivery!==null&&!delivery.includes(row.delivery))||
    new Set(value.targets.map((row:any)=>row.messageId)).size!==value.total||
    new Set(value.targets.map((row:any)=>row.recipient)).size!==value.total||
    keys.some(key=>value.targets.filter((row:any)=>row.state===key).length!==value.counts[key])||
    delivery.some(key=>value.targets.filter((row:any)=>row.delivery===key).length!==value.delivery[key])||
    typeof value.createdAt!=="string"||!Number.isFinite(Date.parse(value.createdAt))||typeof value.expiresAt!=="string"||!Number.isFinite(Date.parse(value.expiresAt))||
    Boolean(value.counts.pending)!==["publishing","cancelling"].includes(value.state))throw new Error("Invalid publication status");
  return value;
}

export function recentPublications(value:any,kind:"category"|"connections"="category"):{publicationId:string;category:string|null;createdAt:string;pending:boolean}[]{
  if(!value||!Array.isArray(value.publications)||value.publications.length>20||value.publications.some((row:any)=>!row||typeof row.publicationId!=="string"||
    !ID.test(row.publicationId)||(kind==="category"?typeof row.category!=="string"||!CATEGORY.test(row.category):row.category!==null)||typeof row.createdAt!=="string"||
    !Number.isFinite(Date.parse(row.createdAt))||typeof row.pending!=="boolean")||new Set(value.publications.map((row:any)=>row.publicationId)).size!==value.publications.length)
    throw new Error("Invalid publication history");
  return value.publications;
}
