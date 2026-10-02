// Limits shared by the browser (to explain problems early) and the server (to enforce them).
// Gmail allows 25 MB per message, but base64 adds a third and the Worker has limited memory, so the
// cap is deliberately lower.
export const MAX_ATTACHMENTS=5;
export const MAX_ATTACHMENT_BYTES=10*1024*1024;
// Gmail itself refuses these, so refusing them here gives a clear message instead of a vague failure.
const BLOCKED=/\.(ade|adp|app|bat|chm|cmd|com|cpl|dll|exe|hta|ins|isp|jar|js|jse|lib|lnk|mde|msc|msi|msp|mst|pif|ps1|reg|scr|sct|shb|sys|vb|vbe|vbs|vxd|wsc|wsf|wsh)$/i;
export function formatBytes(bytes:number){return bytes>=1048576?`${(bytes/1048576).toFixed(1)} MB`:`${Math.max(1,Math.round(bytes/1024))} KB`;}
export function attachmentProblem(files:{name:string;size:number}[]):string|null {
  if(files.length>MAX_ATTACHMENTS)return `Attach at most ${MAX_ATTACHMENTS} files.`;
  for(const file of files){
    if(file.size===0)return `"${file.name.slice(0,60)}" is empty.`;
    if(BLOCKED.test(file.name))return `Gmail does not allow "${file.name.slice(0,60)}" because of its file type. Put it in a zip file or share a link instead.`;
  }
  if(files.reduce((total,file)=>total+file.size,0)>MAX_ATTACHMENT_BYTES)return `Attachments are too large. Keep the total under ${formatBytes(MAX_ATTACHMENT_BYTES)}.`;
  return null;
}
// A safe file name for headers: no path, no quotes or line breaks, bounded length.
export function cleanFileName(name:string):string {
  const base=name.split(/[\\/]/).pop()||'';
  const cleaned=base.normalize('NFC').replace(/[\p{C}"\\]/gu,'_').trim().slice(0,150);
  return cleaned||'attachment';
}
export function cleanMediaType(type:string):string {
  const base=type.split(';')[0].trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(base)&&base.length<=100?base:'application/octet-stream';
}
