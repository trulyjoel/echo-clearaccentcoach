import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export interface StorageProvider {
  upload(key: string, data: Buffer, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
}

function getEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required (see apps/server/.env.example)`);
  return value;
}

function getBucket(): string {
  return getEnv("R2_BUCKET_NAME");
}

let client: S3Client | undefined;

/** Cloudflare R2 is S3-compatible; this just points the AWS SDK's S3 client at R2's endpoint. */
function getClient(): S3Client {
  client ??= new S3Client({
    region: "auto",
    endpoint: `https://${getEnv("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: getEnv("R2_ACCESS_KEY_ID"),
      secretAccessKey: getEnv("R2_SECRET_ACCESS_KEY"),
    },
  });
  return client;
}

class R2StorageProvider implements StorageProvider {
  async upload(key: string, data: Buffer, contentType: string): Promise<void> {
    await getClient().send(
      new PutObjectCommand({ Bucket: getBucket(), Key: key, Body: data, ContentType: contentType }),
    );
  }

  async delete(key: string): Promise<void> {
    await getClient().send(new DeleteObjectCommand({ Bucket: getBucket(), Key: key }));
  }
}

let provider: StorageProvider | undefined;

/** Returns the object-storage provider used to persist flagged-error audio clips. */
export function getStorageProvider(): StorageProvider {
  provider ??= new R2StorageProvider();
  return provider;
}
