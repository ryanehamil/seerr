import logger from '@server/logger';
import { proxyRequestInterceptor } from '@server/utils/customProxyAgent';
import { userAgentRequestInterceptor } from '@server/utils/userAgent';
import axios, { type AxiosInstance } from 'axios';
import rateLimit, { type rateLimitOptions } from 'axios-rate-limit';
import { createHash } from 'crypto';
import { promises } from 'fs';
import mime from 'mime';
import path, { join } from 'path';
import sharp from 'sharp';

const WEBP_QUALITY = 80;
const WEBP_EFFORT = 5;
const CONVERTIBLE_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
];

type ImageResponse = {
  meta: {
    revalidateAfter: number;
    curRevalidate: number;
    isStale: boolean;
    etag: string;
    extension: string | null;
    cacheKey: string;
    cacheMiss: boolean;
  };
  imageBuffer: Buffer;
};

const baseCacheDirectory = process.env.CONFIG_DIRECTORY
  ? `${process.env.CONFIG_DIRECTORY}/cache/images`
  : path.join(__dirname, '../../config/cache/images');

class ImageProxy {
  public static async clearCache(key: string) {
    let deletedImages = 0;
    const cacheDirectory = path.join(baseCacheDirectory, key);

    try {
      const files = await promises.readdir(cacheDirectory);

      for (const file of files) {
        const filePath = path.join(cacheDirectory, file);
        const stat = await promises.lstat(filePath);

        if (stat.isDirectory()) {
          const imageFiles = await promises.readdir(filePath);

          for (const imageFile of imageFiles) {
            const [, expireAtSt] = imageFile.split('.');
            const expireAt = Number(expireAtSt);
            const now = Date.now();

            if (now > expireAt) {
              await promises.rm(path.join(filePath), {
                recursive: true,
              });
              deletedImages += 1;
            }
          }
        }
      }
    } catch (e) {
      if (e.code === 'ENOENT') {
        return;
      }
      logger.error('Failed to read directory', {
        label: 'Image Cache',
        message: e.message,
      });
    }

    logger.info(`Cleared ${deletedImages} stale image(s) from cache '${key}'`, {
      label: 'Image Cache',
    });
  }

  public static async getImageStats(
    key: string
  ): Promise<{ size: number; imageCount: number }> {
    const cacheDirectory = path.join(baseCacheDirectory, key);

    const imageTotalSize = await ImageProxy.getDirectorySize(cacheDirectory);
    const imageCount = await ImageProxy.getImageCount(cacheDirectory);

    return {
      size: imageTotalSize,
      imageCount,
    };
  }

  private static async getDirectorySize(dir: string): Promise<number> {
    try {
      const files = await promises.readdir(dir, {
        withFileTypes: true,
      });

      const paths = files.map(async (file) => {
        const path = join(dir, file.name);

        if (file.isDirectory()) return await ImageProxy.getDirectorySize(path);

        if (file.isFile()) {
          const { size } = await promises.stat(path);

          return size;
        }

        return 0;
      });

      return (await Promise.all(paths))
        .flat(Infinity)
        .reduce((i, size) => i + size, 0);
    } catch (e) {
      if (e.code === 'ENOENT') {
        return 0;
      }
    }

    return 0;
  }

  private static async getImageCount(dir: string) {
    try {
      const files = await promises.readdir(dir);

      return files.length;
    } catch (e) {
      if (e.code === 'ENOENT') {
        return 0;
      }
    }

    return 0;
  }

  // Concurrent requests for the same image share a single download
  private static inFlight = new Map<string, Promise<ImageResponse | null>>();

  private axios: AxiosInstance;
  private cacheVersion;
  private key;

  constructor(
    key: string,
    baseUrl: string,
    options: {
      cacheVersion?: number;
      rateLimitOptions?: rateLimitOptions;
      headers?: Record<string, string>;
    } = {}
  ) {
    this.cacheVersion = options.cacheVersion ?? 1;
    this.key = key;
    this.axios = axios.create({
      baseURL: baseUrl,
      headers: options.headers,
    });
    this.axios.interceptors.request.use(proxyRequestInterceptor);
    this.axios.interceptors.request.use(userAgentRequestInterceptor);

    if (options.rateLimitOptions) {
      this.axios = rateLimit(this.axios, options.rateLimitOptions);
    }
  }

  public async getImage(
    path: string,
    fallbackPath?: string
  ): Promise<ImageResponse> {
    const cacheKey = this.getCacheKey(path);

    const imageResponse = await this.get(cacheKey);

    if (!imageResponse) {
      const newImage = await this.set(path, cacheKey);

      if (!newImage) {
        if (fallbackPath) {
          return await this.getImage(fallbackPath);
        } else {
          throw new Error('Failed to load image');
        }
      }

      return newImage;
    }

    // If the image is stale, we will revalidate it in the background.
    if (imageResponse.meta.isStale) {
      this.set(path, cacheKey);
    }

    return imageResponse;
  }

