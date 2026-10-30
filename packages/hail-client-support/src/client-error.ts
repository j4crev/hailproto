export class ClientError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
