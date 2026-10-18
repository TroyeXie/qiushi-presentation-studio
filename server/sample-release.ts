const SAMPLE_RELEASE_VERSION='20261018-public-academic-gallery-v1';
const SAMPLE_RELEASE_MARKER=`samples/releases/${SAMPLE_RELEASE_VERSION}.json`;
const SAMPLE_IDS=new Set(['course','journal','green-space']);
const PREVIEW_PART_BYTES=4*1024*1024;
const inflight=new WeakMap<object,Promise<void>>();

type Bucket={
 get(key:string):Promise<{json():Promise<any>}|null>;
 put(key:string,value:string|Uint8Array):Promise<unknown>;
};
type ReleaseSample={id:string;catalog:Record<string,any>;previewManifest:Record<string,any>;previewBase64:string;thumbnailManifest:Record<string,any>;thumbnailBase64:string};

/** Only presentation metadata and authenticated preview endpoints leave the server. */
export function publicSampleCatalog(entries:any){
 if(!Array.isArray(entries))return [];
 return entries.filter(item=>item&&SAMPLE_IDS.has(item.id)).map(item=>({
  id:item.id,title:String(item.title||item.name||''),
  description:typeof item.description==='string'?item.description:'',
  ...(Number.isSafeInteger(item.slides)&&item.slides>0?{slides:item.slides}:{}),
  ...(Number.isSafeInteger(item.sizeBytes)&&item.sizeBytes>0?{sizeBytes:item.sizeBytes}:{}),
  ...(Number.isSafeInteger(item.size)&&item.size>0?{size:item.size}:{}),
  readOnly:true,previewUrl:`/api/samples/${item.id}/preview`,thumbnailUrl:`/api/samples/${item.id}/thumbnail`
 }));
}

function decodeBase64(value:string){return Uint8Array.from(atob(value),char=>char.charCodeAt(0));}
async function writeReleaseSample(bucket:Bucket,sample:ReleaseSample){
 if(!['course','journal','green-space'].includes(sample.id))throw new Error('Invalid bundled sample');
 const meta=sample.previewManifest,bytes=decodeBase64(sample.previewBase64);
 if(meta.readOnly!==true||meta.encryption!=='AES-256'||meta.permissions!==0||meta.mime!=='application/pdf'||
  meta.partBytes!==PREVIEW_PART_BYTES||meta.size!==bytes.length||meta.parts!==Math.ceil(bytes.length/PREVIEW_PART_BYTES)||
  !/^[a-f0-9]{64}$/.test(meta.sha256||''))throw new Error('Invalid bundled PDF protection');
 const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');
 if(digest!==meta.sha256)throw new Error('Bundled PDF digest mismatch');
 const prefix=`samples/${sample.id}/preview-readonly`;
 for(let part=0;part<meta.parts;part++)await bucket.put(`${prefix}/${meta.sha256}/${part}`,bytes.slice(part*PREVIEW_PART_BYTES,(part+1)*PREVIEW_PART_BYTES));
 await bucket.put(`${prefix}/manifest.json`,JSON.stringify(meta));
 const thumbnail=decodeBase64(sample.thumbnailBase64),thumbnailMeta=sample.thumbnailManifest;
 if(thumbnailMeta.size!==thumbnail.length||thumbnailMeta.parts!==1||!['image/png','image/jpeg'].includes(thumbnailMeta.mime))throw new Error('Invalid bundled thumbnail');
 await bucket.put(`samples/${sample.id}/thumbnail/0`,thumbnail);
 await bucket.put(`samples/${sample.id}/thumbnail/manifest.json`,JSON.stringify(thumbnailMeta));
}

async function seedSampleRelease(bucket:Bucket){
 if(await bucket.get(SAMPLE_RELEASE_MARKER))return;
 // Fixed server-owned release bytes are never exposed as a public asset.
 const release=(await import('./sample-release-data.json')).default;
 if(release.revision!==SAMPLE_RELEASE_VERSION||!Array.isArray(release.samples)||release.samples.length!==3||
  new Set(release.samples.map(sample=>sample.id)).size!==3)throw new Error('Invalid sample release');
 for(const sample of release.samples)await writeReleaseSample(bucket,sample);
 const existing=await bucket.get('samples/catalog.json'),stored=existing?await existing.json():[];
 const catalog=Array.isArray(stored)?stored:[];
 const additions=new Map(release.samples.map(sample=>[sample.id,sample.catalog]));
 const merged=catalog.filter(item=>item&&SAMPLE_IDS.has(item.id)&&!additions.has(item.id));
 for(const sample of release.samples)merged.push({...sample.catalog,id:sample.id,readOnly:true});
 await bucket.put('samples/catalog.json',JSON.stringify(merged));
 // Mark complete only after all protected assets and the merged catalog are durable.
 await bucket.put(SAMPLE_RELEASE_MARKER,JSON.stringify({version:SAMPLE_RELEASE_VERSION}));
}

/** Install one fixed server-owned release; request bodies cannot alter its content. */
export async function ensureSampleRelease(bucket:Bucket){
 let pending=inflight.get(bucket);
 if(!pending){pending=seedSampleRelease(bucket);inflight.set(bucket,pending);}
 try{await pending;}finally{if(inflight.get(bucket)===pending)inflight.delete(bucket);}
}
