import "server-only";

import { randomUUID } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
  type HeadObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { getAppConfig, getStorageConfig } from "./config.ts";

type R2Command = HeadBucketCommand | PutObjectCommand | GetObjectCommand | HeadObjectCommand | DeleteObjectCommand | ListObjectsV2Command;
export type R2Client = { send(command: R2Command): Promise<unknown> };

function defaultClientFactory(): R2Client {
  const config = getStorageConfig();
  const client = new S3Client({
    endpoint: config.LOCAL801_R2_ENDPOINT,
    region: "auto",
    credentials: {
      accessKeyId: config.LOCAL801_R2_ACCESS_KEY_ID,
      secretAccessKey: config.LOCAL801_R2_SECRET_ACCESS_KEY,
    },
  });
  return {
    send(command) {
      if (command instanceof HeadBucketCommand) return client.send(command);
      if (command instanceof PutObjectCommand) return client.send(command);
      if (command instanceof GetObjectCommand) return client.send(command);
      if (command instanceof HeadObjectCommand) return client.send(command);
      if (command instanceof ListObjectsV2Command) return client.send(command);
      return client.send(command);
    },
  };
}

let r2ClientFactory: () => R2Client = defaultClientFactory;

/** Test seam. Runtime code should use the default factory. */
export function setR2ClientFactoryForTests(factory: (() => R2Client) | null) {
  r2ClientFactory = factory ?? defaultClientFactory;
}

export function createR2Client() {
  return r2ClientFactory();
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value;
}

function hasArrayBuffer(value: unknown): value is { arrayBuffer(): Promise<ArrayBuffer> } {
  return (
    typeof value === "object" &&
    value !== null &&
    "arrayBuffer" in value &&
    typeof (value as { arrayBuffer?: unknown }).arrayBuffer === "function"
  );
}

function assertWithinStoredObjectLimit(byteLength: number, maximumBytes: number) {
  if (byteLength > maximumBytes) throw new Error("Encrypted storage object exceeds the configured size limit.");
}

function validateContentLength(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("R2 response content length is invalid.");
  }
  return value;
}

async function bodyToBuffer(
  body: unknown,
  maximumBytes: number,
  trustedContentLength?: number,
): Promise<Buffer> {
  if (body instanceof Uint8Array) {
    assertWithinStoredObjectLimit(body.byteLength, maximumBytes);
    return Buffer.from(body);
  }
  if (body === null || body === undefined) return Buffer.alloc(0);

  if (isAsyncIterable(body)) {
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    for await (const chunk of body) {
      if (typeof chunk !== "string" && !(chunk instanceof Uint8Array)) {
        throw new Error("Unsupported R2 response stream chunk.");
      }
      const bufferedChunk = Buffer.from(chunk);
      receivedBytes += bufferedChunk.byteLength;
      assertWithinStoredObjectLimit(receivedBytes, maximumBytes);
      chunks.push(bufferedChunk);
    }
    return Buffer.concat(chunks);
  }

  if (hasArrayBuffer(body)) {
    if (trustedContentLength === undefined) {
      throw new Error("R2 response body cannot be safely bounded without a content length.");
    }
    const arrayBuffer = await body.arrayBuffer();
    assertWithinStoredObjectLimit(arrayBuffer.byteLength, maximumBytes);
    return Buffer.from(arrayBuffer);
  }
  throw new Error("Unsupported R2 response body type.");
}

/** Allows for base64 expansion plus bounded JSON envelope/version metadata overhead. */
export function encryptedObjectSizeLimit(plaintextMaximumBytes: number) {
  return Math.ceil(plaintextMaximumBytes / 3) * 4 + 2048;
}

export type StorageKind = "documents" | "imports" | "reports";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const storageKeyPattern = /^local801\/(documents|imports|reports)\/\d{4}\/\d{2}\/[0-9a-f-]{36}$/i;

export function generateStorageKey(kind: StorageKind, id = randomUUID(), createdAt = new Date()) {
  if (kind !== "documents" && kind !== "imports" && kind !== "reports") {
    throw new Error("Invalid Local 801 storage kind.");
  }
  if (!uuidPattern.test(id)) throw new Error("Storage object ID must be a UUID.");
  const year = String(createdAt.getUTCFullYear()).padStart(4, "0");
  const month = String(createdAt.getUTCMonth() + 1).padStart(2, "0");
  return `local801/${kind}/${year}/${month}/${id.toLowerCase()}`;
}