  public async clearCachedImage(path: string) {
    // find cacheKey
    const cacheKey = this.getCacheKey(path);
    const directory = join(this.getCacheDirectory(), cacheKey);

    try {
      await promises.access(directory);
    } catch (e) {
      if (e.code === 'ENOENT') {
        logger.debug(
          `Cache directory '${cacheKey}' does not exist; nothing to clear.`,
          {
            label: 'Image Cache',
          }
        );
        return;
      } else {
        logger.error('Error checking cache directory existence', {
          label: 'Image Cache',
          message: e.message,
        });
        return;
      }
    }

    try {
      const files = await promises.readdir(directory);

      await promises.rm(directory, { recursive: true });

      logger.debug(`Cleared ${files[0]} from cache 'avatar'`, {
        label: 'Image Cache',
      });
    } catch (e) {
      logger.error('Failed to clear cached image', {
        label: 'Image Cache',
        message: e.message,
      });
    }
  }

  private async get(cacheKey: string): Promise<ImageResponse | null> {
    try {
      const directory = join(this.getCacheDirectory(), cacheKey);
      const files = (await promises.readdir(directory))
        .filter((file) => !file.endsWith('.tmp'))
        .sort((a, b) => Number(b.split('.')[1]) - Number(a.split('.')[1]));
      const now = Date.now();

      // Newest entry wins; legacy entries in any format are served as-is
      for (const file of files.slice(0, 1)) {
        const [maxAgeSt, expireAtSt, etag, extension] = file.split('.');
        const buffer = await promises.readFile(join(directory, file));
        const expireAt = Number(expireAtSt);
        const maxAge = Number(maxAgeSt);

        return {
          meta: {
            curRevalidate: maxAge,
            revalidateAfter: maxAge * 1000 + now,
            isStale: now > expireAt,
            etag,
            extension,
            cacheKey,
            cacheMiss: false,
          },
          imageBuffer: buffer,
        };
      }
    } catch {
      // No files. Treat as empty cache.
    }

    return null;
  }

  private set(path: string, cacheKey: string): Promise<ImageResponse | null> {
    const existing = ImageProxy.inFlight.get(cacheKey);
    if (existing) return existing;

    const request = this.download(path, cacheKey).finally(() => {
      ImageProxy.inFlight.delete(cacheKey);
    });
    ImageProxy.inFlight.set(cacheKey, request);
    return request;
  }

  private async download(
    path: string,
    cacheKey: string
  ): Promise<ImageResponse | null> {
    try {
      const directory = join(this.getCacheDirectory(), cacheKey);
      const response = await this.axios.get(path, {
        responseType: 'arraybuffer',
      });

      let buffer = Buffer.from(response.data, 'binary');

      const contentType = (response.headers['content-type'] || '')
        .split(';')[0]
        .trim();
      let extension = (mime.getExtension(contentType) || '').replace(
        /[^\w-]/g,
        ''
      );

      // Re-encode to WebP (metadata is stripped by default); keep the original
      // if conversion fails or does not make the file smaller
      if (CONVERTIBLE_TYPES.includes(contentType)) {
        try {
          const webp = await sharp(buffer)
            .rotate()
            .webp({ quality: WEBP_QUALITY, effort: WEBP_EFFORT })
            .toBuffer();
          if (webp.length < buffer.length) {
            buffer = webp;
            extension = 'webp';
          }
        } catch (e) {
          logger.debug('Failed to convert image to WebP; caching original.', {
            label: 'Image Cache',
            errorMessage: e.message,
          });
        }
      }

      let maxAge = Number(
        (response.headers['cache-control'] ?? '0').split('=')[1]
      );

      if (!maxAge) maxAge = 86400;
      const expireAt = Date.now() + maxAge * 1000;
      const etag = (response.headers.etag ?? '').replace(/[^\w-]/g, '');

      await this.writeToCacheDir(
        directory,
        extension,
        maxAge,
        expireAt,
        buffer,
        etag
      );

      return {
        meta: {
          curRevalidate: maxAge,
          revalidateAfter: expireAt,
          isStale: false,
          etag,
          extension,
          cacheKey,
          cacheMiss: true,
        },
        imageBuffer: buffer,
      };
    } catch (e) {
      logger.debug('Something went wrong caching image.', {
        label: 'Image Cache',
        errorMessage: e.message,
      });
      return null;
    }
  }

  private async writeToCacheDir(
    dir: string,
    extension: string | null,
    maxAge: number,
    expireAt: number,
    buffer: Buffer,
    etag: string
  ) {
    const filename = join(dir, `${maxAge}.${expireAt}.${etag}.${extension}`);

    await promises.mkdir(dir, { recursive: true });

    // Write then rename so readers never see an empty or partial entry
    await promises.writeFile(`${filename}.tmp`, buffer);
    await promises.rename(`${filename}.tmp`, filename);

    const files = await promises.readdir(dir);
    for (const file of files) {
      if (join(dir, file) !== filename) {
        await promises.rm(join(dir, file), { force: true });
      }
    }
  }

  private getCacheKey(path: string) {
    return this.getHash([this.key, this.cacheVersion, path]);
  }

  private getHash(items: (string | number | Buffer)[]) {
    const hash = createHash('sha256');
    for (const item of items) {
      if (typeof item === 'number') hash.update(String(item));
      else {
        hash.update(item);
      }
    }
    // See https://en.wikipedia.org/wiki/Base64#Filenames
    return hash.digest('base64').replace(/\//g, '-');
  }

  private getCacheDirectory() {
    return path.join(baseCacheDirectory, this.key);
  }
}

export default ImageProxy;
