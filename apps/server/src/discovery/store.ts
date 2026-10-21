export interface PublishedAddressBinding {
  id: string;
  accountId: string;
  canonicalAddress: string;
  did: string;
  cose: Uint8Array;
  digest: Uint8Array;
  issuedAt: Date;
  expiresAt: Date;
  publishedAt: Date | null;
}

export interface DiscoveryStore {
  findPublishedByAddress(address: string): Promise<PublishedAddressBinding | null>;
  findPublishedById(id: string): Promise<PublishedAddressBinding | null>;
}
