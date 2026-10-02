// The block added under a message. "-- " on its own line is the long-standing signature separator.
export const signatureBlock=(signature:string)=>signature?`-- \n${signature}`:'';
