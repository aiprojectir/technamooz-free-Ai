// Secure, dependency-free attachment extraction for Cloudflare Workers.
const MAX_FILE = 8 * 1024 * 1024;
const MAX_TOTAL = 20 * 1024 * 1024;
const MAX_FILES = 5;
const ALLOWED = new Set([
  'image/png','image/jpeg','image/webp','application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain','text/markdown','text/csv'
]);
const EXT_MIME = {
  png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',
  pdf:'application/pdf',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt:'text/plain',md:'text/markdown',csv:'text/csv'
};
const decoder = new TextDecoder();
function bytesToBase64(bytes) { let binary=''; for(let i=0;i<bytes.length;i+=0x8000) binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000)); return btoa(binary); }
function xmlText(s) {
  return String(s).replace(/<w:tab[^>]*\/>/g,'\t').replace(/<w:br[^>]*\/>/g,'\n')
    .replace(/<\/w:p>/g,'\n').replace(/<[^>]+>/g,' ')
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n)))
    .replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}
async function inflateLimited(raw, format, maxBytes=25000000) {
  const stream=new Blob([raw]).stream().pipeThrough(new DecompressionStream(format));
  const reader=stream.getReader(); const chunks=[]; let total=0;
  while(true){ const {done,value}=await reader.read(); if(done) break; total+=value.length;
    if(total>maxBytes){ await reader.cancel(); throw new Error('محتوای فشردهٔ فایل بیش از حد مجاز است.'); }
    chunks.push(value);
  }
  const out=new Uint8Array(total); let offset=0;
  for(const chunk of chunks){out.set(chunk,offset);offset+=chunk.length;}
  return out;
}
async function unzip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = {};
  for (let p=0; p+30<bytes.length;) {
    if (view.getUint32(p,true)!==0x04034b50) { p++; continue; }
    const method=view.getUint16(p+8,true), size=view.getUint32(p+18,true);
    const nl=view.getUint16(p+26,true), el=view.getUint16(p+28,true);
    const start=p+30+nl+el, name=decoder.decode(bytes.subarray(p+30,p+30+nl));
    if (start+size>bytes.length) break;
    const raw=bytes.slice(start,start+size);
    try {
      out[name]=method===0?raw:method===8?await inflateLimited(raw,'deflate-raw'):null;
    } catch { out[name]=null; }
    p=start+size;
  }
  return out;
}
function pdfText(bytes) {
  const s=decoder.decode(bytes);
  const out=[];
  // Extract uncompressed PDF text operators and FlateDecode streams.
  const streams=[...s.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)];
  for (const m of streams) {
    let content=m[1];
    const before=s.slice(Math.max(0,m.index-500),m.index);
    if (/\/FlateDecode/.test(before)) {
      try {
        const raw=Uint8Array.from(content, c=>c.charCodeAt(0));
        content=decoder.decode(new Uint8Array()); // replaced below
        // PDF Flate streams use zlib-wrapped DEFLATE.
        content=''; 
        // Decompression is asynchronous in Workers; collected separately by extractPdf.
      } catch {}
    }
    if (!/\/FlateDecode/.test(before)) out.push(content);
  }
  return out.join('\n').replace(/\(([^()]*(?:\\.[^()]*)*)\)\s*Tj/g,(_,t)=>t.replace(/\\([()\\])/g,'$1').replace(/\\n/g,'\n'))
    .replace(/\[([^\]]+)\]\s*TJ/g,(_,t)=>[...t.matchAll(/\(([^()]*)\)/g)].map(x=>x[1]).join(' '))
    .replace(/[^\x20-\x7E\u0600-\u06FF\n\r\t]/g,' ').replace(/[ \t]{2,}/g,' ').trim();
}
async function extractPdf(bytes) {
  const s=decoder.decode(bytes);
  let text=pdfText(bytes);
  const matches=[...s.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)];
  for(let i=0;i<matches.length;i++){
    const m=matches[i], before=s.slice(Math.max(0,m.index-600),m.index);
    if(!/\/FlateDecode/.test(before)) continue;
    try {
      const raw=Uint8Array.from(m[1],c=>c.charCodeAt(0));
      const dec=await inflateLimited(raw,'deflate',12000000);
      const t=decoder.decode(dec);
      text+='\n'+t.replace(/\(([^()]*(?:\\.[^()]*)*)\)\s*Tj/g,(_,v)=>v.replace(/\\([()\\])/g,'$1').replace(/\\n/g,'\n'))
        .replace(/\[([^\]]+)\]\s*TJ/g,(_,v)=>[...v.matchAll(/\(([^()]*)\)/g)].map(x=>x[1]).join(' '));
    } catch {}
  }
  return text.replace(/[^\x20-\x7E\u0600-\u06FF\n\r\t]/g,' ').replace(/[ \t]{2,}/g,' ').trim();
}
async function extractOffice(bytes, kind) {
  const files=await unzip(bytes);
  if(kind==='docx') {
    const doc=files['word/document.xml'];
    if(!doc) throw new Error('ساختار DOCX معتبر نیست.');
    return xmlText(decoder.decode(doc));
  }
  const shared=files['xl/sharedStrings.xml']? [...decoder.decode(files['xl/sharedStrings.xml']).matchAll(/<si[\s\S]*?<\/si>/g)].map(m=>xmlText(m[0])):[];
  const sheets=Object.keys(files).filter(k=>/^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort();
  if(!sheets.length) throw new Error('ساختار XLSX معتبر نیست.');
  return sheets.map((name,i)=>{
    const xml=decoder.decode(files[name]);
    const rows=[...xml.matchAll(/<row\b[\s\S]*?<\/row>/g)].map(r=>{
      const cells=[...r[0].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)].map(c=>{
        const val=(c[2].match(/<v>([\s\S]*?)<\/v>/)||[])[1]||'';
        return /t="s"/.test(c[1])?(shared[Number(val)]||''):xmlText(c[2])||val;
      });
      return cells.join('\t');
    });
    return `Sheet ${i+1}: ${name}\n${rows.join('\n')}`;
  }).join('\n\n');
}
export async function parseAttachments(form) {
  const files=form.getAll('files').filter(x=>x && typeof x.arrayBuffer==='function');
  if(!files.length) throw new Error('حداقل یک فایل انتخاب کنید.');
  if(files.length>MAX_FILES) throw new Error('حداکثر ۵ فایل را هم‌زمان می‌توانید ارسال کنید.');
  let total=0; const parts=[];
  for(const file of files){
    const name=String(file.name||'file').replace(/[\\/\0\r\n]/g,'_').slice(0,120);
    const ext=name.split('.').pop().toLowerCase();
    const mime=EXT_MIME[ext]||file.type||'application/octet-stream';
    if(!ALLOWED.has(mime)) throw new Error(`فرمت فایل «${name}» پشتیبانی نمی‌شود.`);
    if(file.size<=0 || file.size>MAX_FILE) throw new Error(`حجم فایل «${name}» باید کمتر از ۸ مگابایت باشد.`);
    total+=file.size;
    if(total>MAX_TOTAL) throw new Error('حجم مجموع فایل‌ها نباید بیشتر از ۲۰ مگابایت باشد.');
    const bytes=new Uint8Array(await file.arrayBuffer());
    if(ext==='png' && !(bytes[0]===137&&bytes[1]===80&&bytes[2]===78&&bytes[3]===71)) throw new Error('محتوای PNG معتبر نیست.');
    if(ext==='jpg'||ext==='jpeg') if(!(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)) throw new Error('محتوای JPEG معتبر نیست.');
    if(ext==='webp' && !(decoder.decode(bytes.subarray(0,4))==='RIFF' && decoder.decode(bytes.subarray(8,12))==='WEBP')) throw new Error('محتوای WEBP معتبر نیست.');
    if(ext==='pdf' && decoder.decode(bytes.subarray(0,5))!=='%PDF-') throw new Error('فایل PDF معتبر نیست.');
    if((ext==='docx'||ext==='xlsx') && !(bytes[0]===0x50&&bytes[1]===0x4b)) throw new Error('ساختار فایل Office معتبر نیست.');
    if(mime.startsWith('image/')){
      parts.push({type:'image_url',image_url:{url:`data:${mime};base64,${bytesToBase64(bytes)}`}});
    } else {
      let content='';
      if(ext==='txt'||ext==='md'||ext==='csv') content=decoder.decode(bytes);
      else if(ext==='docx') content=await extractOffice(bytes,'docx');
      else if(ext==='xlsx') content=await extractOffice(bytes,'xlsx');
      else if(ext==='pdf') content=await extractPdf(bytes);
      else if(ext==='doc'||ext==='xls') throw new Error(`فایل قدیمی ${ext.toUpperCase()} پشتیبانی نمی‌شود؛ آن را به DOCX یا XLSX تبدیل کنید.`);
      content=content.slice(0,45000);
      if(!content.trim()) throw new Error(`متنی برای استخراج از «${name}» پیدا نشد.`);
      parts.push({type:'text',text:`\n\n--- فایل: ${name} ---\n${content}`});
    }
  }
  return {parts,names:files.map(f=>String(f.name).slice(0,120))};
}
