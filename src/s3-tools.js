// S3 tool implementations for the `sdk` entry type.
//
// Credentials come from the SDK's default chain, which reads ~/.aws using
// AWS_PROFILE. Nothing is injected and no secret is ever read by this code --
// the launcher only decides which profile name is in scope.
//
// There is deliberately no bucket allowlist: the security boundary is the IAM
// policy attached to the user. See etc/iam-policy.example.json for the minimum
// policy these five tools need.
import { createReadStream, createWriteStream, existsSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ToolInputError } from './args.js';
import { log } from './log.js';

const MAX_KEYS = 1000;
const PART_SIZE = 8 * 1024 * 1024;

export const S3_TOOL_NAMES = ['s3_list', 's3_get', 's3_put', 's3_presign', 's3_delete'];

function requireParentDir(target) {
  const parent = path.dirname(target);
  if (!existsSync(parent)) {
    throw new ToolInputError(`destination directory does not exist: ${parent}`);
  }
}

function sizeOf(source) {
  try {
    const stat = statSync(source);
    if (stat.isDirectory()) throw new ToolInputError(`not a file: ${source}`);
    return stat.size;
  } catch (err) {
    if (err instanceof ToolInputError) throw err;
    throw new ToolInputError(`cannot read ${source}: ${err.code ?? err.message}`);
  }
}

export function createS3Tools({ region, presignMaxSeconds }) {
  // Clients are built on first use: a session that never touches S3 never reads
  // credentials. One per region, because presigning needs a region-correct one.
  const clients = new Map();
  const bucketRegions = new Map();

  const clientFor = (r) => {
    if (!clients.has(r)) {
      log.info('creating S3 client', { region: r, profile: process.env.AWS_PROFILE ?? '(default chain)' });
      clients.set(r, new S3Client({ region: r, followRegionRedirects: true }));
    }
    return clients.get(r);
  };
  const s3 = () => clientFor(region);

  // A presigned URL is a plain HTTPS URL handed to someone else -- nothing can
  // follow a region redirect on their behalf, so it has to be signed against the
  // bucket's own region or it just returns 301. Ordinary SDK calls are fine,
  // because followRegionRedirects handles them in-process.
  const clientForBucket = async (bucket) => {
    if (!bucketRegions.has(bucket)) {
      let resolved = region;
      try {
        const head = await s3().send(new HeadBucketCommand({ Bucket: bucket }));
        resolved = head.BucketRegion || region;
      } catch (err) {
        // Only a real service response is an expected failure here: HeadBucket
        // needs s3:ListBucket without a prefix condition, which a tightly scoped
        // policy may not grant, so degrade to the configured region. Anything
        // without $metadata is a bug in this file, and swallowing it would hide
        // the cause behind a wrong-region URL.
        if (!err.$metadata) throw err;
        resolved = err.$metadata.httpHeaders?.['x-amz-bucket-region'] || region;
        log.warn('bucket region lookup denied, using configured region', {
          bucket, region: resolved, error: err.name,
        });
      }
      bucketRegions.set(bucket, resolved);
    }
    return clientFor(bucketRegions.get(bucket));
  };

  return {
    async s3_list({ bucket, prefix, maxKeys = MAX_KEYS, continuationToken }) {
      const out = await s3().send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          MaxKeys: Math.min(maxKeys, MAX_KEYS),
          ContinuationToken: continuationToken,
        }),
      );
      return {
        bucket,
        prefix: prefix ?? '',
        count: out.KeyCount ?? 0,
        isTruncated: Boolean(out.IsTruncated),
        nextContinuationToken: out.NextContinuationToken,
        objects: (out.Contents ?? []).map((o) => ({
          key: o.Key,
          size: o.Size,
          lastModified: o.LastModified?.toISOString(),
          storageClass: o.StorageClass,
        })),
      };
    },

    async s3_get({ bucket, key, path: destination, overwrite = false }) {
      requireParentDir(destination);
      if (!overwrite && existsSync(destination)) {
        throw new ToolInputError(
          `destination already exists: ${destination} (pass overwrite: true to replace it)`,
        );
      }
      const out = await s3().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      try {
        await pipeline(out.Body, createWriteStream(destination));
      } catch (err) {
        // Do not leave a half-written file behind looking like a good download.
        rmSync(destination, { force: true });
        throw err;
      }
      return {
        bucket,
        key,
        path: destination,
        bytes: statSync(destination).size,
        contentType: out.ContentType,
      };
    },

    async s3_put({ bucket, key, path: source, contentType }) {
      const bytes = sizeOf(source);
      const upload = new Upload({
        client: s3(),
        params: {
          Bucket: bucket,
          Key: key,
          Body: createReadStream(source),
          ...(contentType ? { ContentType: contentType } : {}),
        },
        queueSize: 4,
        partSize: PART_SIZE,
      });
      const out = await upload.done();
      return { bucket, key, path: source, bytes, etag: out.ETag, location: out.Location };
    },

    async s3_presign({ bucket, key, expiresIn = 3600 }) {
      const seconds = Math.min(expiresIn, presignMaxSeconds);
      const client = await clientForBucket(bucket);
      const url = await getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
        expiresIn: seconds,
      });
      return {
        bucket,
        key,
        url,
        region: bucketRegions.get(bucket),
        expiresIn: seconds,
        expiresAt: new Date(Date.now() + seconds * 1000).toISOString(),
        capped: seconds !== expiresIn,
      };
    },

    async s3_delete({ bucket, key }) {
      // DeleteObject succeeds on a key that was never there, which would make
      // `deleted: true` a lie. Check first and report what actually happened.
      try {
        await s3().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      } catch (err) {
        if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
          return { bucket, key, deleted: false, existed: false };
        }
        throw err;
      }
      const out = await s3().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      return {
        bucket,
        key,
        deleted: true,
        existed: true,
        versionId: out.VersionId,
        deleteMarker: out.DeleteMarker,
      };
    },
  };
}