export function assertSafeStorageKey(storageKey: string) {
  if (!storageKeyPattern.test(storageKey) || storageKey.includes("..") || storageKey.includes("\\")) {
    throw new Error("Invalid Local 801 storage key.");
  }
  return storageKey;
}

export type StorageReadiness = { storage: "ok" | "error" };

export async function checkStorageReadiness(): Promise<StorageReadiness> {
  try {
    const config = getStorageConfig();
    await createR2Client().send(new HeadBucketCommand({ Bucket: config.LOCAL801_R2_BUCKET }));
    return { storage: "ok" };
  } catch {
    return { storage: "error" };
  }
}

export async function putObject(storageKey: string, body: Buffer | Uint8Array) {
  const key = assertSafeStorageKey(storageKey);
  const config = getStorageConfig();
  const payload = Buffer.from(body);
  await createR2Client().send(
    new PutObjectCommand({
      Bucket: config.LOCAL801_R2_BUCKET,
      Key: key,
      Body: payload,
      ContentType: "application/octet-stream",
    }),
  );
  return { storageKey: key, byteSize: payload.byteLength };
}

export async function getObject(storageKey: string) {
  const key = assertSafeStorageKey(storageKey);
  const config = getStorageConfig();
  const response = (await createR2Client().send(
    new GetObjectCommand({ Bucket: config.LOCAL801_R2_BUCKET, Key: key }),
  )) as GetObjectCommandOutput;
  const maximumBytes = encryptedObjectSizeLimit(getAppConfig().LOCAL801_IMPORT_MAX_BYTES);
  const contentLength = response.ContentLength === undefined
    ? undefined
    : validateContentLength(response.ContentLength);
  if (contentLength !== undefined) assertWithinStoredObjectLimit(contentLength, maximumBytes);
  const body = await bodyToBuffer(response.Body, maximumBytes, contentLength);
  return { body, contentLength: response.ContentLength ?? body.byteLength };
}

function isNotFoundError(error: unknown) {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return (
    candidate.name === "NotFound" ||
    candidate.name === "NoSuchKey" ||
    candidate.$metadata?.httpStatusCode === 404
  );
}

export async function headObject(storageKey: string) {
  const key = assertSafeStorageKey(storageKey);
  const config = getStorageConfig();
  try {
    const response = (await createR2Client().send(
      new HeadObjectCommand({ Bucket: config.LOCAL801_R2_BUCKET, Key: key }),
    )) as HeadObjectCommandOutput;
    return { exists: true as const, contentLength: response.ContentLength };
  } catch (error) {
    if (isNotFoundError(error)) return { exists: false as const };
    throw new Error("Unable to inspect Local 801 storage object.");
  }
}

export async function deleteObject(storageKey: string) {
  const key = assertSafeStorageKey(storageKey);
  const config = getStorageConfig();
  await createR2Client().send(new DeleteObjectCommand({ Bucket: config.LOCAL801_R2_BUCKET, Key: key }));
  return { deleted: true as const, storageKey: key };
}

export async function listStorageObjectKeys(options: { maximumObjects?: number } = {}) {
  const maximumObjects = Math.min(100_000, Math.max(1, Math.trunc(options.maximumObjects ?? 50_000)));
  const config = getStorageConfig();
  const client = createR2Client();
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const response = await client.send(new ListObjectsV2Command({
      Bucket: config.LOCAL801_R2_BUCKET,
      Prefix: "local801/",
      MaxKeys: Math.min(1_000, maximumObjects - keys.length + 1),
      ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
    })) as { Contents?: Array<{ Key?: string }>; IsTruncated?: boolean; NextContinuationToken?: string };
    for (const object of response.Contents ?? []) {
      if (!object.Key) throw new Error("R2 returned an object without a key.");
      keys.push(assertSafeStorageKey(object.Key));
      if (keys.length > maximumObjects) throw new Error("Storage reconciliation object limit exceeded.");
    }
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    if (response.IsTruncated && !continuationToken) throw new Error("R2 reconciliation pagination is incomplete.");
  } while (continuationToken);
  return keys;
}
