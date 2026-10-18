export const UPLOAD_LIMITS = Object.freeze({ maxFileMB: 200, chunkMB: 8, pdfParseMB: 32 });
export const CHUNK_BYTES = UPLOAD_LIMITS.chunkMB * 1024 * 1024;
export const MAX_UPLOAD_BYTES = UPLOAD_LIMITS.maxFileMB * 1024 * 1024;
export const MATERIAL_KINDS = ['pdf', 'docx', 'pptx', 'md', 'txt', 'png', 'jpg', 'jpeg'];
const RANGE_BLOCK_BYTES = 64 * 1024;
const RANGE_CACHE_BYTES = 8 * 1024 * 1024;
const SMALL_RANGE_BYTES = 4 * RANGE_BLOCK_BYTES;
type StoredBucket = {
  get(key: string, options: { range: { offset: number; length: number } }): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
};

export function partSize(size: number, index: number) {
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_UPLOAD_BYTES ||
      !Number.isInteger(index) || index < 0 || index >= Math.ceil(size / CHUNK_BYTES))
    throw new Error('上传分块无效。');
  return Math.min(CHUNK_BYTES, size - index * CHUNK_BYTES);
}

export function storedSource(bucket: StoredBucket, prefix: string, size: number) {
  // Office extraction repeatedly reads adjacent local ZIP headers and XML.
  // Cache bounded 64 KB windows rather than repeatedly fetching each header.
  // Large PDF reads bypass this cache to preserve 8 MB multipart reads.
  const cache = new Map<number, Uint8Array>();
  const pending = new Map<number, Promise<Uint8Array>>();
  let cachedBytes = 0;

  async function getBytes(part: number, offset: number, length: number) {
    const object = await bucket.get(`${prefix}/parts/${part}`, { range: { offset, length } });
    if (!object) throw new Error('上传内容不完整，请删除后重新上传。');
    const data = new Uint8Array(await object.arrayBuffer());
    if (data.length !== length) throw new Error('上传分块大小不匹配，请重新上传。');
    return data;
  }

  async function blockAt(absolute: number): Promise<Uint8Array> {
    const start = Math.floor(absolute / RANGE_BLOCK_BYTES) * RANGE_BLOCK_BYTES;
    const existing = cache.get(start);
    if (existing) { cache.delete(start); cache.set(start, existing); return existing; }
    const inFlight = pending.get(start);
    if (inFlight) return inFlight;
    const part = Math.floor(start / CHUNK_BYTES), localOffset = start % CHUNK_BYTES;
    const wanted = Math.min(RANGE_BLOCK_BYTES, partSize(size, part) - localOffset);
    const loading = getBytes(part, localOffset, wanted).then(data => {
      while (cachedBytes + data.length > RANGE_CACHE_BYTES) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cachedBytes -= cache.get(oldest)!.length;
        cache.delete(oldest);
      }
      cache.set(start, data); cachedBytes += data.length;
      return data;
    });
    pending.set(start, loading);
    try { return await loading; }
    finally { pending.delete(start); }
  }

  return {
    size,
    async readRange(offset: number, length: number): Promise<Uint8Array> {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 ||
          length < 0 || offset + length > size || length > UPLOAD_LIMITS.pdfParseMB * 1024 * 1024)
        throw new Error('读取范围无效。');
      const output = new Uint8Array(length);
      let copied = 0;
      while (copied < length) {
        const absolute = offset + copied;
        if (length <= SMALL_RANGE_BYTES) {
          const data = await blockAt(absolute), withinBlock = absolute % RANGE_BLOCK_BYTES;
          const wanted = Math.min(length - copied, data.length - withinBlock);
          output.set(data.subarray(withinBlock, withinBlock + wanted), copied);
          copied += wanted;
          continue;
        }
        const part = Math.floor(absolute / CHUNK_BYTES);
        const localOffset = absolute % CHUNK_BYTES;
        const wanted = Math.min(length - copied, partSize(size, part) - localOffset);
        const data = await getBytes(part, localOffset, wanted);
        output.set(data, copied);
        copied += wanted;
      }
      return output;
    },
  };
}
