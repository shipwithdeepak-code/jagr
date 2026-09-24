/**
 * BlobStore port — declared, not used in P0. Jagr stores normalised records, not raw files, and
 * large uploads are chunked. A BlobStore is added only if raw uploads or attachments are kept.
 */
export interface BlobStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<{ bytes: Uint8Array; contentType: string } | null>;
  delete(key: string): Promise<void>;
}
