export class ConnectionError extends Error {constructor(readonly status:number,message="Connection not changed. Check the original approval before retrying."){super(message);}}
