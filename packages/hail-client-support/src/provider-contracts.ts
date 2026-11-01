// HTTP response contracts shared by provider and clients. No server implementation imports.
export type StatsRange = "day" | "week" | "month";
export type StorageCategoryId = "content" | "delivery" | "accounts" | "connections" | "evidence" | "migration" | "other";
export type StorageStats={databaseBytes:number;applicationBytes:number;indexBytes:number;otherDatabaseBytes:number;
  categories:{id:StorageCategoryId;label:string;tableBytes:number;indexBytes:number;totalBytes:number}[]};
export type OperatorStats = {
  range:StatsRange; generatedAt:string; storage:StorageStats|null;
  totals:{users:number; pendingUsers:number; sent:number; received:number; rejected:number; delivered:number; failed:number; pending:number; deliveryRate:number|null};
  activity:{start:string; sent:number; received:number}[];
};
export interface PublicOnboardingPreparation {
  accountId: string;
  address: string;
  userRecoveryKey: string;
  userIdentityKey: string;
  providerRotationKey: string;
  providerMessagingKey: string;
  sourceServiceBase: string;
  custodyProfile: "owner-controlled" | "managed";
  managedProfileVersion: "hail-managed-custody-v1" | null;
  monitorOrigin: string;
  monitorPublicKey: string;
  monitorAssurance: "independent" | "reduced-assurance-alpha-v1";
}
